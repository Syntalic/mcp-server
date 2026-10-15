import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { BASE_USDC, formatBalances, formatUnits, readBalances, TEMPO_USDC_E } from "./balances.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("balances", () => {
  it("formats atomic USDC with six decimals", () => {
    assert.equal(formatUnits(0n), "0.000000");
    assert.equal(formatUnits(10_000n), "0.010000");
    assert.equal(formatUnits(49_990_000n), "49.990000");
  });

  it("knows a well-formed token address on each EVM chain", () => {
    assert.match(BASE_USDC, /^0x[0-9a-fA-F]{40}$/);
    assert.match(TEMPO_USDC_E, /^0x[0-9a-fA-F]{40}$/);
  });

  it("reads each chain, and says unavailable rather than zero when an RPC fails", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      const host = new URL(req.url).host;
      if (host === "api.mainnet-beta.solana.com") {
        return Response.json({ result: { value: { amount: "12345678", decimals: 6 } } });
      }
      if (host === "mainnet.base.org") return Response.json({ jsonrpc: "2.0", id: 1, result: "0x2710" });
      return new Response("busy", { status: 429 }); // Tempo
    }) as typeof fetch;
    const balances = await readBalances(
      "0x0000000000000000000000000000000000000001",
      "11111111111111111111111111111112",
    );
    assert.deepEqual(
      balances.map((b) => [b.chain, b.atomic]),
      [
        ["Solana", 12_345_678n],
        ["Base", 10_000n],
        ["Tempo", undefined],
      ],
    );
    const lines = formatBalances(balances);
    assert.match(lines[0]!, /Solana: +12\.345678 USDC/);
    assert.match(lines[1]!, /Base: +0\.010000 USDC/);
    assert.match(lines[2]!, /Tempo: +unavailable \(RPC HTTP 429\); this is not a zero balance/);
  });
});
