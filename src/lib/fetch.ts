import { x402Client, x402HTTPClient, decodePaymentResponseHeader } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { registerExactSvmScheme } from "@x402/svm/exact/client";
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
const DEFAULT_SOLANA_RPC_URL = "https://api.mainnet-beta.solana.com";
const DEFAULT_TEMPO_RPC_URL = "https://rpc.tempo.xyz";
const TEMPO_LABEL = "tempo:4217";

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
  "transaction_failed",
]);

interface FetchConfig {
  evmPrivateKey: string;
  solanaPrivateKey: string;
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
        `If you haven't already, run \`npx @syntalic/mcp-server --export-keys\` in your ` +
        `terminal to back up your private keys — losing ~/.syntalic/wallet.json without a backup ` +
        `means losing any funds you add.`,
    );
    this.name = "PaymentError";
  }
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
function resolveRpcUrl(name: string, envValue: string | undefined, fallback: string): string {
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
      if (maybe.error && typeof maybe.error === "object") {
        return maybe.error as SettleResponse;
      }
    }
  } catch {
    // body may be empty or non-JSON
  }

  return undefined;
}

function isInsufficientBalance(
  network: string,
  failure: SettleResponse | undefined,
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

  const client = new x402Client();
  client.register(BASE_NETWORK_ID, new ExactEvmScheme(evmAccount));
  registerExactSvmScheme(client, { signer, networks: [SOLANA_NETWORK_ID] });
  const httpClient = new x402HTTPClient(client);

  // polyfill: false — we call mppx only as a credential factory for Tempo receipts,
  // never as a fetch wrapper, so the x402 loop stays in control of the 402 dance.
  const mppx = Mppx.create({
    methods: [tempo({ account: evmAccount })],
    polyfill: false,
  });

  const solanaRpcVar = readEnv("SOLANA_RPC_URL");
  const solanaRpcUrl = resolveRpcUrl(
    solanaRpcVar.name,
    solanaRpcVar.value,
    DEFAULT_SOLANA_RPC_URL,
  );
  const tempoRpcVar = readEnv("TEMPO_RPC_URL");
  const tempoRpcUrl = resolveRpcUrl(
    tempoRpcVar.name,
    tempoRpcVar.value,
    DEFAULT_TEMPO_RPC_URL,
  );
  const solanaAddress = signer.address;
  const evmAddress = evmAccount.address;

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
  ): Promise<{ response: Response; failure?: SettleResponse; networkError?: string }> {
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
      };
    }
    if (response.ok) return { response };
    const failure = await extractSettleFailure(response);
    return { response, failure };
  }

  async function attemptTempoPayment(
    firstResponse: Response,
    originalRequest: Request,
    baseFetch: typeof globalThis.fetch,
  ): Promise<Response> {
    const credential = await mppx.createCredential(firstResponse.clone());
    const retryReq = originalRequest.clone();
    retryReq.headers.set("Authorization", credential);
    return baseFetch(retryReq);
  }

  const baseFetch: typeof globalThis.fetch = globalThis.fetch.bind(globalThis);

  const paidFetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
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

      if (network === SOLANA_NETWORK_ID) {
        const check = await solanaBalanceCheck(req);
        if (check.checked && !check.eligible) {
          attempts.push({ network, reason: "insufficient balance (pre-check)" });
          continue;
        }
        if (!check.checked && check.error) {
          // Proceed with the attempt; record so the final error message
          // surfaces a misconfigured RPC if every chain ends up failing.
          console.error(
            `[syntalic-mcp] Solana balance pre-check unavailable (${check.error}); attempting payment.`,
          );
        }
      } else if (network !== BASE_NETWORK_ID) {
        attempts.push({ network, reason: "unsupported by client" });
        continue;
      }

      const { response, failure, networkError } = await attemptX402Payment(
        req,
        paymentRequired,
        savedRequest,
        baseFetch,
      );

      if (response.ok) return response;

      if (networkError) {
        attempts.push({ network, reason: `network error: ${networkError}` });
        continue;
      }

      if (isInsufficientBalance(network, failure)) {
        attempts.push({
          network,
          reason: failure?.errorReason ?? "insufficient balance",
        });
        continue;
      }

      if (failure === undefined) {
        // Ambiguous response (unparseable settle body) — don't surface, the next
        // chain might succeed. x402/MPP both use nonce-style replay protection,
        // so an already-settled payment won't double-charge.
        attempts.push({
          network,
          reason: `unparseable settlement response (HTTP ${response.status})`,
        });
        continue;
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
    if (!tempoResult.ok) {
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
        try {
          const response = await attemptTempoPayment(firstResponse, savedRequest, baseFetch);
          if (response.ok) return response;
          const reason = await extractTempoFailureReason(response);
          attempts.push({ network: TEMPO_LABEL, reason: `tempo payment failed: ${reason}` });
        } catch (err) {
          attempts.push({
            network: TEMPO_LABEL,
            reason: `tempo credential failed: ${sanitizeReason(err)}`,
          });
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
