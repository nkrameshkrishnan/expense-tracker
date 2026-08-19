import { test, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import { RDSDataClient } from "@aws-sdk/client-rds-data";
import { SESClient } from "@aws-sdk/client-ses";
import { freshDb, withProvisioning, makeExecute } from "./pg-harness.js";
import { stripe } from "../src/stripe.js";
import {
  handler,
  fetchCheckoutPriceId,
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
  const payload = JSON.stringify({
    id: "evt_test",
    type,
    data: { object: data },
  });
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
  // This event type falls through to the `default:` no-op branch, which
  // deliberately opens no transaction at all. The Data API is still mocked
  // (the same way db.test.js does) so that a regression re-introducing a
  // transaction around the whole switch fails loudly here on an unexpected
  // AWS call rather than hanging on real credentials - and `sends` proves
  // the current no-transaction behaviour directly.
  const sends = [];
  mock.method(RDSDataClient.prototype, "send", async (command) => {
    sends.push(command.constructor.name);
    if (command.constructor.name === "BeginTransactionCommand")
      return { transactionId: "tx-1" };
    if (command.constructor.name === "ExecuteStatementCommand")
      return { records: [], columnMetadata: [] };
    return {};
  });

  const event = fakeEvent("customer.created", { id: "cus_test123" });
  const res = await handler(event);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(sends, []); // no transaction opened for an unhandled type
});

// --- Business logic: exercised directly against real Postgres/RLS.

test("checkout.session.completed sets plan from the price id and status active", async () => {
  const client = await freshDb();
  try {
    const tenantId = await seedTenant(client);
    mock.method(stripe.checkout.sessions, "listLineItems", async () => ({
      data: [{ price: { id: "price_pro_test" } }],
    }));

    // Two steps, mirroring the real handler: the Stripe HTTPS lookup runs
    // BEFORE the provisioning transaction opens, so the price id is passed
    // into the DB half rather than fetched from inside it.
    const session = {
      id: "sess_test123",
      customer: "cus_test123",
      subscription: "sub_test123",
    };
    const priceId = await fetchCheckoutPriceId(session);
    await withProvisioning(client, "stripe-webhook", (c) =>
      handleCheckoutCompleted(makeExecute(c), session, priceId),
    );

    const { rows } = await client.query(
      `select plan, status, stripe_subscription_id from tenants where id = $1`,
      [tenantId],
    );
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
    const tenantId = await seedTenant(client, {
      plan: "pro",
      status: "active",
      stripeSubscriptionId: "sub_test123",
    });

    await withProvisioning(client, "stripe-webhook", (c) =>
      handleSubscriptionUpdated(makeExecute(c), {
        id: "sub_test123",
        customer: "cus_test123",
        status: "past_due",
      }),
    );

    const { rows } = await client.query(
      `select status from tenants where id = $1`,
      [tenantId],
    );
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
      handleSubscriptionDeleted(makeExecute(c), {
        id: "sub_test123",
        customer: "cus_test123",
      }),
    );

    const { rows } = await client.query(
      `select plan, status, stripe_subscription_id from tenants where id = $1`,
      [tenantId],
    );
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
    const tenantId = await seedTenant(client, {
      plan: "pro",
      status: "active",
      stripeSubscriptionId: "sub_test123",
    });
    const subscription = {
      id: "sub_test123",
      customer: "cus_test123",
      status: "past_due",
    };

    // Two separate provisioning transactions, mirroring two separate
    // Lambda invocations receiving the same redelivered Stripe event.
    await withProvisioning(client, "stripe-webhook", (c) =>
      handleSubscriptionUpdated(makeExecute(c), subscription),
    );
    await withProvisioning(client, "stripe-webhook", (c) =>
      handleSubscriptionUpdated(makeExecute(c), subscription),
    );

    const { rows } = await client.query(
      `select status from tenants where id = $1`,
      [tenantId],
    );
    assert.equal(rows[0].status, "past_due");
  } finally {
    await client.end();
  }
});

// --- SES notifications: these two send real, mocked-SES-only email calls
// out of the same business-logic functions as the rest of this section, for
// the same reason spelled out in the block comment above (the real
// `handler` has no path to the local Docker Postgres, so it can't be used
// to verify a DB-driven owner-email lookup against seeded rows). Only
// SESClient.prototype.send is mocked here - the tenant/tenant_users
// lookups run for real, through RLS, the same as every other test below
// the "Business logic" divider.

