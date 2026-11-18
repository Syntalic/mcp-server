import { x402Client, x402HTTPClient, decodePaymentResponseHeader } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import type { PaymentRequired, PaymentRequirements, SettleResponse } from "@x402/core/types";
import { privateKeyToAccount } from "viem/accounts";
import { address as asSolanaAddress, createKeyPairSignerFromBytes } from "@solana/kit";
import { Mppx, tempo } from "mppx/client";
import { Challenge } from "mppx";
import { readEnv } from "./env.js";
import { deriveAssociatedTokenAccount, getTokenAccountBalance } from "./solana-rpc.js";
import { getErc20Balance } from "./tempo-rpc.js";

const BASE_NETWORK_ID = "eip155:8453";
const SOLANA_NETWORK_ID = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
export const DEFAULT_SOLANA_RPC_URL = "https://api.mainnet-beta.solana.com";
export const DEFAULT_TEMPO_RPC_URL = "https://rpc.tempo.xyz";
const TEMPO_LABEL = "tempo:4217";

// Settle failures that mean nothing was moved, so the next chain may be tried. Each is decided at
// verify, before anything is sent to a chain: the EVM balance checks, and Solana's simulation.
// Solana exposes no dedicated "insufficient funds" settle code — transaction_simulation_failed
// covers that plus unrelated failures. We treat it as balance-related only after the balance
// pre-check said we were eligible (so it's most likely an RPC flake), giving us graceful
// fall-through instead of hard-failing on a transient infra issue.
const INSUFFICIENT_BALANCE_REASONS = new Set<string>([
  "invalid_exact_evm_insufficient_balance",
  "permit2_insufficient_balance",
]);
const AMBIGUOUS_SOLANA_FAILURE_REASONS = new Set<string>([
  "transaction_simulation_failed",
]);
// Settle failures reported after the transaction may have gone out. The x402 Solana facilitator
// answers `transaction_failed` when signing, sending OR confirming throws, so a confirmation that
// timed out reads the same as a transaction that never left: it may still land. Not a reason to pay
// again on another chain (SYNLBS-272).
const MAYBE_SENT_SOLANA_FAILURE_REASONS = new Set<string>(["transaction_failed"]);

/**
 * fetch's failure codes for a connection that was never made: the signed payment did not leave this
 * machine, so trying the next chain cannot pay twice. Any other network failure (a reset, a timeout
 * waiting for the answer, a socket closed mid-answer) can come after the API read the payment and
 * settled it.
 */
const NEVER_SENT_CODES = new Set<string>([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ENETDOWN",
  "EHOSTDOWN",
  "UND_ERR_CONNECT_TIMEOUT",
]);

/** Whether a fetch failure is one of NEVER_SENT_CODES, looking through `cause` and an
 *  AggregateError's `errors` (one per address tried). */
export function failedBeforeSending(err: unknown): boolean {
  const seen = new Set<unknown>();
  const queue: unknown[] = [err];
  while (queue.length > 0) {
    const e = queue.shift();
    if (!e || typeof e !== "object" || seen.has(e)) continue;
    seen.add(e);
    const { code, cause, errors } = e as { code?: unknown; cause?: unknown; errors?: unknown };
    if (typeof code === "string" && NEVER_SENT_CODES.has(code)) return true;
    queue.push(cause);
    if (Array.isArray(errors)) queue.push(...errors);
  }
  return false;
}

interface FetchConfig {
  evmPrivateKey: string;
  solanaPrivateKey: string;
}

/** The chains a payment can go out on, in the order they are tried. */
export const PAYMENT_NETWORKS = ["solana", "base", "tempo"] as const;
export type PaymentNetwork = (typeof PAYMENT_NETWORKS)[number];

/**
 * SYNTALIC_PAYMENT_NETWORK pins every payment to one chain (testing a chain, or keeping spend on
 * the one you funded). Unset or empty means the default order. Anything else is a configuration
 * mistake, refused at startup rather than silently ignored, because an ignored pin spends on a
 * chain the user meant to keep out of it.
 */
