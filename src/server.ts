import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createPaidFetch, PaymentError } from "./lib/fetch.js";
import { countrySchema, retailerSchema, daysSchema } from "./lib/schemas.js";

export interface ServerConfig {
  apiBase: string;
  evmPrivateKey: string;
  solanaPrivateKey: string;
  apiKey?: string;
  /** True if the user has run --setup at least once to view their keys. */
  backupAcknowledged?: boolean;
}

export async function createServer(config: ServerConfig): Promise<McpServer> {
  const server = new McpServer({
    name: "syntalic-pricing-intelligence",
    version: "0.6.0",
  });

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

  // ── Shopper ($0.01/query) ───────────────────────────────────────

  server.tool(
    "best_price",
    "Find the best current price for a product across retailers. Costs $0.01.",
    { q: z.string().describe("Product search query"), country: countrySchema, retailer: retailerSchema },
    async ({ q, country, retailer }) => query("/v1/shopper/best-price", { q, country, retailer }),
  );

  server.tool(
    "price_history",
    "Get price history for a product over time. Costs $0.01.",
    { q: z.string().describe("Product search query"), country: countrySchema, retailer: retailerSchema, days: daysSchema },
    async ({ q, country, retailer, days }) =>
      query("/v1/shopper/price-history", { q, country, retailer, days: days?.toString() }),
  );

  server.tool(
    "deal_finder",
    "Find current deals and discounts in a product category. Costs $0.01.",
    { category: z.string().describe("Product category (e.g. electronics, grocery)"), country: countrySchema, retailer: retailerSchema },
    async ({ category, country, retailer }) => query("/v1/shopper/deal-finder", { category, country, retailer }),
  );

  server.tool(
    "price_drop_alert",
    "Check for recent price drops on a product. Costs $0.01.",
    { q: z.string().describe("Product search query"), country: countrySchema, retailer: retailerSchema, days: daysSchema },
    async ({ q, country, retailer, days }) =>
      query("/v1/shopper/price-drop-alert", { q, country, retailer, days: days?.toString() }),
  );

  // ── Marketing ($0.01/query) ─────────────────────────────────────

  server.tool(
    "competitive_landscape",
    "Get competitive pricing landscape for a category. Costs $0.01.",
    { category: z.string().describe("Product category"), country: countrySchema, retailer: retailerSchema },
    async ({ category, country, retailer }) =>
      query("/v1/marketing/competitive-landscape", { category, country, retailer }),
  );

  server.tool(
    "brand_tracker",
    "Track a brand's pricing and market positioning. Costs $0.01.",
    { brand: z.string().describe("Brand name (e.g. Sony, Samsung)"), country: countrySchema, retailer: retailerSchema, days: daysSchema },
    async ({ brand, country, retailer, days }) =>
      query("/v1/marketing/brand-tracker", { brand, country, retailer, days: days?.toString() }),
  );

  server.tool(
    "promo_intelligence",
    "Analyze promotional activity within a category — promo frequency, average and max discount depth — over a date range. Pivot the breakdown with `aggregate_by`: default `brand` ranks brands within the category; `retailer` ranks retailers (pair with `brand=<name>` to answer 'which retailers run the deepest promos on Brand X in Category Y'). Response key mirrors the dimension: `brands: [...]` or `retailers: [...]`. Costs $0.01.",
    {
      category: z.string().describe("Product category"),
      country: countrySchema,
      retailer: retailerSchema,
      brand: z
        .string()
        .optional()
        .describe(
          "Optional brand filter — limit aggregation to products of this brand (case-insensitive). REQUIRED when aggregate_by=retailer to get per-retailer promo depth for a specific brand.",
        ),
      aggregate_by: z
        .enum(["brand", "retailer"])
        .optional()
        .describe(
          "Group-by dimension. `brand` (default) ranks brands within the category. `retailer` ranks retailers — use this when the question asks 'which retailers' rather than 'which brands'.",
        ),
      days: daysSchema,
    },
    async ({ category, country, retailer, brand, aggregate_by, days }) =>
      query("/v1/marketing/promo-intelligence", {
        category,
        country,
        retailer,
        brand,
        aggregate_by,
        days: days?.toString(),
      }),
  );

  server.tool(
    "share_of_shelf",
    "Analyze brand share of shelf in a category. Costs $0.01.",
    { category: z.string().describe("Product category"), country: countrySchema, retailer: retailerSchema },
    async ({ category, country, retailer }) =>
      query("/v1/marketing/share-of-shelf", { category, country, retailer }),
  );

  server.tool(
    "price_positioning",
    "Analyze a brand's price positioning vs competitors. Costs $0.01.",
    { brand: z.string().describe("Brand name"), country: countrySchema, retailer: retailerSchema },
    async ({ brand, country, retailer }) =>
      query("/v1/marketing/price-positioning", { brand, country, retailer }),
  );

  // ── Analyst ($0.02/query) ───────────────────────────────────────

  server.tool(
    "inflation_tracker",
    "Track price inflation trends in a category. Costs $0.02.",
    { category: z.string().describe("Product category"), country: countrySchema, days: daysSchema },
    async ({ category, country, days }) =>
      query("/v1/analyst/inflation", { category, country, days: days?.toString() }),
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
    { category: z.string().describe("Product category"), country: countrySchema, retailer: retailerSchema },
    async ({ category, country, retailer }) =>
      query("/v1/analyst/price-dispersion", { category, country, retailer }),
  );

  server.tool(
    "retailer_index",
    "Get a pricing index for a specific retailer. Costs $0.02.",
    { retailer: z.string().describe("Retailer name (e.g. amazon, walmart)"), country: countrySchema, days: daysSchema },
    async ({ retailer, country, days }) =>
      query("/v1/analyst/retailer-index", { retailer, country, days: days?.toString() }),
  );

  server.tool(
    "category_summary",
    "Get a comprehensive pricing summary for a category. Costs $0.02.",
    { category: z.string().describe("Product category"), country: countrySchema, retailer: retailerSchema, days: daysSchema },
    async ({ category, country, retailer, days }) =>
      query("/v1/analyst/category-summary", { category, country, retailer, days: days?.toString() }),
  );

  return server;
}
