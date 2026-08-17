import { test, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import { RDSDataClient } from "@aws-sdk/client-rds-data";
import { freshDb, withProvisioning, makeExecute } from "./pg-harness.js";
import { stripe } from "../src/stripe.js";
import {
  handler,
  handleCheckoutCompleted,
  handleSubscriptionUpdated,
  handleSubscriptionDeleted,
} from "../src/stripeWebhook.js";

process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
process.env.STRIPE_PRICE_ID_PRO = "price_pro_test";
process.env.STRIPE_PRICE_ID_FAMILY = "price_family_test";
process.env.STRIPE_PRICE_ID_BUSINESS = "price_business_test";

afterEach(() => mock.restoreAll());

async function seedTenant(client, overrides = {}) {
  return withProvisioning(client, "seed-user", async (c) => {
    const { rows } = await c.query(
      `insert into tenants (name, stripe_customer_id, stripe_subscription_id, plan, status)
       values ($1, $2, $3, $4, $5) returning id`,
      [
        "Household",
        overrides.stripeCustomerId ?? "cus_test123",
        overrides.stripeSubscriptionId ?? null,
        overrides.plan ?? "free",
        overrides.status ?? "active",
      ],
    );
    return rows[0].id;
  });
}

function fakeEvent(type, data) {
  const payload = JSON.stringify({ id: "evt_test", type, data: { object: data } });
  const header = stripe.webhooks.generateTestHeaderString({
    payload,
    secret: process.env.STRIPE_WEBHOOK_SECRET,
  });
  return { body: payload, headers: { "stripe-signature": header } };
}

// --- Top-level `handler` wiring: signature verification + dispatch only.
// These two are the only tests that call the real Lambda entry point.
// Everything else below calls the exported business-logic functions
// directly with a real Postgres `execute` (via pg-harness.js), the same
// pattern every other route module's tests use - see the comment atop
// stripeWebhook.js for why: the real `handler` opens a
// runProvisioningTransaction backed by the actual AWS RDS Data API, which
// has no path to the local Docker Postgres and needs AWS credentials/region
// this test environment doesn't have.

test("rejects a request with an invalid signature", async () => {
  const res = await handler({
    body: JSON.stringify({ type: "checkout.session.completed" }),
    headers: { "stripe-signature": "invalid" },
  });
  assert.equal(res.statusCode, 400);
});

test("accepts a valid signature and returns 200 for an unhandled event type", async () => {
  // No real DB write happens for this event type (falls through to the
  // `default:` no-op branch), but runProvisioningTransaction still opens
  // and commits a transaction around it - mock the Data API the same way
  // db.test.js does, purely to prove the signature-verified dispatch path
  // returns 200 without needing a real AWS-backed transaction.
  mock.method(RDSDataClient.prototype, "send", async (command) => {
    if (command.constructor.name === "BeginTransactionCommand") return { transactionId: "tx-1" };
    if (command.constructor.name === "ExecuteStatementCommand")
      return { records: [], columnMetadata: [] };
    return {};
  });

  const event = fakeEvent("customer.created", { id: "cus_test123" });
  const res = await handler(event);
  assert.equal(res.statusCode, 200);
});

// --- Business logic: exercised directly against real Postgres/RLS.

test("checkout.session.completed sets plan from the price id and status active", async () => {
  const client = await freshDb();
  try {
    const tenantId = await seedTenant(client);
    mock.method(stripe.checkout.sessions, "listLineItems", async () => ({
      data: [{ price: { id: "price_pro_test" } }],
    }));

    await withProvisioning(client, "stripe-webhook", (c) =>
      handleCheckoutCompleted(makeExecute(c), {
        id: "sess_test123",
        customer: "cus_test123",
        subscription: "sub_test123",
      }),
    );

    const { rows } = await client.query(`select plan, status, stripe_subscription_id from tenants where id = $1`, [tenantId]);
    assert.equal(rows[0].plan, "pro");
    assert.equal(rows[0].status, "active");
    assert.equal(rows[0].stripe_subscription_id, "sub_test123");
  } finally {
    await client.end();
  }
});

test("customer.subscription.updated with status past_due sets tenants.status", async () => {
  const client = await freshDb();
  try {
    const tenantId = await seedTenant(client, { plan: "pro", status: "active" });

    await withProvisioning(client, "stripe-webhook", (c) =>
      handleSubscriptionUpdated(makeExecute(c), { customer: "cus_test123", status: "past_due" }),
    );

    const { rows } = await client.query(`select status from tenants where id = $1`, [tenantId]);
    assert.equal(rows[0].status, "past_due");
  } finally {
    await client.end();
  }
});

test("customer.subscription.deleted reverts to free/active and clears subscription id", async () => {
  const client = await freshDb();
  try {
    const tenantId = await seedTenant(client, {
      plan: "family",
      status: "past_due",
      stripeSubscriptionId: "sub_test123",
    });

    await withProvisioning(client, "stripe-webhook", (c) =>
      handleSubscriptionDeleted(makeExecute(c), { customer: "cus_test123" }),
    );

    const { rows } = await client.query(`select plan, status, stripe_subscription_id from tenants where id = $1`, [tenantId]);
    assert.equal(rows[0].plan, "free");
    assert.equal(rows[0].status, "active");
    assert.equal(rows[0].stripe_subscription_id, null);
  } finally {
    await client.end();
  }
});

test("processing the same event twice is safe (idempotent)", async () => {
  const client = await freshDb();
  try {
    const tenantId = await seedTenant(client, { plan: "pro", status: "active" });
    const subscription = { customer: "cus_test123", status: "past_due" };

    // Two separate provisioning transactions, mirroring two separate
    // Lambda invocations receiving the same redelivered Stripe event.
    await withProvisioning(client, "stripe-webhook", (c) =>
      handleSubscriptionUpdated(makeExecute(c), subscription),
    );
    await withProvisioning(client, "stripe-webhook", (c) =>
      handleSubscriptionUpdated(makeExecute(c), subscription),
    );

    const { rows } = await client.query(`select status from tenants where id = $1`, [tenantId]);
    assert.equal(rows[0].status, "past_due");
  } finally {
    await client.end();
  }
});
