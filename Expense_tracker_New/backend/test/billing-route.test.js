import { test, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import { freshDb, withProvisioning, withTenant, makeExecute } from "./pg-harness.js";
import { stripe } from "../src/stripe.js";
import { createCheckoutSession, createPortalSession } from "../src/routes/billing.js";

afterEach(() => mock.restoreAll());

async function seedTenant(client, name) {
  return withProvisioning(client, "seed-user", async (c) => {
    const { rows } = await c.query(`insert into tenants (name) values ($1) returning id`, [name]);
    return rows[0].id;
  });
}

test("createCheckoutSession creates a Stripe customer on first use and stores its id", async () => {
  const client = await freshDb();
  try {
    const tenantId = await seedTenant(client, "Household");
    mock.method(stripe.customers, "create", async () => ({ id: "cus_test123" }));
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
    const { rows } = await client.query(`select stripe_customer_id from tenants where id = $1`, [tenantId]);
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
      c.query(`update tenants set stripe_customer_id = 'cus_existing' where id = $1`, [tenantId]),
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

test("createPortalSession uses the tenant's existing Stripe customer id", async () => {
  const client = await freshDb();
  try {
    const tenantId = await seedTenant(client, "Household");
    await withTenant(client, tenantId, "owner-sub", (c) =>
      c.query(`update tenants set stripe_customer_id = 'cus_existing' where id = $1`, [tenantId]),
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
