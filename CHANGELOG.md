# Changelog

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
