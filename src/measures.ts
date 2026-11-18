// The measure tools: one tool per metric family, in place of one per route.
//
// A measure (`prices`, `trend`, `assortment`, ...) is asked with `subject` (an
// id from `resolve`, or a name), `by` (how the answer is split) and the
// filters the answering route takes. Each `(measure, by)` is one priced API
// route. The table is src/measures.generated.ts, rendered in the Syntalic
// repository from the same registry the API serves at /v1/measures.
//
// The translation happens HERE and the tool calls the route itself. So the
// tools work against any deployment of the API, whether or not it has opened
// its own /v1/measures paths, and a call costs what the route costs.
//
// On by default since 0.13.0: SYNTALIC_TOOLS unset (or `measures`) offers these
// in place of the per-route paid tools, and SYNTALIC_TOOLS=routes brings the
// per-route tools back (index.ts). Each tool is registered as measure_<name>,
// so a call to the bare name or to a route the playbooks name does not hit a
// measure. The free catalog tools and wallet_info stay either way.
//
// A split whose route the production API does not serve yet is left out of
// the tools (NOT_LIVE below), so a model is never offered a `by` that answers
// 404. The generated table keeps it: it is the API's registry, not this list.
// The per-route tool for such a route (SYNTALIC_TOOLS=routes) is not registered
// either (server.ts).
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  MEASURES,
  type MeasureDef,
  type MeasureParam,
  type MeasureSplit,
  type SubjectKind,
} from "./measures.generated.js";

export type QueryParams = Record<string, string | string[] | undefined>;

/**
 * Routes in the generated table that https://api.syntalic.com does not serve yet, with the API flag that
 * opens each. A split on one of them is not offered: no `by` for it, none of its parameters. Remove an
 * entry once the route is in the live /openapi.json; `npm run check:parity` names any entry that is, and
 * any measure route that is neither live nor listed here.
 */
export const NOT_LIVE: Readonly<Record<string, string>> = {
  "/v1/ontology/similar": "SIMILAR_BY_FOOTPRINT (off in production; the route answers 404)",
  "/v1/analyst/inflation": "INFLATION_ENABLED (off in production since 2026-11-16, too little price history; the route answers 404)",
};

/**
 * Parameters a route's OpenAPI entry declares but its validator does not read. The generated table
 * reads the spec, so it lists these as read; a measure call that sends one is refused as if the table
 * did not list it, since the API would drop it and answer a wider question than the one asked, at full
 * price. Each entry is a gap between the API's spec and its code: remove it once the API reads the
 * parameter or stops declaring it. `npm run check:parity` lists the entries on every run.
 */
export const UNREAD_PARAMS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "/v1/shopper/price-drop-alert": {
    time_window: "price-drop-alert reads lookback_days, not time_window",
  },
};

/** The parameters a split's route reads: the generated table's list, less UNREAD_PARAMS. */
export function paramsRead(split: MeasureSplit): string[] {
  const unread = UNREAD_PARAMS[split.route] ?? {};
  return split.params.filter((p) => !(p in unread));
}

/** A measure with its not-live splits taken out, its parameters cut to what the remaining splits read,
 *  and its default moved to the first remaining split if its own was taken out. Null when none remain. */
export function liveMeasure(measure: MeasureDef, notLive: Readonly<Record<string, string>> = NOT_LIVE): MeasureDef | null {
  const splits = measure.splits.filter((s) => !(s.route in notLive));
  if (splits.length === 0) return null;
  if (splits.length === measure.splits.length) return measure;
  const read = new Set(splits.flatMap((s) => s.params));
  return {
    ...measure,
    splits,
    params: measure.params.filter((p) => read.has(p.name)),
    default_by: splits.some((s) => s.by === measure.default_by) ? measure.default_by : splits[0]!.by,
  };
}

/** The measures the server offers: the generated table without the routes in NOT_LIVE. */
export const LIVE_MEASURES: readonly MeasureDef[] = MEASURES.map((m) => liveMeasure(m)).filter(
  (m): m is MeasureDef => m !== null,
);

const ID_SHAPES: Record<SubjectKind, RegExp> = {
  spt: /^[a-z]{2}(?:-\d+)*$/,
  gpc: /^\d{8}$/,
  brand: /^b_[0-9a-f]{16}$/,
  retailer: /^[a-z0-9]{1,64}$/,
  entity: /^[A-Za-z0-9_.:-]{1,128}$/,
};
const SPT_GID = "gid://shopify/TaxonomyCategory/";

