import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { createPaidFetch, PaymentError } from "./lib/fetch.js";
import { registerGuidance, SERVER_INSTRUCTIONS } from "./guidance.js";
import {
  countrySchema,
  retailerSchema,
  daysSchema,
  windowSchema,
  platformSchema,
  organicOnlySchema,
  socialLimitSchema,
  sptSchema,
  gpcSchema,
  brandIdSchema,
  entityUidSchema,
} from "./lib/schemas.js";

// Read the real version rather than a second hand-maintained copy: this said
// 0.6.0 while the package was on 0.9.0, so every client saw the wrong version.
const VERSION: string = createRequire(import.meta.url)("../package.json").version;

/** Tools that cost nothing and change nothing. Every other tool spends USDC from the user's wallet. */
const FREE_TOOLS: ReadonlySet<string> = new Set([
  "wallet_info",
  "catalog_overview",
  "browse_categories",
  "list_retailers",
  "list_brands",
  "coverage_map",
  "ontology_resolve",
  "ontology_neighbors",
  "ontology_coverage",
]);

/** MCP tool annotations (advisory: clients may use them to decide what to confirm). A paid tool is
 *  NOT read-only: running it moves the user's money, and running it twice spends twice, which is
 *  what a client that auto-approves read-only tools must not do for it. Approval and the wallet's
 *  own balance remain the enforcement. */
