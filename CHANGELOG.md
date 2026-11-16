# Changelog

## 0.13.1 (unreleased)

### Changed

- **`measure_neighbors` says a shelf also answers `facets` and `labels`.** The default measure tool's text came from the API's measure registry and still read "ancestors, children, types, brands and chains"; it now names the shelf's marketing practices and the `relations=labels` block (what its posts are). Generated text only: the tool already passed `relations` through.

- **`ontology_neighbors` names a category's `facets` and `labels` blocks.** `facets` (the marketing practices creators describe on a shelf, now the wider `marketing-v2` vocabulary) was already in the defaults but unnamed; `labels` (what the posts about a shelf are: kinds, themes and facets, with counts) is returned only when asked for by name, `relations: ["labels"]`. The API serves both (2026-11-16); the tool already passed `relations` through, so this is the description only.

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
