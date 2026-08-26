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

const res = await fetch(`${API}/openapi.json`);
if (!res.ok) {
  console.error(`could not fetch ${API}/openapi.json (HTTP ${res.status})`);
  process.exit(2);
}
const spec = (await res.json()) as { paths: Record<string, unknown> };

// /v1/public/* is free and intentionally only partly wrapped; everything else
// under /v1 is a priced route an agent should be able to reach.
const paid = Object.keys(spec.paths).filter((p) => p.startsWith("/v1/") && !p.startsWith("/v1/public/"));

const missing = paid.filter((p) => !called.has(p));
const stale = [...called].filter((p) => !p.startsWith("/v1/public/") && !(p in spec.paths));

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
if (missing.length || stale.length) process.exit(1);
console.log("\nparity OK: every paid route has a tool, every tool has a route.");