/** An id as the API writes it (`kind:value`), or null for anything else: a
 *  name. Mirrors the API's parser, so a string is an id here exactly when it
 *  is one there. */
export function parseId(raw: string): { kind: SubjectKind; value: string } | null {
  const s = raw.trim();
  if (s.startsWith(SPT_GID)) {
    const value = s.slice(SPT_GID.length);
    return ID_SHAPES.spt.test(value) ? { kind: "spt", value } : null;
  }
  if (ID_SHAPES.brand.test(s)) return { kind: "brand", value: s };
  const colon = s.indexOf(":");
  if (colon <= 0) return null;
  const kind = s.slice(0, colon).toLowerCase() as SubjectKind;
  if (!(kind in ID_SHAPES)) return null;
  let value = s.slice(colon + 1);
  if (kind === "spt" && value.startsWith(SPT_GID)) value = value.slice(SPT_GID.length);
  return ID_SHAPES[kind].test(value) ? { kind, value } : null;
}

const CLASS_OF: Record<SubjectKind, NonNullable<MeasureSplit["about"]>> = {
  entity: "product",
  spt: "shelf",
  gpc: "shelf",
  brand: "brand",
  retailer: "retailer",
};

/** The route parameters that say what a request is about when it carries no
 *  subject id. */
const CLASS_PARAMS: Record<NonNullable<MeasureSplit["about"]>, readonly string[]> = {
  product: ["entity_uid", "product_uid", "q"],
  shelf: ["spt", "gpc", "category", "department", "node"],
  brand: ["brand_id", "brand"],
  retailer: ["retailer_id", "retailer"],
};

export type Translation =
  | { ok: true; split: MeasureSplit; route: string; params: QueryParams }
  | { ok: false; message: string };

const FREE = "Nothing was called or billed.";

/** `by period (a product)`, or `by drop` when no other split shares the `by`. */
function splitName(split: MeasureSplit): string {
  return `by ${split.by}${split.about ? ` (a ${split.about})` : ""}`;
}

/** The refusal for parameters a split's route does not read: which they are, what the route does
 *  read, and which splits read each of them. */
function unreadMessage(measure: MeasureDef, split: MeasureSplit, unread: string[]): string {
  const tool = measureToolName(measure.name);
  const notes = unread.map((name) => UNREAD_PARAMS[split.route]?.[name]).filter((n): n is string => !!n);
  const elsewhere = unread.map((name) => {
    const by = measure.splits.filter((s) => s !== split && paramsRead(s).includes(name)).map(splitName);
    return by.length ? `${name} is read ${by.join(", ")}` : `no split of ${tool} reads ${name}`;
  });
  return (
    `${tool} ${splitName(split)} is answered by ${split.route}, which does not read ${unread.join(", ")}` +
    (notes.length ? ` (${notes.join("; ")})` : "") +
    `. The API would drop ${unread.length > 1 ? "them" : "it"} and answer a wider question. ` +
    `It reads: ${paramsRead(split).join(", ")}. ${elsewhere.join("; ")}. ` +
    `Leave ${unread.length > 1 ? "them" : "it"} out, or change by. ${FREE}`
  );
}

function kindsOf(split: MeasureSplit): string[] {
  const kinds = Object.keys(split.subject).map((k) => `${k}:`);
  if (split.name) kinds.push("a name");
  return kinds;
}

/**
 * Which route a measure call names, and with which parameters.
 *
 * It decides three things: the split `by` names, where `subject` goes, and
 * whether the two contradict what else was sent. Whether the values are any
 * good is the route's call, and it refuses a bad one free.
 */
