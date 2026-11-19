// `suggested_next_calls` (SYNLBS-266): the API names each by its route and the per-route tool name;
// the server rewrites each to a tool it offers. The hints below are the ones the API writes
// (api/src/lib/ontology-next-calls.ts in Crush-Rewards/syntalic), with the same routes and arguments.
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { generatePrivateKey } from "viem/accounts";
import { base58 } from "@scure/base";
import { createServer, HIDDEN_ROUTE_TOOLS } from "./server.js";
import { measureCallFor, type RouteCall } from "./measures.js";
import { measureHint, rewriteNextCalls, routeHint, routeToolName } from "./next-calls.js";

const SPT = "spt:fb-2-17-2-4";
const GPC = "gpc:10008059";
const BRAND = "brand:b_ac1a1c7143cb2199";
const RETAILER = "retailer:target";
const UID = "85ab90654c05144e8d25fed106d73c35";

const hint = (tool: string, route: string, args: Record<string, string | string[]>, price_usd = 0.01) => ({
  tool,
  route,
  method: "GET",
  args,
  price_usd,
  why: "test",
});

/** Every call the API's suggestion rules write, by the rule that writes it. */
const API_HINTS = [
  // callsForScope, a shelf and a type
  hint("ontology_neighbors", "/v1/ontology/neighbors", { id: SPT }),
  hint("price_dispersion", "/v1/analyst/price-dispersion", { spt: SPT }, 0.02),
  hint("promo_intelligence", "/v1/marketing/promo-intelligence", { spt: SPT, aggregate_by: "brand" }),
  hint("share_of_shelf", "/v1/marketing/share-of-shelf", { spt: SPT }),
  hint("price_dispersion", "/v1/analyst/price-dispersion", { gpc: GPC, country: "ca" }, 0.02),
  hint("share_of_shelf", "/v1/marketing/share-of-shelf", { gpc: GPC }),
  // socialCalls
  hint("brand_share", "/v1/social/brand-share", { spt: SPT }, 0.03),
  hint("topic_trends", "/v1/social/topic-trends", { spt: SPT }, 0.03),
  // callsForBrand, with its social calls on the shelf the rollup files it under
  hint("ontology_neighbors", "/v1/ontology/neighbors", { id: BRAND, relations: "carried_at,not_observed_at,footprint" }),
  hint("brand_breakdown", "/v1/marketing/brand-breakdown", { brand_id: BRAND }),
  hint("brand_share", "/v1/social/brand-share", { spt: SPT, brand_id: BRAND }, 0.03),
  hint("social_series", "/v1/social/series", { spt: SPT, brand_id: BRAND }, 0.03),
  hint("creator_index", "/v1/social/creator-index", { spt: SPT, brand_id: BRAND }, 0.03),
  // callsForTopic
  hint("topic_trends", "/v1/social/topic-trends", { spt: SPT, limit: "100" }, 0.03),
  // callsForRetailer
  hint("ontology_neighbors", "/v1/ontology/neighbors", { id: RETAILER, relations: "assortment,brands" }),
  // callsForEntity
  hint("best_price", "/v1/shopper/best-price", { entity_uid: UID }),
  hint("price_history", "/v1/shopper/price-history", { entity_uid: UID }),
  // callsForBrandOnScope (promo-intelligence with no aggregate_by: the route's default, brand)
  hint("price_positioning", "/v1/marketing/price-positioning", { brand_id: BRAND, spt: SPT }),
  hint("promo_intelligence", "/v1/marketing/promo-intelligence", { spt: SPT, brand_id: BRAND }),
  // two candidate scopes: compare their coverage
  hint("ontology_coverage", "/v1/ontology/coverage", { id: [GPC, SPT] }),
  // a social call in Canada: the social routes do not read country
  hint("brand_share", "/v1/social/brand-share", { spt: SPT, country: "ca" }, 0.03),
];

