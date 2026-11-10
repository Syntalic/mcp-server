// The measure tools (SYNTALIC_TOOLS=measures): one paid tool per measure in place of one per route.
// Driven through a real client over an in-memory transport, against a stubbed fetch, so what is
// asserted is the tool list a client sees and the request that goes over the wire.
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { generatePrivateKey } from "viem/accounts";
import { base58 } from "@scure/base";
import { createServer } from "./server.js";
import { MEASURES } from "./measures.generated.js";
import { describeMeasure, parseId, translate } from "./measures.js";

const API_BASE = "https://api.test";
const FREE = ["wallet_info", "catalog_overview", "browse_categories", "list_retailers", "list_brands", "coverage_map"];
const measure = (name: string) => MEASURES.find((m) => m.name === name)!;

async function solanaKey(): Promise<string> {
  const key = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const priv = new Uint8Array(await crypto.subtle.exportKey("pkcs8", key.privateKey));
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", key.publicKey));
  const bytes = new Uint8Array(64);
  bytes.set(priv.slice(priv.length - 32), 0);
  bytes.set(pub, 32);
  return base58.encode(bytes);
}

let seen: URL[] = [];
const realFetch = globalThis.fetch;

async function connect(tools?: "routes" | "measures"): Promise<Client> {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push(new URL(new Request(input, init).url));
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const server = await createServer({
    apiBase: API_BASE,
    evmPrivateKey: generatePrivateKey(),
    solanaPrivateKey: await solanaKey(),
    backupAcknowledged: true,
    tools,
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const res = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: { type: string; text: string }[];
  };
  return { isError: res.isError === true, text: res.content[0]?.text ?? "" };
}

beforeEach(() => {
  seen = [];
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("the tool list", () => {
  it("is the per-route tools by default, with no measure among them", async () => {
    const names = (await (await connect()).listTools()).tools.map((t) => t.name);
    assert.equal(names.length, 40);
    for (const m of MEASURES) assert.ok(!names.includes(m.name), `${m.name} is listed by default`);
  });

  it("with measures on, is the free tools and one tool per measure", async () => {
    const names = (await (await connect("measures")).listTools()).tools.map((t) => t.name);
    assert.deepEqual(names.sort(), [...FREE, ...MEASURES.map((m) => m.name)].sort());
  });

  it("is at least 30% smaller, measured as the JSON a client is sent", async () => {
    // 49,387 characters for the per-route tools against 32,313 for the measures when this was written
    // (about 12.3k and 8.1k tokens at four characters each): 17 tools in place of 40, and 35% less to read.
    const size = async (mode?: "routes" | "measures") =>
      JSON.stringify((await (await connect(mode)).listTools()).tools).length;
    const [routes, measures] = [await size(), await size("measures")];
    assert.ok(measures < routes * 0.7, `measures ${measures} chars, routes ${routes} chars`);
  });

  it("states each measure's cost, and marks it as spending", async () => {
    const tools = (await (await connect("measures")).listTools()).tools;
    for (const m of MEASURES) {
      const tool = tools.find((t) => t.name === m.name)!;
      assert.match(tool.description ?? "", /Costs \$0\.0\d/, m.name);
      assert.equal(tool.annotations?.readOnlyHint, false, m.name);
      const props = Object.keys((tool.inputSchema.properties ?? {}) as object);
      assert.deepEqual(props.slice(0, 2), ["subject", "by"], m.name);
    }
    for (const name of FREE) assert.equal(tools.find((t) => t.name === name)!.annotations?.readOnlyHint, true, name);
  });

  it("tells the client about the measures in its instructions", async () => {
    assert.match((await connect("measures")).getInstructions() ?? "", /Every other tool is a\s+measure/);
    assert.match((await connect()).getInstructions() ?? "", /ontology_resolve/);
  });
});

describe("the measures reach every route the per-route tools call", () => {
  it("has a split for each paid path in server.ts", () => {
    const src = readFileSync(new URL("./server.ts", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    const called = [...src.matchAll(/query\(\s*"(\/v1\/[^"]+)"/g)].map((m) => m[1]!);
    assert.ok(called.length > 25, `only ${called.length} paid paths found`);
    const reached = new Set(MEASURES.flatMap((m) => m.splits.map((s) => s.route)));
    assert.deepEqual(called.filter((p) => !reached.has(p)), []);
  });
});

describe("a measure call goes to the route its split names", () => {
  it("sends an id subject as the route's id parameter", async () => {
    const client = await connect("measures");
    const res = await call(client, "prices", { subject: "spt:fb-2-17-2-4", by: "distribution", country: "ca" });
    assert.equal(res.isError, false);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.pathname, "/v1/analyst/price-dispersion");
    assert.equal(seen[0]!.search, "?country=ca&spt=spt%3Afb-2-17-2-4");
  });

  it("uses the default split, and sends a name as the route's name parameter", async () => {
    const client = await connect("measures");
    await call(client, "assortment", { subject: "electronics" });
    assert.equal(seen[0]!.pathname, "/v1/marketing/share-of-shelf");
    assert.equal(seen[0]!.searchParams.get("category"), "electronics");
  });

  it("sets what the split fixes", async () => {
    const client = await connect("measures");
    await call(client, "promotions", { subject: "grocery", by: "retailer" });
    assert.equal(seen[0]!.pathname, "/v1/marketing/promo-intelligence");
    assert.equal(seen[0]!.searchParams.get("aggregate_by"), "retailer");
  });

  it("repeats a list parameter, one value each", async () => {
    const client = await connect("measures");
    await call(client, "resolve", { term: ["olipop", "poppi"], kinds: "brand" });
    assert.equal(seen[0]!.pathname, "/v1/ontology/resolve");
    assert.deepEqual(seen[0]!.searchParams.getAll("term"), ["olipop", "poppi"]);
  });

  it("answers compactly: no indentation to pay tokens for", async () => {
    const client = await connect("measures");
    assert.equal((await call(client, "coverage", { subject: "gpc:10008059" })).text, '{"ok":true}');
  });

  it("refuses what it cannot place without calling the API", async () => {
    const client = await connect("measures");
    const res = await call(client, "trend", { subject: "apple" });
    assert.equal(res.isError, true);
    assert.match(res.text, /can be about product, shelf, brand/);
    assert.match(res.text, /Nothing was called or billed/);
    assert.equal(seen.length, 0);
  });
});

describe("translate", () => {
  const to = (name: string, args: Record<string, unknown>) => {
    const out = translate(measure(name), args);
    if (!out.ok) throw new Error(out.message);
    return { route: out.route, params: out.params };
  };
  const refused = (name: string, args: Record<string, unknown>) => {
    const out = translate(measure(name), args);
    if (out.ok) throw new Error(`translated to ${out.route}`);
    return out.message;
  };

  it("settles a shared by from the id's kind, or the route's own scope parameter", () => {
    assert.equal(to("trend", { subject: "entity:ent_1" }).route, "/v1/shopper/price-history");
    assert.equal(to("trend", { subject: "spt:fb-1" }).route, "/v1/analyst/inflation");
    assert.equal(to("trend", { subject: "brand:b_ac1a1c7143cb2199" }).route, "/v1/marketing/brand-tracker");
    assert.equal(to("trend", { brand: "Apple" }).route, "/v1/marketing/brand-tracker");
    assert.equal(to("trend", { q: "airpods" }).route, "/v1/shopper/price-history");
  });

  it("sends an entity id and a reference code as the bare value", () => {
    assert.deepEqual(to("offers", { subject: "entity:ent_123" }).params, { entity_uid: "ent_123" });
    assert.deepEqual(to("resolve", { by: "gpc_attributes", subject: "gpc:10000002" }).params, { gpc_code: "10000002" });
  });

  it("keeps the weekly series' own subject when subject_kind is sent", () => {
    assert.deepEqual(
      to("attention", { by: "week", subject_kind: "brand", subject: "olipop", category: "food-beverages-tobacco" }),
      {
        route: "/v1/social/series",
        params: { category: "food-beverages-tobacco", subject_kind: "brand", subject: "olipop" },
      },
    );
  });

  it("refuses an unknown by, a subject the split cannot take, and a subject beside its parameter", () => {
    assert.match(refused("prices", { by: "tier" }), /summary, distribution, band, brand, product, retailer/);
    assert.match(refused("prices", { by: "band", subject: "gpc:10008059" }), /does not take a gpc id/);
    assert.match(refused("prices", { subject: "spt:fb-1", spt: "spt:fb-2" }), /subject or spt, not both/);
    assert.match(refused("promotions", { by: "brand", subject: "grocery", aggregate_by: "retailer" }), /fixes aggregate_by=brand/);
  });

  it("reads an id the way the API does", () => {
    assert.deepEqual(parseId("gid://shopify/TaxonomyCategory/fb-2-17"), { kind: "spt", value: "fb-2-17" });
    assert.deepEqual(parseId("b_ac1a1c7143cb2199"), { kind: "brand", value: "b_ac1a1c7143cb2199" });
    assert.equal(parseId("protein bars"), null);
    assert.equal(parseId("gpc:123"), null);
  });

  it("names each split's route in the description, so a playbook's tool name can be found", () => {
    assert.match(describeMeasure(measure("prices")), /\[price-positioning, \$0\.01\]/);
    assert.match(describeMeasure(measure("scout")), /\[launch-buzz\]/);
  });
});
