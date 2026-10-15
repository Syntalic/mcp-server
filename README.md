# Syntalic Pricing Intelligence MCP Server

MCP server that gives AI agents access to real-time competitive pricing data across Amazon, Walmart, Costco, and more. Pay-per-query via [x402](https://x402.org) + MPP micropayments with automatic smart routing across Solana, Base, and Tempo.

## Quick Start

### Option A — Let the MCP manage a wallet (recommended for most users)

```bash
npx @syntalic/mcp-server --setup
```

This walks you through:
1. Creating a new multi-chain wallet (or skipping if you prefer BYO — see Option B)
2. Wiring the MCP into Claude Code

After setup:

```bash
# Back up your private keys — mandatory before funding
npx @syntalic/mcp-server --export-keys

# Fund any of the printed addresses with USDC (or USDC.e on Tempo) and you're ready
```

### Option B — Bring your own wallet keys

Skip the generated wallet and supply keys yourself. Recommended if you already use a dedicated agent wallet, you're deploying to CI/CD, or you want to manage keys with an HSM/secret manager.

```bash
# Both env vars are required — setting only one will cause the MCP to exit with an error.
export SYNTALIC_EVM_PRIVATE_KEY=0x<your_evm_private_key>
export SYNTALIC_SOLANA_PRIVATE_KEY=<your_solana_base58_private_key>

# Still run --setup to wire Claude Code (it won't touch the wallet file when both env vars are set)
npx @syntalic/mcp-server --setup
```

When both env vars are set, `~/.syntalic/wallet.json` is ignored entirely.

> ⚠️ Do not use your primary wallet here. Use a dedicated low-balance "agent wallet" — per-query amounts are tiny (0.01–0.02 USDC), so a few dollars buys hundreds of queries.

### Manual MCP config

```json
{
  "mcpServers": {
    "syntalic": {
      "command": "npx",
      "args": ["-y", "@syntalic/mcp-server"]
    }
  }
}
```

## CLI Commands

| Command | Purpose |
|---------|---------|
| `npx @syntalic/mcp-server` | Start the MCP server (default behavior) |
| `... --setup` | Interactive setup: choose wallet path, wire Claude Code |
| `... --export-keys` | Print private keys for backup or importing into Phantom/MetaMask |
| `... --info` | Show wallet addresses, paths, endpoints, and backup status |
| `... --help` | Usage overview |

## Supported Payment Networks

| Protocol | Network | Token | Wallet Type |
|----------|---------|-------|-------------|
| x402 | **Solana** | USDC | Solana (base58) |
| x402 | **Base** | USDC | EVM (`0x...`) |
| MPP | **Tempo** | USDC.e | EVM (`0x...`) |

Base and Tempo share the same EVM address. Solana uses a separate keypair. The client tries chains in that order (Solana first — lowest fees) and falls through when a chain doesn't have enough balance.

## Smart Routing

On every query, the client:

1. Derives your Solana USDC ATA and checks balance via public RPC. Enough → pay on Solana. Not enough, or the balance could not be read → skip.
2. Attempts payment on Base. Falls through on insufficient-balance errors only.
3. Checks USDC.e balance on Tempo, signs an MPP receipt, retries.
4. All chains exhausted → throws a clear `PaymentError` listing what happened per chain.

The Solana check fails closed: the public Solana RPC rate-limits often, and an unreadable balance is
skipped (the `PaymentError` says so) rather than attempted, so a rate-limited RPC never turns into an
opaque `429` while Base or Tempo holds the funds. If your funds are on Solana, set
`SYNTALIC_SOLANA_RPC_URL` to a dedicated RPC. The Tempo check is an optimization: if its RPC is down,
the client attempts payment anyway. Requests never hang on RPC health (2-second timeouts).

To pay on one chain only, set `SYNTALIC_PAYMENT_NETWORK` to `solana`, `base` or `tempo`; the other
chains are skipped and named as skipped in any `PaymentError`. Pinned to `solana`, an unreadable
balance is attempted anyway. `SYNTALIC_PAYMENT_TRACE=1` writes one stderr line per paid call naming
the chain that settled, the payer and the transaction.

## Tools

### Public discovery (free — no payment)

Understand the shape and coverage of the catalog before spending on a paid query.

| Tool | Description |
|------|-------------|
| `catalog_overview` | Total products, brands, categories, retailers, observations + last-updated |
| `browse_categories` | Category tree with per-node product counts |
| `list_retailers` | Retailers (platforms) with product counts, countries, freshness |
| `list_brands` | Brands with product counts (optional `q` prefix filter) |
| `coverage_map` | Where the catalog is deep vs thin — quality status per retailer × country × category |

### Ontology ($0.01/query)

What a name means, what sits next to it, and how much evidence stands behind it. They cost one cent a
call like the other lookups, with no key and no account: the wallet pays the same x402 or MPP
challenge. A malformed request, an id that names nothing, or an ontology that is not published yet is
refused before anything is billed. (The free catalog tools above are still the place to look around
first.) Everything else stays available at once; nothing here routes the agent. Each answer ends with
`suggested_next_calls`: calls that make sense next, with ids filled in and the price beside each.

| Tool | Description |
|------|-------------|
| `ontology_resolve` | Names to ids: shelves, product types, brands, chains and (with `kinds`) products. Every match comes back, none ranked best; a name that fits two things returns both (`co_equal`). A miss says why and offers candidates. |
| `ontology_neighbors` | What sits next to one id: a shelf's siblings and types, a brand's shelves and the chains that do and do not carry it, a chain's assortment |
| `ontology_coverage` | How much evidence stands behind ids and which chains were scanned: the denominators of "not seen at X" |

### Shopper ($0.01/query)

| Tool | Description |
|------|-------------|
| `best_price` | Find the cheapest price for a product across retailers |
| `price_history` | Price trends over time |
| `deal_finder` | Current deals in a category |
| `price_drop_alert` | Recent price drops |

### Marketing ($0.01/query)

| Tool | Description |
|------|-------------|
| `competitive_landscape` | Competitive pricing overview for a category |
| `brand_tracker` | Track a brand's pricing and positioning |
| `promo_intelligence` | Promotional activity intelligence |
| `share_of_shelf` | Brand share of shelf analysis |
| `price_positioning` | Brand price positioning vs competitors |
| `brand_breakdown` | A brand's assortment broken down by category |
| `retailer_assortment` | Which retail chains carry a brand or category |
| `availability_index` | Out-of-stock rates by retailer or category |

### Analyst ($0.02/query)

| Tool | Description |
|------|-------------|
| `inflation_tracker` | Category price inflation trends |
| `price_dispersion` | Price variance across retailers |
| `retailer_index` | Pricing index for a retailer |
| `category_summary` | Comprehensive category pricing summary |
| `category_concentration` | How concentrated a category is, few brands vs fragmented |
| `price_change_leaders` | Biggest price movers over 7, 30 or 90 days |

### Social ($0.03/query)

TikTok and Instagram only. Every route is scoped to one category root: there is no
wildcard, because these answers are ranked comparisons. A `404 NOT_PUBLISHED` means we
do not publish that rollup yet, **not** that the category is quiet, and nothing is billed
for it.

| Tool | Description |
|------|-------------|
| `creator_index` | Creators ranked by mention volume in a category |
| `brand_share` | Share of social conversation by brand |
| `category_structure` | Which subcategories own a category's conversation **(rollup not published yet)** |
| `brand_momentum` | Brands rising, falling or newly appearing |
| `topic_trends` | Emerging conversation topics **(rollup not published yet)** |
| `product_type_trends` | Attention by product type rather than by brand **(rollup not published yet)** |
| `social_series` | Weekly mentions and views time series for one subject |

### Scout, cross-domain ($0.05/query)

The only routes that bind both corpora to one category axis and one brand key.

| Tool | Description |
|------|-------------|
| `attention_vs_shelf` | Brands ranked by share-of-conversation vs share-of-shelf gap |
| `launch_buzz` | New shelf arrivals against the conversation around their brand |

### Utility

| Tool | Description |
|------|-------------|
| `wallet_info` | Show your wallet addresses and funding instructions |

## Parameters

All tools accept optional parameters:

| Parameter | Description |
|-----------|-------------|
| `country` | `us` or `ca` (defaults to `us`) |
| `retailer` | Filter to a specific retailer (e.g. `amazon`, `walmart`, `costco`) |
| `days` | Number of days to look back (where applicable) |

### Ids on the paid tools

A paid tool that takes a category or a brand also takes the id `ontology_resolve` returned, in place
of the name, never with it:

| Parameter | Stands for | Notes |
|-----------|------------|-------|
| `spt` | a shelf, e.g. `spt:fb-2-17-2-4` | instead of `category` |
| `gpc` | a product type, e.g. `gpc:10008059` | instead of `category`; covers every shelf the type is filed under |
| `brand_id` | a brand, e.g. `brand:b_ac1a1c7143cb2199` | instead of `brand` |
| `entity_uid` | one exact product | on `best_price` and `price_history`, instead of `q` |

A malformed or unknown id is refused before any payment is requested. Names still work as before.

## Prompts and resources

The playbooks for questions that take more than one call are **prompts** (each takes an optional
`question`) and **resources**, and the six rules for using the ontology tools, and what each figure the
pricing and shelf tools return means, are one resource each:

| | |
|---|---|
| prompts | `position-on-shelf`, `diagnose-price-move`, `promo-pressure`, `retail-coverage`, `category-brief`, `buyer-pitch` |
| resources | `syntalic://ontology/rules`, `syntalic://ontology/metrics` (each figure's definition, the tool and field that return it, and when it is withheld), `syntalic://playbooks` (the index), `syntalic://playbooks/<name>` |

The playbooks are rendered from the same sources the Syntalic dashboard agent reads, so the two give the
same advice; the metric definitions are rendered from the Syntalic repository's metric registry
(`shared/pricing-canon/data/metrics.json`). `src/playbooks.generated.ts` is generated; edit it only by
re-vendoring (see below).

## Annotations

Every tool carries MCP annotations, which clients may use to decide what to confirm. A paid tool is
`readOnlyHint: false` and not idempotent (running it moves your money, and running it twice spends
twice); the free tools are read-only and idempotent. Annotations are advisory: your wallet balance is
the real limit.

## Configuration

All env vars are optional — a wallet is auto-generated on first run.

| Environment Variable | Description |
|---------------------|-------------|
| `SYNTALIC_EVM_PRIVATE_KEY` | Override the EVM key (Base + Tempo) from the wallet file |
| `SYNTALIC_SOLANA_PRIVATE_KEY` | Override the Solana key from the wallet file |
| `SYNTALIC_API_KEY` | Optional. A staff bypass key, which skips payment on every paid tool. Payment is the normal way in, and nothing needs this; a free ontology key is not honoured, because the ontology is paid |
| `SYNTALIC_API_BASE` | API base URL (default `https://api.syntalic.com`, HTTPS enforced) |
| `SYNTALIC_SOLANA_RPC_URL` | Custom Solana RPC for balance checks (default `https://api.mainnet-beta.solana.com`, HTTPS enforced) |
| `SYNTALIC_TEMPO_RPC_URL` | Custom Tempo RPC for balance checks (default `https://rpc.tempo.xyz`, HTTPS enforced) |
| `SYNTALIC_PAYMENT_NETWORK` | Pay on one chain only: `solana`, `base` or `tempo` (default: try all, in that order). Any other value stops the server at startup |
| `SYNTALIC_PAYMENT_TRACE` | `1` writes one stderr line per paid call: the chain that settled, the payer and the transaction |

If both `SYNTALIC_EVM_PRIVATE_KEY` and `SYNTALIC_SOLANA_PRIVATE_KEY` are set, `~/.syntalic/wallet.json` is untouched.

### Upgrading from ≤ 0.5.x

Versions before 0.6.0 used the package's pre-rebrand naming. Both changes are handled automatically:

- **Wallet file** — `~/.crush/wallet.json` is moved to `~/.syntalic/wallet.json` on first run (same keys, same funds).
- **Env vars** — the old `CRUSH_*` names still work as deprecated fallbacks; the `SYNTALIC_*` name wins when both are set.

## Security

- Private keys are **never** exposed through MCP tools. Export only via the `--export-keys` CLI command, which prints to stderr in your own terminal.
- Wallet file uses mode `0o600` and refuses to follow symlinks.
- RPC URL overrides must be HTTPS (except `localhost`/`127.0.0.1`).
- Balance caps prevent a hostile RPC from spoofing an implausible balance to keep you on a chain you can't pay on.
- Error messages are sanitized to strip anything resembling a private key before being surfaced.

## How It Works

1. You call an MCP tool (e.g. `best_price(q: "wireless earbuds")`).
2. The server makes an HTTP request to the Syntalic Pricing API.
3. The API returns `402 Payment Required` with requirements for Solana, Base, and Tempo.
4. The client runs balance pre-checks, signs a payment on the first eligible chain, and retries.
5. You get the pricing data back.

All payment handling is automatic and transparent via the [x402](https://x402.org) and MPP protocols.

## Direct API Access

Skip the MCP and hit the API directly:

```bash
curl https://api.syntalic.com/openapi.json
curl https://api.syntalic.com/v1/shopper/best-price?q=wireless+earbuds  # returns 402
```

Payments accepted:
- **x402** — USDC on Solana or Base
- **MPP** — USDC.e on Tempo

## License

MIT

## Keeping the tool surface honest

The MCP once drifted 14 paid routes behind the API without anyone noticing: all
nine social/scout routes plus five marketing/analyst ones were live, priced and
unreachable from any agent.

- `npm test` runs offline and pins the inventory. It rejects duplicate tool
  names, duplicate or malformed paths, and any paid tool whose description omits
  its price (agents budget from that string, so a paid tool reading as free gets
  called in a loop). It gates `npm publish`.
- `npm run check:parity` hits the live `/openapi.json` and diffs both ways. It is
  the only check that catches a route shipping in the API with no tool. **Run it
  before publishing.** It also checks the id parameters: where the spec declares
  `spt`, `gpc`, `brand_id` or `entity_uid` on an operation, the tool must pass it
  through. While the API's ontology is closed (neither `ONTOLOGY_ENABLED` nor
  `ONTOLOGY_API_KEYS` set) the spec lists no `/v1/ontology/*` route; the check says so and does not fail, but then it
  has no id parameters to compare, so run it again once the API opens. To check
  against a saved spec instead of the network: `SYNTALIC_SPEC_FILE=spec.json npm run check:parity`.
- `src/server-ontology.test.ts` drives the server through a real client over an
  in-memory transport, against a stubbed `fetch`: what the ontology tools send, the
  id parameters on the paid tools, the annotations, the prompts and the resources.
- `src/playbooks.generated.ts` is vendored from `shared/playbooks` in the Syntalic
  repository (`node shared/playbooks/sync.mjs` renders it; copy it here). Do not
  edit it in this repository.
