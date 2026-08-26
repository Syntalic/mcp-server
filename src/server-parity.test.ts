import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Read the SOURCE rather than dist so this runs without a build step, and so a
// tool that is commented out (shrinkflation_detector) correctly does not count.
const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "server.ts"), "utf8");

/** Strip line and block comments so commented-out tools are not counted. */
function uncommented(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}
const code = uncommented(src);

const toolNames = [...code.matchAll(/server\.tool\(\s*"([a-z_]+)"/g)].map((m) => m[1]);
const queryPaths = [...code.matchAll(/query\w*\(\s*"(\/v1\/[^"]+)"/g)].map((m) => m[1]);

describe("MCP tool registry", () => {
  it("registers tools at all (an empty sweep would pass every assertion below)", () => {
    assert.ok(toolNames.length > 30, `only ${toolNames.length} tools found`);
  });

  it("has no duplicate tool name", () => {
    const dupes = toolNames.filter((n, i) => toolNames.indexOf(n) !== i);
    assert.deepEqual(dupes, [], `duplicate tool names: ${dupes.join(", ")}`);
  });

  it("calls no API path twice from two different tools", () => {
    const dupes = queryPaths.filter((p, i) => queryPaths.indexOf(p) !== i);
    assert.deepEqual(dupes, [], `two tools share one path: ${dupes.join(", ")}`);
  });

  it("only calls well-formed /v1/<tier>/<route> paths", () => {
    const bad = queryPaths.filter((p) => !/^\/v1\/(shopper|marketing|analyst|social|reference|public)\/[a-z-]+$/.test(p));
    assert.deepEqual(bad, [], `malformed paths: ${bad.join(", ")}`);
  });

  // The MCP silently drifted 14 paid routes behind the API before this existed:
  // all 9 social/scout routes plus 5 marketing/analyst ones were live, priced and
  // unreachable from any agent. Pinning the inventory means a removal or rename
  // fails loudly; `npm run check:parity` is what catches a NEW API route.
  it("exposes every social and scout route", () => {
    for (const p of [
      "/v1/social/creator-index",
      "/v1/social/brand-share",
      "/v1/social/category-structure",
      "/v1/social/brand-momentum",
      "/v1/social/topic-trends",
      "/v1/social/product-type-trends",
      "/v1/social/series",
      "/v1/social/attention-vs-shelf",
      "/v1/social/launch-buzz",
    ]) {
      assert.ok(queryPaths.includes(p), `no tool calls ${p}`);
    }
  });

  it("exposes the marketing and analyst routes that had been missed", () => {
    for (const p of [
      "/v1/marketing/brand-breakdown",
      "/v1/marketing/retailer-assortment",
      "/v1/marketing/availability-index",
      "/v1/analyst/category-concentration",
      "/v1/analyst/price-change-leaders",
    ]) {
      assert.ok(queryPaths.includes(p), `no tool calls ${p}`);
    }
  });

  it("keeps every paid tool's cost in its description", () => {
    // Agents budget from the description. A paid tool that does not state its
    // price reads as free and gets called in a loop.
    const blocks = code.split("server.tool(").slice(1);
    const missing: string[] = [];
    for (const b of blocks) {
      const name = b.match(/^\s*"([a-z_]+)"/)?.[1];
      if (!name) continue;
      // The description runs from the tool name to the start of the schema
      // object. Scanning a fixed window instead flagged classify_product_type,
      // whose description is long enough that its price sits past 900 chars.
      const schemaAt = b.indexOf("\n    {");
      const description = schemaAt > 0 ? b.slice(0, schemaAt) : b.slice(0, 2000);
      const isPaid = /query\(\s*"\/v1\/(shopper|marketing|analyst|social|reference)\//.test(b.slice(0, 3000));
      if (isPaid && !/Costs \$\d/.test(description)) missing.push(name);
    }
    assert.deepEqual(missing, [], `paid tools with no price in the description: ${missing.join(", ")}`);
  });
});
