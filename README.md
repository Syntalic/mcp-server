# Syntalic Pricing Intelligence MCP Server

MCP server that gives AI agents access to real-time competitive pricing data across Amazon, Walmart, Costco, and more. Pay-per-query via [x402](https://x402.org) + MPP micropayments with automatic smart routing across Solana, Base, and Tempo.

## Quick Start

### Option A — Let the MCP manage a wallet (recommended for most users)

```bash
npx @syntalic/mcp-server@latest --setup
```

This walks you through:
1. Creating a new multi-chain wallet (or skipping if you prefer BYO — see Option B)
2. Wiring the MCP into Claude Code

After setup:

```bash
# Back up your private keys — mandatory before funding
npx @syntalic/mcp-server@latest --export-keys

# Fund any of the printed addresses with USDC (or USDC.e on Tempo) and you're ready
```

### Option B — Bring your own wallet keys

Skip the generated wallet and supply keys yourself. Recommended if you already use a dedicated agent wallet, you're deploying to CI/CD, or you want to manage keys with an HSM/secret manager.

```bash
# Both env vars are required — setting only one will cause the MCP to exit with an error.
export SYNTALIC_EVM_PRIVATE_KEY=0x<your_evm_private_key>
export SYNTALIC_SOLANA_PRIVATE_KEY=<your_solana_base58_private_key>

# Still run --setup to wire Claude Code. With both env vars set it creates no wallet file and prints no
# addresses to fund: the server pays from your keys.
npx @syntalic/mcp-server@latest --setup
```

When both env vars are set, `~/.syntalic/wallet.json` is ignored entirely, and `--setup` neither creates it
nor shows its addresses. `--info` shows the addresses your keys pay from, and their balances.

> ⚠️ Do not use your primary wallet here. Use a dedicated low-balance "agent wallet" — per-query amounts are tiny (0.01–0.02 USDC), so a few dollars buys hundreds of queries.

### Manual MCP config

Claude Code (what `--setup` runs for you; Claude Code does not read MCP servers from
`~/.claude/settings.json`):

```bash
claude mcp add -s user syntalic -- npx -y @syntalic/mcp-server@latest
```

Other clients that take an `mcpServers` file:

```json
{
  "mcpServers": {
    "syntalic": {
      "command": "npx",
      "args": ["-y", "@syntalic/mcp-server@latest"]
    }
  }
}
```

## CLI Commands

| Command | Purpose |
|---------|---------|
| `npx @syntalic/mcp-server` | Start the MCP server (default behavior) |
| `... --setup` | Interactive setup: choose wallet path, wire Claude Code. `--yes` takes every default; `--no-claude` skips Claude Code. Piped answers work, and a closed stdin never configures Claude Code |
| `... --export-keys` | Print private keys for backup or importing into Phantom/MetaMask |
| `... --info` | Show wallet addresses, live balances, paths, endpoints, and backup status |
| `... --help` | Usage overview |

## Supported Payment Networks

| Protocol | Network | Token | Wallet Type |
|----------|---------|-------|-------------|
| x402 | **Solana** | USDC | Solana (base58) |
| x402 | **Base** | USDC | EVM (`0x...`) |
| MPP | **Tempo** | USDC.e | EVM (`0x...`) |

Base and Tempo share the same EVM address. Solana uses a separate keypair. The client tries chains in that order (Solana first — lowest fees) and moves to the next one only when nothing was paid on the one before (see Smart Routing).

## Smart Routing

On every query, the client:

1. Derives your Solana USDC ATA and checks balance via public RPC. Enough → pay on Solana. Not enough, or the balance could not be read → skip.
2. Attempts payment on Base.
3. Checks USDC.e balance on Tempo, signs an MPP receipt, retries.
4. All chains exhausted → throws a clear `PaymentError` listing what happened per chain.

It moves on from a chain only when nothing was paid there:

- the chain was skipped before anything was signed (a `SYNTALIC_PAYMENT_NETWORK` pin, a balance
  pre-check, an unreadable Solana balance);
- the API refused the payment at verify for its balance (`invalid_exact_evm_insufficient_balance`,
  `permit2_insufficient_balance`, Solana's `transaction_simulation_failed`);
- the API answered `402` again with no settlement response: it asks again only when nothing was captured;
- the connection was never made (refused, DNS, connect timeout), so the payment never left the machine.

Once a signed payment may have reached the API, the client stops on that chain. The next chain would
sign a new authorization with its own nonce, so if the first one settled, the call would be paid twice.
A gateway error with no settlement response (a `502` or `504`), a connection that drops after the request
went out, Solana's `transaction_failed` (which the facilitator also answers when the transaction was sent
and its confirmation timed out), or a settlement response that says the payment settled followed by an
error: the tool says the payment's outcome is unknown (or that it settled), with what is known (the
chain, the payer, the HTTP status, the transaction or receipt, the request id), and tries no other
chain. Check the balance or the transaction before calling again. An answer from the API itself after
payment, such as `404 NO_RESULTS`, is returned as the answer, and any other refusal with a reason (a bad
signature, a used nonce) stops with a `PaymentError`.

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