export function parsePaymentNetwork(name: string, raw: string | undefined): PaymentNetwork | undefined {
  const value = raw?.trim().toLowerCase();
  if (!value) return undefined;
  if ((PAYMENT_NETWORKS as readonly string[]).includes(value)) return value as PaymentNetwork;
  throw new Error(`${name} must be one of ${PAYMENT_NETWORKS.join(", ")} (got "${raw}").`);
}

function labelOf(network: string): PaymentNetwork | undefined {
  if (network === SOLANA_NETWORK_ID) return "solana";
  if (network === BASE_NETWORK_ID) return "base";
  return undefined;
}

export interface PaidFetchResult {
  fetch: typeof globalThis.fetch;
  /** Validated EVM address (Base + Tempo share the same EVM account). */
  evmAddress: `0x${string}`;
  /** Validated Solana base58 address. */
  solanaAddress: string;
}

export class PaymentError extends Error {
  constructor(public readonly attempts: ReadonlyArray<{ network: string; reason: string }>) {
    const detail = attempts.length
      ? attempts.map((a) => `${a.network}: ${a.reason}`).join("; ")
      : "no supported chains matched server's accepted payment methods";
    super(
      `Payment failed across all supported chains (${detail}). ` +
        `Fund one of your wallets and retry. Run the \`wallet_info\` tool to see addresses. ` +
        `If you haven't already, run \`npx @syntalic/mcp-server@latest --export-keys\` in your ` +
        `terminal to back up your private keys — losing ~/.syntalic/wallet.json without a backup ` +
        `means losing any funds you add.`,
    );
    this.name = "PaymentError";
  }
}

/** What is known about a payment whose outcome is not. */
export interface UnclearPayment {
  /** The chain it went out on: a CAIP-2 id, or tempo:4217. */
  network: string;
  /** The address that signed it. */
  payer: string;
  /** What was seen instead of an answer. */
  reason: string;
  /** The HTTP status of the answer, when there was one. */
  status?: number;
  /** True when the API's settlement response said the payment settled. */
  settled?: boolean;
  /** The chain transaction, from the settlement response. */
  transaction?: string;
  /** A settlement or receipt header that could not be decoded, as sent (cut to 200 characters). */
  receipt?: string;
  /** The API's X-Request-Id, for support. */
  requestId?: string;
  /** What happened on the chains tried before this one; none of them paid. */
  attempts: ReadonlyArray<{ network: string; reason: string }>;
}

/**
 * A payment went out and what came back does not say whether it settled, or says it settled with no
 * answer to show for it. No other chain is tried: that would sign a new authorization with its own
 * nonce, and if the first one settled the user would pay twice for one answer (SYNLBS-272).
 */
export class PaymentOutcomeUnknownError extends Error {
  constructor(public readonly payment: UnclearPayment) {
    const known = [
      `chain ${payment.network}`,
      `payer ${payment.payer}`,
      payment.status !== undefined ? `HTTP ${payment.status}` : undefined,
      payment.transaction ? `transaction ${payment.transaction}` : undefined,
      payment.receipt ? `receipt ${payment.receipt}` : undefined,
      payment.requestId ? `request id ${payment.requestId}` : undefined,
    ].filter(Boolean);
    super(
      (payment.settled
        ? `The payment on ${payment.network} settled, but the answer could not be read (${payment.reason}). `
        : `The payment on ${payment.network} may have settled; its outcome is unknown (${payment.reason}). `) +
        `No other chain was tried, so this call cannot have been paid twice. Known: ${known.join(", ")}. ` +
        `Check the payer's balance or the transaction before calling again.`,
    );
    this.name = "PaymentOutcomeUnknownError";
  }
}

/** What an answer to a paid request says about its payment: the x402 settlement header (decoded, or
 *  as sent when it does not decode), MPP's receipt, and the request id. */
