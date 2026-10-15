// Payment routing over a stubbed network: which chain is tried, which is skipped and why.
// The API, the Solana RPC and the Tempo RPC are all answered by one fetch stub, so nothing here
// leaves the process and no key here holds funds.
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { generatePrivateKey } from "viem/accounts";
import { base58 } from "@scure/base";
import { createPaidFetch, parsePaymentNetwork, PaymentError } from "./fetch.js";

const API = "https://api.test/v1/ontology/resolve?term=x";
const SOLANA_RPC = "https://api.mainnet-beta.solana.com";
const TEMPO_RPC = "https://rpc.tempo.xyz";
const CUSTOM_SOLANA_RPC = "https://solana-rpc.example";
const SOLANA = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const BASE = "eip155:8453";

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");
const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

// The shape of the API's real 402 (captured from api.syntalic.com on 2026-10-14).
const PAYMENT_REQUIRED = {
  x402Version: 2,
  resource: { url: API, description: "Ontology lookup - $0.01 per request" },
  accepts: [
    {
      scheme: "exact",
      network: SOLANA,
      amount: "10000",
      asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      payTo: "2hYY7wHhXsoWnskQRzYFUNH7YboXNMEqbGnAFHpRuB2W",
      maxTimeoutSeconds: 60,
      extra: { feePayer: "CjNFTjvBhbJJd2B5ePPMHRLx1ELZpa8dwQgGL727eKww" },
    },
    {
      scheme: "exact",
      network: BASE,
      amount: "10000",
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      payTo: "0xe2e662cF219025AFC0C9Bf850b6a2B0a0b5517fe",
      maxTimeoutSeconds: 300,
      extra: { name: "USD Coin", version: "2" },
    },
  ],
};
const TEMPO_REQUEST = {
  amount: "10000",
  currency: "0x20c000000000000000000000b9537d11c60e8b50",
  methodDetails: { chainId: 4217 },
  recipient: "0xe2e662cF219025AFC0C9Bf850b6a2B0a0b5517fe",
};

function challenge(): Response {
  const expires = new Date(Date.now() + 60_000).toISOString();
  return new Response(JSON.stringify({ status: 402 }), {
    status: 402,
    headers: {
      "content-type": "application/problem+json",
      "payment-required": b64(PAYMENT_REQUIRED),
      "www-authenticate": `Payment id="test", realm="api.test", method="tempo", intent="charge", request="${b64url(TEMPO_REQUEST)}", expires="${expires}"`,
    },
  });
}

async function solanaKey(): Promise<string> {
  const key = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const priv = new Uint8Array(await crypto.subtle.exportKey("pkcs8", key.privateKey));
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", key.publicKey));
  const bytes = new Uint8Array(64);
  bytes.set(priv.slice(priv.length - 32), 0);
  bytes.set(pub, 32);
  return base58.encode(bytes);
}

interface Scenario {
  /** What the Solana RPC answers: a balance, or an HTTP status for a failure. */
  solana: { balance: bigint } | { status: number };
  /** What the API answers a Base payment with. */
  base: "settles" | "insufficient";
}
interface Log {
  paidWith: string[]; // network of every paid retry the API saw
  rpc: string[]; // every RPC host hit
}

const realFetch = globalThis.fetch;
const realError = console.error;
afterEach(() => {
  globalThis.fetch = realFetch;
  console.error = realError;
  delete process.env.SYNTALIC_PAYMENT_NETWORK;
  delete process.env.SYNTALIC_PAYMENT_TRACE;
  delete process.env.SYNTALIC_SOLANA_RPC_URL;
});

async function setup(s: Scenario): Promise<{ paidFetch: typeof fetch; log: Log }> {
  const log: Log = { paidWith: [], rpc: [] };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    if (req.url.startsWith(SOLANA_RPC) || req.url.startsWith(CUSTOM_SOLANA_RPC)) {
      const { method } = (await req.json()) as { method: string };
      log.rpc.push(`${new URL(req.url).host} ${method}`);
      if ("status" in s.solana) return new Response("rate limited", { status: s.solana.status });
      if (method === "getTokenAccountBalance") {
        return Response.json({ result: { value: { amount: s.solana.balance.toString(), decimals: 6 } } });
      }
      // Building the Solana payment reads the mint; refusing it stops the attempt at that point.
      return Response.json({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "stub" } });
    }
    if (req.url.startsWith(TEMPO_RPC)) {
      log.rpc.push("tempo");
      return Response.json({ jsonrpc: "2.0", id: 1, result: "0x0" }); // nothing on Tempo
    }
    const sig = req.headers.get("payment-signature");
    if (!sig) return challenge();
    const network = (JSON.parse(Buffer.from(sig, "base64").toString()) as { accepted?: { network?: string } })
      .accepted?.network ?? "unknown";
    log.paidWith.push(network);
    if (network === BASE && s.base === "settles") {
      return Response.json(
        { ok: true },
        { headers: { "payment-response": b64({ success: true, transaction: "0xfeed", network: BASE, payer: "0xpayer" }) } },
      );
    }
    return Response.json(
      { x402Version: 2 },
      {
        status: 402,
        headers: {
          "payment-response": b64({
            success: false,
            errorReason: "invalid_exact_evm_insufficient_balance",
            transaction: "",
            network,
          }),
        },
      },
    );
  }) as typeof fetch;
  const { fetch: paidFetch } = await createPaidFetch({
    evmPrivateKey: generatePrivateKey(),
    solanaPrivateKey: await solanaKey(),
  });
  return { paidFetch, log };
}

