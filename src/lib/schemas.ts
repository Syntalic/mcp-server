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