test("customer.subscription.updated to past_due sends the past-due email to the owner", async () => {
  const client = await freshDb();
  try {
    const tenantId = await seedTenant(client, {
      plan: "pro",
      status: "active",
      stripeSubscriptionId: "sub_test123",
    });
    await withProvisioning(client, "owner-sub", async (c) => {
      await c.query(
        `insert into tenant_users (user_sub, tenant_id, email, role) values ('owner-sub', $1, 'owner@x.com', 'owner')`,
        [tenantId],
      );
    });
    const sent = [];
    mock.method(SESClient.prototype, "send", async (command) => {
      sent.push(command.input);
      return {};
    });

    await withProvisioning(client, "stripe-webhook", (c) =>
      handleSubscriptionUpdated(makeExecute(c), {
        id: "sub_test123",
        customer: "cus_test123",
        status: "past_due",
      }),
    );

    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].Destination.ToAddresses, ["owner@x.com"]);
    assert.match(sent[0].Message.Subject.Data, /payment failed/i);
  } finally {
    await client.end();
  }
});

test("customer.subscription.deleted sends the downgraded email to the owner", async () => {
  const client = await freshDb();
  try {
    const tenantId = await seedTenant(client, {
      plan: "family",
      status: "active",
      stripeSubscriptionId: "sub_test123",
    });
    await withProvisioning(client, "owner-sub", async (c) => {
      await c.query(
        `insert into tenant_users (user_sub, tenant_id, email, role) values ('owner-sub', $1, 'owner@x.com', 'owner')`,
        [tenantId],
      );
    });
    const sent = [];
    mock.method(SESClient.prototype, "send", async (command) => {
      sent.push(command.input);
      return {};
    });

    await withProvisioning(client, "stripe-webhook", (c) =>
      handleSubscriptionDeleted(makeExecute(c), {
        id: "sub_test123",
        customer: "cus_test123",
      }),
    );

    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].Destination.ToAddresses, ["owner@x.com"]);
    assert.match(sent[0].Message.Subject.Data, /Free plan/);
  } finally {
    await client.end();
  }
});

test("customer.subscription.updated NOT reaching past_due does not send any email", async () => {
  const client = await freshDb();
  try {
    const tenantId = await seedTenant(client, {
      plan: "pro",
      status: "past_due",
      stripeSubscriptionId: "sub_test123",
    });
    await withProvisioning(client, "owner-sub", async (c) => {
      await c.query(
        `insert into tenant_users (user_sub, tenant_id, email, role) values ('owner-sub', $1, 'owner@x.com', 'owner')`,
        [tenantId],
      );
    });
    const sent = [];
    mock.method(SESClient.prototype, "send", async (command) => {
      sent.push(command.input);
      return {};
    });

    // Recovery: status goes from past_due back to active. Only the
    // past_due branch should ever email - a recovering subscription must
    // not trigger a past-due (or any) notification.
    await withProvisioning(client, "stripe-webhook", (c) =>
      handleSubscriptionUpdated(makeExecute(c), {
        id: "sub_test123",
        customer: "cus_test123",
        status: "active",
      }),
    );

    assert.equal(sent.length, 0);
  } finally {
    await client.end();
  }
});

test("an SES failure does not roll back the tenant status/plan DB write", async () => {
  const client = await freshDb();
  try {
    const updatedTenantId = await seedTenant(client, {
      plan: "pro",
      status: "active",
      stripeCustomerId: "cus_update_fail",
      stripeSubscriptionId: "sub_update_fail",
    });
    const deletedTenantId = await seedTenant(client, {
      plan: "family",
      status: "active",
      stripeCustomerId: "cus_delete_fail",
      stripeSubscriptionId: "sub_delete_fail",
    });
    for (const [tenantId, customerId] of [
      [updatedTenantId, "cus_update_fail"],
      [deletedTenantId, "cus_delete_fail"],
    ]) {
      await withProvisioning(client, "owner-sub", async (c) => {
        await c.query(
          `insert into tenant_users (user_sub, tenant_id, email, role) values ($1, $2, 'owner@x.com', 'owner')`,
          [`owner-${customerId}`, tenantId],
        );
      });
    }
    mock.method(SESClient.prototype, "send", async () => {
      throw new Error("SES throttled");
    });

    // Neither call should throw - a rejected SES send must not surface as
    // an error out of the handler, and (more importantly, see below) must
    // not have rolled back the update that already ran.
    await withProvisioning(client, "stripe-webhook", (c) =>
      handleSubscriptionUpdated(makeExecute(c), {
        id: "sub_update_fail",
        customer: "cus_update_fail",
        status: "past_due",
      }),
    );
    await withProvisioning(client, "stripe-webhook", (c) =>
      handleSubscriptionDeleted(makeExecute(c), {
        id: "sub_delete_fail",
        customer: "cus_delete_fail",
      }),
    );

    const updated = await client.query(
      `select status from tenants where id = $1`,
      [updatedTenantId],
    );
    assert.equal(updated.rows[0].status, "past_due");

    const deleted = await client.query(
      `select plan, status, stripe_subscription_id from tenants where id = $1`,
      [deletedTenantId],
    );
    assert.equal(deleted.rows[0].plan, "free");
    assert.equal(deleted.rows[0].status, "active");
    assert.equal(deleted.rows[0].stripe_subscription_id, null);
  } finally {
    await client.end();
  }
});