describe("a suggested call, as a measure tool call", () => {
  it("maps every call the API's rules write to a measure tool, by and subject", () => {
    const unmapped = API_HINTS.filter((h) => measureCallFor(h as RouteCall) === null).map((h) => `${h.route} ${JSON.stringify(h.args)}`);
    assert.deepEqual(unmapped, []);
  });

  it("names the tool, the split, the subject and the rest of the arguments", () => {
    const at = (i: number) => measureHint(API_HINTS[i]!);
    assert.deepEqual(at(0), { tool: "measure_neighbors", by: "relations", subject: SPT, args: {}, route: "/v1/ontology/neighbors", price_usd: 0.01, why: "test" });
    assert.deepEqual(at(1), { tool: "measure_prices", by: "distribution", subject: SPT, args: {}, route: "/v1/analyst/price-dispersion", price_usd: 0.02, why: "test" });
    // aggregate_by is what the split fixes, so the call does not send it
    assert.deepEqual(at(2).args, {});
    assert.equal(at(2).by, "brand");
    assert.deepEqual([at(4).subject, at(4).args], [GPC, { country: "ca" }]);
    assert.deepEqual([at(8).tool, at(8).subject, at(8).args], ["measure_neighbors", BRAND, { relations: "carried_at,not_observed_at,footprint" }]);
    assert.deepEqual([at(9).tool, at(9).by, at(9).subject], ["measure_assortment", "category", BRAND]);
    assert.deepEqual([at(11).tool, at(11).by, at(11).subject, at(11).args], ["measure_attention", "week", SPT, { brand_id: BRAND }]);
    // a number is a number, as the tool's schema takes it
    assert.deepEqual([at(13).by, at(13).args], ["topic", { limit: 100 }]);
    assert.deepEqual([at(15).tool, at(15).by, at(15).subject], ["measure_offers", "retailer", `entity:${UID}`]);
    assert.deepEqual([at(16).tool, at(16).by, at(16).subject], ["measure_trend", "period", `entity:${UID}`]);
    assert.deepEqual([at(17).tool, at(17).by, at(17).subject, at(17).args], ["measure_prices", "brand", SPT, { brand_id: BRAND }]);
    assert.deepEqual([at(18).tool, at(18).by], ["measure_promotions", "brand"]);
    // a list of ids is not one subject: it stays an argument
    assert.deepEqual([at(19).tool, at(19).subject, at(19).args], ["measure_coverage", undefined, { id: [GPC, SPT] }]);
    // the route does not read country, and the API ignores it there
    assert.deepEqual(at(20).args, {});
    for (const h of API_HINTS) {
      const out = measureHint(h);
      assert.equal(out.callable, undefined, h.route);
      assert.equal("method" in out, false);
    }
  });

  it("leaves a call it cannot make unchanged, and marks it", () => {
    // /v1/analyst/inflation is in NOT_LIVE: no split of measure_trend reaches it.
    const dark = hint("inflation", "/v1/analyst/inflation", { spt: SPT }, 0.02);
    const out = measureHint(dark);
    assert.equal(out.callable, false);
    assert.match(String(out.note), /inflation is the route's name, not a tool here/);
    assert.deepEqual({ ...out, callable: undefined, note: undefined }, { ...dark, callable: undefined, note: undefined });
    // An argument the route does not read is left out (the API ignores it there); one it reads, in a
    // form the tool refuses, leaves the call unmapped.
    assert.equal(measureHint(hint("share_of_shelf", "/v1/marketing/share-of-shelf", { spt: SPT, limit: "x" })).callable, undefined);
    assert.equal(measureHint(hint("topic_trends", "/v1/social/topic-trends", { spt: SPT, limit: "5000" })).callable, false);
    assert.equal(measureHint({ tool: "x", why: "no route" }).callable, false);
  });
});

describe("a suggested call, as a per-route tool call (SYNTALIC_TOOLS=routes)", () => {
  const registered = new Set(["ontology_neighbors", "share_of_shelf", "classify_product_type", "social_series"]);

  it("keeps a name that is a registered tool, and fixes one that is not the tool's name", () => {
    const keep = hint("share_of_shelf", "/v1/marketing/share-of-shelf", { spt: SPT });
    assert.equal(routeHint(keep, registered), keep);
    assert.equal(routeHint(hint("classify", "/v1/reference/classify", { q: "x" }), registered).tool, "classify_product_type");
  });

  it("marks a route with no registered tool", () => {
    const out = routeHint(hint("inflation", "/v1/analyst/inflation", { spt: SPT }), registered);
    assert.equal(out.callable, false);
    assert.match(String(out.note), /No tool in this mode calls \/v1\/analyst\/inflation/);
  });

  it("names each per-route tool server.ts registers by its route", () => {
    const src = readFileSync(new URL("./server.ts", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    const starts = [...src.matchAll(/server\.tool\(\s*"([a-z_]+)"/g)].map((m) => ({ name: m[1]!, at: m.index! }));
    let checked = 0;
    starts.forEach(({ name, at }, i) => {
      const body = src.slice(at, starts[i + 1]?.at ?? src.length);
      const route = /query\(\s*"(\/v1\/[^"]+)"/.exec(body)?.[1];
      if (!route) return;
      checked++;
      assert.equal(routeToolName(route), name, route);
    });
    assert.ok(checked > 30, `only ${checked} per-route tools found`);
  });
});

describe("rewriteNextCalls", () => {
  it("rewrites the hints at any depth and nothing else", () => {
    const data = {
      results: [{ term: "x", matches: [{ id: SPT, why: "keep" }], suggested_next_calls: [API_HINTS[3]] }],
      suggested_next_calls: [API_HINTS[17]],
      note: { suggested_next_calls: "not a list" },
    };
    const out = rewriteNextCalls(data, measureHint) as typeof data & {
      results: { suggested_next_calls: { tool: string }[] }[];
      suggested_next_calls: { tool: string }[];
    };
    assert.equal(out.results[0]!.suggested_next_calls[0]!.tool, "measure_assortment");
    assert.equal(out.suggested_next_calls[0]!.tool, "measure_prices");
    assert.deepEqual(out.results[0]!.matches, data.results[0]!.matches);
    assert.deepEqual(out.note, data.note);
  });
});

describe("the tools' answers carry rewritten hints", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  async function solanaKey(): Promise<string> {
    const key = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
    const priv = new Uint8Array(await crypto.subtle.exportKey("pkcs8", key.privateKey));
    const pub = new Uint8Array(await crypto.subtle.exportKey("raw", key.publicKey));
    const bytes = new Uint8Array(64);
    bytes.set(priv.slice(priv.length - 32), 0);
    bytes.set(pub, 32);
    return base58.encode(bytes);
  }

  async function answer(tools: "measures" | "routes", name: string, args: Record<string, unknown>) {
    globalThis.fetch = (async () =>
      Response.json({
        results: [{ term: "protein bars", suggested_next_calls: [API_HINTS[3], hint("inflation", "/v1/analyst/inflation", { spt: SPT }, 0.02)] }],
      })) as typeof fetch;
    const server = await createServer({
      apiBase: "https://api.test",
      evmPrivateKey: generatePrivateKey(),
      solanaPrivateKey: await solanaKey(),
      backupAcknowledged: true,
      tools,
    });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0" });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[] };
    return JSON.parse(res.content[0]!.text) as { results: { suggested_next_calls: Record<string, unknown>[] }[] };
  }

  it("in the default mode, a measure tool and a by", async () => {
    const out = await answer("measures", "measure_resolve", { term: ["protein bars"] });
    const [shelf, dark] = out.results[0]!.suggested_next_calls;
    assert.deepEqual([shelf!.tool, shelf!.by, shelf!.subject], ["measure_assortment", "brand", SPT]);
    assert.equal(dark!.callable, false);
  });

  it("with SYNTALIC_TOOLS=routes, the per-route tool", async () => {
    assert.deepEqual(HIDDEN_ROUTE_TOOLS, ["inflation_tracker"]);
    const out = await answer("routes", "ontology_resolve", { terms: ["protein bars"] });
    const [shelf, dark] = out.results[0]!.suggested_next_calls;
    assert.equal(shelf!.tool, "share_of_shelf");
    assert.equal(shelf!.callable, undefined);
    assert.equal(dark!.callable, false, "inflation_tracker is not registered while its route is dark");
  });
});
