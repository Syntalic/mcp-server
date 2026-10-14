// social_series takes `brand` like its sibling tools (0.11.0 answered `brand=olipop` with a 400).
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { generatePrivateKey } from "viem/accounts";
import { base58 } from "@scure/base";
import { createServer } from "./server.js";

const realFetch = globalThis.fetch;
let seen: URL[] = [];
afterEach(() => {
  globalThis.fetch = realFetch;
  seen = [];
});

async function connect(): Promise<Client> {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push(new URL(new Request(input, init).url));
    return Response.json({ series: [] });
  }) as typeof fetch;
  const key = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const priv = new Uint8Array(await crypto.subtle.exportKey("pkcs8", key.privateKey));
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", key.publicKey));
  const bytes = new Uint8Array(64);
  bytes.set(priv.slice(priv.length - 32), 0);
  bytes.set(pub, 32);
  const server = await createServer({
    apiBase: "https://api.test",
    evmPrivateKey: generatePrivateKey(),
    solanaPrivateKey: base58.encode(bytes),
    backupAcknowledged: true,
  });
  const [c, s] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(s), client.connect(c)]);
  return client;
}

describe("social_series", () => {
  it("sends `brand` as the brand subject", async () => {
    const client = await connect();
    const r = await client.callTool({ name: "social_series", arguments: { category: "food-beverages-tobacco", brand: "olipop" } });
    assert.equal(r.isError, undefined);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.pathname, "/v1/social/series");
    assert.equal(seen[0]!.searchParams.get("subject"), "olipop");
    assert.equal(seen[0]!.searchParams.get("subject_kind"), "brand");
    assert.equal(seen[0]!.searchParams.has("brand"), false);
  });

  it("still takes subject and subject_kind as before", async () => {
    const client = await connect();
    await client.callTool({ name: "social_series", arguments: { category: "health-beauty", subject: "glossier" } });
    assert.equal(seen[0]!.searchParams.get("subject"), "glossier");
    assert.equal(seen[0]!.searchParams.has("subject_kind"), false);
  });

  it("refuses a brand and a different subject, or a brand on a category chart, without calling the API", async () => {
    const client = await connect();
    const both = await client.callTool({
      name: "social_series",
      arguments: { category: "health-beauty", brand: "a", subject: "b" },
    });
    const kind = await client.callTool({
      name: "social_series",
      arguments: { category: "health-beauty", brand: "a", subject_kind: "category" },
    });
    assert.equal(both.isError, true);
    assert.equal(kind.isError, true);
    assert.equal(seen.length, 0);
  });
});

describe("social tool descriptions", () => {
  it("do not claim a rollup is unpublished for every category", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    for (const t of tools) {
      assert.doesNotMatch(t.description ?? "", /returns 404 NOT_PUBLISHED for every category/, t.name);
      const category = (t.inputSchema.properties as Record<string, { description?: string }> | undefined)?.category;
      assert.doesNotMatch(category?.description ?? "", /'beauty'/, `${t.name}: 'beauty' is not a social category`);
    }
  });
});

describe("price_bands", () => {
  // The position-on-shelf playbook's step 4 calls price_bands "with the brand named"; on the MCP
  // the tool took the shelf only, so an agent following the playbook could not do that step.
  it("passes a brand, by name or by id, with the shelf", async () => {
    const client = await connect();
    await client.callTool({ name: "price_bands", arguments: { spt: "spt:el-1", brand_id: "brand:b_1" } });
    await client.callTool({ name: "price_bands", arguments: { node: "electronics/headphones", brand: "sony" } });
    assert.equal(seen[0]!.searchParams.get("brand_id"), "brand:b_1");
    assert.equal(seen[0]!.searchParams.get("spt"), "spt:el-1");
    assert.equal(seen[1]!.searchParams.get("brand"), "sony");
    assert.equal(seen[1]!.searchParams.get("node"), "electronics/headphones");
  });
});