function paymentEvidence(response: Response): Pick<UnclearPayment, "status" | "settled" | "transaction" | "receipt" | "requestId"> & {
  payer?: string;
} {
  const out: ReturnType<typeof paymentEvidence> = { status: response.status };
  const raw = response.headers.get("payment-response") ?? response.headers.get("x-payment-response");
  if (raw) {
    try {
      const settle = decodePaymentResponseHeader(raw);
      if (settle.success === true) out.settled = true;
      if (settle.transaction) out.transaction = settle.transaction;
      if (settle.payer) out.payer = settle.payer;
    } catch {
      out.receipt = raw.slice(0, 200);
    }
  }
  const mppReceipt = response.headers.get("payment-receipt");
  if (mppReceipt && !out.receipt) out.receipt = mppReceipt.slice(0, 200);
  const requestId = response.headers.get("x-request-id");
  if (requestId) out.requestId = requestId;
  return out;
}

function sanitizeReason(err: unknown, ...secrets: string[]): string {
  let msg = err instanceof Error ? err.message : String(err);
  for (const s of secrets) {
    if (s && msg.includes(s)) msg = msg.split(s).join("[redacted]");
  }
  msg = msg.replace(/0x[0-9a-fA-F]{32,}/g, "[redacted]");
  return msg.length > 200 ? msg.slice(0, 200) + "…" : msg;
}

/**
 * RPC URLs will receive POSTs containing the user's wallet address. Rejecting non-HTTPS
 * plus non-loopback hosts prevents an attacker with env-write access from exfiltrating
 * addresses or spoofing balances via a hostile local service (cf. SSRF to 169.254.169.254).
 */
export function resolveRpcUrl(name: string, envValue: string | undefined, fallback: string): string {
  const raw = envValue?.trim();
  if (!raw) return fallback;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    console.error(`[syntalic-mcp] ${name} is not a valid URL (${raw}); using default.`);
    return fallback;
  }
  const host = parsed.hostname.toLowerCase();
  const isLoopback = host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (parsed.protocol !== "https:" && !isLoopback) {
    console.error(
      `[syntalic-mcp] ${name} must use https:// (got ${parsed.protocol}//${host}); using default.`,
    );
    return fallback;
  }
  return raw;
}

async function extractSettleFailure(response: Response): Promise<SettleResponse | undefined> {
  const headerName = response.headers.has("x-payment-response")
    ? "x-payment-response"
    : response.headers.has("payment-response")
      ? "payment-response"
      : null;

  if (headerName) {
    const raw = response.headers.get(headerName);
    if (raw) {
      try {
        return decodePaymentResponseHeader(raw);
      } catch {
        // fall through to body parsing
      }
    }
  }

  try {
    const cloned = response.clone();
    const body = (await cloned.json()) as unknown;
    if (body && typeof body === "object") {
      const maybe = body as Record<string, unknown>;
      if (typeof maybe.errorReason === "string" || maybe.success === false) {
        return maybe as unknown as SettleResponse;
      }
      // Only treat a nested error object as a settle failure when it
      // actually carries a settle reason. The API's RFC 9457 bodies nest
      // an application error ({code, message}) here — casting that to a
      // SettleResponse is what turned paid 404 NO_RESULTS into the
      // misleading "payment rejected: unknown".
      if (maybe.error && typeof maybe.error === "object") {
        const inner = maybe.error as Record<string, unknown>;
        if (typeof inner.errorReason === "string" || inner.success === false) {
          return inner as unknown as SettleResponse;
        }
      }
    }
  } catch {
    // body may be empty or non-JSON
  }

  return undefined;
}

/** An application-level error response (RFC 9457 problem+json, or a body
 *  carrying an API error code without any settle reason) means the payment
 *  SETTLED and the API answered — e.g. 404 NO_RESULTS for a product the
 *  catalog genuinely lacks. Surface it as the API's answer instead of
 *  misreporting it as a payment failure. */
