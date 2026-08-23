import { test, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  freshDb,
  withProvisioning,
  withTenant,
  makeExecute,
} from "./pg-harness.js";
import { stripe } from "../src/stripe.js";
import {
  createCheckoutSession,
  createPortalSession,
  getPlans,
} from "../src/routes/billing.js";

afterEach(() => mock.restoreAll());

async function seedTenant(client, name) {
  return withProvisioning(client, "seed-user", async (c) => {
    const { rows } = await c.query(
      `insert into tenants (name) values ($1) returning id`,
      [name],
    );
    return rows[0].id;
  });
}

test("createCheckoutSession creates a Stripe customer on first use and stores its id", async () => {
  const client = await freshDb();
  try {
    const tenantId = await seedTenant(client, "Household");
    mock.method(stripe.customers, "create", async () => ({
      id: "cus_test123",
    }));
    mock.method(stripe.checkout.sessions, "create", async (args) => {
      assert.equal(args.customer, "cus_test123");
      assert.equal(args.mode, "subscription");
      assert.equal(args.line_items[0].price, "price_pro_test");
      return { url: "https://checkout.stripe.com/test-session" };
    });

    const result = await withTenant(client, tenantId, "owner-sub", (c) =>
      createCheckoutSession(makeExecute(c), stripe, tenantId, {
        priceId: "price_pro_test",
        successUrl: "https://example.com/success",
        cancelUrl: "https://example.com/cancel",
      }),
    );

    assert.equal(result.url, "https://checkout.stripe.com/test-session");
    const { rows } = await client.query(
      `select stripe_customer_id from tenants where id = $1`,
      [tenantId],
    );
    assert.equal(rows[0].stripe_customer_id, "cus_test123");
  } finally {
    await client.end();
  }
});

test("createCheckoutSession reuses an existing Stripe customer id, doesn't create a second one", async () => {
  const client = await freshDb();
  try {
    const tenantId = await seedTenant(client, "Household");
    await withTenant(client, tenantId, "owner-sub", (c) =>
      c.query(
        `update tenants set stripe_customer_id = 'cus_existing' where id = $1`,
        [tenantId],
      ),
    );

    let createCalled = false;
    mock.method(stripe.customers, "create", async () => {
      createCalled = true;
      return { id: "cus_should_not_be_used" };
    });
    mock.method(stripe.checkout.sessions, "create", async (args) => {
      assert.equal(args.customer, "cus_existing");
      return { url: "https://checkout.stripe.com/test-session" };
    });

    await withTenant(client, tenantId, "owner-sub", (c) =>
      createCheckoutSession(makeExecute(c), stripe, tenantId, {
        priceId: "price_pro_test",
        successUrl: "https://example.com/success",
        cancelUrl: "https://example.com/cancel",
      }),
    );

    assert.equal(createCalled, false);
  } finally {
    await client.end();
  }
});

test("createCheckoutSession refuses to start a SECOND subscription for a tenant that already has one", async () => {
  const client = await freshDb();
  try {
    const tenantId = await seedTenant(client, "Household");
    await withTenant(client, tenantId, "owner-sub", (c) =>
      c.query(
        `update tenants set plan = 'pro', stripe_customer_id = 'cus_existing', stripe_subscription_id = 'sub_existing' where id = $1`,
        [tenantId],
      ),
    );

    // Checkout creates a NEW subscription; an existing subscriber changing
    // plans has to go through the Portal, or they end up billed twice.
    const calls = [];
    mock.method(stripe.customers, "create", async () => {
      calls.push("customers.create");
      return { id: "cus_should_not_be_used" };
    });
    mock.method(stripe.checkout.sessions, "create", async () => {
      calls.push("checkout.sessions.create");
      return { url: "https://checkout.stripe.com/should-not-happen" };
    });

    await assert.rejects(
      () =>
        withTenant(client, tenantId, "owner-sub", (c) =>
          createCheckoutSession(makeExecute(c), stripe, tenantId, {
            priceId: "price_family_test",
            successUrl: "https://example.com/success",
            cancelUrl: "https://example.com/cancel",
          }),
        ),
      /already has an active subscription/,
    );
    assert.deepEqual(calls, []); // rejected before any Stripe call

    const { rows } = await client.query(
      `select plan, stripe_subscription_id from tenants where id = $1`,
      [tenantId],
    );
    assert.equal(rows[0].plan, "pro");
    assert.equal(rows[0].stripe_subscription_id, "sub_existing");
  } finally {
    await client.end();
  }
});

