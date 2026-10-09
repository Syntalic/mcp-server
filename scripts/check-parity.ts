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

const API = process.env.SYNTALIC_API_BASE ?? "https://api.syntalic.com";

const src = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");
const called = new Set([...src.matchAll(/query\w*\(\s*"(\/v1\/[^"]+)"/g)].map((m) => m[1]));

// SYNTALIC_SPEC_FILE reads a saved spec instead of fetching one: how to check against a deployment
// that has the ontology open when the live one does not yet, or without a network.
type Spec = { paths: Record<string, { get?: { parameters?: { name: string }[] } }> };
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

// /v1/public/* is free and intentionally only partly wrapped; everything else
// under /v1 is a priced route an agent should be able to reach.
const paid = Object.keys(spec.paths).filter((p) => p.startsWith("/v1/") && !p.startsWith("/v1/public/"));

const missing = paid.filter((p) => !called.has(p));
// The ontology routes appear in the spec only once ONTOLOGY_API_KEYS is set on the API (they are keyed
// and dark until then). While the spec has none, tools that call them are expected, not stale: they
// answer with the API's 401 until the API opens. Said below, so a release does not go out unaware.
const ontologyOpen = Object.keys(spec.paths).some((p) => p.startsWith("/v1/ontology/"));
const stale = [...called].filter(
  (p) => !p.startsWith("/v1/public/") && !(p in spec.paths) && (ontologyOpen || !p.startsWith("/v1/ontology/")),
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
  "/v1/analyst/price-bands": ["brand_id"], // the tool takes the shelf only
  "/v1/shopper/price-drop-alert": ["entity_uid"], // the tool takes q only
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
    "\nnote: the API's spec lists no /v1/ontology/* route, so it is closed (ONTOLOGY_API_KEYS unset).\n" +
      "      The three ontology tools will answer with its 401 until it opens, and the id parameters\n" +
      "      on the paid tools are not in the spec to check.",
  );
}
if (unpassed.length) {
  console.error(`\n${unpassed.length} id parameter(s) the API declares and the tool does not pass:`);
  unpassed.forEach((p) => console.error("   " + p));
}
if (missing.length || stale.length || unpassed.length) process.exit(1);
console.log("\nparity OK: every paid route has a tool, every tool has a route, every id parameter is passed.");