export async function isApplicationErrorResponse(response: Response): Promise<boolean> {
  // 402 Payment Required is the x402 challenge, not an application answer.
  // Treating problem+json 402 as "the API answered" leaked the raw 402 body
  // to MCP tools (classify/reverse, 2026-08-14).
  if (response.status === 402) return false;
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/problem+json")) return true;
  try {
    const body = (await response.clone().json()) as unknown;
    if (body && typeof body === "object") {
      const maybe = body as Record<string, unknown>;
      if (typeof maybe.errorReason === "string" || maybe.success === false) return false;
      if (maybe.error && typeof maybe.error === "object") {
        const inner = maybe.error as Record<string, unknown>;
        if (typeof inner.errorReason === "string") return false;
        if (typeof inner.code === "string") return true;
      }
    }
  } catch {
    // empty or non-JSON body — not an application error envelope
  }
  return false;
}

/** A settle failure decided at verify, before anything was sent: the next chain may be tried. */
export function isInsufficientBalance(
  network: string,
  failure: Pick<SettleResponse, "errorReason"> | undefined,
): boolean {
  if (!failure) return false;
  const reason = failure.errorReason;
  if (!reason) return false;
  if (INSUFFICIENT_BALANCE_REASONS.has(reason)) return true;
  if (network === SOLANA_NETWORK_ID && AMBIGUOUS_SOLANA_FAILURE_REASONS.has(reason)) {
    return true;
  }
  return false;
}

/** A settle failure the facilitator also reports after the transaction went out. */
export function mayHaveBeenSent(network: string, failure: Pick<SettleResponse, "errorReason"> | undefined): boolean {
  return network === SOLANA_NETWORK_ID && MAYBE_SENT_SOLANA_FAILURE_REASONS.has(failure?.errorReason ?? "");
}

function readRequiredAtomicAmount(req: PaymentRequirements): bigint | null {
  const candidates = [
    (req as unknown as { amount?: unknown }).amount,
    (req as unknown as { maxAmountRequired?: unknown }).maxAmountRequired,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && /^\d+$/.test(c)) return BigInt(c);
    if (typeof c === "number" && Number.isInteger(c) && c >= 0) return BigInt(c);
  }
  return null;
}

type TempoChargeChallenge = { amountAtomic: bigint; currency: string };

function findTempoChargeChallenge(
  response: Response,
): { ok: true; value: TempoChargeChallenge | null } | { ok: false; error: string } {
  let challenges: ReturnType<typeof Challenge.fromResponseList>;
  try {
    challenges = Challenge.fromResponseList(response);
  } catch (err) {
    // Surface the parse error rather than silently hiding the Tempo path —
    // a malformed WWW-Authenticate header from the server or a mppx version
    // mismatch would otherwise look like "Tempo doesn't work."
    return { ok: false, error: sanitizeReason(err) };
  }
  for (const c of challenges) {
    if (c.method !== "tempo" || c.intent !== "charge") continue;
    const req = c.request as Record<string, unknown>;
    const amt = req.amount;
    const cur = req.currency;
    if (typeof amt !== "string" || !/^\d+$/.test(amt)) continue;
    if (typeof cur !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(cur)) continue;
    return { ok: true, value: { amountAtomic: BigInt(amt), currency: cur } };
  }
  return { ok: true, value: null };
}

async function extractTempoFailureReason(response: Response): Promise<string> {
  try {
    const body = (await response.clone().json()) as unknown;
    if (body && typeof body === "object") {
      const r = body as Record<string, unknown>;
      if (typeof r.errorReason === "string") return r.errorReason;
      if (typeof r.error === "string") return r.error;
      if (r.error && typeof r.error === "object") {
        const inner = r.error as Record<string, unknown>;
        if (typeof inner.code === "string") return inner.code;
        if (typeof inner.message === "string") return inner.message;
      }
    }
  } catch {
    // fall through to generic
  }
  return `HTTP ${response.status}`;
}

