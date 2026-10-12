import { z } from "zod";

export const countrySchema = z
  .enum(["us", "ca"])
  .optional()
  .describe("Country code (us or ca). Defaults to us.");

export const retailerSchema = z
  .string()
  .optional()
  .describe("Filter to a specific retailer (e.g. amazon, walmart, costco)");

export const daysSchema = z
  .number()
  .int()
  .positive()
  .optional()
  .describe("Number of days to look back");

// ── Social tier ───────────────────────────────────────────────────
// Seven of the nine social routes take the same four options, so they live
// here rather than being retyped per tool. Enums mirror the API's OpenAPI
// spec exactly: sending a value outside them earns a 400, not a coercion.

export const windowSchema = z
  .enum(["7d", "30d", "90d"])
  .optional()
  .describe("Rollup window. Only published windows are accepted. Defaults to 30d.");

export const platformSchema = z
  .enum(["all", "tiktok", "instagram"])
  .optional()
  .describe("TikTok and Instagram are the only platforms in the corpus. Defaults to all.");

export const organicOnlySchema = z
  .boolean()
  .optional()
  .describe("Exclude posts marked as ads. Defaults to false.");

export const socialLimitSchema = z
  .number()
  .int()
  .min(1)
  .max(100)
  .optional()
  .describe("Max results to return (default 25, min 1, max 100)");

// ── Ontology ids ──────────────────────────────────────────────────
// The paid routes that take a category or a brand also take the id the free
// ontology tools return, beside the name. An id is `kind:value`; the API
// refuses a malformed one before any payment is requested.

export const sptSchema = z
  .string()
  .optional()
  .describe(
    "A shelf by id, from ontology_resolve (a category match's `id`, e.g. 'spt:fb-2-17-2-4'). Send it INSTEAD of the category name, not with it.",
  );

export const gpcSchema = z
  .string()
  .optional()
  .describe(
    "A product type by id, from ontology_resolve (a product_type match's `id`, e.g. 'gpc:10008059'). Covers every shelf the type is filed under, so a type shelved in two departments is one scope. Send it INSTEAD of the category name, not with it.",
  );

export const brandIdSchema = z
  .string()
  .optional()
  .describe(
    "A brand by id, from ontology_resolve (a brand match's `id`, e.g. 'brand:b_ac1a1c7143cb2199'). Send it INSTEAD of the brand name, not with it.",
  );

export const entityUidSchema = z
  .string()
  .optional()
  .describe(
    "One specific product by its entity uid, from a ontology_resolve result with kinds ['entity'] (the `entity_uid` in its suggested call). Send it INSTEAD of q.",
  );
