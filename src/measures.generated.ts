// GENERATED FILE — DO NOT EDIT.
// Source: api/src/measures.ts and the OpenAPI document in Crush-Rewards/syntalic.
// Edit the source there and run: (cd api && npx tsx scripts/export-measures.ts)
// A test in that repository fails when this copy drifts from the sources.

export type SubjectKind = "spt" | "gpc" | "brand" | "retailer" | "entity";

export interface MeasureParam {
  name: string;
  type: "string" | "integer" | "number" | "boolean";
  /** The parameter repeats (term=a&term=b). */
  array?: true;
  enum?: string[];
  description: string;
}

export interface MeasureSplit {
  /** The `by` value that selects it. */
  by: string;
  /** Set when another split shares `by`: what this one is about. */
  about?: "product" | "shelf" | "brand" | "retailer";
  /** The priced route that answers, and what it costs per call. */
  route: string;
  price_usd: string;
  answers: string;
  /** Where a subject id of each kind goes on the route: the parameter, and
   *  whether it takes the whole id or its value. */
  subject: Partial<Record<SubjectKind, { param: string; as: "id" | "value" }>>;
  /** Where a subject that is a name goes. Absent: the split needs an id. */
  name?: string;
  /** Parameters the split fixes. */
  fixed?: Record<string, string>;
}

export interface MeasureDef {
  name: string;
  summary: string;
  default_by: string;
  splits: MeasureSplit[];
  /** The parameters of the routes that answer, once each. */
  params: MeasureParam[];
}