export function translate(
  measure: MeasureDef,
  args: { subject?: string; by?: string; [param: string]: unknown },
): Translation {
  const bys = [...new Set(measure.splits.map((s) => s.by))];
  const by = (args.by ?? "").trim().toLowerCase() || measure.default_by;
  const candidates = measure.splits.filter((s) => s.by === by);
  if (candidates.length === 0) {
    return { ok: false, message: `Unknown by "${by}" for ${measure.name}. Use one of: ${bys.join(", ")}. ${FREE}` };
  }

  // Everything sent, by name. Which of it goes to the route is settled once
  // the split is known: a tool offers the union of its routes' parameters.
  const sent: QueryParams = {};
  for (const p of measure.params) {
    const v = args[p.name];
    if (v === undefined || v === null || v === "") continue;
    sent[p.name] = Array.isArray(v) ? v.map(String) : String(v);
  }

  // The weekly series has a parameter of its own called `subject`, beside
  // `subject_kind`: with that sent, the subject is the route's and passes
  // through as it is.
  const ownSubject =
    candidates.length === 1 && candidates[0]!.own_subject === true && sent.subject_kind !== undefined;
  const subject = (args.subject ?? "").trim();
  const id = subject && !ownSubject ? parseId(subject) : null;

  let split: MeasureSplit | undefined;
  if (candidates.length === 1) {
    split = candidates[0];
  } else {
    const classes = candidates.map((s) => s.about).filter((c): c is NonNullable<MeasureSplit["about"]> => !!c);
    const fromParams = classes.filter((c) => CLASS_PARAMS[c].some((p) => sent[p] !== undefined));
    const cls = id ? CLASS_OF[id.kind] : fromParams.length === 1 ? fromParams[0] : undefined;
    split = cls ? candidates.find((s) => s.about === cls) : undefined;
    if (!split) {
      const ids = [...new Set(candidates.flatMap((s) => Object.keys(s.subject)))].map((k) => `${k}:`);
      return {
        ok: false,
        message:
          `${measure.name} by ${by} can be about ${classes.join(", ")}. Say which with a subject id ` +
          `(${ids.join(", ")}) or the matching parameter. ${FREE}`,
      };
    }
  }
  if (!split) return { ok: false, message: `Unknown by "${by}" for ${measure.name}. ${FREE}` };

  // A tool offers the union of its splits' parameters, so one this split's route does not read looks
  // valid. Sent, the API drops it and answers a wider question than the one asked, at full price
  // (SYNLBS-266: time_window on a product's history). So it is refused here, free, with the split
  // that reads it. What a route reads comes from the generated table, so this follows the API.
  const reads = new Set(paramsRead(split));
  const unread = Object.keys(sent).filter((name) => !reads.has(name));
  if (unread.length > 0) return { ok: false, message: unreadMessage(measure, split, unread) };
  const params: QueryParams = { ...sent };

  if (ownSubject) {
    params.subject = subject || undefined;
  } else if (subject) {
    const target = id ? split.subject[id.kind] : split.name ? { param: split.name, as: "id" as const } : undefined;
    if (!target) {
      const takes = kindsOf(split);
      return {
        ok: false,
        message:
          `${measure.name} by ${by} does not take ${id ? `a ${id.kind} id` : "a name"} as its subject. ` +
          (takes.length ? `It takes ${takes.join(", ")}.` : "It takes no subject: send its own parameters.") +
          ` ${FREE}`,
      };
    }
    if (params[target.param] !== undefined) {
      return { ok: false, message: `Send subject or ${target.param}, not both: they name the same thing here. ${FREE}` };
    }
    params[target.param] = target.as === "value" && id ? id.value : subject;
  }

  for (const [name, value] of Object.entries(split.fixed ?? {})) {
    if (params[name] !== undefined && params[name] !== value) {
      return { ok: false, message: `${measure.name} by ${by} fixes ${name}=${value}. Leave ${name} out, or change by. ${FREE}` };
    }
    params[name] = value;
  }

  return { ok: true, split, route: split.route, params };
}

function paramSchema(p: MeasureParam): z.ZodTypeAny {
  let base: z.ZodTypeAny;
  const numeric = p.type === "integer" || p.type === "number";
  if (p.enum && p.enum.length > 0 && numeric) {
    // The API's own values, as numbers (win is 7, 30 or 90).
    const [first, second, ...rest] = p.enum.map((v) => z.literal(Number(v)));
    base = second ? z.union([first!, second, ...rest]) : first!;
  } else if (p.enum && p.enum.length > 0) {
    base = z.enum(p.enum.map(String) as [string, ...string[]]);
  } else if (numeric) {
    // The route's own bounds, so an out-of-range value is caught here.
    let n = z.number();
    if (p.type === "integer") n = n.int();
    if (p.minimum !== undefined) n = n.min(p.minimum);
    if (p.maximum !== undefined) n = n.max(p.maximum);
    base = n;
  } else if (p.type === "boolean") base = z.boolean();
  else base = z.string();
  if (p.array) base = z.array(base);
  return (p.description ? base.describe(p.description) : base).optional();
}

