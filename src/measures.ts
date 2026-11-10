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
// Off by default: SYNTALIC_TOOLS=measures swaps the per-route paid tools for
// these (index.ts). The free catalog tools and wallet_info stay either way.
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

  const params: QueryParams = {};
  for (const p of measure.params) {
    const v = args[p.name];
    if (v === undefined || v === null || v === "") continue;
    params[p.name] = Array.isArray(v) ? v.map(String) : String(v);
  }

  // The weekly series has a parameter of its own called `subject`, beside
  // `subject_kind`: with that sent, the subject is the route's and passes
  // through as it is.
  const ownSubject =
    candidates.length === 1 &&
    measure.params.some((p) => p.name === "subject_kind") &&
    candidates[0]!.route.endsWith("/series") &&
    params.subject_kind !== undefined;
  const subject = (args.subject ?? "").trim();
  const id = subject && !ownSubject ? parseId(subject) : null;

  let split: MeasureSplit | undefined;
  if (candidates.length === 1) {
    split = candidates[0];
  } else {
    const classes = candidates.map((s) => s.about).filter((c): c is NonNullable<MeasureSplit["about"]> => !!c);
    const fromParams = classes.filter((c) => CLASS_PARAMS[c].some((p) => params[p] !== undefined));
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

  // A parameter the chosen route does not read is left out: the tool offers
  // the union of its routes' parameters, and the route would only ignore it.
  return { ok: true, split, route: split.route, params };
}

function paramSchema(p: MeasureParam): z.ZodTypeAny {
  let base: z.ZodTypeAny;
  if (p.enum && p.enum.length > 0) base = z.enum(p.enum as [string, ...string[]]);
  else if (p.type === "integer" || p.type === "number") base = z.number();
  else if (p.type === "boolean") base = z.boolean();
  else base = z.string();
  if (p.array) base = z.array(base);
  return (p.description ? base.describe(p.description) : base).optional();
}

/** `$0.01`, or `$0.01 to $0.02` when the splits' routes differ in price. */
function priceRange(measure: MeasureDef): string {
  const prices = [...new Set(measure.splits.map((s) => s.price_usd))].sort((a, b) => Number(a) - Number(b));
  return prices.length === 1 ? `$${prices[0]}` : `$${prices[0]} to $${prices[prices.length - 1]}`;
}

/** What the model reads to pick the tool and the split. The route's last
 *  segment is named beside each split: the playbooks and earlier versions of
 *  this server call the routes by it. */
export function describeMeasure(measure: MeasureDef): string {
  const mixed = new Set(measure.splits.map((s) => s.price_usd)).size > 1;
  const splits = measure.splits.map((s) => {
    const about = s.about ? ` for a ${s.about}` : "";
    const tag = s.by === measure.default_by ? " (default)" : "";
    const price = mixed ? `, $${s.price_usd}` : "";
    return `${s.by}${about}${tag}: ${s.answers} [${s.route.split("/").pop()}${price}]`;
  });
  return (
    `${measure.summary} Costs ${priceRange(measure)} per call. ` +
    `\`by\` picks the split. ${splits.join("; ")}. ` +
    "`subject` is what it is about: an id from resolve (spt:, gpc:, brand:, retailer:, entity:) or a name. " +
    "A split that cannot take the subject is refused before anything is billed, with what it takes."
  );
}

/** What a client is told at connection when the measure tools are on. */
export const MEASURE_INSTRUCTIONS =
  "Syntalic prices, brands and shelves. Free: wallet_info and the catalog discovery tools. Every other tool is a " +
  "measure, and states its cost in its description: offers, prices, trend, promotions, assortment (the shelf), " +
  "attention, signals (social), scout (social against shelf), and resolve, neighbors, coverage (names to ids, what " +
  "sits next to an id, the evidence behind it). Each takes `by` (how the answer is split) and `subject` (what it is " +
  "about). When a question names a brand, category, product type, retailer or product, call resolve once per " +
  "conversation (one concept per term) and use the ids it returns as `subject`. A name that fits several things " +
  "returns all of them as co-equals: never pick one silently. Say 'not seen at X' only when X is in " +
  "retailers_scanned. A malformed request is refused before anything is billed. " +
  "The playbook prompts and the resources syntalic://ontology/rules and syntalic://ontology/metrics name tools by " +
  "their route (price_positioning, ontology_resolve): each is a split of a measure, named in square brackets in that " +
  "measure's description.";

export type MeasureQuery = (
  path: string,
  params: QueryParams,
  opts: { compact: boolean },
) => Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }>;

/** Register one tool per measure. `query` is the server's paid fetch. */
export function registerMeasureTools(
  server: McpServer,
  query: MeasureQuery,
  annotations: (name: string) => ToolAnnotations,
): void {
  for (const measure of MEASURES) {
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
    server.tool(measure.name, describeMeasure(measure), shape, annotations(measure.name), async (args) => {
      const out = translate(measure, args as Record<string, unknown>);
      if (!out.ok) return { content: [{ type: "text" as const, text: out.message }], isError: true };
      return query(out.route, out.params, { compact: true });
    });
  }
}