export async function createPaidFetch(config: FetchConfig): Promise<PaidFetchResult> {
  let evmAccount: ReturnType<typeof privateKeyToAccount>;
  try {
    evmAccount = privateKeyToAccount(config.evmPrivateKey as `0x${string}`);
  } catch (err) {
    throw new Error(
      `EVM private key is malformed (${sanitizeReason(err, config.evmPrivateKey)}). ` +
        `Delete ~/.syntalic/wallet.json and re-run \`npx @syntalic/mcp-server --setup\`, ` +
        `or set SYNTALIC_EVM_PRIVATE_KEY to a valid 0x-prefixed key.`,
    );
  }

  let signer: Awaited<ReturnType<typeof createKeyPairSignerFromBytes>>;
  try {
    const { base58 } = await import("@scure/base");
    const secretBytes = base58.decode(config.solanaPrivateKey);
    signer = await createKeyPairSignerFromBytes(secretBytes);
  } catch (err) {
    throw new Error(
      `Solana private key is malformed (${sanitizeReason(err, config.solanaPrivateKey)}). ` +
        `Delete ~/.syntalic/wallet.json and re-run \`npx @syntalic/mcp-server --setup\`, ` +
        `or set SYNTALIC_SOLANA_PRIVATE_KEY to a valid base58 key.`,
    );
  }

  const solanaRpcVar = readEnv("SOLANA_RPC_URL");
  const solanaRpcUrl = resolveRpcUrl(
    solanaRpcVar.name,
    solanaRpcVar.value,
    DEFAULT_SOLANA_RPC_URL,
  );
  const client = new x402Client();
  client.register(BASE_NETWORK_ID, new ExactEvmScheme(evmAccount));
  // Registered directly rather than through registerExactSvmScheme, which takes no RPC URL: building
  // a Solana payment reads the mint over RPC, and without this it always used the public mainnet
  // RPC, so SYNTALIC_SOLANA_RPC_URL covered the balance check but not the payment itself.
  client.register(SOLANA_NETWORK_ID, new ExactSvmScheme(signer, { rpcUrl: solanaRpcUrl }));
  const httpClient = new x402HTTPClient(client);

  // polyfill: false — we call mppx only as a credential factory for Tempo receipts,
  // never as a fetch wrapper, so the x402 loop stays in control of the 402 dance.
  const mppx = Mppx.create({
    methods: [tempo({ account: evmAccount })],
    polyfill: false,
  });

  const tempoRpcVar = readEnv("TEMPO_RPC_URL");
  const tempoRpcUrl = resolveRpcUrl(
    tempoRpcVar.name,
    tempoRpcVar.value,
    DEFAULT_TEMPO_RPC_URL,
  );
  const pinVar = readEnv("PAYMENT_NETWORK");
  const pin = parsePaymentNetwork(pinVar.name, pinVar.value);
  const skipReason = `skipped (${pinVar.name}=${pin})`;
  // Off by default: one stderr line per paid call, naming the chain that settled, the payer and
  // the transaction, which is what a "did this call debit the wallet I think it did" check needs.
  const trace = /^(1|true|yes)$/i.test(readEnv("PAYMENT_TRACE").value?.trim() ?? "");
  const solanaAddress = signer.address;
  const evmAddress = evmAccount.address;

  function traceSettled(url: string, network: string, response: Response): void {
    if (!trace) return;
    const path = new URL(url).pathname;
    let detail = "";
    const raw = response.headers.get("payment-response") ?? response.headers.get("x-payment-response");
    if (raw) {
      try {
        const settle = decodePaymentResponseHeader(raw);
        detail = ` payer=${settle.payer ?? "?"} tx=${settle.transaction || "?"}`;
        if (settle.amount) detail += ` amount=${settle.amount}`;
      } catch {
        detail = " (unreadable payment-response header)";
      }
    } else if (network === TEMPO_LABEL) {
      detail = ` payer=${evmAddress}`;
    } else {
      detail = " (no payment-response header)";
    }
    console.error(`[syntalic-mcp] paid ${path} via ${network}${detail}`);
  }

  type BalanceCheck =
    | { eligible: true; checked: true }
    | { eligible: false; checked: true }
    | { eligible: true; checked: false; error: string };

  async function solanaBalanceCheck(req: PaymentRequirements): Promise<BalanceCheck> {
    const required = readRequiredAtomicAmount(req);
    const mintStr = (req as unknown as { asset?: unknown }).asset;
    if (required === null || typeof mintStr !== "string" || mintStr.length === 0) {
      return { eligible: true, checked: false, error: "missing amount/asset" };
    }
    try {
      const ownerAddr = asSolanaAddress(solanaAddress);
      const mintAddr = asSolanaAddress(mintStr);
      const ata = await deriveAssociatedTokenAccount(ownerAddr, mintAddr);
      const balance = await getTokenAccountBalance(solanaRpcUrl, ata);
      return { eligible: balance >= required, checked: true };
    } catch (err) {
      return { eligible: true, checked: false, error: sanitizeReason(err) };
    }
  }

  async function tempoBalanceCheck(
    amountAtomic: bigint,
    currency: string,
  ): Promise<BalanceCheck> {
    try {
      const balance = await getErc20Balance(tempoRpcUrl, currency, evmAddress);
      return { eligible: balance >= amountAtomic, checked: true };
    } catch (err) {
      return { eligible: true, checked: false, error: sanitizeReason(err) };
    }
  }

  /**
   * Runs one x402 payment attempt for a single requirement. Signing/encoding errors
   * are allowed to throw (those are library or config bugs that shouldn't silently
   * look like a network failure on this chain); only the network fetch is wrapped.
   */
  async function attemptX402Payment(
    req: PaymentRequirements,
    required: PaymentRequired,
    originalRequest: Request,
    baseFetch: typeof globalThis.fetch,
  ): Promise<{ response: Response; failure?: SettleResponse; networkError?: string; neverSent?: boolean }> {
    const single: PaymentRequired = { ...required, accepts: [req] };
    const payload = await client.createPaymentPayload(single);
    const headers = httpClient.encodePaymentSignatureHeader(payload);
    const retryReq = originalRequest.clone();
    for (const [k, v] of Object.entries(headers)) {
      retryReq.headers.set(k, v);
    }
    retryReq.headers.set(
      "Access-Control-Expose-Headers",
      "PAYMENT-RESPONSE,X-PAYMENT-RESPONSE",
    );
    let response: Response;
    try {
      response = await baseFetch(retryReq);
    } catch (err) {
      return {
        response: new Response(null, { status: 599 }),
        networkError: sanitizeReason(err),
        neverSent: failedBeforeSending(err),
      };
    }
    if (response.ok) return { response };
    const failure = await extractSettleFailure(response);
    return { response, failure };
  }

  /** The request again, carrying a signed MPP credential for Tempo. Nothing is sent here. */
  async function tempoRequest(firstResponse: Response, originalRequest: Request): Promise<Request> {
    const credential = await mppx.createCredential(firstResponse.clone());
    const retryReq = originalRequest.clone();
    retryReq.headers.set("Authorization", credential);
    return retryReq;
  }

  const baseFetch: typeof globalThis.fetch = globalThis.fetch.bind(globalThis);

  const paidFetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    request.headers.set("X-Syntalic-Client", "mcp");
    const savedRequest = request.clone();
    const firstResponse = await baseFetch(request);
    if (firstResponse.status !== 402) return firstResponse;

    let paymentRequired: PaymentRequired;
    try {
      const getHeader = (name: string) => firstResponse.headers.get(name);
      let body: unknown;
      try {
        const text = await firstResponse.clone().text();
        if (text) body = JSON.parse(text);
      } catch {
        // empty or non-JSON body — header path handles it
      }
      paymentRequired = httpClient.getPaymentRequiredResponse(getHeader, body);
    } catch (err) {
      const contentType = firstResponse.headers.get("content-type") ?? "unknown";
      throw new Error(
        `Failed to parse payment requirements from server ` +
          `(HTTP ${firstResponse.status}, content-type: ${contentType}): ${sanitizeReason(err)}`,
      );
    }

    const attempts: Array<{ network: string; reason: string }> = [];

    for (const req of paymentRequired.accepts) {
      const network = req.network;
      const label = labelOf(network);

      if (label === undefined) {
        attempts.push({ network, reason: "unsupported by client" });
        continue;
      }
      if (pin && label !== pin) {
        attempts.push({ network, reason: skipReason });
        continue;
      }

      if (label === "solana") {
        const check = await solanaBalanceCheck(req);
        if (check.checked && !check.eligible) {
          attempts.push({ network, reason: "insufficient balance (pre-check)" });
          continue;
        }
        if (!check.checked && pin !== "solana") {
          // Fail closed: a balance we could not read is not a balance we have. The public Solana
          // RPC rate-limits often, and attempting anyway surfaced as an opaque 429 on the tool
          // while Base or Tempo had the funds. Fall through to them instead. A Solana pin is the
          // user saying "pay on Solana", so it still attempts (below), with the reason on stderr.
          attempts.push({
            network,
            reason:
              `skipped: could not read the Solana balance (${check.error}). ` +
              `Set ${solanaRpcVar.name} to a dedicated RPC if your funds are on Solana.`,
          });
          continue;
        }
        if (!check.checked) {
          console.error(
            `[syntalic-mcp] Solana balance pre-check unavailable (${check.error}); attempting payment (${pinVar.name}=solana).`,
          );
        }
      }

      const { response, failure, networkError, neverSent } = await attemptX402Payment(
        req,
        paymentRequired,
        savedRequest,
        baseFetch,
      );

      if (response.ok) {
        traceSettled(savedRequest.url, network, response);
        return response;
      }

      // From here a signed payment for this chain may have reached the API. The next chain signs a
      // NEW authorization with its own nonce, so falling through is only safe when this one is known
      // not to have settled. Each case below says why it is, or stops (SYNLBS-272).
      const payer = label === "solana" ? solanaAddress : evmAddress;

      if (networkError) {
        // Safe only when the connection was never made: the payment never left this machine.
        if (neverSent) {
          attempts.push({ network, reason: `network error before the payment was sent: ${networkError}` });
          continue;
        }
        throw new PaymentOutcomeUnknownError({
          network,
          payer,
          reason: `the connection failed after the signed payment was sent: ${networkError}`,
          attempts,
        });
      }

      // Payment went through but the API answered with an application
      // error (e.g. 404 NO_RESULTS). Return it so the caller sees the real
      // problem body — retrying another chain would just pay again for the
      // same answer.
      if (await isApplicationErrorResponse(response)) {
        return response;
      }

      // Safe: refused at verify (the balance checks, Solana's simulation), before anything was sent.
      if (isInsufficientBalance(network, failure)) {
        attempts.push({
          network,
          reason: failure?.errorReason ?? "insufficient balance",
        });
        continue;
      }

      if (failure === undefined) {
        // Safe: a 402 is the API refusing the payment and asking again, which it does only when
        // nothing was captured (no matching requirement, verify refused, settle refused).
        if (response.status === 402) {
          attempts.push({ network, reason: "payment refused (HTTP 402, no settlement response): nothing was settled" });
          continue;
        }
        // Anything else with no settlement response (a gateway's 502/504, a 500 without the API's
        // error body) can come after the API settled the payment, as the API settles before it
        // answers. The next chain would pay a second time for one answer.
        const evidence = paymentEvidence(response);
        throw new PaymentOutcomeUnknownError({
          network,
          payer: evidence.payer ?? payer,
          ...evidence,
          reason: `HTTP ${response.status} with no readable settlement response`,
          attempts,
        });
      }

      // The settlement response says it settled, but the answer is an error with no API error body.
      // Known to be paid: never pay again on another chain, and say it was paid.
      if (failure.success === true) {
        const evidence = paymentEvidence(response);
        throw new PaymentOutcomeUnknownError({
          network,
          payer: evidence.payer ?? payer,
          ...evidence,
          settled: true,
          reason: `HTTP ${response.status} after the settlement`,
          attempts,
        });
      }

      if (mayHaveBeenSent(network, failure)) {
        const evidence = paymentEvidence(response);
        throw new PaymentOutcomeUnknownError({
          network,
          payer: failure.payer || evidence.payer || payer,
          ...evidence,
          settled: undefined,
          reason: `the facilitator answered ${failure.errorReason}, which it also answers when the transaction was sent and its confirmation timed out`,
          attempts,
        });
      }

      // Known, non-balance failure (signature/nonce/server error). Don't retry —
      // that could waste USDC if the chain state is genuinely broken — throw with
      // a clear reason so the user sees an actionable message in Claude Code.
      throw new PaymentError([
        ...attempts,
        {
          network,
          reason: `payment rejected: ${failure.errorReason ?? "unknown"}${
            failure.errorMessage ? ` — ${failure.errorMessage}` : ""
          }`,
        },
      ]);
    }

    const tempoResult = findTempoChargeChallenge(firstResponse);
    if (pin && pin !== "tempo") {
      if (tempoResult.ok && tempoResult.value) attempts.push({ network: TEMPO_LABEL, reason: skipReason });
    } else if (!tempoResult.ok) {
      attempts.push({
        network: TEMPO_LABEL,
        reason: `failed to parse tempo challenge: ${tempoResult.error}`,
      });
    } else if (tempoResult.value) {
      const { amountAtomic, currency } = tempoResult.value;
      const check = await tempoBalanceCheck(amountAtomic, currency);
      if (check.checked && !check.eligible) {
        attempts.push({
          network: TEMPO_LABEL,
          reason: "insufficient balance (pre-check)",
        });
      } else {
        if (!check.checked && check.error) {
          console.error(
            `[syntalic-mcp] Tempo balance pre-check unavailable (${check.error}); attempting payment.`,
          );
        }
        let retryReq: Request | undefined;
        try {
          retryReq = await tempoRequest(firstResponse, savedRequest);
        } catch (err) {
          attempts.push({
            network: TEMPO_LABEL,
            reason: `tempo credential failed: ${sanitizeReason(err)}`,
          });
        }
        if (retryReq) {
          let response: Response | undefined;
          try {
            response = await baseFetch(retryReq);
          } catch (err) {
            // Tempo is the last chain, so nothing would pay twice here; what matters is not telling
            // the user a payment failed when it may have gone through.
            if (!failedBeforeSending(err)) {
              throw new PaymentOutcomeUnknownError({
                network: TEMPO_LABEL,
                payer: evmAddress,
                reason: `the connection failed after the signed payment was sent: ${sanitizeReason(err)}`,
                attempts,
              });
            }
            attempts.push({
              network: TEMPO_LABEL,
              reason: `network error before the payment was sent: ${sanitizeReason(err)}`,
            });
          }
          if (response?.ok) {
            traceSettled(savedRequest.url, TEMPO_LABEL, response);
            return response;
          }
          if (response) {
            // MPP settles before the API answers: an application error was paid for, as on x402.
            if (await isApplicationErrorResponse(response)) return response;
            if (response.status !== 402) {
              const evidence = paymentEvidence(response);
              throw new PaymentOutcomeUnknownError({
                network: TEMPO_LABEL,
                payer: evmAddress,
                ...evidence,
                reason: `HTTP ${response.status} without the API's error body`,
                attempts,
              });
            }
            const reason = await extractTempoFailureReason(response);
            attempts.push({ network: TEMPO_LABEL, reason: `tempo payment failed: ${reason}` });
          }
        }
      }
    }

    throw new PaymentError(attempts);
  };

  return {
    fetch: paidFetch,
    evmAddress,
    solanaAddress,
  };
}