test("createPortalSession uses the tenant's existing Stripe customer id", async () => {
  const client = await freshDb();
  try {
    const tenantId = await seedTenant(client, "Household");
    await withTenant(client, tenantId, "owner-sub", (c) =>
      c.query(
        `update tenants set stripe_customer_id = 'cus_existing' where id = $1`,
        [tenantId],
      ),
    );
    mock.method(stripe.billingPortal.sessions, "create", async (args) => {
      assert.equal(args.customer, "cus_existing");
      assert.equal(args.return_url, "https://example.com/data");
      return { url: "https://billing.stripe.com/test-portal" };
    });

    const result = await withTenant(client, tenantId, "owner-sub", (c) =>
      createPortalSession(makeExecute(c), stripe, tenantId, {
        returnUrl: "https://example.com/data",
      }),
    );

    assert.equal(result.url, "https://billing.stripe.com/test-portal");
  } finally {
    await client.end();
  }
});

test("getPlans returns every SEAT_CAPS tier, with live amounts for every configured price id", async () => {
  process.env.STRIPE_PRICE_ID_PRO = "price_pro_test";
  process.env.STRIPE_PRICE_ID_FAMILY = "price_family_test";
  mock.method(stripe.prices, "retrieve", async (id) => {
    const byId = {
      price_pro_test: { unit_amount: 700, currency: "cad" },
      price_family_test: { unit_amount: 1300, currency: "cad" },
    };
    return byId[id];
  });

  const plans = await getPlans(stripe);

  assert.deepEqual(plans, [
    {
      id: "free",
      priceId: null,
      seatCap: 1,
      features: { netWorth: false, historyMonths: 12 },
    },
    {
      id: "pro",
      priceId: "price_pro_test",
      seatCap: 2,
      features: { netWorth: true, historyMonths: null },
      amount: 700,
      currency: "cad",
    },
    {
      id: "family",
      priceId: "price_family_test",
      seatCap: 5,
      features: { netWorth: true, historyMonths: null },
      amount: 1300,
      currency: "cad",
    },
  ]);
});

test("getPlans includes a tier even when its price id isn't configured - just without amount/currency", async () => {
  process.env.STRIPE_PRICE_ID_PRO = "price_pro_test";
  process.env.STRIPE_PRICE_ID_FAMILY = "";
  mock.method(stripe.prices, "retrieve", async () => ({
    unit_amount: 700,
    currency: "cad",
  }));

  const plans = await getPlans(stripe);
  const family = plans.find((p) => p.id === "family");

  assert.deepEqual(family, {
    id: "family",
    priceId: null,
    seatCap: 5,
    features: { netWorth: true, historyMonths: null },
  });
});

test("getPlans includes a tier even when its price id fails to resolve - just without amount/currency", async () => {
  process.env.STRIPE_PRICE_ID_PRO = "price_pro_test";
  process.env.STRIPE_PRICE_ID_FAMILY = "price_missing";
  mock.method(stripe.prices, "retrieve", async (id) => {
    if (id === "price_missing") throw new Error("No such price");
    return { unit_amount: 700, currency: "cad" };
  });

  const plans = await getPlans(stripe);
  const pro = plans.find((p) => p.id === "pro");
  const family = plans.find((p) => p.id === "family");

  assert.deepEqual(pro, {
    id: "pro",
    priceId: "price_pro_test",
    seatCap: 2,
    features: { netWorth: true, historyMonths: null },
    amount: 700,
    currency: "cad",
  });
  assert.deepEqual(family, {
    id: "family",
    priceId: "price_missing",
    seatCap: 5,
    features: { netWorth: true, historyMonths: null },
  });
});