export const MEASURES: MeasureDef[] = [
  {
    "name": "offers",
    "summary": "Who sells one product, and at what price, now.",
    "default_by": "retailer",
    "splits": [
      {
        "by": "retailer",
        "route": "/v1/shopper/best-price",
        "price_usd": "0.01",
        "answers": "the current offers for one product across retailers, cheapest first",
        "subject": {
          "entity": {
            "param": "entity_uid",
            "as": "value"
          },
          "retailer": {
            "param": "retailer_id",
            "as": "id"
          }
        },
        "name": "q"
      }
    ],
    "params": [
      {
        "name": "q",
        "type": "string",
        "description": "Search query (product name, keyword, or brand + model)."
      },
      {
        "name": "product_uid",
        "type": "string",
        "description": "Stable product identifier returned by a prior Syntalic shopper response."
      },
      {
        "name": "entity_uid",
        "type": "string",
        "description": "Stable cross-retailer entity identifier returned by a prior Syntalic shopper response."
      },
      {
        "name": "country",
        "type": "string",
        "enum": [
          "us",
          "ca"
        ],
        "description": "Country (us or ca)"
      },
      {
        "name": "retailer",
        "type": "string",
        "enum": [
          "amazon",
          "walmart",
          "target",
          "bestbuy",
          "homedepot",
          "costco",
          "ikea",
          "samsclub",
          "cvs",
          "dillards"
        ],
        "description": "Filter to a specific retailer platform (long-tail specialty stores are also present; any platform key is accepted)"
      },
      {
        "name": "limit",
        "type": "integer",
        "description": "Max results to return (default 10, min 1, max 50)"
      },
      {
        "name": "strict",
        "type": "boolean",
        "description": "When true, restrict the comparison to entity-verified listings of the matched product (match_type 'entity' only)."
      },
      {
        "name": "retailer_id",
        "type": "string",
        "description": "A chain by id, from GET /v1/ontology/resolve (a retailer match's `id`): the chain (seller_norm) whatever lane its listings were scraped through, never a lane."
      }
    ]
  },
  {
    "name": "prices",
    "summary": "The price level and spread of a shelf.",
    "default_by": "summary",
    "splits": [
      {
        "by": "summary",
        "route": "/v1/analyst/category-summary",
        "price_usd": "0.02",
        "answers": "counts, median and range, promo rate and in-stock rate, top brands",
        "subject": {
          "spt": {
            "param": "spt",
            "as": "id"
          },
          "gpc": {
            "param": "gpc",
            "as": "id"
          },
          "retailer": {
            "param": "retailer_id",
            "as": "id"
          }
        },
        "name": "category"
      },
      {
        "by": "distribution",
        "route": "/v1/analyst/price-dispersion",
        "price_usd": "0.02",
        "answers": "mean, spread and percentiles of current prices",
        "subject": {
          "spt": {
            "param": "spt",
            "as": "id"
          },
          "gpc": {
            "param": "gpc",
            "as": "id"
          },
          "retailer": {
            "param": "retailer_id",
            "as": "id"
          }
        },
        "name": "category"
      },
      {
        "by": "band",
        "route": "/v1/analyst/price-bands",
        "price_usd": "0.02",
        "answers": "the shelf's price tiers and its comparability window",
        "subject": {
          "spt": {
            "param": "spt",
            "as": "id"
          },
          "brand": {
            "param": "brand_id",
            "as": "id"
          }
        },
        "name": "node"
      },
      {
        "by": "brand",
        "route": "/v1/marketing/price-positioning",
        "price_usd": "0.01",
        "answers": "one brand's place on the shelf's price ladder (send brand_id or brand)",
        "subject": {
          "spt": {
            "param": "spt",
            "as": "id"
          },
          "gpc": {
            "param": "gpc",
            "as": "id"
          },
          "brand": {
            "param": "brand_id",
            "as": "id"
          },
          "retailer": {
            "param": "retailer_id",
            "as": "id"
          }
        },
        "name": "category"
      },
      {
        "by": "product",
        "route": "/v1/marketing/competitive-landscape",
        "price_usd": "0.01",
        "answers": "every product on the shelf with its current price",
        "subject": {
          "spt": {
            "param": "spt",
            "as": "id"
          },
          "gpc": {
            "param": "gpc",
            "as": "id"
          },
          "retailer": {
            "param": "retailer_id",
            "as": "id"
          }
        },
        "name": "category"
      },
      {
        "by": "retailer",
        "route": "/v1/analyst/retailer-index",
        "price_usd": "0.02",
        "answers": "one retailer's price index against the shelf, day by day (send retailer_id or retailer)",
        "subject": {
          "spt": {
            "param": "spt",
            "as": "id"
          },
          "gpc": {
            "param": "gpc",
            "as": "id"
          },
          "retailer": {
            "param": "retailer_id",
            "as": "id"
          }
        },
        "name": "category"
      }
    ],
    "params": [
      {
        "name": "category",
        "type": "string",
        "description": "Product category in the Shopify product taxonomy."
      },
      {
        "name": "include_homes",
        "type": "boolean",
        "description": "Optional."
      },
      {
        "name": "department",
        "type": "string",
        "description": "Top-level department (root category), e.g."
      },
      {
        "name": "country",
        "type": "string",
        "enum": [
          "us",
          "ca"
        ],
        "description": "Country (us or ca)"
      },
      {
        "name": "retailer",
        "type": "string",
        "enum": [
          "amazon",
          "walmart",
          "target",
          "bestbuy",
          "homedepot",
          "costco",
          "ikea",
          "samsclub",
          "cvs",
          "dillards"
        ],
        "description": "Filter to a specific retailer platform (long-tail specialty stores are also present; any platform key is accepted)"
      },
      {
        "name": "spt",
        "type": "string",
        "description": "A shelf by id, from GET /v1/ontology/resolve (a category match's `id`)."
      },
      {
        "name": "gpc",
        "type": "string",
        "description": "A product type by GS1 GPC id, from GET /v1/ontology/resolve (a product_type match's `id`)."
      },
      {
        "name": "retailer_id",
        "type": "string",
        "description": "A chain by id, from GET /v1/ontology/resolve (a retailer match's `id`): the chain (seller_norm) whatever lane its listings were scraped through, never a lane."
      },
      {
        "name": "node",
        "type": "string",
        "description": "Ladder node as a Shopify taxonomy path, in slug or display form — 'electronics', 'electronics/computers', 'Electronics > Computers > Laptops', or a deeper rung."
      },
      {
        "name": "brand",
        "type": "string",
        "description": "Optional."
      },
      {
        "name": "brand_id",
        "type": "string",
        "description": "A brand by id, from GET /v1/ontology/resolve (a brand match's `id`)."
      },
      {
        "name": "sort_by",
        "type": "string",
        "enum": [
          "price_asc",
          "price_desc",
          "rating",
          "reviews"
        ],
        "description": "Sort order (rating/reviews accepted for compatibility; fall back to price_asc)"
      },
      {
        "name": "cursor",
        "type": "integer",
        "description": "Pagination cursor — pass the previous response's next_cursor"
      },
      {
        "name": "limit",
        "type": "integer",
        "description": "Max results to return (default 20, min 1, max 50)"
      },
      {
        "name": "time_window",
        "type": "string",
        "enum": [
          "last_30_days",
          "last_60_days",
          "last_90_days",
          "month_to_date",
          "previous_month",
          "month_over_month",
          "quarter_to_date",
          "custom"
        ],
        "description": "Historical window preset."
      },
      {
        "name": "from",
        "type": "string",
        "description": "Start date (ISO 8601, defaults to 30 days ago)"
      },
      {
        "name": "to",
        "type": "string",
        "description": "End date (ISO 8601, defaults to now)"
      }
    ]
  },
  {
    "name": "trend",
    "summary": "How prices moved, for a product, a shelf or a brand.",
    "default_by": "period",
    "splits": [
      {
        "by": "period",
        "about": "product",
        "route": "/v1/shopper/price-history",
        "price_usd": "0.01",
        "answers": "one product's price series, with its low, high and direction",
        "subject": {
          "entity": {
            "param": "entity_uid",
            "as": "value"
          },
          "retailer": {
            "param": "retailer_id",
            "as": "id"
          }
        },
        "name": "q"
      },
      {
        "by": "period",
        "about": "shelf",
        "route": "/v1/analyst/inflation",
        "price_usd": "0.02",
        "answers": "a shelf's like-for-like price change, period by period",
        "subject": {
          "spt": {
            "param": "spt",
            "as": "id"
          },
          "gpc": {
            "param": "gpc",
            "as": "id"
          },
          "retailer": {
            "param": "retailer_id",
            "as": "id"
          }
        }
      },
      {
        "by": "period",
        "about": "brand",
        "route": "/v1/marketing/brand-tracker",
        "price_usd": "0.01",
        "answers": "a brand's price, product count and promo count, day by day",
        "subject": {
          "brand": {
            "param": "brand_id",
            "as": "id"
          },
          "retailer": {
            "param": "retailer_id",
            "as": "id"
          }
        }
      },
      {
        "by": "drop",
        "route": "/v1/shopper/price-drop-alert",
        "price_usd": "0.01",
        "answers": "whether one product's current price is below its recent average",
        "subject": {
          "entity": {
            "param": "entity_uid",
            "as": "value"
          },
          "retailer": {
            "param": "retailer_id",
            "as": "id"
          }
        },
        "name": "q"
      },
      {
        "by": "product",
        "route": "/v1/analyst/price-change-leaders",
        "price_usd": "0.02",
        "answers": "the products that rose and fell most, on a shelf or for a brand",
        "subject": {
          "spt": {
            "param": "spt",
            "as": "id"
          },
          "gpc": {
            "param": "gpc",
            "as": "id"
          },
          "brand": {
            "param": "brand_id",
            "as": "id"
          }
        },
        "name": "category"
      }
    ],
    "params": [
      {
        "name": "q",
        "type": "string",
        "description": "Search query (product name, keyword, or brand + model)."
      },
      {
        "name": "product_uid",
        "type": "string",
        "description": "Stable product identifier returned by a prior Syntalic shopper response."
      },
      {
        "name": "entity_uid",
        "type": "string",
        "description": "Stable cross-retailer entity identifier returned by a prior Syntalic shopper response."
      },
      {
        "name": "country",
        "type": "string",
        "enum": [
          "us",
          "ca"
        ],
        "description": "Country (us or ca)"
      },
      {
        "name": "retailer",
        "type": "string",
        "enum": [
          "amazon",
          "walmart",
          "target",
          "bestbuy",
          "homedepot",
          "costco",
          "ikea",
          "samsclub",
          "cvs",
          "dillards"
        ],
        "description": "Filter to a specific retailer platform (long-tail specialty stores are also present; any platform key is accepted)"
      },
      {
        "name": "time_window",
        "type": "string",
        "enum": [
          "last_30_days",
          "last_60_days",
          "last_90_days",
          "month_to_date",
          "previous_month",
          "month_over_month",
          "quarter_to_date",
          "custom"
        ],
        "description": "Historical window preset."
      },
      {
        "name": "from",
        "type": "string",
        "description": "Start date (ISO 8601, defaults to 30 days ago)"
      },
      {
        "name": "to",
        "type": "string",
        "description": "End date (ISO 8601, defaults to now)"
      },
      {
        "name": "win",
        "type": "integer",
        "enum": [
          "7",
          "30",
          "90"
        ],
        "description": "Window in days for series_summary.change_pct."
      },
      {
        "name": "retailer_id",
        "type": "string",
        "description": "A chain by id, from GET /v1/ontology/resolve (a retailer match's `id`): the chain (seller_norm) whatever lane its listings were scraped through, never a lane."
      },
      {
        "name": "category",
        "type": "string",
        "description": "Product category in the Shopify product taxonomy."
      },
      {
        "name": "include_homes",
        "type": "boolean",
        "description": "Optional."
      },
      {
        "name": "department",
        "type": "string",
        "description": "Top-level department (root category), e.g."
      },
      {
        "name": "granularity",
        "type": "string",
        "enum": [
          "daily",
          "weekly",
          "monthly"
        ],
        "description": "Time granularity for the series"
      },
      {
        "name": "spt",
        "type": "string",
        "description": "A shelf by id, from GET /v1/ontology/resolve (a category match's `id`)."
      },
      {
        "name": "gpc",
        "type": "string",
        "description": "A product type by GS1 GPC id, from GET /v1/ontology/resolve (a product_type match's `id`)."
      },
      {
        "name": "brand",
        "type": "string",
        "description": "Brand name (e.g., Sony, Samsung, Nike)"
      },
      {
        "name": "brand_id",
        "type": "string",
        "description": "A brand by id, from GET /v1/ontology/resolve (a brand match's `id`)."
      },
      {
        "name": "lookback_days",
        "type": "integer",
        "description": "Days to look back for price drops (default 30)."
      },
      {
        "name": "limit",
        "type": "integer",
        "description": "Max results to return (default 15, min 1, max 100)"
      }
    ]
  },
  {
    "name": "promotions",
    "summary": "Who discounts, how often and how deep.",
    "default_by": "brand",
    "splits": [
      {
        "by": "brand",
        "route": "/v1/marketing/promo-intelligence",
        "price_usd": "0.01",
        "answers": "promo frequency and depth per brand on a shelf",
        "subject": {
          "spt": {
            "param": "spt",
            "as": "id"
          },
          "gpc": {
            "param": "gpc",
            "as": "id"
          },
          "brand": {
            "param": "brand_id",
            "as": "id"
          },
          "retailer": {
            "param": "retailer_id",
            "as": "id"
          }
        },
        "name": "category",
        "fixed": {
          "aggregate_by": "brand"
        }
      },
      {
        "by": "retailer",
        "route": "/v1/marketing/promo-intelligence",
        "price_usd": "0.01",
        "answers": "promo frequency and depth per retailer on a shelf",
        "subject": {
          "spt": {
            "param": "spt",
            "as": "id"
          },
          "gpc": {
            "param": "gpc",
            "as": "id"
          },
          "brand": {
            "param": "brand_id",
            "as": "id"
          },
          "retailer": {
            "param": "retailer_id",
            "as": "id"
          }
        },
        "name": "category",
        "fixed": {
          "aggregate_by": "retailer"
        }
      },
      {
        "by": "product",
        "route": "/v1/shopper/deal-finder",
        "price_usd": "0.01",
        "answers": "the discounted products on a shelf or for a brand, best first",
        "subject": {
          "spt": {
            "param": "spt",
            "as": "id"
          },
          "gpc": {
            "param": "gpc",
            "as": "id"
          },
          "brand": {
            "param": "brand_id",
            "as": "id"
          },
          "retailer": {
            "param": "retailer_id",
            "as": "id"
          }
        },
        "name": "category"
      }
    ],
    "params": [
      {
        "name": "category",
        "type": "string",
        "description": "Product category in the Shopify product taxonomy."
      },
      {
        "name": "include_homes",
        "type": "boolean",
        "description": "Optional."
      },
      {
        "name": "country",
        "type": "string",
        "enum": [
          "us",
          "ca"
        ],
        "description": "Country (us or ca)"
      },
      {
        "name": "retailer",
        "type": "string",
        "enum": [
          "amazon",
          "walmart",
          "target",
          "bestbuy",
          "homedepot",
          "costco",
          "ikea",
          "samsclub",
          "cvs",
          "dillards"
        ],
        "description": "Filter to a specific retailer platform (long-tail specialty stores are also present; any platform key is accepted)"
      },
      {
        "name": "brand",
        "type": "string",
        "description": "Optional brand filter, in both modes — limit aggregation to products of this brand (case-insensitive)."
      },
      {
        "name": "aggregate_by",
        "type": "string",
        "enum": [
          "brand",
          "retailer"
        ],
        "description": "Group-by dimension."
      },
      {
        "name": "time_window",
        "type": "string",
        "enum": [
          "last_30_days",
          "last_60_days",
          "last_90_days",
          "month_to_date",
          "previous_month",
          "month_over_month",
          "quarter_to_date",
          "custom"
        ],
        "description": "Historical window preset."
      },
      {
        "name": "from",
        "type": "string",
        "description": "Start date (ISO 8601, defaults to 30 days ago)"
      },
      {
        "name": "to",
        "type": "string",
        "description": "End date (ISO 8601, defaults to now)"
      },
      {
        "name": "spt",
        "type": "string",
        "description": "A shelf by id, from GET /v1/ontology/resolve (a category match's `id`)."
      },
      {
        "name": "gpc",
        "type": "string",
        "description": "A product type by GS1 GPC id, from GET /v1/ontology/resolve (a product_type match's `id`)."
      },
      {
        "name": "brand_id",
        "type": "string",
        "description": "A brand by id, from GET /v1/ontology/resolve (a brand match's `id`)."
      },
      {
        "name": "retailer_id",
        "type": "string",
        "description": "A chain by id, from GET /v1/ontology/resolve (a retailer match's `id`): the chain (seller_norm) whatever lane its listings were scraped through, never a lane."
      },
      {
        "name": "min_discount_pct",
        "type": "integer",
        "description": "Minimum discount percentage (default 10)"
      },
      {
        "name": "limit",
        "type": "integer",
        "description": "Max results to return (default 20, min 1, max 50)"
      }
    ]
  },
  {
    "name": "assortment",
    "summary": "What is on the shelf, and who holds it.",
    "default_by": "brand",
    "splits": [
      {
        "by": "brand",
        "route": "/v1/marketing/share-of-shelf",
        "price_usd": "0.01",
        "answers": "each brand's share of the shelf, by product count",
        "subject": {
          "spt": {
            "param": "spt",
            "as": "id"
          },
          "gpc": {
            "param": "gpc",
            "as": "id"
          },
          "retailer": {
            "param": "retailer_id",
            "as": "id"
          }
        },
        "name": "category"
      },
      {
        "by": "concentration",
        "route": "/v1/analyst/category-concentration",
        "price_usd": "0.02",
        "answers": "how concentrated the shelf is: HHI, CR4, effective brands",
        "subject": {
          "spt": {
            "param": "spt",
            "as": "id"
          },
          "gpc": {
            "param": "gpc",
            "as": "id"
          }
        },
        "name": "category"
      },
      {
        "by": "category",
        "route": "/v1/marketing/brand-breakdown",
        "price_usd": "0.01",
        "answers": "what a brand sells, counted per category",
        "subject": {
          "brand": {
            "param": "brand_id",
            "as": "id"
          }
        },
        "name": "brand"
      },
      {
        "by": "retailer",
        "route": "/v1/marketing/retailer-assortment",
        "price_usd": "0.01",
        "answers": "which chains carry a brand or a shelf, and how much of it",
        "subject": {
          "spt": {
            "param": "spt",
            "as": "id"
          },
          "gpc": {
            "param": "gpc",
            "as": "id"
          },
          "brand": {
            "param": "brand_id",
            "as": "id"
          }
        }
      },
      {
        "by": "availability",
        "route": "/v1/marketing/availability-index",
        "price_usd": "0.01",
        "answers": "out-of-stock rate per chain (aggregate_by=category_root for per category)",
        "subject": {
          "spt": {
            "param": "spt",
            "as": "id"
          },
          "gpc": {
            "param": "gpc",
            "as": "id"
          },
          "brand": {
            "param": "brand_id",
            "as": "id"
          }
        },
        "name": "category"
      }
    ],
    "params": [
      {
        "name": "category",
        "type": "string",
        "description": "Product category in the Shopify product taxonomy."
      },
      {
        "name": "include_homes",
        "type": "boolean",
        "description": "Optional."
      },
      {
        "name": "country",
        "type": "string",
        "enum": [
          "us",
          "ca"
        ],
        "description": "Country (us or ca)"
      },
      {
        "name": "retailer",
        "type": "string",
        "enum": [
          "amazon",
          "walmart",
          "target",
          "bestbuy",
          "homedepot",
          "costco",
          "ikea",
          "samsclub",
          "cvs",
          "dillards"
        ],
        "description": "Filter to a specific retailer platform (long-tail specialty stores are also present; any platform key is accepted)"
      },
      {
        "name": "spt",
        "type": "string",
        "description": "A shelf by id, from GET /v1/ontology/resolve (a category match's `id`)."
      },
      {
        "name": "gpc",
        "type": "string",
        "description": "A product type by GS1 GPC id, from GET /v1/ontology/resolve (a product_type match's `id`)."
      },
      {
        "name": "retailer_id",
        "type": "string",
        "description": "A chain by id, from GET /v1/ontology/resolve (a retailer match's `id`): the chain (seller_norm) whatever lane its listings were scraped through, never a lane."
      },
      {
        "name": "brand",
        "type": "string",
        "description": "Brand name (e.g., Sony, Samsung, Nike)"
      },
      {
        "name": "brand_id",
        "type": "string",
        "description": "A brand by id, from GET /v1/ontology/resolve (a brand match's `id`)."
      },
      {
        "name": "aggregate_by",
        "type": "string",
        "enum": [
          "seller",
          "category_root"
        ],
        "description": "Dimension to group by: retail chain (default) or category root."
      }
    ]
  },
  {
    "name": "attention",
    "summary": "Share of social conversation, and how it is moving.",
    "default_by": "brand",
    "splits": [
      {
        "by": "brand",
        "route": "/v1/social/brand-share",
        "price_usd": "0.03",
        "answers": "each brand's share of mentions on a shelf",
        "subject": {
          "spt": {
            "param": "spt",
            "as": "id"
          },
          "brand": {
            "param": "brand_id",
            "as": "id"
          }
        },
        "name": "category"
      },
      {
        "by": "product",
        "route": "/v1/social/product-share",
        "price_usd": "0.03",
        "answers": "the catalog products a shelf is talking about",
        "subject": {
          "spt": {
            "param": "spt",
            "as": "id"
          },
          "brand": {
            "param": "brand_id",
            "as": "id"
          }
        },
        "name": "category"
      },
      {
        "by": "category",
        "route": "/v1/social/category-structure",
        "price_usd": "0.03",
        "answers": "which subcategories own a shelf's conversation",
        "subject": {
          "spt": {
            "param": "spt",
            "as": "id"
          }
        },
        "name": "category"
      },
      {
        "by": "creator",
        "route": "/v1/social/creator-index",
        "price_usd": "0.03",
        "answers": "the creators driving a shelf's conversation",
        "subject": {
          "spt": {
            "param": "spt",
            "as": "id"
          },
          "brand": {
            "param": "brand_id",
            "as": "id"
          }
        },
        "name": "category"
      },
      {
        "by": "product_type",
        "route": "/v1/social/product-type-trends",
        "price_usd": "0.03",
        "answers": "attention per product type, and how the mix is shifting",
        "subject": {
          "spt": {
            "param": "spt",
            "as": "id"
          }
        },
        "name": "category"
      },
      {
        "by": "topic",
        "route": "/v1/social/topic-trends",
        "price_usd": "0.03",
        "answers": "the topics emerging and fading on a shelf",
        "subject": {
          "spt": {
            "param": "spt",
            "as": "id"
          }
        },
        "name": "category"
      },
      {
        "by": "momentum",
        "route": "/v1/social/brand-momentum",
        "price_usd": "0.03",
        "answers": "brands ranked by movement: new, rising, falling",
        "subject": {
          "spt": {
            "param": "spt",
            "as": "id"
          }
        },
        "name": "category"
      },
      {
        "by": "emerging",
        "route": "/v1/social/emerging-brands",
        "price_usd": "0.03",
        "answers": "brands creators keep tagging that the catalog does not carry",
        "subject": {
          "spt": {
            "param": "spt",
            "as": "id"
          }
        }
      },
      {
        "by": "week",
        "route": "/v1/social/series",
        "price_usd": "0.03",
        "answers": "weekly mentions and views for one brand or one shelf",
        "subject": {
          "spt": {
            "param": "spt",
            "as": "id"
          },
          "brand": {
            "param": "brand_id",
            "as": "id"
          }
        }
      }
    ],
    "params": [
      {
        "name": "category",
        "type": "string",
        "description": "Shopify taxonomy path, as a join key or a display path: a root (food-beverages-tobacco) or any node under it."
      },
      {
        "name": "window",
        "type": "string",
        "enum": [
          "30d",
          "90d"
        ],
        "description": "Rollup window."
      },
      {
        "name": "platform",
        "type": "string",
        "enum": [
          "all",
          "tiktok",
          "instagram"
        ],
        "description": "TikTok and Instagram are the only platforms in the corpus."
      },
      {
        "name": "organic_only",
        "type": "boolean",
        "description": "Exclude posts marked as ads."
      },
      {
        "name": "brand",
        "type": "string",
        "description": "Brand name (e.g., Sony, Samsung, Nike)"
      },
      {
        "name": "limit",
        "type": "integer",
        "description": "Max results to return (default 25, min 1, max 100)"
      },
      {
        "name": "spt",
        "type": "string",
        "description": "A shelf by id, from GET /v1/ontology/resolve (a category match's `id`)."
      },
      {
        "name": "brand_id",
        "type": "string",
        "description": "A brand by id, from GET /v1/ontology/resolve (a brand match's `id`)."
      },
      {
        "name": "status",
        "type": "string",
        "enum": [
          "new",
          "rising",
          "falling",
          "all"
        ],
        "description": "Restrict to one movement class."
      },
      {
        "name": "product_type",
        "type": "string",
        "description": "Only brands with a product typed at or under this Shopify taxonomy path."
      },
      {
        "name": "subject_kind",
        "type": "string",
        "enum": [
          "brand",
          "category"
        ],
        "description": "What kind of subject to chart."
      },
      {
        "name": "weeks",
        "type": "integer",
        "description": "How many trailing ISO weeks to return."
      }
    ]
  },
  {
    "name": "signals",
    "summary": "What posts say, as labels: launches, reviews, stance, names, practices.",
    "default_by": "brand",
    "splits": [
      {
        "by": "brand",
        "route": "/v1/social/brand-signals",
        "price_usd": "0.03",
        "answers": "launches, reviews, stance, retailers and prices posts attach to each brand",
        "subject": {
          "spt": {
            "param": "spt",
            "as": "id"
          },
          "brand": {
            "param": "brand_id",
            "as": "id"
          }
        },
        "name": "category"
      },
      {
        "by": "product_name",
        "route": "/v1/social/product-names",
        "price_usd": "0.03",
        "answers": "product names read off posts that match no catalog product",
        "subject": {
          "spt": {
            "param": "spt",
            "as": "id"
          },
          "brand": {
            "param": "brand_id",
            "as": "id"
          }
        }
      },
      {
        "by": "practice",
        "route": "/v1/social/tactics",
        "price_usd": "0.03",
        "answers": "the marketing practices creators describe brands using",
        "subject": {
          "spt": {
            "param": "spt",
            "as": "id"
          }
        },
        "name": "category"
      }
    ],
    "params": [
      {
        "name": "category",
        "type": "string",
        "description": "Shopify taxonomy path, as a join key or a display path: a root (food-beverages-tobacco) or any node under it."
      },
      {
        "name": "window",
        "type": "string",
        "enum": [
          "30d",
          "90d"
        ],
        "description": "Rollup window."
      },
      {
        "name": "platform",
        "type": "string",
        "enum": [
          "all",
          "tiktok",
          "instagram"
        ],
        "description": "TikTok and Instagram are the only platforms in the corpus."
      },
      {
        "name": "organic_only",
        "type": "boolean",
        "description": "Exclude posts marked as ads."
      },
      {
        "name": "brand",
        "type": "string",
        "description": "Only this brand."
      },
      {
        "name": "limit",
        "type": "integer",
        "description": "Max results to return (default 25, min 1, max 100)"
      },
      {
        "name": "spt",
        "type": "string",
        "description": "A shelf by id, from GET /v1/ontology/resolve (a category match's `id`)."
      },
      {
        "name": "brand_id",
        "type": "string",
        "description": "A brand by id, from GET /v1/ontology/resolve (a brand match's `id`)."
      },
      {
        "name": "product_type",
        "type": "string",
        "description": "Only names the retail chain typed at or under this Shopify taxonomy path."
      },
      {
        "name": "type_source",
        "type": "string",
        "enum": [
          "spt_chain",
          "brand_node",
          "none"
        ],
        "description": "What is known about the name."
      },
      {
        "name": "channel",
        "type": "string",
        "enum": [
          "email"
        ],
        "description": "Only practices in this channel of the marketing-v1 vocabulary."
      },
      {
        "name": "lane",
        "type": "string",
        "enum": [
          "launch",
          "collab",
          "newsletter",
          "content",
          "offer",
          "hero",
          "footer",
          "design",
          "cadence"
        ],
        "description": "Only practices in this lane (a group of practices within a channel)."
      },
      {
        "name": "practice",
        "type": "string",
        "enum": [
          "restock_as_launch",
          "launch_arc",
          "collab_arc",
          "founder_letter",
          "recipe_click_through",
          "calendar_content",
          "soft_sell_guide",
          "discount_in_hero",
          "offer_steps",
          "immersive_hero",
          "buttons_above_fold",
          "category_buttons",
          "final_cta",
          "bright_visuals",
          "editorial_layout",
          "stated_cadence"
        ],
        "description": "Only this practice, by its vocabulary id."
      }
    ]
  },
  {
    "name": "scout",
    "summary": "Social attention set against the shelf.",
    "default_by": "gap",
    "splits": [
      {
        "by": "gap",
        "route": "/v1/social/attention-vs-shelf",
        "price_usd": "0.05",
        "answers": "brands ranked by share of conversation against share of shelf",
        "subject": {
          "spt": {
            "param": "spt",
            "as": "id"
          }
        },
        "name": "category"
      },
      {
        "by": "launch",
        "route": "/v1/social/launch-buzz",
        "price_usd": "0.05",
        "answers": "new arrivals on a shelf against the conversation around their brand",
        "subject": {
          "spt": {
            "param": "spt",
            "as": "id"
          }
        },
        "name": "category"
      }
    ],
    "params": [
      {
        "name": "category",
        "type": "string",
        "description": "Shopify taxonomy path, as a join key or a display path: a root (food-beverages-tobacco) or any node under it."
      },
      {
        "name": "country",
        "type": "string",
        "enum": [
          "us",
          "ca"
        ],
        "description": "Country for the SHELF side of the join."
      },
      {
        "name": "window",
        "type": "string",
        "enum": [
          "30d",
          "90d"
        ],
        "description": "Rollup window."
      },
      {
        "name": "platform",
        "type": "string",
        "enum": [
          "all",
          "tiktok",
          "instagram"
        ],
        "description": "TikTok and Instagram are the only platforms in the corpus."
      },
      {
        "name": "organic_only",
        "type": "boolean",
        "description": "Exclude posts marked as ads."
      },
      {
        "name": "limit",
        "type": "integer",
        "description": "Maximum ranked brands to return."
      },
      {
        "name": "spt",
        "type": "string",
        "description": "A shelf by id, from GET /v1/ontology/resolve (a category match's `id`)."
      }
    ]
  },
  {
    "name": "resolve",
    "summary": "A name, phrase or code to ids.",
    "default_by": "name",
    "splits": [
      {
        "by": "name",
        "route": "/v1/ontology/resolve",
        "price_usd": "0.01",
        "answers": "every shelf, product type, brand and chain a term names, as ids",
        "subject": {},
        "name": "term"
      },
      {
        "by": "browse_node",
        "route": "/v1/reference/classify",
        "price_usd": "0.01",
        "answers": "Amazon browse node ids or phrases to GS1 GPC codes",
        "subject": {},
        "name": "q"
      },
      {
        "by": "gpc_browse_nodes",
        "route": "/v1/reference/reverse",
        "price_usd": "0.01",
        "answers": "the browse nodes mapped onto a GPC code",
        "subject": {
          "gpc": {
            "param": "gpc_code",
            "as": "value"
          }
        }
      },
      {
        "by": "gpc_attributes",
        "route": "/v1/reference/brick-attributes",
        "price_usd": "0.01",
        "answers": "the attributes GS1 defines for a GPC brick, with their allowed values",
        "subject": {
          "gpc": {
            "param": "gpc_code",
            "as": "value"
          }
        }
      }
    ],
    "params": [
      {
        "name": "term",
        "type": "string",
        "array": true,
        "description": "A name to resolve: a category, a product type, a brand, a chain."
      },
      {
        "name": "kinds",
        "type": "string",
        "description": "Comma-joined or repeated: which kinds a term may resolve to."
      },
      {
        "name": "within",
        "type": "string",
        "description": "An spt or gpc id naming the shelf the question is on."
      },
      {
        "name": "country",
        "type": "string",
        "enum": [
          "us",
          "ca"
        ],
        "description": "Coverage is per country, so a typo is a 400 rather than a quiet read of the other one."
      },
      {
        "name": "browse_id",
        "type": "string",
        "description": "Comma-separated Amazon browse node ids (max 100 per request)."
      },
      {
        "name": "q",
        "type": "string",
        "description": "Comma-separated product-type phrases to resolve to GPC bricks or classes via the curated lexicon, e.g."
      },
      {
        "name": "gpc_code",
        "type": "string",
        "description": "Comma-separated 8-digit GS1 GPC codes (max 100 per request)"
      }
    ]
  },
  {
    "name": "neighbors",
    "summary": "What sits next to an id.",
    "default_by": "relations",
    "splits": [
      {
        "by": "relations",
        "route": "/v1/ontology/neighbors",
        "price_usd": "0.01",
        "answers": "ancestors, children, types, brands and chains around an id",
        "subject": {
          "entity": {
            "param": "id",
            "as": "id"
          },
          "spt": {
            "param": "id",
            "as": "id"
          },
          "gpc": {
            "param": "id",
            "as": "id"
          },
          "brand": {
            "param": "id",
            "as": "id"
          },
          "retailer": {
            "param": "id",
            "as": "id"
          }
        }
      },
      {
        "by": "similar",
        "route": "/v1/ontology/similar",
        "price_usd": "0.01",
        "answers": "the brands most like a footprint of shelves",
        "subject": {}
      }
    ],
    "params": [
      {
        "name": "id",
        "type": "string",
        "description": "An id from `resolve`: spt:…, gpc:…, brand:… or retailer:…."
      },
      {
        "name": "relations",
        "type": "string",
        "description": "Comma-joined or repeated: which blocks to return."
      },
      {
        "name": "limit",
        "type": "integer",
        "description": "Most items in each list."
      },
      {
        "name": "country",
        "type": "string",
        "enum": [
          "us",
          "ca"
        ],
        "description": "Coverage is per country, so a typo is a 400 rather than a quiet read of the other one."
      },
      {
        "name": "shelf",
        "type": "string",
        "array": true,
        "description": "One per shelf the brand sells on: `<spt id>,<products>[,<tier>]`."
      },
      {
        "name": "brand",
        "type": "string",
        "description": "The catalog brand this footprint belongs to, when it is one."
      }
    ]
  },
  {
    "name": "coverage",
    "summary": "How much evidence stands behind an id.",
    "default_by": "evidence",
    "splits": [
      {
        "by": "evidence",
        "route": "/v1/ontology/coverage",
        "price_usd": "0.01",
        "answers": "listings, freshness, channels and the chains scanned",
        "subject": {
          "entity": {
            "param": "id",
            "as": "id"
          },
          "spt": {
            "param": "id",
            "as": "id"
          },
          "gpc": {
            "param": "id",
            "as": "id"
          },
          "brand": {
            "param": "id",
            "as": "id"
          },
          "retailer": {
            "param": "id",
            "as": "id"
          }
        }
      }
    ],
    "params": [
      {
        "name": "id",
        "type": "string",
        "array": true,
        "description": "An id from `resolve`."
      },
      {
        "name": "retailer",
        "type": "string",
        "description": "Narrows a brand's coverage to one chain: seen there, scanned and not seen, or not scanned."
      },
      {
        "name": "country",
        "type": "string",
        "enum": [
          "us",
          "ca"
        ],
        "description": "Coverage is per country, so a typo is a 400 rather than a quiet read of the other one."
      }
    ]
  }
];