/** `$0.01`, or `$0.01 to $0.02` when the splits' routes differ in price. */
function priceRange(measure: MeasureDef): string {
  const prices = [...new Set(measure.splits.map((s) => s.price_usd))].sort((a, b) => Number(a) - Number(b));
  return prices.length === 1 ? `$${prices[0]}` : `$${prices[0]} to $${prices[prices.length - 1]}`;
}

/** The name the server registers. A bare measure name (`prices`, `resolve`) is
 *  what a model calls when a playbook said a route (`price_positioning`,
 *  `ontology_resolve`) and the two vocabularies get mixed. The prefix keeps
 *  the measure tools from answering that call. */
export function measureToolName(name: string): string {
  return `measure_${name}`;
}

/** What the model reads to pick the tool and the split. The route's last
 *  segment is named beside each split: the playbooks and earlier versions of
 *  this server call the routes by it. That segment is not a tool name. */
export function describeMeasure(measure: MeasureDef): string {
  const mixed = new Set(measure.splits.map((s) => s.price_usd)).size > 1;
  const splits = measure.splits.map((s) => {
    const about = s.about ? ` for a ${s.about}` : "";
    const tag = s.by === measure.default_by ? " (default)" : "";
    const price = mixed ? `, $${s.price_usd}` : "";
    return `${s.by}${about}${tag}: ${s.answers} [${s.route.split("/").pop()}${price}]`;
  });
  const tool = measureToolName(measure.name);
  return (
    `${measure.summary} Costs ${priceRange(measure)} per call. Call ${tool}. ` +
    `\`${measure.name}\` and the names in square brackets are not tools. ` +
    `\`by\` picks the split. ${splits.join("; ")}. ` +
    `\`subject\` is what it is about: an id from ${measureToolName("resolve")} (spt:, gpc:, brand:, retailer:, entity:) or a name. ` +
    "A split that cannot take the subject is refused before anything is billed, with what it takes."
  );
}

/** What a client is told at connection when the measure tools are on (the default). */
export const MEASURE_INSTRUCTIONS =
  "Syntalic prices, brands and shelves. Free: wallet_info and the catalog discovery tools. Every other tool is a " +
  "measure, and its name starts with measure_: measure_offers, measure_prices, measure_trend, measure_promotions, " +
  "measure_assortment (the shelf), measure_attention, measure_signals (social), measure_scout (social against shelf), " +
  "and measure_resolve, measure_neighbors, measure_coverage (names to ids, what sits next to an id, the evidence " +
  "behind it). Call those names. The bare names (offers, prices, resolve) are not tools. Each states its cost in " +
  "its description and takes `by` (how the answer is split) and `subject` (what it is about). When a question names " +
  "a brand, category, product type, retailer or product, call measure_resolve once per conversation (one concept " +
  "per term) and use the ids it returns as `subject`. A name that fits several things returns all of them as " +
  "co-equals: never pick one silently. Say 'not seen at X' only when X is in retailers_scanned. A malformed " +
  "request, or an argument the chosen split does not read, is refused before anything is billed. Each entry in " +
  "an answer's suggested_next_calls names the measure tool, by and subject to call, and args for the rest; one " +
  "marked callable: false has no tool here. The playbook prompts and the resources syntalic://ontology/rules " +
  "and syntalic://ontology/metrics name tools by their route (price_positioning, ontology_resolve). Those are not " +
  "tools in this mode: each is a split of a measure, named in square brackets in that measure's description.";

export type MeasureQuery = (
  path: string,
  params: QueryParams,
  opts: { compact: boolean },
) => Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }>;

/** A measure tool's input schema: `subject`, `by`, and every parameter its splits' routes read. */
export function measureShape(measure: MeasureDef): Record<string, z.ZodTypeAny> {
  const bys = [...new Set(measure.splits.map((s) => s.by))] as [string, ...string[]];
  const shape: Record<string, z.ZodTypeAny> = {
    subject: z
      .string()
      .optional()
      .describe("What the question is about: an id from resolve (spt:, gpc:, brand:, retailer:, entity:) or a name."),
    by: z.enum(bys).optional().describe(`How the answer is split. Default ${measure.default_by}.`),
  };
  for (const p of measure.params) {
    if (p.name in shape) continue;
    shape[p.name] = paramSchema(p);
  }
  return shape;
}

/** A call the API suggests next (`suggested_next_calls`): a route and its query arguments. */
export interface RouteCall {
  route: string;
  args: Record<string, string | string[]>;
}

