import { test } from "node:test";
import assert from "node:assert/strict";

process.env.STRIPE_PRICE_ID_PRO = "price_pro_test";
process.env.STRIPE_PRICE_ID_FAMILY = "price_family_test";

const { SEAT_CAPS, FEATURES, planFromPriceId, AI_IMPORT_MONTHLY_CAP } =
  await import("../src/plans.js");

test("SEAT_CAPS has all three tiers with the spec's caps", () => {
  assert.deepEqual(SEAT_CAPS, {
    free: 1,
    pro: 2,
    family: 5,
  });
});

test("FEATURES: only free restricts net worth and history", () => {
  assert.equal(FEATURES.free.netWorth, false);
  assert.equal(FEATURES.free.historyMonths, 12);
  for (const tier of ["pro", "family"]) {
    assert.equal(FEATURES[tier].netWorth, true);
    assert.equal(FEATURES[tier].historyMonths, null);
  }
});

test("FEATURES: aiImport is only true for pro and family", () => {
  assert.equal(FEATURES.free.aiImport, false);
  assert.equal(FEATURES.pro.aiImport, true);
  assert.equal(FEATURES.family.aiImport, true);
});

test("AI_IMPORT_MONTHLY_CAP is a positive number", () => {
  assert.equal(typeof AI_IMPORT_MONTHLY_CAP, "number");
  assert.ok(AI_IMPORT_MONTHLY_CAP > 0);
});

test("planFromPriceId maps configured price ids to plan names", () => {
  assert.equal(planFromPriceId("price_pro_test"), "pro");
  assert.equal(planFromPriceId("price_family_test"), "family");
});

test("planFromPriceId throws on an unrecognized price id", () => {
  assert.throws(
    () => planFromPriceId("price_unknown"),
    /Unrecognized Stripe price/,
  );
});
