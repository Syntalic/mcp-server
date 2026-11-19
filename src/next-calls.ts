// `suggested_next_calls` in an API answer, made callable from this server (SYNLBS-266).
//
// The API suggests what to call next as a route, its query arguments and a `tool`: the route's last
// path segment (`share_of_shelf`, `brand_breakdown`) or `ontology_neighbors`. Those are the per-route
// tool names, so with the measure tools (the default) none of them is a tool, and a model had to work
// out on its own which measure and `by` reach the route. Each suggestion is rewritten here:
//
// - measure tools: `tool` is the measure tool, with `by`, `subject` (when the call names an id the
//   split takes as its subject) and `args` (the tool's other arguments). measureCallFor
//   (src/measures.ts) reads this off the generated table and keeps only a call that translates back
//   to exactly the route and arguments suggested.
// - per-route tools (SYNTALIC_TOOLS=routes): `tool` is the registered tool for the route.
//
// A suggestion that cannot be mapped keeps what the API sent and is marked `callable: false`, with a
// `note` saying why. Nothing else in the answer changes.
import { measureCallFor, type RouteCall } from "./measures.js";

type Hint = Record<string, unknown>;

/** The route and arguments of a suggestion, or null when it is not one the API writes. */
function routeCall(hint: Hint): RouteCall | null {
  if (typeof hint.route !== "string" || !hint.route.startsWith("/v1/")) return null;
  const args: RouteCall["args"] = {};
  if (hint.args !== undefined) {
    if (!hint.args || typeof hint.args !== "object" || Array.isArray(hint.args)) return null;
    for (const [k, v] of Object.entries(hint.args as Record<string, unknown>)) {
      if (typeof v === "string") args[k] = v;
      else if (Array.isArray(v) && v.every((x) => typeof x === "string")) args[k] = v as string[];
      else if (typeof v === "number" || typeof v === "boolean") args[k] = String(v);
      else return null;
    }
  }
  return { route: hint.route, args };
}

function uncallable(hint: Hint, note: string): Hint {
  return { ...hint, callable: false, note };
}

/** A suggestion as a measure tool call (the default mode). */
export function measureHint(hint: Hint): Hint {
  const call = routeCall(hint);
  const named = typeof hint.tool === "string" ? hint.tool : "this name";
  if (!call) return uncallable(hint, `${named} is not a tool here, and the suggestion names no route to map.`);
  const m = measureCallFor(call);
  if (!m) {
    return uncallable(
      hint,
      `${named} is the route's name, not a tool here: no measure tool makes this exact call to ${call.route}.`,
    );
  }
  const { tool: _tool, args: _args, method: _method, ...rest } = hint;
  return { tool: m.tool, by: m.by, ...(m.subject ? { subject: m.subject } : {}), args: m.args, ...rest };
}

/** Routes whose per-route tool is not the route's last segment (server.ts). The rest are. */
const ROUTE_TOOL_NAMES: Readonly<Record<string, string>> = {
  "/v1/ontology/resolve": "ontology_resolve",
  "/v1/ontology/neighbors": "ontology_neighbors",
  "/v1/ontology/coverage": "ontology_coverage",
  "/v1/reference/classify": "classify_product_type",
  "/v1/reference/reverse": "gpc_reverse_lookup",
  "/v1/reference/brick-attributes": "gpc_brick_attributes",
  "/v1/analyst/inflation": "inflation_tracker",
  "/v1/social/series": "social_series",
};

/** The per-route tool's name for a route, registered or not. */
export function routeToolName(route: string): string {
  return ROUTE_TOOL_NAMES[route] ?? route.slice(route.lastIndexOf("/") + 1).replace(/-/g, "_");
}

/** A suggestion as a per-route tool call (SYNTALIC_TOOLS=routes). */
export function routeHint(hint: Hint, registered: ReadonlySet<string>): Hint {
  const call = routeCall(hint);
  if (!call) {
    if (typeof hint.tool === "string" && registered.has(hint.tool)) return hint;
    return uncallable(hint, "This is not a tool here, and the suggestion names no route to map.");
  }
  const tool = routeToolName(call.route);
  if (registered.has(tool)) return hint.tool === tool ? hint : { ...hint, tool };
  return uncallable(hint, `No tool in this mode calls ${call.route}.`);
}

/** The answer with every `suggested_next_calls` entry, at any depth, passed through `rewrite`. */
export function rewriteNextCalls(data: unknown, rewrite: (hint: Hint) => Hint): unknown {
  if (Array.isArray(data)) return data.map((item) => rewriteNextCalls(item, rewrite));
  if (!data || typeof data !== "object") return data;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    out[key] =
      key === "suggested_next_calls" && Array.isArray(value)
        ? value.map((h) => (h && typeof h === "object" && !Array.isArray(h) ? rewrite(h as Hint) : h))
        : rewriteNextCalls(value, rewrite);
  }
  return out;
}