By default the server offers **17 tools**: the six free ones below and **11 paid measure tools**, one per
measure. Set `SYNTALIC_TOOLS=routes` to get the per-route tools used before 0.13.0 back (39 tools: the
same six free ones and 33 paid tools, one per API route the API serves; `inflation_tracker` comes back with
the API's inflation route). The measure tools reach every route the
per-route tools call, at the same price.

### Public discovery (free — no payment)

Understand the shape and coverage of the catalog before spending on a paid query.

| Tool | Description |
|------|-------------|
| `catalog_overview` | Total products, brands, categories, retailers, observations + last-updated |
| `browse_categories` | Category tree with per-node product counts |
| `list_retailers` | Retailers (platforms) with product counts, countries, freshness |
| `list_brands` | Brands with product counts (optional `q` prefix filter) |
| `coverage_map` | Where the catalog is deep vs thin — quality status (`serving`, `thin`, `stale`) per retailer × country × category |

### Utility (free)

| Tool | Description |
|------|-------------|
| `wallet_info` | Show your wallet addresses, their live balance on each chain, and funding instructions |

### Measure tools (the default)

Eleven paid tools, one per measure. A measure is a metric family; `by` picks how the answer is split and
`subject` says what it is about. Each split is one API route, so nothing is lost: between them the
measures reach every paid route the API serves, including five the per-route tools do not
(`product-share`, `product-names`, `brand-signals`, `emerging-brands` and `tactics`).

The tool name is `measure_` plus the measure, so a call to `prices` or to a route the playbooks
name (`price_positioning`, `ontology_resolve`) is not a tool. The route is a split, named in square
brackets in that measure's description.

| Tool | Cost | `by` (default first) |
|------|------|----------------------|
| `measure_offers` | $0.01 | `retailer` |
| `measure_prices` | $0.01 to $0.02 | `summary`, `distribution`, `band`, `brand`, `product`, `retailer` |
| `measure_trend` | $0.01 to $0.02 | `period` (a product or a brand), `drop`, `product` |
| `measure_promotions` | $0.01 | `brand`, `retailer`, `product` |
| `measure_assortment` | $0.01 to $0.02 | `brand`, `concentration`, `category`, `retailer`, `availability` |
| `measure_attention` | $0.03 | `brand`, `product`, `category`, `creator`, `product_type`, `topic`, `momentum`, `emerging`, `week` |
| `measure_signals` | $0.03 | `brand`, `product_name`, `practice` |
| `measure_scout` | $0.05 | `gap`, `launch` |
| `measure_resolve` | $0.01 | `name`, `browse_node`, `gpc_browse_nodes`, `gpc_attributes` |
| `measure_neighbors` | $0.01 | `relations` |
| `measure_coverage` | $0.01 | `evidence` |

```
measure_prices     { subject: "spt:fb-2-17-2-4", by: "distribution" }
measure_trend      { subject: "brand:b_ac1a1c7143cb2199" }
measure_promotions { subject: "grocery", by: "retailer" }
```

- `subject` is an id from `measure_resolve` (`spt:`, `gpc:`, `brand:`, `retailer:`, `entity:`) or a name. It is
  sent to the route as the parameter of its kind. Every other argument is the route's own.
- The server translates the call and calls the route itself, so the tools work against any deployment of
  the API and a call costs what the route costs. The API's own `/v1/measures/*` paths are not used.
- A `by` the measure does not have, a subject the split cannot take, or a `by` that could be about two
  things with nothing to say which, is refused by the server before any request is made.
- So is an argument the chosen split's route does not read. A tool's schema is the union of its splits'
  parameters, so `sort_by` on `measure_prices` by `band` looks valid; sent, the API would drop it and answer
  a wider question at full price. The refusal names what the route reads and which split reads the
  argument. What a route reads comes from the generated table, less `UNREAD_PARAMS` in `src/measures.ts`:
  parameters the API's spec declares but its code does not read (today `time_window` on
  `/v1/shopper/price-history` and `/v1/shopper/price-drop-alert`; a product's history takes `from` and
  `to`). `npm run check:parity` lists them on every run.