function annotationsFor(name: string): ToolAnnotations {
  return FREE_TOOLS.has(name)
    ? { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    : { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
}

/** A category given by NAME. Optional because the same tools take `spt` or `gpc` instead
 *  (ids from ontology_resolve); the API refuses a call that names none, free of charge. */
const categoryNameSchema = (what: string) =>
  z.string().optional().describe(`${what}. Send this OR spt OR gpc (ids from ontology_resolve), not more than one.`);

/** A brand given by NAME; `brand_id` is the alternative. */
const brandNameSchema = (what: string) =>
  z.string().optional().describe(`${what}. Send this OR brand_id (from ontology_resolve), not both.`);

export interface ServerConfig {
  apiBase: string;
  evmPrivateKey: string;
  solanaPrivateKey: string;
  apiKey?: string;
  /** True if the user has run --setup at least once to view their keys. */
  backupAcknowledged?: boolean;
}

export async function createServer(config: ServerConfig): Promise<McpServer> {
  const server = new McpServer(
    {
      name: "syntalic-pricing-intelligence",
      version: VERSION,
    },
    { instructions: SERVER_INSTRUCTIONS },
  );

  // createPaidFetch validates both keys (throws a helpful error on malformed input)
  // and returns the derived addresses, so we don't redo the parsing here.
  const { fetch: paidFetch, evmAddress, solanaAddress } = await createPaidFetch({
    evmPrivateKey: config.evmPrivateKey,
    solanaPrivateKey: config.solanaPrivateKey,
  });

  // ── Wallet info tool ────────────────────────────────────────────

  server.tool(
    "wallet_info",
    "Show your wallet addresses and funding instructions for all supported chains. Call this if a payment fails or to check your wallet. Keys are never exposed via MCP tools — to see addresses + config without revealing keys, the user can run `npx @syntalic/mcp-server --info` in their terminal. To export private keys for backup/import, they run `--export-keys` instead.",
    {},
    annotationsFor("wallet_info"),
    async () => {
      const lines: string[] = [
        "Wallets (client auto-picks the chain with balance per query):",
        "",
        "  Base / Tempo (EVM): " + evmAddress,
        "    • Fund with USDC on Base — https://www.coinbase.com or any Base bridge",
        "    • Native Base USDC contract: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        "    • Or USDC.e on Tempo — https://tempo.xyz",
        "",
        "  Solana:             " + solanaAddress,
        "    • Fund with USDC on Solana — https://www.coinbase.com or any Solana wallet",
        "    • USDC mint: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        "",
        "Each query costs 0.01-0.02 USDC. Even 1 USDC gets you 50-100 queries.",
        "",
        "CLI commands (run in your own terminal, not via MCP):",
        "  --info         Show wallet paths, endpoints, and backup status (no keys shown)",
        "  --export-keys  Dump private keys for backup or importing into MetaMask/Phantom",
        "",
        "Bring your own keys instead? Set these env vars and the wallet file is ignored:",
        "  SYNTALIC_EVM_PRIVATE_KEY, SYNTALIC_SOLANA_PRIVATE_KEY",
      ];

      // Fail-safe default: if the caller never set this field (undefined),
      // still nag about backup. The cost of a spurious warning is low; the
      // cost of silently skipping it is unrecoverable funds.
      if (config.backupAcknowledged !== true) {
        lines.push(
          "",
          "⚠️  You have not exported your private keys yet. Run --export-keys before",
          "   funding — if ~/.syntalic/wallet.json is deleted without a backup, any USDC",
          "   sent to these addresses becomes unrecoverable.",
        );
      }

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    },
  );

  async function query(path: string, params: Record<string, string | undefined>) {
    const url = new URL(path, config.apiBase);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) url.searchParams.set(k, v);
    }

    const headers: Record<string, string> = {};
    if (config.apiKey) headers["X-API-Key"] = config.apiKey;

    let res: Response;
    try {
      res = await paidFetch(url.toString(), { headers });
    } catch (err) {
      // Surface PaymentError with per-chain detail as a bullet list. Models
      // tend to paraphrase paragraph-style errors into generic "insufficient
      // balance" — bullets survive summarization better and let the user see
      // exactly which chain reported what, which is the information needed
      // to diagnose (wrong token, funded elsewhere, facilitator issue, etc).
      if (err instanceof PaymentError) {
        const perChain = err.attempts.length > 0
          ? err.attempts.map((a) => `  • ${a.network} — ${a.reason}`).join("\n")
          : "  • no supported chains advertised by server";
        const text = [
          "Payment failed. Per-chain reasons:",
          "",
          perChain,
          "",
          "Next steps:",
          "  • Run `wallet_info` to see funding addresses.",
          "  • Native Base USDC is `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` — do not fund USDbC / USDC.e on Base.",
          "  • If a chain reports insufficient balance but the wallet is funded, verify the token contract on that chain.",
        ].join("\n");
        return { content: [{ type: "text" as const, text }], isError: true };
      }
      throw err;
    }

    if (res.status === 402) {
      // paidFetch must settle or throw PaymentError. A 402 here is a client
      // bug — never return the payment-required body as the tool result.
      return {
        content: [
          {
            type: "text" as const,
            text: "Payment required after retry. This is an MCP client bug, not an API miss. Run wallet_info.",
          },
        ],
        isError: true,
      };
    }

    if (!res.ok) {
      const text = await res.text();
      return {
        content: [{ type: "text" as const, text: `Error ${res.status}: ${text}` }],
        isError: true,
      };
    }

    const data = await res.json();
    return {
      content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    };
  }

  // Free discovery reads: the /v1/public/* surface is unauthenticated and never
  // payment-gated, so it uses a plain fetch (no wallet / no x402 handshake).
  // Bounded at 15s: without a signal, a black-holed connection would hang the
  // tool call for as long as the MCP client tolerates.
  const PUBLIC_FETCH_TIMEOUT_MS = 15_000;
  async function queryPublic(path: string, params: Record<string, string | undefined>) {
    const url = new URL(path, config.apiBase);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) url.searchParams.set(k, v);
    }
    let res: Response;
    try {
      res = await fetch(url.toString(), { signal: AbortSignal.timeout(PUBLIC_FETCH_TIMEOUT_MS) });
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Network error: ${(err as Error).message}` }],
        isError: true,
      };
    }
    if (!res.ok) {
      const text = await res.text();
      return {
        content: [{ type: "text" as const, text: `Error ${res.status}: ${text}` }],
        isError: true,
      };
    }
    // A proxy/LB can hand back non-JSON with a 200; surface it as a tool
    // error instead of throwing out of the handler.
    let data: unknown;
    try {
      data = await res.json();
    } catch {
      return {
        content: [{ type: "text" as const, text: "Error: API returned a non-JSON response" }],
        isError: true,
      };
    }
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  }

  // The free ontology routes (/v1/ontology/*) are keyed, not paid: an API key in
  // X-API-Key, no wallet and no x402 handshake. The key is SYNTALIC_API_KEY, the
  // variable that already carries a staff key on the paid routes; a staff key is
  // admitted here too. A batch is REPEATED parameters (term=a&term=b): the routes refuse
  // the comma-joined spelling, because a comma can sit inside a real name.
  //
  // Compact JSON on purpose: an ontology answer is the largest thing an agent reads
  // (every match carries its coverage), and indentation is tokens spent on nothing.
  async function queryOntology(path: string, params: Record<string, string | string[] | undefined>) {
    if (!config.apiKey) {
      return {
        content: [
          {
            type: "text" as const,
            text:
              "The ontology tools need a free Syntalic API key. Set SYNTALIC_API_KEY in this MCP server's " +
              "environment and restart it. (A wallet is not needed for these tools, and the key is not a " +
              "wallet key.) Until then, the paid tools still work with names; ids from the ontology need the key.",
          },
        ],
        isError: true,
      };
    }
    const url = new URL(path, config.apiBase);
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined) continue;
      for (const item of Array.isArray(v) ? v : [v]) url.searchParams.append(k, item);
    }
    let res: Response;
    try {
      res = await fetch(url.toString(), {
        headers: { "X-API-Key": config.apiKey, accept: "application/json" },
        signal: AbortSignal.timeout(PUBLIC_FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Network error: ${(err as Error).message}` }],
        isError: true,
      };
    }
    if (!res.ok) {
      const text = await res.text();
      let detail = text;
      try {
        const body = JSON.parse(text) as { error?: { code?: string; message?: string } };
        if (body.error?.message) detail = `${body.error.code ?? res.status}: ${body.error.message}`;
      } catch {
        // not JSON: show what came back
      }
      const hint =
        res.status === 401 || res.status === 403
          ? " The ontology routes are keyed: check that SYNTALIC_API_KEY is a valid Syntalic API key."
          : res.status === 503
            ? " The ontology may not be published yet. Paid tools still work with names."
            : "";
      return {
        content: [{ type: "text" as const, text: `Error ${res.status}: ${detail}${hint}` }],
        isError: true,
      };
    }
    let data: unknown;
    try {
      data = await res.json();
    } catch {
      return {
        content: [{ type: "text" as const, text: "Error: API returned a non-JSON response" }],
        isError: true,
      };
    }
    return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
  }

  // ── Public discovery (FREE — no payment) ────────────────────────
  // Understand the shape/coverage of the catalog before spending on a paid query.

  server.tool(
    "catalog_overview",
    "See the shape of the catalog: total unique products, listings, brands, categories, retailers, price observations, and the last-updated timestamp. FREE — no payment. Call this first to understand what data exists before spending on a paid query.",
    {},
    annotationsFor("catalog_overview"),
    async () => queryPublic("/v1/public/stats", {}),
  );

  server.tool(
    "browse_categories",
    "Browse the product category tree with per-node product counts. FREE — no payment. Pass parent_path to drill into a subtree.",
    {
      parent_path: z
        .string()
        .optional()
        .describe("Category path to list descendants of (e.g. electronics). Omit for top-level."),
      depth: z.number().int().min(1).max(3).optional().describe("Levels below parent_path (default 1, max 3)"),
      limit: z.number().int().min(1).max(500).optional().describe("Page size (default 200)"),
      offset: z.number().int().min(0).optional().describe("Pagination offset"),
    },
    annotationsFor("browse_categories"),
    async ({ parent_path, depth, limit, offset }) =>
      queryPublic("/v1/public/categories", {
        parent_path,
        depth: depth?.toString(),
        limit: limit?.toString(),
        offset: offset?.toString(),
      }),
  );

  server.tool(
    "list_retailers",
    "List the retailers (platforms) in the catalog with product counts, countries covered, and freshness. FREE — no payment.",
    {
      limit: z.number().int().min(1).max(500).optional().describe("Page size (default 100)"),
      offset: z.number().int().min(0).optional().describe("Pagination offset"),
    },
    annotationsFor("list_retailers"),
    async ({ limit, offset }) =>
      queryPublic("/v1/public/retailers", { limit: limit?.toString(), offset: offset?.toString() }),
  );

  server.tool(
    "list_brands",
    "List the brands in the catalog with product counts. FREE — no payment. Optional q prefix-matches the brand name (case/punctuation-insensitive: 'sam' → Samsung).",
    {
      q: z.string().optional().describe("Prefix filter on the brand name"),
      limit: z.number().int().min(1).max(500).optional().describe("Page size (default 100)"),
      offset: z.number().int().min(0).optional().describe("Pagination offset"),
    },
    annotationsFor("list_brands"),
    async ({ q, limit, offset }) =>
      queryPublic("/v1/public/brands", { q, limit: limit?.toString(), offset: offset?.toString() }),
  );

  server.tool(
    "coverage_map",
    "See where the catalog is deep vs thin: priced product counts and a quality status (serving/thin/unmanaged/empty) per retailer × country × category. FREE — no payment. Use this to check whether a paid query will hit good data before you spend. Filter by country, platform, category_root, or quality_status.",
    {
      country: countrySchema,
      platform: z.string().optional().describe("Filter to a platform (e.g. amazon, walmart)"),
      category_root: z.string().optional().describe("Filter to a top-level category (e.g. electronics)"),
      quality_status: z
        .enum(["serving", "thin", "unmanaged", "empty"])
        .optional()
        .describe("Filter to a coverage tier"),
      limit: z.number().int().min(1).max(1000).optional().describe("Page size (default 200)"),
      offset: z.number().int().min(0).optional().describe("Pagination offset"),
    },
    annotationsFor("coverage_map"),
    async ({ country, platform, category_root, quality_status, limit, offset }) =>
      queryPublic("/v1/public/coverage", {
        country,
        platform,
        category_root,
        quality_status,
        limit: limit?.toString(),
        offset: offset?.toString(),
      }),
  );

  // ── Ontology (FREE — keyed, no payment) ─────────────────────────
  // What a name means, what sits next to it, and how much evidence stands behind it.
  // Three tools under one prefix; everything else stays available, and nothing here
  // routes the agent: `suggested_next_calls` in each answer is advice with ids and prices.

  server.tool(
    "ontology_resolve",
    "FREE — no payment (needs a free API key in SYNTALIC_API_KEY). Use when a question names a " +
      "brand, category, product type, retailer or product: it turns each name into ids. One " +
      "concept per term (\"protein bars\", \"gerber\"); \"woman-owned candy\" is two terms. EVERY thing a " +
      "term can name comes back and none is ranked best: a name that fits two shelves or two " +
      "brands returns both as co-equals (`co_equal`), so never pick one silently: run each, or " +
      "ask. Each match carries an `id`, the `key` of a category, and coverage counts. A term " +
      "that names nothing returns a `miss` with the reason and close candidates, never a guess. " +
      "Each result ends with `suggested_next_calls`: calls that make sense next, with the ids " +
      "filled in and the price beside each. Pass an id to the paid tools as `spt`, `gpc` or " +
      "`brand_id` instead of a name.",
    {
      terms: z
        .array(z.string().min(1).max(200))
        .min(1)
        .max(25)
        .describe("One concept per term, answered in the same order. Up to 25."),
      kinds: z
        .array(z.enum(["category", "product_type", "brand", "retailer", "entity"]))
        .optional()
        .describe(
          "Which kinds a term may resolve to. Omit for category, product_type, brand and retailer. Add 'entity' to find one specific product (a brand plus its words).",
        ),
      within: z
        .string()
        .optional()
        .describe(
          "An spt: or gpc: id for the shelf the question is on, when you already know it. Hits outside it move to `also_ok`.",
        ),
      country: countrySchema,
    },
    annotationsFor("ontology_resolve"),
    async ({ terms, kinds, within, country }) =>
      queryOntology("/v1/ontology/resolve", { term: terms, kinds: kinds?.join(","), within, country }),
  );

  server.tool(
    "ontology_neighbors",
    "FREE — no payment (needs a free API key in SYNTALIC_API_KEY). Use for what sits next to ONE " +
      "id from ontology_resolve. A category (spt:): ancestors, children, siblings, the product " +
      "types filed under it, its top brands and chains. A product type (gpc:): its ancestry and " +
      "every shelf it is filed under. A brand (brand:): the shelves it sells on (`footprint`), " +
      "the chains that carry it (`carried_at`) and the chains we scanned where it lives that do " +
      "NOT (`not_observed_at`). A chain (retailer:): what it sells and which brands it carries. " +
      "Pick blocks with `relations`; every list says its `total`.",
    {
      id: z
        .string()
        .min(1)
        .describe("One id exactly as ontology_resolve returned it: spt:…, gpc:…, brand:… or retailer:…"),
      relations: z
        .array(z.string().min(1))
        .optional()
        .describe(
          "Blocks to return. category: ancestors, children, siblings, types, parallel_homes, aliases, top_brands, top_retailers. product type: ancestry, homes, siblings, aliases. brand: profile, aliases, footprint, carried_at, not_observed_at. chain: profile, assortment, brands. Omit for the kind's defaults.",
        ),
      limit: z.number().int().min(1).max(200).optional().describe("Most items per list (default 25)."),
      country: countrySchema,
    },
    annotationsFor("ontology_neighbors"),
    async ({ id, relations, limit, country }) =>
      queryOntology("/v1/ontology/neighbors", {
        id,
        relations: relations?.join(","),
        limit: limit?.toString(),
        country,
      }),
  );

  server.tool(
    "ontology_coverage",
    "FREE — no payment (needs a free API key in SYNTALIC_API_KEY). Use before you hedge, choose a " +
      "grain (shelf or parent) or spend: how much evidence stands behind ids, and what was looked " +
      "at. Listings, freshness, `channels_present` and `channels_not_observed` (a channel with no " +
      "evidence at all), and `retailers_scanned`. These are the denominators of an absence claim: " +
      "say 'not seen at X' ONLY when X is in `retailers_scanned` for that shelf; a chain outside " +
      "it is unknown, not absent. With `retailer` and a brand id it answers one question: seen " +
      "there, scanned and not seen (`absence: not_observed`), or not scanned (`absence: " +
      "unscanned`: nothing can be said). An id that names nothing comes back `found: false`.",
    {
      ids: z
        .array(z.string().min(1))
        .min(1)
        .max(25)
        .describe("Ids exactly as ontology_resolve returned them, answered in the same order."),
      retailer: z
        .string()
        .optional()
        .describe("A retailer: id (e.g. 'retailer:costco'). Needs at least one brand id in `ids`."),
      country: countrySchema,
    },
    annotationsFor("ontology_coverage"),
    async ({ ids, retailer, country }) =>
      queryOntology("/v1/ontology/coverage", { id: ids, retailer, country }),
  );

  // ── Shopper ($0.01/query) ───────────────────────────────────────

  server.tool(
    "best_price",
    "Find the best current price for a product across retailers. Pass `q` (a name), or `entity_uid` for one exact product from ontology_resolve. Costs $0.01.",
    {
      q: z.string().optional().describe("Product search query. Send this OR entity_uid."),
      entity_uid: entityUidSchema,
      country: countrySchema,
      retailer: retailerSchema,
    },
    annotationsFor("best_price"),
    async ({ q, entity_uid, country, retailer }) =>
      query("/v1/shopper/best-price", { q, entity_uid, country, retailer }),
  );

  server.tool(
    "price_history",
    "Get price history for a product over time. Pass `q` (a name), or `entity_uid` for one exact product from ontology_resolve. Costs $0.01.",
    {
      q: z.string().optional().describe("Product search query. Send this OR entity_uid."),
      entity_uid: entityUidSchema,
      country: countrySchema,
      retailer: retailerSchema,
      days: daysSchema,
    },
    annotationsFor("price_history"),
    async ({ q, entity_uid, country, retailer, days }) =>
      query("/v1/shopper/price-history", { q, entity_uid, country, retailer, days: days?.toString() }),
  );

  server.tool(
    "deal_finder",
    "Find current deals and discounts in a product category. Costs $0.01.",
    {
      category: categoryNameSchema("Product category (e.g. electronics, grocery)"),
      spt: sptSchema,
      gpc: gpcSchema,
      country: countrySchema,
      retailer: retailerSchema,
    },
    annotationsFor("deal_finder"),
    async ({ category, spt, gpc, country, retailer }) =>
      query("/v1/shopper/deal-finder", { category, spt, gpc, country, retailer }),
  );

  server.tool(
    "price_drop_alert",
    "Check for recent price drops on a product. Costs $0.01.",
    { q: z.string().describe("Product search query"), country: countrySchema, retailer: retailerSchema, days: daysSchema },
    annotationsFor("price_drop_alert"),
    async ({ q, country, retailer, days }) =>
      query("/v1/shopper/price-drop-alert", { q, country, retailer, days: days?.toString() }),
  );

  // ── Marketing ($0.01/query) ─────────────────────────────────────

  server.tool(
    "competitive_landscape",
    "Get competitive pricing landscape for a category. Costs $0.01.",
    {
      category: categoryNameSchema("Product category"),
      spt: sptSchema,
      gpc: gpcSchema,
      country: countrySchema,
      retailer: retailerSchema,
    },
    annotationsFor("competitive_landscape"),
    async ({ category, spt, gpc, country, retailer }) =>
      query("/v1/marketing/competitive-landscape", { category, spt, gpc, country, retailer }),
  );

  server.tool(
    "brand_tracker",
    "Track a brand's pricing and market positioning. Costs $0.01.",
    {
      brand: brandNameSchema("Brand name (e.g. Sony, Samsung)"),
      brand_id: brandIdSchema,
      country: countrySchema,
      retailer: retailerSchema,
      days: daysSchema,
    },
    annotationsFor("brand_tracker"),
    async ({ brand, brand_id, country, retailer, days }) =>
      query("/v1/marketing/brand-tracker", { brand, brand_id, country, retailer, days: days?.toString() }),
  );

  server.tool(
    "promo_intelligence",
    "Analyze promotional activity within a category — promo frequency, average and max discount depth — over a date range. Pivot the breakdown with `aggregate_by`: default `brand` ranks brands within the category; `retailer` ranks retailers (pair with `brand=<name>` to answer 'which retailers run the deepest promos on Brand X in Category Y'). Response key mirrors the dimension: `brands: [...]` or `retailers: [...]`. Costs $0.01.",
    {
      category: categoryNameSchema("Product category"),
      spt: sptSchema,
      gpc: gpcSchema,
      country: countrySchema,
      retailer: retailerSchema,
      brand: z
        .string()
        .optional()
        .describe(
          "Optional brand filter — limit aggregation to products of this brand (case-insensitive). REQUIRED when aggregate_by=retailer to get per-retailer promo depth for a specific brand. Or send brand_id instead.",
        ),
      brand_id: brandIdSchema,
      aggregate_by: z
        .enum(["brand", "retailer"])
        .optional()
        .describe(
          "Group-by dimension. `brand` (default) ranks brands within the category. `retailer` ranks retailers — use this when the question asks 'which retailers' rather than 'which brands'.",
        ),
      days: daysSchema,
    },
    annotationsFor("promo_intelligence"),
    async ({ category, spt, gpc, country, retailer, brand, brand_id, aggregate_by, days }) =>
      query("/v1/marketing/promo-intelligence", {
        category,
        spt,
        gpc,
        country,
        retailer,
        brand,
        brand_id,
        aggregate_by,
        days: days?.toString(),
      }),
  );

  server.tool(
    "share_of_shelf",
    "Analyze brand share of shelf in a category. Costs $0.01.",
    {
      category: categoryNameSchema("Product category"),
      spt: sptSchema,
      gpc: gpcSchema,
      country: countrySchema,
      retailer: retailerSchema,
    },
    annotationsFor("share_of_shelf"),
    async ({ category, spt, gpc, country, retailer }) =>
      query("/v1/marketing/share-of-shelf", { category, spt, gpc, country, retailer }),
  );

  server.tool(
    "price_positioning",
    "Analyze a brand's price positioning vs competitors. Pass the shelf (category, spt or gpc): without one the brand is compared with the whole catalogue and no price tier is returned. Costs $0.01.",
    {
      brand: brandNameSchema("Brand name"),
      brand_id: brandIdSchema,
      category: categoryNameSchema("Product category to compare the brand against"),
      spt: sptSchema,
      gpc: gpcSchema,
      country: countrySchema,
      retailer: retailerSchema,
    },
    annotationsFor("price_positioning"),
    async ({ brand, brand_id, category, spt, gpc, country, retailer }) =>
      query("/v1/marketing/price-positioning", { brand, brand_id, category, spt, gpc, country, retailer }),
  );

  // ── Analyst ($0.02/query) ───────────────────────────────────────

  server.tool(
    "inflation_tracker",
    "Track price inflation trends in a category. Costs $0.02.",
    {
      category: categoryNameSchema("Product category"),
      spt: sptSchema,
      gpc: gpcSchema,
      country: countrySchema,
      days: daysSchema,
    },
    annotationsFor("inflation_tracker"),
    async ({ category, spt, gpc, country, days }) =>
      query("/v1/analyst/inflation", { category, spt, gpc, country, days: days?.toString() }),
  );

  // Hidden until the backend endpoint is implemented. Re-enable by uncommenting.
  // server.tool(
  //   "shrinkflation_detector",
  //   "Detect shrinkflation patterns in a category. Costs $0.02.",
  //   { category: z.string().describe("Product category"), country: countrySchema, days: daysSchema },
  //   async ({ category, country, days }) =>
  //     query("/v1/analyst/shrinkflation", { category, country, days: days?.toString() }),
  // );

  server.tool(
    "price_dispersion",
    "Analyze price variance across retailers for a category. Costs $0.02.",
    {
      category: categoryNameSchema("Product category"),
      spt: sptSchema,
      gpc: gpcSchema,
      country: countrySchema,
      retailer: retailerSchema,
    },
    annotationsFor("price_dispersion"),
    async ({ category, spt, gpc, country, retailer }) =>
      query("/v1/analyst/price-dispersion", { category, spt, gpc, country, retailer }),
  );

  server.tool(
    "retailer_index",
    "Get a pricing index for a specific retailer. Costs $0.02.",
    { retailer: z.string().describe("Retailer name (e.g. amazon, walmart)"), country: countrySchema, days: daysSchema },
    annotationsFor("retailer_index"),
    async ({ retailer, country, days }) =>
      query("/v1/analyst/retailer-index", { retailer, country, days: days?.toString() }),
  );

  server.tool(
    "price_bands",
    "Get the price architecture of one category shelf: the window that defines " +
      "'similarly priced' there, plus the shelf's price tiers (entry through luxury). " +
      "Use it to decide whether two products actually compete on price, or to place a " +
      "price within its shelf. Scoped by a browse-node path, not a category term. " +
      "Costs $0.02.",
    {
      node: z
        .string()
        .optional()
        .describe(
          "Category path — 'electronics', 'electronics/headphones', or a deeper rung. Or send spt instead.",
        ),
      spt: sptSchema,
    },
    annotationsFor("price_bands"),
    async ({ node, spt }) => query("/v1/analyst/price-bands", { node, spt }),
  );

  server.tool(
    "category_summary",
    "Get a comprehensive pricing summary for a category. Costs $0.02.",
    {
      category: categoryNameSchema("Product category"),
      spt: sptSchema,
      gpc: gpcSchema,
      country: countrySchema,
      retailer: retailerSchema,
      days: daysSchema,
    },
    annotationsFor("category_summary"),
    async ({ category, spt, gpc, country, retailer, days }) =>
      query("/v1/analyst/category-summary", { category, spt, gpc, country, retailer, days: days?.toString() }),
  );

  // ── Reference / taxonomy ($0.01 per REQUEST, up to 100 ids) ──────
  // Batch-first on purpose: the realistic caller is classifying a catalog, not
  // looking up one node, so the price is per request rather than per lookup
  // (~$0.0001 an item at full batch). Version-pinned rather than freshness-
  // pinned — answers change when GS1 publishes a release, not with observation
  // age — so responses carry X-GPC-Release / X-Map-Version.

  server.tool(
    "classify_product_type",
    "Resolve product types to GS1 GPC bricks — the identity of WHAT a product is, " +
      "independent of which category a retailer shelved it under. Pass `q` with " +
      "product-type phrases ('protein bars') or `browse_id` with Amazon browse node " +
      "ids, up to 100 comma-separated values, but not both. Use this when a question " +
      "is about a product TYPE that spans categories: protein bars sit under Health at " +
      "one retailer and Grocery at another, so a category filter answers from a " +
      "fraction of the data. Unresolvable inputs come back with an empty/null gpc " +
      "rather than a nearest guess, and the response lines up 1:1 with the request, so " +
      "misses are visible. A phrase can resolve to SEVERAL bricks when they are " +
      "co-equal (same product type at finer granularity, e.g. 'running' -> Athletic " +
      "Footwear General Purpose + Specialist); `match_kind` is 'co-equal' there and " +
      "each entry carries its own `source`. Each brick also reports `is_catchall` " +
      "(true when GS1 files it as a residual bucket like 'Small Cooking Appliances " +
      "Other', so the match is exact but the destination is broad) and " +
      "`attributes_defined`. Costs $0.01 per request.",
    {
      q: z
        .string()
        .optional()
        .describe("Comma-separated product-type phrases, e.g. 'protein bars,laptops'"),
      browse_id: z
        .string()
        .optional()
        .describe("Comma-separated Amazon browse node ids, e.g. '300334,12899121'"),
    },
    annotationsFor("classify_product_type"),
    async ({ q, browse_id }) => query("/v1/reference/classify", { q, browse_id }),
  );

  server.tool(
    "gpc_reverse_lookup",
    "Reverse the crosswalk: given GS1 GPC codes, return the Amazon browse nodes mapped " +
      "onto them. Up to 100 comma-separated codes. `browse_node_count` is always the " +
      "true total while `browse_ids` is capped per code (see `ids_per_code_cap`), so " +
      "truncation is detectable rather than silent. Node counts vary widely by code " +
      "and that is the retailer's shelving, not a coverage gap: a code reached by 2 " +
      "nodes is not thinner data than one reached by 20. Costs $0.01 per request.",
    { gpc_code: z.string().describe("Comma-separated 8-digit GPC codes, e.g. '10001159'") },
    annotationsFor("gpc_reverse_lookup"),
    async ({ gpc_code }) => query("/v1/reference/reverse", { gpc_code }),
  );

  server.tool(
    "gpc_brick_attributes",
    "Return the GS1 attribute schema for one or more GPC bricks — attribute names and " +
      "the controlled vocabulary each permits (for example Formation, If Organic). Up " +
      "to 100 comma-separated codes. Use it to discover what GS1 defines for a product " +
      "category before asking about it. An empty attribute list is not ambiguous: read " +
      "`attributes_defined` on the brick, false meaning GS1 genuinely defines none " +
      "(739 bricks do) rather than the schema having been lost in transit. Costs $0.01 " +
      "per request.",
    { gpc_code: z.string().describe("Comma-separated 8-digit GPC codes, e.g. '10000002'") },
    annotationsFor("gpc_brick_attributes"),
    async ({ gpc_code }) => query("/v1/reference/brick-attributes", { gpc_code }),
  );


  // ── Marketing and Analyst routes the MCP had never exposed ──────
  //
  // These five are priced and live in the API's tier map but had no tool, so
  // an agent could not reach them at all. Added alongside the social tier so
  // the MCP covers the paid surface rather than a subset of it.

  server.tool(
    "brand_breakdown",
    "Break a brand's assortment down by category, so you can see what a brand actually " +
      "sells rather than what it is known for. Costs $0.01.",
    { brand: brandNameSchema("Brand name"), brand_id: brandIdSchema, country: countrySchema },
    annotationsFor("brand_breakdown"),
    async ({ brand, brand_id, country }) => query("/v1/marketing/brand-breakdown", { brand, brand_id, country }),
  );

  server.tool(
    "retailer_assortment",
    "Find which retail chains carry a brand or a category. You must pass at least one of " +
      "`brand` or `category`; passing neither is rejected, because an unbounded scan is " +
      "not a question. Costs $0.01.",
    {
      brand: z.string().optional().describe("Brand name"),
      brand_id: brandIdSchema,
      category: z.string().optional().describe("Product category"),
      spt: sptSchema,
      gpc: gpcSchema,
      country: countrySchema,
    },
    annotationsFor("retailer_assortment"),
    async ({ brand, brand_id, category, spt, gpc, country }) =>
      query("/v1/marketing/retailer-assortment", { brand, brand_id, category, spt, gpc, country }),
  );

  server.tool(
    "availability_index",
    "Measure out-of-stock rates by retailer or by category. Aggregate by seller to " +
      "compare chains, or by category_root to compare shelves. You must pass at least " +
      "one of `category` or `brand`. Costs $0.01.",
    {
      category: z.string().optional().describe("Product category"),
      spt: sptSchema,
      gpc: gpcSchema,
      brand: z.string().optional().describe("Brand name"),
      brand_id: brandIdSchema,
      country: countrySchema,
      aggregate_by: z
        .enum(["seller", "category_root"])
        .optional()
        .describe("Group results by retailer or by category root. Defaults to seller."),
    },
    annotationsFor("availability_index"),
    async ({ category, spt, gpc, brand, brand_id, country, aggregate_by }) =>
      query("/v1/marketing/availability-index", { category, spt, gpc, brand, brand_id, country, aggregate_by }),
  );

  server.tool(
    "category_concentration",
    "Measure how concentrated a category is: whether a few brands own the shelf or it " +
      "is genuinely fragmented. Costs $0.02.",
    { category: categoryNameSchema("Product category"), spt: sptSchema, gpc: gpcSchema, country: countrySchema },
    annotationsFor("category_concentration"),
    async ({ category, spt, gpc, country }) =>
      query("/v1/analyst/category-concentration", { category, spt, gpc, country }),
  );

  server.tool(
    "price_change_leaders",
    "Rank the biggest price movers in a category or for a brand over a 7, 30 or 90 day " +
      "window. You must pass at least one of `category` or `brand`. Costs $0.02.",
    {
      category: z.string().optional().describe("Product category"),
      spt: sptSchema,
      gpc: gpcSchema,
      brand: z.string().optional().describe("Brand name"),
      brand_id: brandIdSchema,
      country: countrySchema,
      win: z
        .union([z.literal(7), z.literal(30), z.literal(90)])
        .optional()
        .describe("Lookback window in days: 7, 30 or 90. Defaults to 30."),
      limit: z.number().int().min(1).max(100).optional().describe("Max movers to return (default 15)"),
    },
    annotationsFor("price_change_leaders"),
    async ({ category, spt, gpc, brand, brand_id, country, win, limit }) =>
      query("/v1/analyst/price-change-leaders", {
        category,
        spt,
        gpc,
        brand,
        brand_id,
        country,
        win: win?.toString(),
        limit: limit?.toString(),
      }),
  );

  // ── Social ($0.03/query) ────────────────────────────────────────
  //
  // Corpus is TikTok and Instagram only, and every route is scoped to one
  // category root: there is no wildcard, because these answers are ranked
  // comparisons and a cross-category ranking would be meaningless.
  //
  // A 404 NOT_PUBLISHED from any of these is a gap in what we publish, NOT a
  // finding about the category. Do not report it as "no activity". Nothing is
  // billed for that response.
  //
  // `organic_only` is only sent when true. The API already defaults it to
  // false, so omitting it is identical in effect and avoids any chance of a
  // stringified "false" being read as truthy on the way through.

  server.tool(
    "creator_index",
    "Rank the creators driving mention volume in a category. Use it to find who is " +
      "actually talking about a shelf, not who has the biggest following. Costs $0.03.",
    {
      category: z.string().describe("Category root slug, e.g. 'beauty'"),
      window: windowSchema,
      platform: platformSchema,
      organic_only: organicOnlySchema,
      limit: socialLimitSchema,
    },
    annotationsFor("creator_index"),
    async ({ category, window, platform, organic_only, limit }) =>
      query("/v1/social/creator-index", {
        category,
        window,
        platform,
        organic_only: organic_only ? "true" : undefined,
        limit: limit?.toString(),
      }),
  );

  server.tool(
    "brand_share",
    "Share of social conversation by brand within a category. This is share of " +
      "ATTENTION, not share of shelf or of sales. `rank` is emitted only on unfiltered " +
      "requests; `tied_with` is pairwise proximity rather than an equivalence class. " +
      "Costs $0.03.",
    {
      category: z.string().describe("Category root slug, e.g. 'beauty'"),
      window: windowSchema,
      platform: platformSchema,
      organic_only: organicOnlySchema,
      brand: z.string().optional().describe("Brand name to focus on"),
      limit: socialLimitSchema,
    },
    annotationsFor("brand_share"),
    async ({ category, window, platform, organic_only, brand, limit }) =>
      query("/v1/social/brand-share", {
        category,
        window,
        platform,
        organic_only: organic_only ? "true" : undefined,
        brand,
        limit: limit?.toString(),
      }),
  );

  server.tool(
    "category_structure",
    "Show which subcategories own a category's conversation. Use it before brand-level " +
      "questions, to see where the attention actually sits. NOTE: this rollup is not " +
      "published yet and currently returns 404 NOT_PUBLISHED for every category; that is " +
      "a gap in what we publish, not a finding, and nothing is billed. Costs $0.03.",
    {
      category: z.string().describe("Category root slug, e.g. 'beauty'"),
      window: windowSchema,
      platform: platformSchema,
      organic_only: organicOnlySchema,
      limit: socialLimitSchema,
    },
    annotationsFor("category_structure"),
    async ({ category, window, platform, organic_only, limit }) =>
      query("/v1/social/category-structure", {
        category,
        window,
        platform,
        organic_only: organic_only ? "true" : undefined,
        limit: limit?.toString(),
      }),
  );

  server.tool(
    "brand_momentum",
    "Rank brands by conversation momentum in a category: who is rising, falling, or " +
      "newly appearing. `status: new` is emerging-brand detection. Costs $0.03.",
    {
      category: z.string().describe("Category root slug, e.g. 'beauty'"),
      window: windowSchema,
      platform: platformSchema,
      organic_only: organicOnlySchema,
      status: z
        .enum(["new", "rising", "falling", "all"])
        .optional()
        .describe("Restrict to one movement class. 'new' = emerging-brand detection. Defaults to all."),
      limit: socialLimitSchema,
    },
    annotationsFor("brand_momentum"),
    async ({ category, window, platform, organic_only, status, limit }) =>
      query("/v1/social/brand-momentum", {
        category,
        window,
        platform,
        organic_only: organic_only ? "true" : undefined,
        status,
        limit: limit?.toString(),
      }),
  );

  server.tool(
    "topic_trends",
    "Emerging conversation topics in a category. NOTE: this rollup is not published yet " +
      "and currently returns 404 NOT_PUBLISHED for every category; that is a gap in what " +
      "we publish, not a finding, and nothing is billed. Costs $0.03.",
    {
      category: z.string().describe("Category root slug, e.g. 'beauty'"),
      window: windowSchema,
      platform: platformSchema,
      organic_only: organicOnlySchema,
      limit: socialLimitSchema,
    },
    annotationsFor("topic_trends"),
    async ({ category, window, platform, organic_only, limit }) =>
      query("/v1/social/topic-trends", {
        category,
        window,
        platform,
        organic_only: organic_only ? "true" : undefined,
        limit: limit?.toString(),
      }),
  );

  server.tool(
    "product_type_trends",
    "Attention by product type within a category, so you can see which kind of thing is " +
      "being talked about rather than which brand. NOTE: this rollup is not published yet " +
      "and currently returns 404 NOT_PUBLISHED for every category; that is a gap in what " +
      "we publish, not a finding, and nothing is billed. Costs $0.03.",
    {
      category: z.string().describe("Category root slug, e.g. 'beauty'"),
      window: windowSchema,
      platform: platformSchema,
      organic_only: organicOnlySchema,
      limit: socialLimitSchema,
    },
    annotationsFor("product_type_trends"),
    async ({ category, window, platform, organic_only, limit }) =>
      query("/v1/social/product-type-trends", {
        category,
        window,
        platform,
        organic_only: organic_only ? "true" : undefined,
        limit: limit?.toString(),
      }),
  );

  server.tool(
    "social_series",
    "Weekly mentions and views time series for one subject: a brand or a " +
      "category. Use it to chart a trend rather than rank a moment. `subject` is " +
      "required unless subject_kind is 'category'. Costs $0.03.",
    {
      category: z.string().describe("Category root slug the subject is scoped to"),
      subject_kind: z
        .enum(["brand", "category"])
        .optional()
        .describe("What kind of subject to chart. Defaults to brand."),
      subject: z
        .string()
        .optional()
        .describe("The subject key (brand key). Required unless subject_kind='category'."),
      platform: platformSchema,
      organic_only: organicOnlySchema,
      weeks: z
        .number()
        .int()
        .min(1)
        .max(104)
        .optional()
        .describe("How many trailing ISO weeks to return (default 26, max 104)"),
    },
    annotationsFor("social_series"),
    async ({ category, subject_kind, subject, platform, organic_only, weeks }) =>
      query("/v1/social/series", {
        category,
        subject_kind,
        subject,
        platform,
        organic_only: organic_only ? "true" : undefined,
        weeks: weeks?.toString(),
      }),
  );

  // ── Scout / cross-domain ($0.05/query) ──────────────────────────
  //
  // These are the only routes that bind BOTH corpora to one category axis and
  // one brand key. Nobody holding just the social corpus or just the shelf can
  // reproduce them, which is why they are priced above the social tier.

  server.tool(
    "attention_vs_shelf",
    "Rank brands by the gap between share-of-conversation and share-of-shelf. A brand " +
      "with attention and no distribution is a stocking opportunity; the reverse is " +
      "shelf that is not earning its space. Costs $0.05.",
    {
      category: z.string().describe("Category root slug, e.g. 'beauty'"),
      country: countrySchema,
      window: windowSchema,
      platform: platformSchema,
      organic_only: organicOnlySchema,
      limit: socialLimitSchema,
    },
    annotationsFor("attention_vs_shelf"),
    async ({ category, country, window, platform, organic_only, limit }) =>
      query("/v1/social/attention-vs-shelf", {
        category,
        country,
        window,
        platform,
        organic_only: organic_only ? "true" : undefined,
        limit: limit?.toString(),
      }),
  );

  server.tool(
    "launch_buzz",
    "New shelf arrivals set against the conversation around their brand, so you can " +
      "tell a launch that landed from one that shipped in silence. Costs $0.05.",
    {
      category: z.string().describe("Category root slug, e.g. 'beauty'"),
      country: countrySchema,
      window: windowSchema,
      platform: platformSchema,
      organic_only: organicOnlySchema,
      limit: socialLimitSchema,
    },
    annotationsFor("launch_buzz"),
    async ({ category, country, window, platform, organic_only, limit }) =>
      query("/v1/social/launch-buzz", {
        category,
        country,
        window,
        platform,
        organic_only: organic_only ? "true" : undefined,
        limit: limit?.toString(),
      }),
  );

  // Prompts (the playbooks) and resources (the rules, the playbook index): guidance an agent can
  // pull, rendered from the same sources Eve reads (shared/playbooks in the Syntalic repo).
  registerGuidance(server);

  return server;
}