async function paymentError(p: Promise<unknown>): Promise<PaymentError> {
  try {
    await p;
  } catch (err) {
    assert.ok(err instanceof PaymentError, `expected a PaymentError, got ${String(err)}`);
    return err;
  }
  assert.fail("expected the payment to fail");
}

describe("payment routing", () => {
  it("skips Solana when its balance cannot be read, and pays on Base", async () => {
    console.error = () => {};
    const { paidFetch, log } = await setup({ solana: { status: 429 }, base: "settles" });
    const res = await paidFetch(API);
    assert.equal(res.status, 200);
    assert.deepEqual(log.paidWith, [BASE], "no Solana payment may be attempted on an unread balance");
  });

  it("names the unread Solana balance in the error when every chain fails", async () => {
    console.error = () => {};
    const { paidFetch } = await setup({ solana: { status: 429 }, base: "insufficient" });
    const err = await paymentError(paidFetch(API));
    const solana = err.attempts.find((a) => a.network === SOLANA);
    assert.match(solana?.reason ?? "", /could not read the Solana balance \(RPC HTTP 429\)/);
    assert.match(solana?.reason ?? "", /SYNTALIC_SOLANA_RPC_URL/);
    assert.deepEqual(
      err.attempts.map((a) => a.network),
      [SOLANA, BASE, "tempo:4217"],
    );
  });

  it("still goes to Solana first when its balance reads enough", async () => {
    console.error = () => {};
    const { paidFetch, log } = await setup({ solana: { balance: 50_000_000n }, base: "settles" });
    await paidFetch(API).catch(() => undefined);
    // the balance check, then the payment build (stopped by the stub), all before Base
    assert.deepEqual(log.rpc.slice(0, 2), ["api.mainnet-beta.solana.com getTokenAccountBalance", "api.mainnet-beta.solana.com getAccountInfo"]);
  });

  it("builds the Solana payment on SYNTALIC_SOLANA_RPC_URL, not the public RPC", async () => {
    process.env.SYNTALIC_SOLANA_RPC_URL = CUSTOM_SOLANA_RPC;
    console.error = () => {};
    const { paidFetch, log } = await setup({ solana: { balance: 50_000_000n }, base: "settles" });
    await paidFetch(API).catch(() => undefined);
    assert.ok(log.rpc.length >= 2, `expected a balance check and a payment build, saw ${log.rpc.join(", ")}`);
    assert.deepEqual(
      log.rpc.filter((r) => !r.startsWith("solana-rpc.example ")),
      [],
      "every Solana RPC call goes to the configured RPC",
    );
  });

  it("pinned to base, touches no other chain", async () => {
    process.env.SYNTALIC_PAYMENT_NETWORK = "base";
    const { paidFetch, log } = await setup({ solana: { balance: 50_000_000n }, base: "settles" });
    const res = await paidFetch(API);
    assert.equal(res.status, 200);
    assert.deepEqual(log.paidWith, [BASE]);
    assert.deepEqual(log.rpc, [], "a pinned payment reads no other chain's balance");
  });

  it("pinned to tempo, names Solana and Base as skipped", async () => {
    process.env.SYNTALIC_PAYMENT_NETWORK = "Tempo";
    const { paidFetch, log } = await setup({ solana: { balance: 50_000_000n }, base: "settles" });
    const err = await paymentError(paidFetch(API));
    assert.deepEqual(log.paidWith, []);
    assert.deepEqual(err.attempts, [
      { network: SOLANA, reason: "skipped (SYNTALIC_PAYMENT_NETWORK=tempo)" },
      { network: BASE, reason: "skipped (SYNTALIC_PAYMENT_NETWORK=tempo)" },
      { network: "tempo:4217", reason: "insufficient balance (pre-check)" },
    ]);
  });

  it("refuses an unknown pin at startup", async () => {
    process.env.SYNTALIC_PAYMENT_NETWORK = "ethereum";
    await assert.rejects(setup({ solana: { balance: 0n }, base: "settles" }), /SYNTALIC_PAYMENT_NETWORK must be one of solana, base, tempo/);
  });

  it("traces the chain, payer and transaction that settled", async () => {
    process.env.SYNTALIC_PAYMENT_TRACE = "1";
    process.env.SYNTALIC_PAYMENT_NETWORK = "base";
    const lines: string[] = [];
    console.error = (...a: unknown[]) => void lines.push(a.join(" "));
    const { paidFetch } = await setup({ solana: { balance: 0n }, base: "settles" });
    await paidFetch(API);
    assert.deepEqual(lines, [`[syntalic-mcp] paid /v1/ontology/resolve via ${BASE} payer=0xpayer tx=0xfeed`]);
  });
});

describe("parsePaymentNetwork", () => {
  it("reads the three chains in any case and treats empty as unset", () => {
    assert.equal(parsePaymentNetwork("X", " SOLANA "), "solana");
    assert.equal(parsePaymentNetwork("X", "base"), "base");
    assert.equal(parsePaymentNetwork("X", ""), undefined);
    assert.equal(parsePaymentNetwork("X", undefined), undefined);
    assert.throws(() => parsePaymentNetwork("X", "eth"), /X must be one of/);
  });
});
