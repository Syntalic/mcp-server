/**
 * Compare the MCP's tool surface against the LIVE API's OpenAPI spec.
 *
 * The offline test in src/server-parity.test.ts pins what we already expose, so
 * a removal fails loudly. Only this can catch the other direction: a route that
 * shipped in the API and has no tool. That is how the MCP ended up 14 paid
 * routes behind without anyone noticing.
 *
 * Run before publishing:  npm run check:parity
 */
import { readFileSync } from "node:fs";
import { MEASURES } from "../src/measures.generated.js";
import { NOT_LIVE, UNREAD_PARAMS } from "../src/measures.js";

const API = process.env.SYNTALIC_API_BASE ?? "https://api.syntalic.com";

const src = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");
const called = new Set([...src.matchAll(/query\w*\(\s*"(\/v1\/[^"]+)"/g)].map((m) => m[1]));

// SYNTALIC_SPEC_FILE reads a saved spec instead of fetching one: how to check against a deployment
// that has the ontology open when the live one does not yet, or without a network.
type Spec = { paths: Record<string, { get?: { parameters?: { name: string }[]; security?: unknown[] } }> };
let spec: Spec;
if (process.env.SYNTALIC_SPEC_FILE) {
  spec = JSON.parse(readFileSync(process.env.SYNTALIC_SPEC_FILE, "utf8")) as Spec;
} else {
  const res = await fetch(`${API}/openapi.json`);
  if (!res.ok) {
    console.error(`could not fetch ${API}/openapi.json (HTTP ${res.status})`);
    process.exit(2);
  }
  spec = (await res.json()) as Spec;
}

// /v1/public/* is free and intentionally only partly wrapped, and so is any operation the spec marks free
// (`security: []`, such as the measures index /v1/measures, in the spec since 2026-11-18); everything
// else under /v1 is a priced route an agent should be able to reach.
const markedFree = (p: string) => Array.isArray(spec.paths[p]?.get?.security) && spec.paths[p]!.get!.security!.length === 0;
const paid = Object.keys(spec.paths).filter((p) => p.startsWith("/v1/") && !p.startsWith("/v1/public/") && !markedFree(p));

// The measure tools (the default) reach a route through a split, which is a tool for it too. The API's
// own /v1/measures/<name> paths are not called (the server translates to the split's route itself), so
// one is covered when the generated table has that measure, and a measure the API added is missing.
const measureNames = new Set(MEASURES.map((m) => m.name));
const splitRoutes = new Set(
  MEASURES.flatMap((m) => m.splits.map((s) => s.route)).filter((r) => !(r in NOT_LIVE)),
);
const coveredByMeasure = (p: string) =>
  splitRoutes.has(p) || (p.startsWith("/v1/measures/") && measureNames.has(p.slice("/v1/measures/".length)));
const missing = paid.filter((p) => !called.has(p) && !coveredByMeasure(p));
// Reached by a measure only: there is no tool for them with SYNTALIC_TOOLS=routes. Said, not failed.
const measureOnly = paid.filter((p) => !called.has(p) && splitRoutes.has(p));
// The ontology routes appear in the spec only once ONTOLOGY_ENABLED opens them on the API (priced, one
// cent a call; dark until then). While the spec has none, tools that call them are expected, not stale:
// they answer with the API's 401 until the API opens. Said below, so a release does not go out unaware.
const ontologyOpen = Object.keys(spec.paths).some((p) => p.startsWith("/v1/ontology/"));
const stale = [...called].filter(
  (p) =>
    !p.startsWith("/v1/public/") &&
    !(p in spec.paths) &&
    // A NOT_LIVE route's per-route tool is not registered (src/server.ts), so its call is not stale.
    !(p in NOT_LIVE) &&
    (ontologyOpen || !p.startsWith("/v1/ontology/")),
);

// The id parameters (ontology): where the spec declares one on an operation, the tool for it must
// pass it through, or an agent holding an id from ontology_resolve has no way to use it. Read from
// the `query("/path", { ... })` call, the same source the path check above reads.
const ID_PARAMS = ["spt", "gpc", "brand_id", "entity_uid"];
/** Operations whose tool does not expose the name-shaped parameter either, so there is nothing for
 *  the id to stand in for. A gap here is deliberate; add to this list only with a reason. */
const KNOWN_GAPS: Record<string, string[]> = {
  "/v1/shopper/deal-finder": ["brand_id"], // the tool has no brand filter
  "/v1/analyst/retailer-index": ["spt", "gpc"], // the tool has no category filter
  "/v1/shopper/price-drop-alert": ["entity_uid"], // the tool takes q only
  // The per-route social and scout tools (SYNTALIC_TOOLS=routes) take a category name only, as in
  // 0.12.x. The API has since declared spt and brand_id on them; the measure tools (the default) pass
  // both, which the measure id check below holds.
  "/v1/social/creator-index": ["spt", "brand_id"],
  "/v1/social/brand-share": ["spt", "brand_id"],
  "/v1/social/category-structure": ["spt"],
  "/v1/social/brand-momentum": ["spt"],
  "/v1/social/topic-trends": ["spt"],
  "/v1/social/product-type-trends": ["spt"],
  "/v1/social/series": ["spt", "brand_id"],
  "/v1/social/attention-vs-shelf": ["spt"],
  "/v1/social/launch-buzz": ["spt"],
};
const calls = new Map<string, Set<string>>();
for (const m of src.matchAll(/query\w*\(\s*"(\/v1\/[^"]+)"\s*,\s*\{([^}]*)\}/g)) {
  const keys = m[2]!
    .split(",")
    .map((k) => k.trim().split(":")[0]!.trim())
    .filter(Boolean);
  calls.set(m[1]!, new Set(keys));
}
const unpassed: string[] = [];
for (const [path, item] of Object.entries(spec.paths)) {
  const declared = (item.get?.parameters ?? []).map((p) => p.name).filter((n) => ID_PARAMS.includes(n));
  const passed = calls.get(path);
  if (!passed) continue;
  for (const id of declared) {
    if (!passed.has(id) && !(KNOWN_GAPS[path] ?? []).includes(id)) unpassed.push(`${path}  ${id}`);
  }
}

// The measure tools pass every parameter the generated table lists for a split's route, so an id
// parameter the live spec declares and the table does not means the table is stale: regenerate it.
const measureUnpassed: string[] = [];
for (const m of MEASURES) {
  for (const split of m.splits) {
    if (split.route in NOT_LIVE) continue;
    const declared = (spec.paths[split.route]?.get?.parameters ?? []).map((p) => p.name).filter((n) => ID_PARAMS.includes(n));
    for (const id of declared) {
      if (!split.params.includes(id)) measureUnpassed.push(`${m.name} by ${split.by}  ${split.route}  ${id}`);
    }
  }
}

// The measure tools (the default): every route a split names must be served, or be in NOT_LIVE
// (src/measures.ts), which hides its split. A NOT_LIVE route that the spec now lists can come off it.
const measureRoutes = [...new Set(MEASURES.flatMap((m) => m.splits.map((s) => s.route)))];
const deadSplits = measureRoutes.filter(
  (p) => !(p in spec.paths) && !(p in NOT_LIVE) && (ontologyOpen || !p.startsWith("/v1/ontology/")),
);
const nowLive = Object.keys(NOT_LIVE).filter((p) => p in spec.paths);

console.log(`API paid routes : ${paid.length}`);
console.log(`MCP tool paths  : ${called.size}`);

if (missing.length) {
  console.error(`\n${missing.length} paid route(s) with NO tool:`);
  missing.forEach((p) => console.error("   " + p));
}
if (stale.length) {
  console.error(`\n${stale.length} tool(s) calling a path the API no longer serves:`);
  stale.forEach((p) => console.error("   " + p));
}
if (!ontologyOpen) {
  console.warn(
    "\nnote: the API's spec lists no /v1/ontology/* route, so it is closed (ONTOLOGY_ENABLED unset).\n" +
      "      The three ontology tools will answer with its 401 until it opens, and the id parameters\n" +
      "      on the paid tools are not in the spec to check.",
  );
}
if (unpassed.length) {
  console.error(`\n${unpassed.length} id parameter(s) the API declares and the tool does not pass:`);
  unpassed.forEach((p) => console.error("   " + p));
}
if (measureUnpassed.length) {
  console.error(
    `\n${measureUnpassed.length} id parameter(s) the API declares that the measure table does not list ` +
      "(regenerate src/measures.generated.ts):",
  );
  measureUnpassed.forEach((p) => console.error("   " + p));
}
if (measureOnly.length) {
  console.warn(`\nnote: ${measureOnly.length} paid route(s) only the measure tools reach (none with SYNTALIC_TOOLS=routes):`);
  measureOnly.forEach((p) => console.warn("   " + p));
}
if (deadSplits.length) {
  console.error(`\n${deadSplits.length} measure route(s) the API does not serve, not in NOT_LIVE (src/measures.ts):`);
  deadSplits.forEach((p) => console.error("   " + p));
}
if (nowLive.length) {
  console.warn(`\nnote: ${nowLive.length} NOT_LIVE route(s) are now in the spec; take them off NOT_LIVE to offer them:`);
  nowLive.forEach((p) => console.warn("   " + p));
}
// UNREAD_PARAMS: parameters a route's spec declares and its code does not read. Nothing here can tell
// when the API starts reading one, so each run names them: an entry the API now reads should come off.
const unreadEntries = Object.entries(UNREAD_PARAMS).flatMap(([route, params]) =>
  Object.entries(params).map(([name, why]) => `${route}  ${name}: ${why}`),
);
if (unreadEntries.length) {
  console.warn(
    `\nnote: ${unreadEntries.length} parameter(s) in UNREAD_PARAMS (src/measures.ts) are refused although the spec\n` +
      "      declares them; take an entry off once the API reads it or drops it from the spec:",
  );
  unreadEntries.forEach((e) => console.warn("   " + e));
}
const staleUnread = Object.entries(UNREAD_PARAMS).flatMap(([route, params]) =>
  Object.keys(params)
    .filter((name) => spec.paths[route] && !(spec.paths[route].get?.parameters ?? []).some((p) => p.name === name))
    .map((name) => `${route}  ${name}`),
);
if (staleUnread.length) {
  console.warn("\nnote: UNREAD_PARAMS entries the spec no longer declares (regenerate the measure table, then drop them):");
  staleUnread.forEach((e) => console.warn("   " + e));
}
if (missing.length || stale.length || unpassed.length || measureUnpassed.length || deadSplits.length) process.exit(1);
console.log(
  "\nparity OK: every paid route has a tool, every tool has a route, every id parameter is passed, " +
    "every measure split is served or hidden, and the API serves no measure the table lacks.",
);