- `suggested_next_calls` in an answer name the per-route tools (`share_of_shelf`), which are not tools in
  this mode. Each is rewritten to the measure tool, `by` and `subject` that make the same request, with
  `args` for the rest, read off the generated table and kept only if it translates back to the exact route
  and arguments the API suggested. One that cannot be mapped keeps what the API sent and gains
  `callable: false` and a `note`. With `SYNTALIC_TOOLS=routes`, `tool` is the registered per-route tool.
- 17 tools in place of 40, and a tool list a third smaller: 32,815 characters of tool definitions against
  49,387 (about 8.2k tokens against 12.3k).
- A split whose route the production API does not serve yet is not offered: its `by` is left out of the
  tool, and so are the parameters only it reads. Today that is `measure_neighbors` by `similar`
  (`/v1/ontology/similar`, behind the API's `SIMILAR_BY_FOOTPRINT` flag) and `measure_trend` by `period`
  on a shelf (`/v1/analyst/inflation`, behind the API's `INFLATION_ENABLED` flag). The list is `NOT_LIVE` in
  `src/measures.ts`; the generated table keeps the split, so taking the route off the list brings it back.
  With `SYNTALIC_TOOLS=routes`, a `NOT_LIVE` route's own tool (`inflation_tracker`) is not registered either.
- The playbook prompts name the per-route tools (`price_positioning`). In this mode that name is a
  split of `measure_prices`, written in square brackets in the description. The playbooks themselves
  are not rewritten. Call `measure_prices`, not `price_positioning` and not `prices`.

### Per-route tools (`SYNTALIC_TOOLS=routes`)

One paid tool per API route, the default before 0.13.0. They replace the measure tools; the free tools
stay. The playbook prompts name these tools, and in the default mode each of them is a split of a measure,
named in square brackets in the measure's description.

#### Ontology ($0.01/query)

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

#### Shopper ($0.01/query)

| Tool | Description |
|------|-------------|
| `best_price` | Find the cheapest price for a product across retailers |
| `price_history` | Price trends over time |
| `deal_finder` | Current deals in a category |
| `price_drop_alert` | Recent price drops |

#### Marketing ($0.01/query)

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

#### Analyst ($0.02/query)

| Tool | Description |
|------|-------------|
| `price_dispersion` | Price variance across retailers |
| `retailer_index` | Pricing index for a retailer |
| `category_summary` | Comprehensive category pricing summary |
| `category_concentration` | How concentrated a category is, few brands vs fragmented |
| `price_change_leaders` | Biggest price movers over 7, 30 or 90 days |

#### Social ($0.03/query)

TikTok and Instagram only. Every route is scoped to one category, named by its Shopify taxonomy
path (`health-beauty`, `food-beverages-tobacco`, `food-beverages-tobacco/beverages`): there is no
wildcard, because these answers are ranked comparisons. An unknown category is refused free of
charge with the published roots listed. A `404 NOT_PUBLISHED` means the latest run did not publish
that rollup, **not** that the category is quiet, and nothing is billed for it.

| Tool | Description |
|------|-------------|
| `creator_index` | Creators ranked by mention volume in a category |
| `brand_share` | Share of social conversation by brand |
| `category_structure` | Which subcategories own a category's conversation |
| `brand_momentum` | Brands rising, falling or newly appearing |
| `topic_trends` | Emerging conversation topics |
| `product_type_trends` | Attention by product type rather than by brand |
| `social_series` | Weekly mentions and views time series for one subject (`brand`, or `subject` + `subject_kind`) |

#### Scout, cross-domain ($0.05/query)

The only routes that bind both corpora to one category axis and one brand key.

| Tool | Description |
|------|-------------|
| `attention_vs_shelf` | Brands ranked by share-of-conversation vs share-of-shelf gap |
| `launch_buzz` | New shelf arrivals against the conversation around their brand |

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

The playbooks are rendered from the same sources Synthia, the dashboard agent, reads, so the two give the
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
| `SYNTALIC_BASE_RPC_URL` | Custom Base RPC for the balances `wallet_info` and `--info` show (default `https://mainnet.base.org`, HTTPS enforced) |
| `SYNTALIC_PAYMENT_NETWORK` | Pay on one chain only: `solana`, `base` or `tempo` (default: try all, in that order). Any other value stops the server at startup |
| `SYNTALIC_TOOLS` | Which paid tools to offer. Unset or `measures` (the default since 0.13.0): one tool per measure (see Measure tools). `routes`: one tool per API route, as before 0.13.0. Any other value stops the server at startup |
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

1. You call an MCP tool (e.g. `measure_offers(subject: "wireless earbuds")`, which calls `/v1/shopper/best-price`).
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
  before publishing.** A route a live measure split reaches has a tool (the five only
  the measures reach are named), and the API's own `/v1/measures/<name>` paths are
  covered by the measure of that name, so a measure the API adds fails it. It also
  checks the id parameters: where the spec declares `spt`, `gpc`, `brand_id` or
  `entity_uid` on an operation, the tool must pass it through, and a measure split
  must list it (or the generated table is stale). The per-route social and scout
  tools take a category name only, as in 0.12.x; those gaps are in `KNOWN_GAPS`. While the API's ontology is closed (neither `ONTOLOGY_ENABLED` nor
  `ONTOLOGY_API_KEYS` set) the spec lists no `/v1/ontology/*` route; the check says so and does not fail, but then it
  has no id parameters to compare, so run it again once the API opens. To check
  against a saved spec instead of the network: `SYNTALIC_SPEC_FILE=spec.json npm run check:parity`.
- `src/server-ontology.test.ts` drives the server through a real client over an
  in-memory transport, against a stubbed `fetch`: what the ontology tools send, the
  id parameters on the paid tools, the annotations, the prompts and the resources.
- `src/measures.generated.ts` is vendored from the Syntalic repository
  (`shared/measures/mcp/measures.generated.ts`; `npx tsx scripts/export-measures.ts` in `api/` renders it
  from the API's measure registry and its OpenAPI document; copy it here). Do not edit it. The script is
  not on the API's `main` yet: take `api/scripts/export-measures.ts` from the branch
  `claude/intelligent-lamport-v2w1n9`, run it over `main`'s `api/` with `INFLATION_ENABLED=true` (the
  script opens the other dark routes itself; without that flag the inflation split loses its parameters).
  `src/server-measures.test.ts` holds the measure tools to it: every paid path `server.ts` calls has a
  live split, a call reaches the route its split names, and no default tool offers a `by` whose route
  is in `NOT_LIVE`. `npm run check:parity` also fails on a measure route the live API does not serve
  and `NOT_LIVE` does not list, and names any `NOT_LIVE` route the API now serves.
- `src/playbooks.generated.ts` is vendored from `shared/playbooks` in the Syntalic
  repository (`node shared/playbooks/sync.mjs` renders it; copy it here). Do not
  edit it in this repository.
