// The ontology on the MCP surface: three free tools, the id parameters on the paid tools, the
// playbooks as prompts and resources, the annotations. Driven through a real client over an
// in-memory transport, against a stubbed fetch, so what is asserted is what a client sees and what
// goes over the wire.
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { generatePrivateKey } from "viem/accounts";
import { base58 } from "@scure/base";
import { createServer } from "./server.js";
import { PLAYBOOKS, RULES } from "./playbooks.generated.js";

const API_BASE = "https://api.test";
const ONTOLOGY_KEY = "free-key-0123456789";

async function solanaKey(): Promise<string> {
  const key = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const priv = new Uint8Array(await crypto.subtle.exportKey("pkcs8", key.privateKey));
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", key.publicKey));
  const bytes = new Uint8Array(64);
  bytes.set(priv.slice(priv.length - 32), 0);
  bytes.set(pub, 32);
  return base58.encode(bytes);
}

interface Seen {
  url: URL;
  headers: Record<string, string>;
}
let seen: Seen[] = [];
let reply: { status: number; body: unknown } = { status: 200, body: {} };
const realFetch = globalThis.fetch;

async function connect(apiKey: string | undefined): Promise<Client> {
  // the paid fetch wraps the global at creation, so the stub goes in first
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    seen.push({ url, headers });
    return new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const server = await createServer({
    apiBase: API_BASE,
    evmPrivateKey: generatePrivateKey(),
    solanaPrivateKey: await solanaKey(),
    apiKey,
    backupAcknowledged: true,
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
}

const text = (r: unknown): string => (r as { content: { text: string }[] }).content[0]!.text;

beforeEach(() => {
  seen = [];
  reply = { status: 200, body: {} };
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("the three ontology tools", () => {
  it("send a batch as repeated term=, with the key, and return compact JSON", async () => {
    reply = { status: 200, body: { results: [{ term: "a" }, { term: "b" }], schema_version: "ontology/1" } };
    const client = await connect(ONTOLOGY_KEY);
    const out = await client.callTool({
      name: "ontology_resolve",
      arguments: { terms: ["protein bars", "gerber, inc"], kinds: ["brand", "category"], within: "spt:bt-10-1", country: "ca" },
    });
    assert.equal(seen.length, 1);
    const { url, headers } = seen[0]!;
    assert.equal(url.pathname, "/v1/ontology/resolve");
    assert.deepEqual(url.searchParams.getAll("term"), ["protein bars", "gerber, inc"]);
    assert.equal(url.searchParams.get("kinds"), "brand,category");
    assert.equal(url.searchParams.get("within"), "spt:bt-10-1");
    assert.equal(url.searchParams.get("country"), "ca");
    assert.equal(headers["x-api-key"], ONTOLOGY_KEY);
    assert.equal(text(out), JSON.stringify(reply.body));
  });

  it("neighbors sends one id and the blocks; coverage sends ids as repeated id= and the retailer", async () => {
    const client = await connect(ONTOLOGY_KEY);
    await client.callTool({
      name: "ontology_neighbors",
      arguments: { id: "brand:b_1", relations: ["carried_at", "not_observed_at"], limit: 10 },
    });
    await client.callTool({
      name: "ontology_coverage",
      arguments: { ids: ["brand:b_1", "gpc:10008059"], retailer: "retailer:costco" },
    });
    const [n, c] = seen;
    assert.equal(n!.url.pathname, "/v1/ontology/neighbors");
    assert.deepEqual(n!.url.searchParams.getAll("id"), ["brand:b_1"]);
    assert.equal(n!.url.searchParams.get("relations"), "carried_at,not_observed_at");
    assert.equal(n!.url.searchParams.get("limit"), "10");
    assert.equal(c!.url.pathname, "/v1/ontology/coverage");
    assert.deepEqual(c!.url.searchParams.getAll("id"), ["brand:b_1", "gpc:10008059"]);
    assert.equal(c!.url.searchParams.get("retailer"), "retailer:costco");
  });

  it("without a key say how to get one, and make no request", async () => {
    const client = await connect(undefined);
    const out = (await client.callTool({ name: "ontology_resolve", arguments: { terms: ["quest"] } })) as { isError?: boolean };
    assert.equal(out.isError, true);
    assert.match(text(out), /SYNTALIC_API_KEY/);
    assert.equal(seen.length, 0);
  });

  it("turn the API's refusals into something a person can act on", async () => {
    const client = await connect(ONTOLOGY_KEY);
    reply = { status: 401, body: { error: { code: "API_KEY_REQUIRED", message: "An API key is required." } } };
    let out = await client.callTool({ name: "ontology_resolve", arguments: { terms: ["quest"] } });
    assert.match(text(out), /API_KEY_REQUIRED: An API key is required\./);
    assert.match(text(out), /SYNTALIC_API_KEY is a valid/);
    reply = { status: 503, body: { error: { code: "NOT_PUBLISHED", message: "not published" } } };
    out = await client.callTool({ name: "ontology_resolve", arguments: { terms: ["quest"] } });
    assert.match(text(out), /may not be published yet/);
    reply = { status: 400, body: { error: { code: "INVALID_PARAMS", message: "kinds has an unknown kind 'x'." } } };
    out = await client.callTool({ name: "ontology_resolve", arguments: { terms: ["quest"] } });
    assert.match(text(out), /INVALID_PARAMS: kinds has an unknown kind/);
  });

  it("bound a batch (a batch over the cap never leaves the client)", async () => {
    const client = await connect(ONTOLOGY_KEY);
    // the SDK reports an invalid argument as an error RESULT, not a protocol failure
    const out = (await client.callTool({
      name: "ontology_resolve",
      arguments: { terms: Array.from({ length: 26 }, (_, i) => `t${i}`) },
    })) as { isError?: boolean };
    assert.equal(out.isError, true);
    assert.match(text(out), /terms/);
    assert.equal(seen.length, 0);
  });
});

describe("the id parameters on the paid tools", () => {
  // The tools whose routes take a category, a brand or an entity, and the id parameters each must
  // expose (the API's ID_ROUTES, plus entity_uid on the shopper routes).
  const EXPECTED: Record<string, string[]> = {
    deal_finder: ["spt", "gpc"],
    competitive_landscape: ["spt", "gpc"],
    brand_tracker: ["brand_id"],
    promo_intelligence: ["spt", "gpc", "brand_id"],
    share_of_shelf: ["spt", "gpc"],
    price_positioning: ["spt", "gpc", "brand_id", "category"],
    brand_breakdown: ["brand_id"],
    retailer_assortment: ["spt", "gpc", "brand_id"],
    availability_index: ["spt", "gpc", "brand_id"],
    inflation_tracker: ["spt", "gpc"],
    price_dispersion: ["spt", "gpc"],
    price_bands: ["spt"],
    category_summary: ["spt", "gpc"],
    category_concentration: ["spt", "gpc"],
    price_change_leaders: ["spt", "gpc", "brand_id"],
    best_price: ["entity_uid"],
    price_history: ["entity_uid"],
  };

  it("are declared on exactly the tools that need them", async () => {
    const client = await connect(ONTOLOGY_KEY);
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, Object.keys((t.inputSchema.properties ?? {}) as object)]));
    for (const [name, params] of Object.entries(EXPECTED)) {
      const have = byName.get(name);
      assert.ok(have, `${name} is not registered`);
      for (const p of params) assert.ok(have.includes(p), `${name} has no ${p}`);
    }
    for (const [name, have] of byName) {
      if (name in EXPECTED) continue;
      for (const p of ["spt", "gpc", "brand_id", "entity_uid"]) assert.ok(!have.includes(p), `${name} unexpectedly takes ${p}`);
    }
  });

  it("send the id instead of the name, and nothing the caller did not give", async () => {
    const client = await connect(ONTOLOGY_KEY);
    await client.callTool({ name: "price_dispersion", arguments: { gpc: "gpc:10008059", country: "ca" } });
    await client.callTool({ name: "price_positioning", arguments: { brand_id: "brand:b_1", spt: "spt:bt-10-1" } });
    await client.callTool({ name: "best_price", arguments: { entity_uid: "e1" } });
    const [a, b, c] = seen.map((s) => s.url);
    assert.equal(a!.pathname, "/v1/analyst/price-dispersion");
    assert.equal(a!.searchParams.get("gpc"), "gpc:10008059");
    assert.equal(a!.searchParams.has("category"), false);
    assert.equal(b!.searchParams.get("brand_id"), "brand:b_1");
    assert.equal(b!.searchParams.get("spt"), "spt:bt-10-1");
    assert.equal(b!.searchParams.has("brand"), false);
    assert.equal(c!.searchParams.get("entity_uid"), "e1");
    assert.equal(c!.searchParams.has("q"), false);
  });

  it("still take a name, as before", async () => {
    const client = await connect(undefined);
    await client.callTool({ name: "share_of_shelf", arguments: { category: "protein bars", retailer: "amazon" } });
    const u = seen[0]!.url;
    assert.equal(u.searchParams.get("category"), "protein bars");
    assert.equal(u.searchParams.get("retailer"), "amazon");
    assert.equal(u.searchParams.has("spt"), false);
  });

  it("name every tool a suggested call can name (the API builds tool names from route slugs)", async () => {
    const client = await connect(ONTOLOGY_KEY);
    const names = new Set((await client.listTools()).tools.map((t) => t.name));
    for (const n of ["ontology_neighbors", "ontology_coverage", "price_dispersion", "promo_intelligence", "share_of_shelf", "price_positioning", "brand_breakdown", "best_price", "price_history"]) {
      assert.ok(names.has(n), `${n} is not a tool`);
    }
  });
});

describe("annotations", () => {
  it("a tool that costs money is not read-only or idempotent, and a free one is", async () => {
    const client = await connect(ONTOLOGY_KEY);
    const { tools } = await client.listTools();
    assert.ok(tools.length > 30, `only ${tools.length} tools`);
    for (const t of tools) {
      const paid = /Costs \$\d/.test(t.description ?? "");
      assert.ok(t.annotations, `${t.name} has no annotations`);
      assert.equal(t.annotations.readOnlyHint, !paid, `${t.name} readOnlyHint`);
      assert.equal(t.annotations.idempotentHint, !paid, `${t.name} idempotentHint`);
      assert.equal(t.annotations.destructiveHint, false, `${t.name} destructiveHint`);
    }
  });
});

describe("the playbooks and the rules", () => {
  it("are told to the client at connection", async () => {
    const client = await connect(ONTOLOGY_KEY);
    const instructions = client.getInstructions() ?? "";
    assert.match(instructions, /ontology_resolve/);
    assert.match(instructions, /syntalic:\/\/ontology\/rules/);
    assert.match(instructions, /never pick one silently/);
  });

  it("are prompts, one per playbook, carrying the playbook and, if given, the question", async () => {
    const client = await connect(ONTOLOGY_KEY);
    const { prompts } = await client.listPrompts();
    assert.deepEqual(prompts.map((p) => p.name).sort(), PLAYBOOKS.map((p) => p.name).sort());
    const got = await client.getPrompt({ name: "position-on-shelf", arguments: { question: "Where is Quest priced?" } });
    const body = (got.messages[0]!.content as { text: string }).text;
    assert.match(body, /^Playbook: position-on-shelf\./);
    assert.match(body, /Place the brand on its shelf's own price ladder/);
    assert.match(body, /The question: Where is Quest priced\?/);
    assert.match(body, /use the buyer-pitch prompt/);
  });

  it("are resources: the rules, an index, and each playbook", async () => {
    const client = await connect(ONTOLOGY_KEY);
    const { resources } = await client.listResources();
    const uris = resources.map((r) => r.uri).sort();
    assert.deepEqual(uris, [
      "syntalic://ontology/rules",
      "syntalic://playbooks",
      ...PLAYBOOKS.map((p) => `syntalic://playbooks/${p.name}`),
    ].sort());
    const rules = await client.readResource({ uri: "syntalic://ontology/rules" });
    assert.equal((rules.contents[0] as { text: string }).text, RULES.text);
    const index = await client.readResource({ uri: "syntalic://playbooks" });
    for (const p of PLAYBOOKS) assert.match((index.contents[0] as { text: string }).text, new RegExp(p.name));
  });

  it("name only tools this server has, and leave no template marker behind", async () => {
    const client = await connect(ONTOLOGY_KEY);
    const names = new Set((await client.listTools()).tools.map((t) => t.name));
    for (const p of [...PLAYBOOKS, RULES]) {
      assert.doesNotMatch(p.text, /\{\{|<!--/, `${p.name} has a marker left`);
      for (const m of p.text.matchAll(/`([a-z]+_[a-z_]+)`/g)) {
        const word = m[1]!;
        // a backticked snake_case word is a tool name unless it is a field or a parameter
        const FIELDS = new Set(["price_index", "brand_source", "banded_from", "brand_products", "category_root", "aggregate_by", "not_observed_at", "channels_not_observed", "retailers_scanned", "suggested_next_calls", "co_equal", "brand_id", "entity_uid", "physical_store", "not_observed", "also_ok", "carried_at"]);
        if (FIELDS.has(word)) continue;
        assert.ok(names.has(word), `${p.name} names \`${word}\`, which is not a tool of this server`);
      }
    }
  });

  it("never name a tool the MCP server lacks (Eve-only tools stay in Eve's blocks)", async () => {
    for (const eveOnly of ["resolve_context", "retailer_prices", "new_arrivals", "onboarded_catalog", "price_inflation"]) {
      for (const p of PLAYBOOKS) assert.ok(!p.text.includes(eveOnly), `${p.name} mentions ${eveOnly}`);
    }
  });
});