// --- Late / out-of-order redelivery of a SUPERSEDED subscription's events.
// Stripe delivery is at-least-once and unordered, so a retry of an event
// belonging to a subscription the customer has since cancelled and replaced
// can land at any time. Both handlers key on stripe_subscription_id as well
// as stripe_customer_id precisely so those stale events match nothing; with
// a customer-only WHERE clause both tests below would clobber the live
// subscription's state.

test("a stale customer.subscription.deleted does not downgrade the tenant's CURRENT subscription", async () => {
  const client = await freshDb();
  try {
    // Tenant resubscribed: checkout completed for sub_B, so that is what is
    // on file. sub_A is the older, already-gone subscription.
    const tenantId = await seedTenant(client, {
      plan: "free",
      status: "active",
    });
    mock.method(stripe.checkout.sessions, "listLineItems", async () => ({
      data: [{ price: { id: "price_family_test" } }],
    }));
    const session = {
      id: "sess_B",
      customer: "cus_test123",
      subscription: "sub_B",
    };
    const priceId = await fetchCheckoutPriceId(session);
    await withProvisioning(client, "stripe-webhook", (c) =>
      handleCheckoutCompleted(makeExecute(c), session, priceId),
    );

    const sent = [];
    mock.method(SESClient.prototype, "send", async (command) => {
      sent.push(command.input);
      return {};
    });

    await withProvisioning(client, "stripe-webhook", (c) =>
      handleSubscriptionDeleted(makeExecute(c), {
        id: "sub_A",
        customer: "cus_test123",
      }),
    );

    const { rows } = await client.query(
      `select plan, status, stripe_subscription_id from tenants where id = $1`,
      [tenantId],
    );
    assert.equal(rows[0].plan, "family");
    assert.equal(rows[0].status, "active");
    assert.equal(rows[0].stripe_subscription_id, "sub_B");
    // And no "you're back on the Free plan" email for a downgrade that
    // never happened.
    assert.equal(sent.length, 0);
  } finally {
    await client.end();
  }
});

test("a stale customer.subscription.updated does not mark a live subscription past_due", async () => {
  const client = await freshDb();
  try {
    const tenantId = await seedTenant(client, {
      plan: "free",
      status: "active",
    });
    mock.method(stripe.checkout.sessions, "listLineItems", async () => ({
      data: [{ price: { id: "price_pro_test" } }],
    }));
    const session = {
      id: "sess_B",
      customer: "cus_test123",
      subscription: "sub_B",
    };
    const priceId = await fetchCheckoutPriceId(session);
    await withProvisioning(client, "stripe-webhook", (c) =>
      handleCheckoutCompleted(makeExecute(c), session, priceId),
    );

    const sent = [];
    mock.method(SESClient.prototype, "send", async (command) => {
      sent.push(command.input);
      return {};
    });

    await withProvisioning(client, "stripe-webhook", (c) =>
      handleSubscriptionUpdated(makeExecute(c), {
        id: "sub_A",
        customer: "cus_test123",
        status: "past_due",
      }),
    );

    const { rows } = await client.query(
      `select plan, status, stripe_subscription_id from tenants where id = $1`,
      [tenantId],
    );
    assert.equal(rows[0].plan, "pro");
    assert.equal(rows[0].status, "active");
    assert.equal(rows[0].stripe_subscription_id, "sub_B");
    assert.equal(sent.length, 0); // no false "payment failed" email either
  } finally {
    await client.end();
  }
});

test("an UPDATE that matches no tenant is logged rather than passing silently", async () => {
  const client = await freshDb();
  const errors = [];
  mock.method(console, "error", (...args) => errors.push(args.join(" ")));
  try {
    await seedTenant(client, {
      plan: "pro",
      status: "active",
      stripeSubscriptionId: "sub_B",
    });

    await withProvisioning(client, "stripe-webhook", (c) =>
      handleSubscriptionUpdated(makeExecute(c), {
        id: "sub_A",
        customer: "cus_unknown",
        status: "past_due",
      }),
    );

    assert.ok(
      errors.some((e) =>
        /Webhook matched no tenant for customer cus_unknown/.test(e),
      ),
      `expected a no-tenant-matched console.error, got: ${JSON.stringify(errors)}`,
    );
  } finally {
    await client.end();
  }
});
