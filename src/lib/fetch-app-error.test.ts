import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isApplicationErrorResponse } from "./fetch.js";

describe("isApplicationErrorResponse", () => {
  it("never treats a 402 payment challenge as an application answer", async () => {
    const res = new Response(
      JSON.stringify({
        type: "https://api.syntalic.com/errors/payment-required",
        title: "Payment Required",
        status: 402,
        error: { code: "PAYMENT_REQUIRED" },
      }),
      { status: 402, headers: { "content-type": "application/problem+json" } },
    );
    assert.equal(await isApplicationErrorResponse(res), false);
  });

  it("still recognises a settled application problem+json", async () => {
    const res = new Response(
      JSON.stringify({
        type: "https://api.syntalic.com/errors/no-results",
        title: "No Results",
        status: 404,
        error: { code: "NO_RESULTS" },
      }),
      { status: 404, headers: { "content-type": "application/problem+json" } },
    );
    assert.equal(await isApplicationErrorResponse(res), true);
  });
});
