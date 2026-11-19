# Changelog

## 0.14.0

### Fixed

- **`measure_trend` takes `time_window` and `lookback_days` on a product's price history (SYNLBS-259).**
  0.14.0 first refused `time_window` there, because the API dropped it and answered over its 30-day
  default (a paid 404 in the 2026-11-18 hand-run). The API reads it since 2026-11-18 (Crush-Rewards/syntalic
  #1659), and documents `lookback_days`, so the measure table is re-rendered from the API's `main` and both
  go through. `price-drop-alert` still reads `lookback_days` only, so `time_window` is still refused there.

- **`measure_signals` by `practice` takes every channel the API does (SYNLBS-269).** The generated measure
  table still had the marketing-v1 vocabulary, so `channel` accepted only `email`. The API's tactics route
  (`/v1/social/tactics`) takes nine: `email`, `retail`, `supply`, `brand_launch`, `growth`, `social`,
  `site`, `branding` and `customer`, with 10 more lanes and 21 more practices. The table is re-rendered
  from the API's registry (Crush-Rewards/syntalic `main`), which also brings `representative` to
  `sort_by` on `measure_prices` by `product` and the API's current wording for a few parameters.

- **A payment whose outcome is unknown no longer leads to a second payment (SYNLBS-272).** When a paid
  request came back with an error and no readable settlement response, the client moved on to the next
  chain. That chain signs a new authorization with its own nonce, so if the first payment had settled
  (the API settles before it answers), one answer was paid for twice. Now the client moves on only when
  nothing can have been paid: the chain was skipped before signing, the API refused the payment at
  verify for its balance, the API answered `402` again (it asks again only when nothing was captured),
  or the connection was never made. Anything else stops on that chain and says the payment's outcome is
  unknown, with what is known: the chain, the payer, the HTTP status, the transaction or receipt, and
  the request id. That covers a gateway's `502` or `504`, a connection that drops after the request went
  out, Solana's `transaction_failed` (which the facilitator also answers when the transaction was sent
  and its confirmation timed out; it used to fall through as a balance failure), and a settlement
  response that says the payment settled followed by an error (which read "payment rejected" before).
  On Tempo, the last chain, an API error after payment is now returned as the answer, as on Base and
  Solana, instead of as a failed payment.

- **`--setup` registers `@syntalic/mcp-server@latest` (SYNLBS-270)**, so npx fetches the current release
  rather than re-running the version it cached first. Declining auto-configuration used to print a
  `~/.claude/settings.json` snippet, which Claude Code does not read MCP servers from; it now prints
  `claude mcp add -s user syntalic -- npx -y @syntalic/mcp-server@latest`. The `--export-keys` backup
  hints say `@latest` too.

- **`--setup` leaves your own keys alone (SYNLBS-271).** With `SYNTALIC_EVM_PRIVATE_KEY` and
  `SYNTALIC_SOLANA_PRIVATE_KEY` both set, the server pays from them and never reads
  `~/.syntalic/wallet.json`. Setup skipped the generated wallet only on the answer "2", so Enter or
  `--yes` created a wallet and printed its addresses to fund, while the server paid from the env keys.
  Setup now checks the env first: it creates no wallet, shows no addresses, and says so. With only one of
  the two set it warns that the server will not start.

- **The measure tools refuse an argument the chosen split does not read (SYNLBS-266).** A tool's schema
  is the union of its splits' parameters, so `time_window` on `measure_trend` for a product looked valid;
  the API dropped it, the 30-day default applied, and a paid call answered `404`. The server now refuses
  such an argument before anything is billed, naming what the route reads and which split reads the
  argument. What a route reads comes from the generated table, less `UNREAD_PARAMS` (`src/measures.ts`):
  parameters the API's spec declares but its code ignores, today `time_window` on
  `/v1/shopper/price-history` and `/v1/shopper/price-drop-alert`. A product's history takes `from` and
  `to`. `npm run check:parity` lists `UNREAD_PARAMS` on every run.

- **`suggested_next_calls` name tools you can call (SYNLBS-266).** The API names each suggestion by its
  route (`share_of_shelf`, `brand_breakdown`, `ontology_neighbors`), which are not tools in the default
  mode. Each is rewritten to the measure tool, `by` and `subject` that make the same request, with `args`
  for the rest, and kept only if it translates back to the exact route and arguments the API suggested.
  Every call the API's suggestion rules write maps today; one that does not keeps what the API sent and
  is marked `callable: false`, with a `note`. With `SYNTALIC_TOOLS=routes`, `tool` is the registered
  per-route tool. The rest of each answer is unchanged.

