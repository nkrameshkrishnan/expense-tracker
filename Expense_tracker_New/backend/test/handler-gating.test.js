import { test, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import { assertManagesInvites, assertKnownPriceId } from "../src/handler.js";
import { stripe } from "../src/stripe.js";

process.env.STRIPE_PRICE_ID_PRO = "price_pro_test";
process.env.STRIPE_PRICE_ID_FAMILY = "price_family_test";
process.env.STRIPE_PRICE_ID_BUSINESS = "price_business_test";

afterEach(() => mock.restoreAll());

test("throws for a member", () => {
  assert.throws(() => assertManagesInvites({ role: "member" }));
});
test("throws for no membership at all", () => {
  assert.throws(() => assertManagesInvites(null));
});
test("does not throw for an owner", () => {
  assert.doesNotThrow(() => assertManagesInvites({ role: "owner" }));
});
test("does not throw for an admin", () => {
  assert.doesNotThrow(() => assertManagesInvites({ role: "admin" }));
});

// assertKnownPriceId is the guard the createCheckoutSession action runs
// BEFORE it calls into routes/billing.js - which is the only place any
// Stripe API call happens for that action. Mocking the two Stripe calls
// that path would otherwise make, and asserting neither fires, is what
// pins down "rejected before reaching Stripe", i.e. before a card can be
// charged for a price id this app cannot map back to a plan.
test("assertKnownPriceId rejects an unrecognized price id without calling Stripe", () => {
  const calls = [];
  mock.method(stripe.customers, "create", async () => {
    calls.push("customers.create");
    return { id: "cus_should_not_happen" };
  });
  mock.method(stripe.checkout.sessions, "create", async () => {
    calls.push("checkout.sessions.create");
    return { url: "https://checkout.stripe.com/should-not-happen" };
  });

  assert.throws(
    () => assertKnownPriceId("price_typo_or_wrong_mode"),
    /Unrecognized Stripe price id/,
  );
  assert.deepEqual(calls, []);
});

test("assertKnownPriceId accepts each configured price id", () => {
  for (const id of ["price_pro_test", "price_family_test", "price_business_test"])
    assert.doesNotThrow(() => assertKnownPriceId(id));
});

test("assertKnownPriceId rejects a missing price id", () => {
  assert.throws(() => assertKnownPriceId(undefined), /Unrecognized Stripe price id/);
});
