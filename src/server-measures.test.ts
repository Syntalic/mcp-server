// The measure tools (the default since 0.13.0; SYNTALIC_TOOLS=routes brings back one tool per route).
// Driven through a real client over an in-memory transport, against a stubbed fetch, so what is
// asserted is the tool list a client sees and the request that goes over the wire.
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { generatePrivateKey } from "viem/accounts";
import { base58 } from "@scure/base";
import { HIDDEN_ROUTE_TOOLS, createServer } from "./server.js";
import { MEASURES } from "./measures.generated.js";
import { LIVE_MEASURES, NOT_LIVE, describeMeasure, liveMeasure, measureToolName, parseId, translate } from "./measures.js";
import { parseToolsMode } from "./lib/env.js";

const API_BASE = "https://api.test";
const FREE = ["wallet_info", "catalog_overview", "browse_categories", "list_retailers", "list_brands", "coverage_map"];
const measure = (name: string) => MEASURES.find((m) => m.name === name)!;

/** server.ts without its comments, so a commented-out tool does not count. */
const src = (): string =>
  readFileSync(new URL("./server.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

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
  const res = (await client.callTool({ name: measureToolName(name), arguments: args })) as {
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
  it("is the free tools and one prefixed tool per live measure by default", async () => {
    const names = (await (await connect()).listTools()).tools.map((t) => t.name);
    assert.deepEqual([...names].sort(), [...FREE, ...LIVE_MEASURES.map((m) => measureToolName(m.name))].sort());
    assert.ok(LIVE_MEASURES.length >= 10, `only ${LIVE_MEASURES.length} measures`);
    const explicit = (await (await connect("measures")).listTools()).tools.map((t) => t.name);
    assert.deepEqual(explicit, names);
    assert.match((await connect()).getInstructions() ?? "", /Every other tool is a\s+measure/);
  });

  it("is the per-route tools with SYNTALIC_TOOLS=routes, with no measure among them", async () => {
    const names = (await (await connect("routes")).listTools()).tools.map((t) => t.name);
    // Every tool server.ts registers, however many that is.
    // Every tool server.ts registers, however many that is, but those its route's flag keeps dark.
    const registered = [...src().matchAll(/server\.tool\(\s*"([a-z_]+)"/g)]
      .map((m) => m[1]!)
      .filter((n) => !HIDDEN_ROUTE_TOOLS.includes(n));
    assert.ok(registered.length > 30, `only ${registered.length} tools found in server.ts`);
    assert.deepEqual([...names].sort(), [...registered].sort());
    for (const hidden of HIDDEN_ROUTE_TOOLS) assert.ok(!names.includes(hidden), `${hidden} is listed`);
    for (const m of MEASURES) {
      assert.ok(!names.includes(m.name), `${m.name} is listed in routes mode`);
      assert.ok(!names.includes(measureToolName(m.name)), `${measureToolName(m.name)} is listed in routes mode`);
    }
    assert.match((await connect("routes")).getInstructions() ?? "", /ontology_resolve/);
  });

  it("registers no measure under its bare name", async () => {
    const names = (await (await connect()).listTools()).tools.map((t) => t.name);
    for (const m of MEASURES) assert.ok(!names.includes(m.name), `${m.name} is registered bare`);
  });

  it("reads SYNTALIC_TOOLS: unset or measures is the measures, routes the per-route tools", () => {
    assert.equal(parseToolsMode(undefined), "measures");
    assert.equal(parseToolsMode(""), "measures");
    assert.equal(parseToolsMode(" Measures "), "measures");
    assert.equal(parseToolsMode("routes"), "routes");
    assert.equal(parseToolsMode("ROUTES"), "routes");
    assert.equal(parseToolsMode("all"), null);
  });

  it("is at least 30% smaller, measured as the JSON a client is sent", async () => {
    // 49,387 characters for the per-route tools against 32,815 for the measures in 0.13.0 (about 12.3k
    // and 8.2k tokens at four characters each): 17 tools in place of 40, and a third less to read.
    const size = async (mode?: "routes" | "measures") =>
      JSON.stringify((await (await connect(mode)).listTools()).tools).length;
    const [routes, measures] = [await size("routes"), await size()];
    assert.ok(measures < routes * 0.7, `measures ${measures} chars, routes ${routes} chars`);
  });

  it("states each measure's cost, and marks it as spending", async () => {
    const tools = (await (await connect()).listTools()).tools;
    for (const m of LIVE_MEASURES) {
      const tool = tools.find((t) => t.name === measureToolName(m.name))!;
      assert.match(tool.description ?? "", /Costs \$0\.0\d/, m.name);
      assert.equal(tool.annotations?.readOnlyHint, false, m.name);
      const props = Object.keys((tool.inputSchema.properties ?? {}) as object);
      assert.deepEqual(props.slice(0, 2), ["subject", "by"], m.name);
    }
    for (const name of FREE) assert.equal(tools.find((t) => t.name === name)!.annotations?.readOnlyHint, true, name);
  });

  it("tells the client about the measures in its instructions", async () => {
    const instructions = (await connect()).getInstructions() ?? "";
    assert.match(instructions, /Every other tool is a\s+measure/);
    assert.match(instructions, /measure_resolve/);
    assert.match(instructions, /The bare names \(offers, prices, resolve\) are not tools/);
  });
});

describe("a route the API does not serve is not offered", () => {
  it("lists /v1/ontology/similar as not live", () => {
    assert.ok("/v1/ontology/similar" in NOT_LIVE);
    // It is still in the generated table: hidden here, not deleted there.
    assert.ok(MEASURES.some((m) => m.splits.some((s) => s.route === "/v1/ontology/similar")));
  });

  it("offers no default tool a by whose route is not live", async () => {
    const tools = (await (await connect()).listTools()).tools;
    let checked = 0;
    for (const m of MEASURES) {
      const tool = tools.find((t) => t.name === measureToolName(m.name));
      if (!tool) continue;
      const by = (tool.inputSchema.properties as Record<string, { enum?: string[] }>).by;
      // A by two splits share (trend by period) stays offered for its live splits only.
      const live = liveMeasure(m)!;
      for (const value of by?.enum ?? []) {
        for (const split of live.splits.filter((s) => s.by === value)) {
          checked++;
          assert.ok(!(split.route in NOT_LIVE), `${tool.name} by ${value} routes to ${split.route}`);
          assert.notEqual(split.route, "/v1/ontology/similar", `${tool.name} by ${value}`);
        }
      }
      assert.doesNotMatch(tool.description ?? "", /\[similar\]/, tool.name);
    }
    // Every live split is reachable through some by, and only those (40 of the table's 41 in 0.13.0).
    assert.equal(checked, LIVE_MEASURES.reduce((n, m) => n + m.splits.length, 0));
    assert.ok(checked > 30, `only ${checked} splits checked`);
    const neighbors = tools.find((t) => t.name === measureToolName("neighbors"))!;
    const props = Object.keys(neighbors.inputSchema.properties ?? {});
    assert.ok(!props.includes("shelf"), "the similar split's footprint parameter is offered");
  });

  it("refuses by=similar without calling the API", async () => {
    const client = await connect();
    const refused = await client
      .callTool({ name: measureToolName("neighbors"), arguments: { by: "similar", brand: "olipop" } })
      .then((r) => (r as { isError?: boolean }).isError === true, () => true);
    assert.equal(refused, true);
    assert.equal(seen.length, 0);
  });

  it("drops a not-live split, its parameters, and moves the default off it", () => {
    const neighbors = liveMeasure(measure("neighbors"))!;
    assert.deepEqual(neighbors.splits.map((s) => s.by), ["relations"]);
    // The API's INFLATION_ENABLED is off: trend by period is a product's or a brand's, not a shelf's.
    assert.ok("/v1/analyst/inflation" in NOT_LIVE);
    const trend = liveMeasure(measure("trend"))!;
    assert.deepEqual(trend.splits.filter((s) => s.by === "period").map((s) => s.about), ["product", "brand"]);
    assert.ok(!trend.splits.some((s) => s.route === "/v1/analyst/inflation"));
    assert.deepEqual(HIDDEN_ROUTE_TOOLS, ["inflation_tracker"]);
    assert.deepEqual(neighbors.params.map((p) => p.name), ["id", "relations", "limit", "country"]);
    const moved = liveMeasure(measure("prices"), { [measure("prices").splits[0]!.route]: "test" })!;
    assert.notEqual(moved.default_by, measure("prices").splits[0]!.by);
    assert.ok(moved.splits.some((s) => s.by === moved.default_by));
    assert.equal(liveMeasure(measure("coverage"), { "/v1/ontology/coverage": "test" }), null);
  });
});

describe("the measures reach every route the per-route tools call", () => {
  it("has a live split for each paid path in server.ts", () => {
    // A route in NOT_LIVE has neither a split nor a registered tool.
    const called = [...src().matchAll(/query\(\s*"(\/v1\/[^"]+)"/g)].map((m) => m[1]!).filter((p) => !(p in NOT_LIVE));
    assert.ok(called.length > 25, `only ${called.length} paid paths found`);
    const reached = new Set(LIVE_MEASURES.flatMap((m) => m.splits.map((s) => s.route)));
    assert.deepEqual(called.filter((p) => !reached.has(p)), []);
  });
});

describe("a measure call goes to the route its split names", () => {
  it("sends an id subject as the route's id parameter", async () => {
    const client = await connect();
    const res = await call(client, "prices", { subject: "spt:fb-2-17-2-4", by: "distribution", country: "ca" });
    assert.equal(res.isError, false);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.pathname, "/v1/analyst/price-dispersion");
    assert.equal(seen[0]!.search, "?country=ca&spt=spt%3Afb-2-17-2-4");
  });

  it("uses the default split, and sends a name as the route's name parameter", async () => {
    const client = await connect();
    await call(client, "assortment", { subject: "electronics" });
    assert.equal(seen[0]!.pathname, "/v1/marketing/share-of-shelf");
    assert.equal(seen[0]!.searchParams.get("category"), "electronics");
  });

  it("sets what the split fixes", async () => {
    const client = await connect();
    await call(client, "promotions", { subject: "grocery", by: "retailer" });
    assert.equal(seen[0]!.pathname, "/v1/marketing/promo-intelligence");
    assert.equal(seen[0]!.searchParams.get("aggregate_by"), "retailer");
  });

  it("repeats a list parameter, one value each", async () => {
    const client = await connect();
    await call(client, "resolve", { term: ["olipop", "poppi"], kinds: "brand" });
    assert.equal(seen[0]!.pathname, "/v1/ontology/resolve");
    assert.deepEqual(seen[0]!.searchParams.getAll("term"), ["olipop", "poppi"]);
  });

  it("refuses, free, an argument the chosen split's route does not read (SYNLBS-266)", async () => {
    const client = await connect();
    // sort_by and department belong to other splits of prices; price-bands reads neither. Dropped,
    // the call would answer a wider question than the one asked, at full price.
    const res = await call(client, "prices", { by: "band", subject: "electronics/computers", sort_by: "price_asc", department: "Grocery" });
    assert.equal(res.isError, true);
    assert.equal(seen.length, 0);
    assert.match(res.text, /measure_prices by band is answered by \/v1\/analyst\/price-bands, which does not read department, sort_by/);
    assert.match(res.text, /sort_by is read by product/);
    assert.match(res.text, /department is read by summary, by distribution, by retailer/);
    assert.match(res.text, /Nothing was called or billed/);
  });

  it("refuses time_window on a product's price history, and takes it on a brand's (SYNLBS-266)", async () => {
    const client = await connect();
    // The 2026-11-18 incident: price-history drops time_window, the 30-day default applied, and a paid
    // call answered 404. Its spec lists time_window, so UNREAD_PARAMS holds it until the API reads it.
    const res = await call(client, "trend", { subject: "entity:85ab90654c05144e8d25fed106d73c35", time_window: "last_90_days" });
    assert.equal(res.isError, true);
    assert.equal(seen.length, 0);
    assert.match(res.text, /by period \(a product\) is answered by \/v1\/shopper\/price-history, which does not read time_window/);
    assert.match(res.text, /reads from and to, not time_window/);
    assert.match(res.text, /time_window is read by period \(a brand\)/);
    const brand = await call(client, "trend", { subject: "brand:b_ac1a1c7143cb2199", time_window: "last_90_days" });
    assert.equal(brand.isError, false, brand.text);
    assert.equal(seen[0]!.pathname, "/v1/marketing/brand-tracker");
    assert.equal(seen[0]!.searchParams.get("time_window"), "last_90_days");
  });

  it("takes from and to on a product's price history", async () => {
    const client = await connect();
    const res = await call(client, "trend", { subject: "entity:abc", from: "2026-08-01", to: "2026-11-01" });
    assert.equal(res.isError, false, res.text);
    assert.equal(seen[0]!.pathname, "/v1/shopper/price-history");
    assert.equal(seen[0]!.search, "?from=2026-08-01&to=2026-11-01&entity_uid=abc");
  });

  it("takes any retailer, as the API and the per-route tools do", async () => {
    const client = await connect();
    const res = await call(client, "prices", { by: "retailer", subject: "electronics", retailer: "staples" });
    assert.equal(res.isError, false);
    assert.equal(seen[0]!.searchParams.get("retailer"), "staples");
  });

  it("takes win as the number the API types it as, and holds limit to the route's bounds", async () => {
    const client = await connect();
    const ok = await call(client, "trend", { subject: "spt:fb-2-17-2-4", by: "product", win: 30 });
    assert.equal(ok.isError, false);
    assert.equal(seen[0]!.pathname, "/v1/analyst/price-change-leaders");
    assert.equal(seen[0]!.searchParams.get("win"), "30");
    seen = [];
    const bad = await client.callTool({ name: measureToolName("trend"), arguments: { subject: "spt:fb-2-17-2-4", by: "product", win: 45 } }).then(
      (r) => (r as { isError?: boolean }).isError === true,
      () => true,
    );
    assert.equal(bad, true);
    const tooMany = await client.callTool({ name: measureToolName("offers"), arguments: { subject: "airpods", limit: 100000 } }).then(
      (r) => (r as { isError?: boolean }).isError === true,
      () => true,
    );
    assert.equal(tooMany, true);
    assert.equal(seen.length, 0);
  });

  it("takes every channel the tactics route takes, not only email (SYNLBS-269)", async () => {
    const client = await connect();
    const tool = (await client.listTools()).tools.find((t) => t.name === measureToolName("signals"))!;
    const channel = (tool.inputSchema.properties as Record<string, { enum?: string[] }>).channel;
    const nine = ["email", "retail", "supply", "brand_launch", "growth", "social", "site", "branding", "customer"];
    assert.deepEqual([...(channel?.enum ?? [])].sort(), [...nine].sort());
    const res = await call(client, "signals", { by: "practice", subject: "spt:fb-2-17-2-4", channel: "retail" });
    assert.equal(res.isError, false, res.text);
    assert.equal(seen[0]!.pathname, "/v1/social/tactics");
    assert.equal(seen[0]!.searchParams.get("channel"), "retail");
  });

  it("answers compactly: no indentation to pay tokens for", async () => {
    const client = await connect();
    assert.equal((await call(client, "coverage", { subject: "gpc:10008059" })).text, '{"ok":true}');
  });

  it("refuses what it cannot place without calling the API", async () => {
    const client = await connect();
    const res = await call(client, "trend", { subject: "apple" });
    assert.equal(res.isError, true);
    // A shelf too while the API serves /v1/analyst/inflation (NOT_LIVE).
    assert.match(res.text, /can be about product, (shelf, )?brand/);
    assert.match(res.text, /Nothing was called or billed/);
    assert.equal(seen.length, 0);
  });
});

describe("coverage_map", () => {
  it("offers the quality statuses the API returns: serving, thin, stale (SYNLBS-266)", async () => {
    const client = await connect();
    const tool = (await client.listTools()).tools.find((t) => t.name === "coverage_map")!;
    const status = (tool.inputSchema.properties as Record<string, { enum?: string[] }>).quality_status;
    assert.deepEqual(status?.enum, ["serving", "thin", "stale"]);
    assert.match(tool.description ?? "", /serving, thin or stale/);
    assert.doesNotMatch(tool.description ?? "", /unmanaged|empty/);
    await client.callTool({ name: "coverage_map", arguments: { quality_status: "stale" } });
    assert.equal(seen[0]!.searchParams.get("quality_status"), "stale");
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

  it("names each split's route in the description, and registers the measure under a prefix", () => {
    assert.match(describeMeasure(measure("prices")), /Call measure_prices/);
    assert.match(describeMeasure(measure("prices")), /\[price-positioning, \$0\.01\]/);
    assert.match(describeMeasure(measure("scout")), /Call measure_scout/);
    assert.match(describeMeasure(measure("scout")), /\[launch-buzz\]/);
    assert.equal(measureToolName("prices"), "measure_prices");
  });
});