- **`coverage_map` lists the quality statuses the API returns (SYNLBS-266):** `serving`, `thin` and
  `stale`. `unmanaged` and `empty` were retired.

### Changed

- **`npm run check:parity` passes against the live API again.** It failed on 0.13.2: the API now serves
  its own `/v1/measures/*` paths and declares `spt` and `brand_id` on the social routes. A route a live
  measure split reaches now counts as having a tool (the five only the measures reach are named), a
  `/v1/measures/<name>` path is covered by the measure of that name (a measure the API adds fails the
  check), each split must list the id parameters its route declares, and the per-route social and scout
  tools' missing `spt` and `brand_id` are in `KNOWN_GAPS` (they take a category name, as in 0.12.x).

- README: Synthia is the dashboard agent; Syntalic stays the data and the API. The quick start and the
  manual config use `@latest`, with the `claude mcp add` line for Claude Code.

## 0.13.2

### Changed

- **`measure_neighbors` says a shelf also answers `facets` and `labels`.** The default measure tool's text came from the API's measure registry and still read "ancestors, children, types, brands and chains"; it now names the shelf's marketing practices and the `relations=labels` block (what its posts are). Generated text only: the tool already passed `relations` through.

- **`ontology_neighbors` names a category's `facets` and `labels` blocks.** `facets` (the marketing practices creators describe on a shelf, now the wider `marketing-v2` vocabulary) was already in the defaults but unnamed; `labels` (what the posts about a shelf are: kinds, themes and facets, with counts) is returned only when asked for by name, `relations: ["labels"]`. The API serves both (2026-11-16); the tool already passed `relations` through, so this is the description only.

## 0.13.1

### Changed

- **Inflation is hidden.** The API's `GET /v1/analyst/inflation` is off (its `INFLATION_ENABLED` flag, off since
  2026-11-16: too little price history for a shelf-level inflation read), and the route answers 404. It is in
  `NOT_LIVE` (`src/measures.ts`), so `measure_trend` no longer offers `by: "period"` on a shelf: `period` is a
  product's history or a brand's tracker, and a shelf's price movement is `by: "product"` (the biggest movers).
  With `SYNTALIC_TOOLS=routes`, `inflation_tracker` is not registered (39 tools in that mode, not 40), and
  `--help` no longer lists it. The generated measure table is unchanged, so taking the route off `NOT_LIVE`
  brings both back.
- The playbook prompts (generated from the API repo) still name `inflation_tracker` in `category-brief`,
  `diagnose-price-move` and the metric definitions until that text changes upstream.

## 0.13.0 (unreleased)

### Changed

- **The measure tools are the default.** With `SYNTALIC_TOOLS` unset the server offers 17 tools: the six
  free ones (`wallet_info`, `catalog_overview`, `browse_categories`, `list_retailers`, `list_brands`,
  `coverage_map`) and 11 paid measure tools (`measure_offers`, `measure_prices`, `measure_trend`,
  `measure_promotions`, `measure_assortment`, `measure_attention`, `measure_signals`, `measure_scout`,
  `measure_resolve`, `measure_neighbors`, `measure_coverage`). Before, it offered 40 tools, one per route.
  The tool definitions a client reads drop from 49,387 to 32,815 characters.
- `SYNTALIC_TOOLS=routes` brings back the per-route tools (`best_price`, `price_positioning`,
  `ontology_resolve` and the rest) exactly as in 0.12.x. `SYNTALIC_TOOLS=measures` still works and is the
  same as unset. Any other value still stops the server at startup.
- `createServer()` defaults to the measure tools as well; pass `tools: "routes"` for the per-route ones.

### Added

- `NOT_LIVE` in `src/measures.ts`: routes in the generated measure table that production does not serve
  yet. Their splits are not offered (no `by`, none of their own parameters). It holds
  `/v1/ontology/similar` (the API's `SIMILAR_BY_FOOTPRINT` flag, off; the route answers 404), so
  `measure_neighbors` offers `by: "relations"` only. The generated table is unchanged.
- `npm run check:parity` fails on a measure route the live API does not serve and `NOT_LIVE` does not list,
  and names any `NOT_LIVE` route the API now serves.

### Upgrading

A client or prompt that calls the per-route tool names (`best_price`, `price_positioning`, ...) should set
`SYNTALIC_TOOLS=routes`, or call the measure tool whose description names that route in square brackets.

## 0.12.1 and earlier

See the git history and the GitHub releases.