/** The measure tool call that reaches a suggested route call with the same arguments. */
export interface MeasureCall {
  tool: string;
  by: string;
  subject?: string;
  /** The tool's other arguments, typed as its schema takes them. */
  args: Record<string, unknown>;
}

/** A query's parameters as one string or a list, for comparing two of them. */
function sameQuery(a: QueryParams, b: QueryParams): boolean {
  const norm = (q: QueryParams) =>
    JSON.stringify(
      Object.entries(q)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, Array.isArray(v) ? v.map(String) : String(v)])
        .sort(([x], [y]) => String(x).localeCompare(String(y))),
    );
  return norm(a) === norm(b);
}

/**
 * The measure tool, `by` and `subject` that make the same request as a route call the API suggested,
 * or null when no live split does. Read off the generated table (route to split, where a subject of
 * each kind goes, each parameter's type) and checked by translating the result back: it is offered
 * only if the tool would send exactly the route and arguments the API suggested.
 */
export function measureCallFor(call: RouteCall, measures: readonly MeasureDef[] = LIVE_MEASURES): MeasureCall | null {
  const fits = (s: MeasureSplit) => Object.entries(s.fixed ?? {}).every(([k, v]) => call.args[k] === undefined || call.args[k] === v);
  let options = measures.flatMap((m) => m.splits.filter((s) => s.route === call.route && fits(s)).map((s) => ({ m, s })));
  // promo-intelligence is two splits, told apart by the aggregate_by each fixes. A call that names
  // its aggregate_by is that split; one that does not gets the route's default, which is the measure's.
  if (options.length > 1) {
    const named = options.filter(({ s }) => Object.keys(s.fixed ?? {}).every((k) => call.args[k] !== undefined));
    options = named.length > 0 ? named : options.filter(({ m, s }) => s.by === m.default_by);
  }
  if (options.length !== 1) return null;
  const { m, s } = options[0]!;

  // An argument the route does not read changes nothing there (the API ignores it: country=ca on a
  // social route), so the tool call leaves it out rather than be refused for it.
  const read = new Set(paramsRead(s));
  const used = Object.fromEntries(Object.entries(call.args).filter(([k]) => read.has(k)));
  const rest: Record<string, string | string[]> = { ...used };
  for (const k of Object.keys(s.fixed ?? {})) delete rest[k];
  let subject: string | undefined;
  for (const [kind, target] of Object.entries(s.subject) as [SubjectKind, { param: string; as: "id" | "value" }][]) {
    const v = rest[target.param];
    if (typeof v !== "string") continue;
    const id = target.as === "id" ? v : `${kind}:${v}`;
    if (parseId(id)?.kind !== kind) continue;
    subject = id;
    delete rest[target.param];
    break;
  }

  const args: Record<string, unknown> = {};
  for (const [name, v] of Object.entries(rest)) {
    const p = m.params.find((x) => x.name === name);
    if (!p) return null;
    const one = (x: string): unknown =>
      p.type === "integer" || p.type === "number" ? Number(x) : p.type === "boolean" ? x === "true" : x;
    args[name] = Array.isArray(v) ? v.map(one) : p.array ? [one(v)] : one(v);
  }
  const out: MeasureCall = { tool: measureToolName(m.name), by: s.by, ...(subject ? { subject } : {}), args };

  // The proof: what the tool takes, and what it would send.
  if (!z.object(measureShape(m)).safeParse({ by: out.by, subject: out.subject, ...args }).success) return null;
  const back = translate(m, { by: out.by, subject: out.subject, ...args });
  if (!back.ok || back.route !== call.route) return null;
  if (!sameQuery(back.params, { ...used, ...(s.fixed ?? {}) })) return null;
  return out;
}

/** Register one tool per measure. `query` is the server's paid fetch. */
export function registerMeasureTools(
  server: McpServer,
  query: MeasureQuery,
  annotations: (name: string) => ToolAnnotations,
): void {
  for (const measure of LIVE_MEASURES) {
    const tool = measureToolName(measure.name);
    server.tool(tool, describeMeasure(measure), measureShape(measure), annotations(tool), async (args) => {
      const out = translate(measure, args as Record<string, unknown>);
      if (!out.ok) return { content: [{ type: "text" as const, text: out.message }], isError: true };
      return query(out.route, out.params, { compact: true });
    });
  }
}
