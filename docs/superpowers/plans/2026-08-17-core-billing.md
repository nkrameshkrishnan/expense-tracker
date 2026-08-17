# Core Billing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Stripe Checkout + webhook billing to Ledger's multi-tenant backend — four pricing tiers (Free/Pro/Family/Business), seat-cap and feature-gate enforcement, a 30-day past-due grace period, SES + in-app notifications, and a frontend Billing panel.

**Architecture:** Stripe Checkout/Customer Portal (redirect-based, no embedded payment form) for the money-moving UI; a webhook Lambda, separate from the authenticated `DataFunction`, receives Stripe's server-to-server events and is the source of truth for `tenants.plan`/`tenants.status`. `createCheckoutSession`/`createPortalSession` are two new actions on the *existing* authenticated `{action, ...}` contract — no new Lambda needed for those, only the webhook is a new entry point.

**Tech Stack:** `stripe` npm SDK (Node), `@aws-sdk/client-ses` (matches the project's existing AWS SDK v3 pattern), Node's built-in `node:test` (mocked Stripe/SES clients for unit tests, real Postgres via the existing `pg-harness.js` for integration tests).

**Spec:** `docs/superpowers/specs/2026-08-17-core-billing-design.md`

## Global Constraints

- **`pg` stays a `backend/package.json` devDependency only** — no `pg` import under `backend/src/`. (Carried forward from the original hardening plan's constraint; still applies.)
- **Every new/modified JS file must pass `node --check`.**
- **All new backend actions follow the existing `{action, ...}` POST / query-param GET contract.**
- **Existing members/data are never locked out by a downgrade or cancellation** — only new growth (inviting past the new plan's seat cap) is blocked. Never write code that removes, hides, or restricts access to data/members a tenant already had.
- **`past_due` restricts nothing.** Only a canceled subscription (`plan` reverting to `free`) triggers feature/seat enforcement. The 30-day grace period is a Stripe Dashboard setting (Billing → "manage failed payments"), not application code — no task in this plan builds a timer or scheduled job.
- **Webhook handlers must be idempotent** — Stripe can redeliver the same event; every handler must be safe to run twice with the same end state.
- **Department/cost-center tracking and tenant-switching UI are out of scope** — do not build anything for either in this plan.

---

## File Structure

New files:

```
Expense_tracker_New/
  backend/src/
    plans.js                      # SEAT_CAPS, FEATURES, planFromPriceId() - Task 2
    stripe.js                     # lazy Stripe SDK client singleton - Task 3
    routes/billing.js             # createCheckoutSession, createPortalSession - Task 3
    stripeWebhook.js              # separate Lambda handler, 4 event types - Task 4
    notify.js                     # sendPastDueEmail, sendDowngradedEmail (SES) - Task 7
  backend/test/
    plans.test.js                 # Task 2
    billing-route.test.js         # Task 3
    stripe-webhook.test.js        # Task 4
    seat-cap.test.js              # Task 5
    feature-gate.test.js          # Task 6
    notify.test.js                # Task 7
```

Modified files: `db/schema.sql` (Task 1), `backend/package.json` (Tasks 3, 7 — new deps), `backend/src/handler.js` (Tasks 3, 6), `backend/src/routes/tenants.js` (Task 5), `backend/src/postConfirmation.js` (Task 5), `backend/src/routes/balances.js` (Task 6), `backend/src/routes/transactions.js` (Task 6), `backend/src/stripeWebhook.js` (Task 7, extending Task 4's file), `frontend/assets/store.js` (Task 8), `frontend/assets/app.js` (Task 9), `backend/template.yaml` (Task 10).

---

### Task 1: Schema — Stripe identifiers on `tenants`

**Files:**
- Modify: `Expense_tracker_New/db/schema.sql`
- Modify: `Expense_tracker_New/backend/test/pg-harness.test.js`

**Interfaces:**
- Produces: `tenants.stripe_customer_id text`, `tenants.stripe_subscription_id text` (both nullable — a Free tenant that's never checked out has neither).

- [ ] **Step 1: Write the failing test**

Add to `Expense_tracker_New/backend/test/pg-harness.test.js`, a new test in the same file as the existing schema-application check:

```js
test("freshDb applies schema.sql - tenants has Stripe identifier columns", async () => {
  const client = await freshDb();
  try {
    const { rows } = await client.query(
      `select column_name from information_schema.columns
       where table_name = 'tenants' and column_name in ('stripe_customer_id', 'stripe_subscription_id')`,
    );
    assert.equal(rows.length, 2);
  } finally {
    await client.end();
  }
});
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
cd Expense_tracker_New/backend && npm test -- test/pg-harness.test.js 2>&1 | grep -A5 "Stripe identifier"
```

Expected: FAIL — `rows.length` is `0`, not `2`.

- [ ] **Step 3: Add the columns**

In `db/schema.sql`, find the `tenants` table definition (`create table tenants (...)`) and add two nullable columns after `status`:

```sql
create table tenants (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  plan        text not null default 'free',
  status      text not null default 'active', -- active | past_due
  stripe_customer_id     text,
  stripe_subscription_id text,
  created_at  timestamptz not null default now()
);
```

(Match this against the file's actual current column list and ordering before editing — the above is the target shape, not a literal diff.)

- [ ] **Step 4: Run it to confirm it passes**

```bash
npm test -- test/pg-harness.test.js
```

Expected: PASS.

- [ ] **Step 5: Run the full suite to confirm nothing else broke**

```bash
npm test
```

Expected: all existing tests still pass — adding nullable columns to an existing table doesn't change any existing INSERT/UPDATE statement's behavior (none of them list `tenants` columns explicitly by name in a way that would break from an added column).

- [ ] **Step 6: Commit**

```bash
git add db/schema.sql backend/test/pg-harness.test.js
git commit -m "feat: add Stripe customer/subscription id columns to tenants"
```

---

### Task 2: Shared plan constants

**Files:**
- Create: `Expense_tracker_New/backend/src/plans.js`
- Create: `Expense_tracker_New/backend/test/plans.test.js`

**Interfaces:**
- Produces: `SEAT_CAPS: {free:1, pro:2, family:5, business:Infinity}`, `FEATURES: {free:{netWorth:false,historyMonths:12}, pro:{...}, family:{...}, business:{...}}` (all four with `netWorth:true, historyMonths:null`), `planFromPriceId(priceId: string): string` — throws if the price id isn't recognized.
- Consumes: `process.env.STRIPE_PRICE_ID_PRO`/`STRIPE_PRICE_ID_FAMILY`/`STRIPE_PRICE_ID_BUSINESS` for `planFromPriceId`'s lookup table.

- [ ] **Step 1: Write the failing test**

`Expense_tracker_New/backend/test/plans.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.STRIPE_PRICE_ID_PRO = "price_pro_test";
process.env.STRIPE_PRICE_ID_FAMILY = "price_family_test";
process.env.STRIPE_PRICE_ID_BUSINESS = "price_business_test";

const { SEAT_CAPS, FEATURES, planFromPriceId } = await import("../src/plans.js");

test("SEAT_CAPS has all four tiers with the spec's caps", () => {
  assert.deepEqual(SEAT_CAPS, { free: 1, pro: 2, family: 5, business: Infinity });
});

test("FEATURES: only free restricts net worth and history", () => {
  assert.equal(FEATURES.free.netWorth, false);
  assert.equal(FEATURES.free.historyMonths, 12);
  for (const tier of ["pro", "family", "business"]) {
    assert.equal(FEATURES[tier].netWorth, true);
    assert.equal(FEATURES[tier].historyMonths, null);
  }
});

test("planFromPriceId maps configured price ids to plan names", () => {
  assert.equal(planFromPriceId("price_pro_test"), "pro");
  assert.equal(planFromPriceId("price_family_test"), "family");
  assert.equal(planFromPriceId("price_business_test"), "business");
});

test("planFromPriceId throws on an unrecognized price id", () => {
  assert.throws(() => planFromPriceId("price_unknown"), /Unrecognized Stripe price/);
});
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
node --test test/plans.test.js
```

Expected: FAIL — `../src/plans.js` doesn't exist.

- [ ] **Step 3: Implement `plans.js`**

`Expense_tracker_New/backend/src/plans.js`:

```js
/* The four pricing tiers' seat caps and feature restrictions, plus the
   Stripe price-id -> plan-name mapping the webhook handler needs to know
   what a customer actually bought. Deliberately code constants, not a DB
   table: there are exactly four fixed tiers, and making them
   data-configurable would need a Stripe Dashboard change (a new
   Product/Price) whenever they change anyway. */

export const SEAT_CAPS = {
  free: 1,
  pro: 2,
  family: 5,
  business: Infinity,
};

export const FEATURES = {
  free: { netWorth: false, historyMonths: 12 },
  pro: { netWorth: true, historyMonths: null },
  family: { netWorth: true, historyMonths: null },
  business: { netWorth: true, historyMonths: null },
};

/** Maps a Stripe Price id (from a checkout.session.completed event's line
    item) back to one of this app's plan names. Read lazily from
    process.env on each call, not at module load, so tests can set the env
    vars after import - matches how auth.js reads COGNITO_USER_POOL_ID. */
export function planFromPriceId(priceId) {
  const map = {
    [process.env.STRIPE_PRICE_ID_PRO]: "pro",
    [process.env.STRIPE_PRICE_ID_FAMILY]: "family",
    [process.env.STRIPE_PRICE_ID_BUSINESS]: "business",
  };
  const plan = map[priceId];
  if (!plan) throw new Error(`Unrecognized Stripe price id: ${priceId}`);
  return plan;
}
```

- [ ] **Step 4: Run it to confirm it passes**

```bash
node --test test/plans.test.js
```

Expected: PASS, all four tests.

- [ ] **Step 5: `node --check` and commit**

```bash
node --check src/plans.js
git add src/plans.js test/plans.test.js
git commit -m "feat: add shared plan/seat-cap/feature-gate constants"
```

---

### Task 3: Checkout & Portal actions

**Files:**
- Create: `Expense_tracker_New/backend/src/stripe.js`
- Create: `Expense_tracker_New/backend/src/routes/billing.js`
- Create: `Expense_tracker_New/backend/test/billing-route.test.js`
- Modify: `Expense_tracker_New/backend/src/handler.js`
- Modify: `Expense_tracker_New/backend/package.json`

**Interfaces:**
- Consumes: `planFromPriceId` is NOT needed here (only the webhook needs it); `assertManagesInvites`-style role gate pattern from `handler.js`.
- Produces: `routes/billing.js`'s `createCheckoutSession(execute, stripe, tenantId, { priceId, successUrl, cancelUrl }): Promise<{url}>` and `createPortalSession(execute, stripe, tenantId, { returnUrl }): Promise<{url}>`. `stripe.js`'s `stripe` — a singleton Stripe client instance, `stripe.checkout.sessions.create`/`stripe.billingPortal.sessions.create`/`stripe.customers.create` used by `billing.js`.
- New POST actions on the existing contract: `createCheckoutSession` (payload: `{priceId, successUrl, cancelUrl}`), `createPortalSession` (payload: `{returnUrl}`). Both owner-only.

- [ ] **Step 1: Add the `stripe` dependency**

`Expense_tracker_New/backend/package.json` — add to `dependencies`:

```json
    "stripe": "^17.0.0",
```

```bash
npm install
```

- [ ] **Step 2: Write the failing test**

`Expense_tracker_New/backend/test/billing-route.test.js`:

```js
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
    await client.query(`update tenants set stripe_customer_id = 'cus_existing' where id = $1`, [tenantId]);

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
    await client.query(`update tenants set stripe_customer_id = 'cus_existing' where id = $1`, [tenantId]);
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
```

- [ ] **Step 3: Run it to confirm it fails**

```bash
node --test test/billing-route.test.js
```

Expected: FAIL — `../src/stripe.js` and `../src/routes/billing.js` don't exist.

- [ ] **Step 4: Implement `stripe.js`**

`Expense_tracker_New/backend/src/stripe.js`:

```js
/* Lazy Stripe SDK client singleton - same shape as db.js's module-scope
   RDSDataClient. STRIPE_SECRET_KEY is read once at module load; tests
   mock individual resource methods (stripe.customers.create, etc.)
   directly rather than mocking a prototype, since the Stripe SDK exposes
   real per-resource objects, not one shared class the way AWS SDK v3
   commands do. */
import Stripe from "stripe";

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_placeholder");
```

- [ ] **Step 5: Implement `routes/billing.js`**

`Expense_tracker_New/backend/src/routes/billing.js`:

```js
/* Checkout/Portal session creation. Both functions assume they're called
   inside an already tenant-scoped transaction (see db.js's
   runInTenantTransaction), same trust boundary as every other routes/*.js
   module - tenantId is passed explicitly (rather than read back out of
   the DB) because the caller already has it from the verified JWT, and
   the customer-lookup UPDATE below needs to target the right row under
   RLS regardless. */

export async function createCheckoutSession(execute, stripe, tenantId, { priceId, successUrl, cancelUrl }) {
  const customerId = await ensureStripeCustomer(execute, stripe, tenantId);
  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: "subscription",
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
  });
  return { url: session.url };
}

export async function createPortalSession(execute, stripe, tenantId, { returnUrl }) {
  const customerId = await ensureStripeCustomer(execute, stripe, tenantId);
  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: returnUrl,
  });
  return { url: session.url };
}

/** Creates a Stripe Customer on first use and stores its id, or returns
    the one already on file. tenant_id is tagged into the Customer's
    metadata - this is how the webhook handler maps a Stripe event back to
    a tenant without trusting anything client-supplied (see
    stripeWebhook.js). */
async function ensureStripeCustomer(execute, stripe, tenantId) {
  const rows = await execute.rows(
    `select stripe_customer_id from tenants where id = cast(:tenantId as uuid)`,
    { tenantId },
  );
  const existing = rows[0]?.stripe_customer_id;
  if (existing) return existing;

  const customer = await stripe.customers.create({
    metadata: { tenant_id: tenantId },
  });
  await execute(
    `update tenants set stripe_customer_id = :customerId where id = cast(:tenantId as uuid)`,
    { customerId: customer.id, tenantId },
  );
  return customer.id;
}
```

- [ ] **Step 6: Run it to confirm it passes**

```bash
node --test test/billing-route.test.js
```

Expected: PASS, all three tests.

- [ ] **Step 7: Wire into `handler.js`**

Add the import near the other route imports:

```js
import { createCheckoutSession, createPortalSession } from "./routes/billing.js";
import { stripe } from "./stripe.js";
```

Add two cases to `handlePost`'s `switch (action)`, gated owner-only (billing is more sensitive than invite management — admins can manage invites, only the owner touches money):

```js
      case "createCheckoutSession": {
        const membership = await tenants.getMembership(execute, user.sub);
        if (!membership || membership.role !== "owner")
          throw new Error("Only the owner can manage billing.");
        if (!/^https:\/\//.test(payload.successUrl) || !/^https:\/\//.test(payload.cancelUrl))
          throw new Error("successUrl/cancelUrl must be https:// URLs.");
        return {
          ok: true,
          ...(await createCheckoutSession(execute, stripe, user.tenantId, payload)),
        };
      }
      case "createPortalSession": {
        const membership = await tenants.getMembership(execute, user.sub);
        if (!membership || membership.role !== "owner")
          throw new Error("Only the owner can manage billing.");
        if (!/^https:\/\//.test(payload.returnUrl))
          throw new Error("returnUrl must be an https:// URL.");
        return {
          ok: true,
          ...(await createPortalSession(execute, stripe, user.tenantId, payload)),
        };
      }
```

- [ ] **Step 8: `node --check` and full suite**

```bash
node --check src/handler.js src/stripe.js src/routes/billing.js
npm test
```

Expected: no syntax errors; every test passes.

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json src/stripe.js src/routes/billing.js src/handler.js test/billing-route.test.js
git commit -m "feat: add Stripe Checkout/Portal session actions"
```

---

### Task 4: Stripe webhook handler

**Files:**
- Create: `Expense_tracker_New/backend/src/stripeWebhook.js`
- Create: `Expense_tracker_New/backend/test/stripe-webhook.test.js`

**Interfaces:**
- Consumes: `stripe` from `./stripe.js`, `planFromPriceId` from `./plans.js`.
- Produces: `export const handler` — a Lambda handler with the same `(event) => response` shape as `handler.js`'s `handler`, but with NO `requireUser()` call — Stripe calls this directly with no Cognito JWT. Not called from `handler.js`; this is its own file/Lambda entry point (wired in `template.yaml` in Task 10).

This task does NOT send notification emails yet — that's Task 7, added into this same file.

- [ ] **Step 1: Write the failing test**

`Expense_tracker_New/backend/test/stripe-webhook.test.js`:

```js
import { test, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import { freshDb, withProvisioning } from "./pg-harness.js";
import { stripe } from "../src/stripe.js";
import { handler } from "../src/stripeWebhook.js";

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

test("rejects a request with an invalid signature", async () => {
  const res = await handler({
    body: JSON.stringify({ type: "checkout.session.completed" }),
    headers: { "stripe-signature": "invalid" },
  });
  assert.equal(res.statusCode, 400);
});

test("checkout.session.completed sets plan from the price id and status active", async () => {
  const client = await freshDb();
  try {
    const tenantId = await seedTenant(client);
    const event = fakeEvent("checkout.session.completed", {
      customer: "cus_test123",
      subscription: "sub_test123",
      line_items: undefined, // Checkout sessions don't include line_items by default
    });
    // The handler must retrieve the session's line items itself (Checkout
    // Session webhook payloads don't include them inline by default).
    mock.method(stripe.checkout.sessions, "listLineItems", async () => ({
      data: [{ price: { id: "price_pro_test" } }],
    }));

    const res = await handler(event);
    assert.equal(res.statusCode, 200);

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
    const event = fakeEvent("customer.subscription.updated", {
      customer: "cus_test123",
      status: "past_due",
    });

    await handler(event);

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
    const event = fakeEvent("customer.subscription.deleted", { customer: "cus_test123" });

    await handler(event);

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
    const event = fakeEvent("customer.subscription.updated", {
      customer: "cus_test123",
      status: "past_due",
    });

    await handler(event);
    await handler(event); // redeliver

    const { rows } = await client.query(`select status from tenants where id = $1`, [tenantId]);
    assert.equal(rows[0].status, "past_due");
  } finally {
    await client.end();
  }
});
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
node --test test/stripe-webhook.test.js
```

Expected: FAIL — `../src/stripeWebhook.js` doesn't exist.

- [ ] **Step 3: Implement `stripeWebhook.js`**

`Expense_tracker_New/backend/src/stripeWebhook.js`:

```js
/* Separate, UNAUTHENTICATED Lambda entry point - Stripe calls this
   directly with no Cognito JWT, so requireUser() never runs here.
   Authenticity comes entirely from Stripe's own signature scheme
   (stripe.webhooks.constructEvent), checked before anything touches the
   database. Every handler below is written to be safe to process the
   same event twice - Stripe redelivers on any non-2xx response, and an
   `update ... where stripe_customer_id = ...` is naturally idempotent. */

import { stripe } from "./stripe.js";
import { planFromPriceId } from "./plans.js";
import { runProvisioningTransaction } from "./db.js";

export const handler = async (event) => {
  const signature = event.headers?.["stripe-signature"] || event.headers?.["Stripe-Signature"];
  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(
      event.body,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET,
    );
  } catch (err) {
    return { statusCode: 400, body: `Webhook signature verification failed: ${err.message}` };
  }

  try {
    switch (stripeEvent.type) {
      case "checkout.session.completed":
        await handleCheckoutCompleted(stripeEvent.data.object);
        break;
      case "customer.subscription.updated":
        await handleSubscriptionUpdated(stripeEvent.data.object);
        break;
      case "customer.subscription.deleted":
        await handleSubscriptionDeleted(stripeEvent.data.object);
        break;
      default:
        // Unhandled event types are a normal, expected state (Stripe sends
        // many more event types than this app acts on) - 200 tells Stripe
        // not to retry, silently ignoring is correct here.
        break;
    }
    return { statusCode: 200, body: "ok" };
  } catch (err) {
    console.error(`Webhook handling failed for ${stripeEvent.type}:`, err.message, err.stack);
    return { statusCode: 500, body: "Webhook handler error" }; // Stripe retries on 5xx
  }
};

/** No app.tenant_id is knowable from a Stripe event alone - these queries
    scope by stripe_customer_id directly instead, same provisioning-style
    transaction postConfirmation.js uses for the same reason (no tenant
    context exists yet from this code path's point of view). */
async function withCustomerLookup(fn) {
  return runProvisioningTransaction("stripe-webhook", fn);
}

async function handleCheckoutCompleted(session) {
  const lineItems = await stripe.checkout.sessions.listLineItems(session.id);
  const priceId = lineItems.data[0]?.price?.id;
  const plan = planFromPriceId(priceId);

  await withCustomerLookup(async (execute) => {
    await execute(
      `update tenants set plan = :plan, status = 'active', stripe_subscription_id = :subscriptionId
       where stripe_customer_id = :customerId`,
      { plan, subscriptionId: session.subscription, customerId: session.customer },
    );
  });
}

async function handleSubscriptionUpdated(subscription) {
  // Stripe subscription statuses collapse to the two this app branches on:
  // 'past_due' maps directly; everything else that still represents a live,
  // paying subscription (active, trialing) maps to 'active'. A status this
  // app doesn't otherwise act on (e.g. 'incomplete') still lands safely in
  // 'active' rather than an unrecognized value the rest of the code doesn't
  // know how to handle.
  const status = subscription.status === "past_due" ? "past_due" : "active";
  await withCustomerLookup(async (execute) => {
    await execute(`update tenants set status = :status where stripe_customer_id = :customerId`, {
      status,
      customerId: subscription.customer,
    });
  });
}

async function handleSubscriptionDeleted(subscription) {
  await withCustomerLookup(async (execute) => {
    await execute(
      `update tenants set plan = 'free', status = 'active', stripe_subscription_id = null
       where stripe_customer_id = :customerId`,
      { customerId: subscription.customer },
    );
  });
}
```

- [ ] **Step 4: Run it to confirm it passes**

```bash
node --test test/stripe-webhook.test.js
```

Expected: PASS, all five tests.

- [ ] **Step 5: `node --check` and full suite**

```bash
node --check src/stripeWebhook.js
npm test
```

- [ ] **Step 6: Commit**

```bash
git add src/stripeWebhook.js test/stripe-webhook.test.js
git commit -m "feat: add Stripe webhook handler (checkout, subscription updated/deleted)"
```

---

### Task 5: Seat-cap enforcement

**Files:**
- Modify: `Expense_tracker_New/backend/src/routes/tenants.js`
- Modify: `Expense_tracker_New/backend/src/postConfirmation.js`
- Create: `Expense_tracker_New/backend/test/seat-cap.test.js`

**Interfaces:**
- Consumes: `SEAT_CAPS` from `./plans.js`.
- Produces: `createInvite` now throws if the tenant is already at its seat cap (counting current members + pending invites). `postConfirmation.js`'s invite-redemption path re-checks the cap at the moment of actual join.

- [ ] **Step 1: Write the failing test**

`Expense_tracker_New/backend/test/seat-cap.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { freshDb, withProvisioning, withTenant, makeExecute } from "./pg-harness.js";
import { createInvite } from "../src/routes/tenants.js";

async function seedTenant(client, plan = "free") {
  return withProvisioning(client, "seed-user", async (c) => {
    const { rows } = await c.query(
      `insert into tenants (name, plan) values ($1, $2) returning id`,
      ["Household", plan],
    );
    return rows[0].id;
  });
}

test("createInvite rejects once a Free tenant (cap 1) already has its one member", async () => {
  const client = await freshDb();
  try {
    const tenantId = await seedTenant(client, "free");
    await withTenant(client, tenantId, "owner-sub", async (c) => {
      await c.query(
        `insert into tenant_users (user_sub, tenant_id, email, role) values ('owner-sub', $1, 'owner@x.com', 'owner')`,
        [tenantId],
      );
    });

    await assert.rejects(
      withTenant(client, tenantId, "owner-sub", (c) =>
        createInvite(makeExecute(c), { email: "new@x.com" }),
      ),
      /seat/i,
    );
  } finally {
    await client.end();
  }
});

test("createInvite counts pending invites toward the cap, not just members", async () => {
  const client = await freshDb();
  try {
    const tenantId = await seedTenant(client, "pro"); // cap 2
    await withTenant(client, tenantId, "owner-sub", async (c) => {
      await c.query(
        `insert into tenant_users (user_sub, tenant_id, email, role) values ('owner-sub', $1, 'owner@x.com', 'owner')`,
        [tenantId],
      );
      // One already-pending invite fills the second seat.
      await c.query(`insert into tenant_invites (tenant_id, email) values ($1, 'pending@x.com')`, [tenantId]);
    });

    await assert.rejects(
      withTenant(client, tenantId, "owner-sub", (c) =>
        createInvite(makeExecute(c), { email: "another@x.com" }),
      ),
      /seat/i,
    );
  } finally {
    await client.end();
  }
});

test("createInvite succeeds when under the cap", async () => {
  const client = await freshDb();
  try {
    const tenantId = await seedTenant(client, "family"); // cap 5
    await withTenant(client, tenantId, "owner-sub", async (c) => {
      await c.query(
        `insert into tenant_users (user_sub, tenant_id, email, role) values ('owner-sub', $1, 'owner@x.com', 'owner')`,
        [tenantId],
      );
    });

    const invite = await withTenant(client, tenantId, "owner-sub", (c) =>
      createInvite(makeExecute(c), { email: "new@x.com" }),
    );
    assert.ok(invite.token);
  } finally {
    await client.end();
  }
});
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
node --test test/seat-cap.test.js
```

Expected: FAIL — no seat-cap check exists yet, so all three tenants can be invited freely (the first two tests fail because no rejection occurs).

- [ ] **Step 3: Add the soft check to `createInvite`**

In `Expense_tracker_New/backend/src/routes/tenants.js`, add the import and modify `createInvite`:

```js
import { SEAT_CAPS } from "../plans.js";
```

```js
export async function createInvite(execute, { email, role }) {
  const [{ plan }] = await execute.rows(
    `select plan from tenants where id = cast(current_setting('app.tenant_id', true) as uuid)`,
  );
  const [{ count: memberCount }] = await execute.rows(
    `select count(*)::int as count from tenant_users`,
  );
  const [{ count: pendingCount }] = await execute.rows(
    `select count(*)::int as count from tenant_invites where used_at is null and expires_at > now()`,
  );
  if (memberCount + pendingCount >= SEAT_CAPS[plan]) {
    throw new Error(
      `This plan is limited to ${SEAT_CAPS[plan]} seat${SEAT_CAPS[plan] === 1 ? "" : "s"} - upgrade to invite more members.`,
    );
  }

  // cast(...) rather than the `::uuid` shorthand: the latter's second colon
  // is indistinguishable from a `:name` bind param to any regex-based
  // named-parameter translator (see test/tenants-route.test.js's execute
  // shim), so it silently corrupts the query there. Functionally identical
  // to `::uuid` in real Postgres, but doesn't collide with that convention.
  const rows = await execute.rows(
    `insert into tenant_invites (tenant_id, email, role)
     values (cast(current_setting('app.tenant_id', true) as uuid), :email, :role)
     returning token, email, role, expires_at`,
    { email, role: role || "member" },
  );
  return rows[0];
}
```

- [ ] **Step 4: Run it to confirm the soft-check tests pass**

```bash
node --test test/seat-cap.test.js
```

Expected: PASS, all three.

- [ ] **Step 5: Add the hard check to `postConfirmation.js`'s invite-redemption path**

In `Expense_tracker_New/backend/src/postConfirmation.js`, add the import:

```js
import { SEAT_CAPS } from "./plans.js";
```

In `resolveTenant`'s `if (invites[0])` branch, add the check right before the `insert into tenant_users` call:

```js
      if (invites[0]) {
        const { tenant_id, role } = invites[0];
        const [{ plan }] = await execute.rows(
          `select plan from tenants where id = :tenantId`,
          { tenantId: tenant_id },
        );
        const [{ count: memberCount }] = await execute.rows(
          `select count(*)::int as count from tenant_users where tenant_id = :tenantId`,
          { tenantId: tenant_id },
        );
        // Hard, authoritative check: state can have changed (plan
        // downgraded, another invite redeemed) since this invite was
        // created - createInvite's check above is only a soft, best-effort
        // warning at send time. Falling through to "create a new tenant"
        // here would silently strand the invitee in the wrong household,
        // so this rejects outright instead - same reasoning as an
        // expired/invalid token, but the failure mode is different enough
        // (the invite IS valid, the household just doesn't have room) that
        // it deserves its own message when this ever gets surfaced to a
        // user-facing flow.
        if (memberCount >= SEAT_CAPS[plan]) {
          throw new Error(`Household is at its ${SEAT_CAPS[plan]}-seat limit for its current plan.`);
        }
        await execute(
          `insert into tenant_users (user_sub, tenant_id, email, role)
           values (:sub, :tenantId, :email, :role)`,
          { sub, tenantId: tenant_id, email, role },
        );
        await execute(
          `update tenant_invites set used_at = now() where token = :token`,
          { token: inviteToken },
        );
        return tenant_id;
      }
```

- [ ] **Step 6: `node --check` and full suite**

```bash
node --check src/routes/tenants.js src/postConfirmation.js
npm test
```

- [ ] **Step 7: Commit**

```bash
git add src/routes/tenants.js src/postConfirmation.js test/seat-cap.test.js
git commit -m "feat: enforce seat caps at invite creation and redemption"
```

---

### Task 6: Feature-gate enforcement

**Files:**
- Modify: `Expense_tracker_New/backend/src/handler.js`
- Modify: `Expense_tracker_New/backend/src/routes/balances.js`
- Modify: `Expense_tracker_New/backend/src/routes/transactions.js`
- Create: `Expense_tracker_New/backend/test/feature-gate.test.js`

**Interfaces:**
- Consumes: `FEATURES` from `./plans.js`.
- Produces: `getBalances(execute, features)` (signature change — was `getBalances(execute)`), `listTransactions(execute, {txYear}, features)` and `listTransactionYears(execute, features)` (signature changes — both gain a `features` parameter). `handleGet` in `handler.js` resolves `tenant.plan`/`FEATURES[plan]` once and passes it to these calls, the same way `user`/`membership` are already resolved once and threaded through.

- [ ] **Step 1: Write the failing test**

`Expense_tracker_New/backend/test/feature-gate.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { freshDb, withProvisioning, withTenant, makeExecute } from "./pg-harness.js";
import { listBalances } from "../src/routes/balances.js";
import { listTransactions, listTransactionYears } from "../src/routes/transactions.js";
import { FEATURES } from "../src/plans.js";

async function seedTenantWithData(client, plan) {
  return withProvisioning(client, "seed-user", async (c) => {
    const { rows } = await c.query(`insert into tenants (name, plan) values ($1, $2) returning id`, ["Household", plan]);
    const tenantId = rows[0].id;
    return tenantId;
  });
}

test("getBalances returns nothing for Free tier, even if rows exist", async () => {
  const client = await freshDb();
  try {
    const tenantId = await seedTenantWithData(client, "free");
    await withTenant(client, tenantId, "owner-sub", async (c) => {
      await c.query(`insert into balances (tenant_id, date, account, amount) values ($1, '2026-01-01', 'Chequing', 1000)`, [tenantId]);
    });

    const result = await withTenant(client, tenantId, "owner-sub", (c) =>
      listBalances(makeExecute(c), FEATURES.free),
    );
    assert.deepEqual(result, []);
  } finally {
    await client.end();
  }
});

test("getBalances returns real data for Pro tier", async () => {
  const client = await freshDb();
  try {
    const tenantId = await seedTenantWithData(client, "pro");
    await withTenant(client, tenantId, "owner-sub", async (c) => {
      await c.query(`insert into balances (tenant_id, date, account, amount) values ($1, '2026-01-01', 'Chequing', 1000)`, [tenantId]);
    });

    const result = await withTenant(client, tenantId, "owner-sub", (c) =>
      listBalances(makeExecute(c), FEATURES.pro),
    );
    assert.equal(result.length, 1);
  } finally {
    await client.end();
  }
});

test("listTransactions excludes rows older than 12 months for Free tier", async () => {
  const client = await freshDb();
  try {
    const tenantId = await seedTenantWithData(client, "free");
    const oldDate = new Date();
    oldDate.setFullYear(oldDate.getFullYear() - 2);
    const oldDateStr = oldDate.toISOString().slice(0, 10);
    await withTenant(client, tenantId, "owner-sub", async (c) => {
      await c.query(
        `insert into transactions (tenant_id, date, amount) values ($1, $2, 10), ($1, current_date, 20)`,
        [tenantId, oldDateStr],
      );
    });

    const result = await withTenant(client, tenantId, "owner-sub", (c) =>
      listTransactions(makeExecute(c), {}, FEATURES.free),
    );
    assert.equal(result.length, 1);
    assert.equal(Number(result[0].amount), 20);
  } finally {
    await client.end();
  }
});

test("listTransactionYears only offers years within the Free tier's window", async () => {
  const client = await freshDb();
  try {
    const tenantId = await seedTenantWithData(client, "free");
    const currentYear = new Date().getFullYear();
    await withTenant(client, tenantId, "owner-sub", async (c) => {
      await c.query(
        `insert into transactions (tenant_id, date, amount) values ($1, $2, 10), ($1, $3, 20)`,
        [tenantId, `${currentYear - 5}-01-01`, `${currentYear}-01-01`],
      );
    });

    const years = await withTenant(client, tenantId, "owner-sub", (c) =>
      listTransactionYears(makeExecute(c), FEATURES.free),
    );
    assert.deepEqual(years, [currentYear]);
  } finally {
    await client.end();
  }
});
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
node --test test/feature-gate.test.js
```

Expected: FAIL — `listBalances`/`listTransactions`/`listTransactionYears` don't accept a `features` argument yet, and unconditionally return everything.

- [ ] **Step 3: Update `routes/balances.js`**

```js
export async function listBalances(execute, features) {
  if (!features.netWorth) return [];
  return execute.rows(`select * from balances order by date desc`);
}
```

- [ ] **Step 4: Update `routes/transactions.js`**

```js
export async function listTransactions(execute, { txYear } = {}, features) {
  if (txYear === -1) return []; // metadata-only refresh, mirrors Code.gs's txYear:-1 convention
  const historyFloor = features.historyMonths
    ? `and date >= (current_date - interval '1 month' * ${Number(features.historyMonths)})`
    : "";
  const where = txYear ? `where date >= :start and date <= :end ${historyFloor}` : `where true ${historyFloor}`;
  const params = txYear ? { start: `${txYear}-01-01`, end: `${txYear}-12-31` } : {};
  return execute.rows(
    `select * from transactions ${where} order by date desc, id desc`,
    params,
  );
}

export async function listTransactionYears(execute, features) {
  const historyFloor = features.historyMonths
    ? `where date >= (current_date - interval '1 month' * ${Number(features.historyMonths)})`
    : "";
  // cast(... as int) rather than `::int`: the second colon of `::` is
  // indistinguishable from a `:name` bind param to the RDS Data API's
  // named-parameter parser, which then fails the statement with an unbound
  // parameter. Same reason routes/tenants.js's createInvite avoids `::uuid`.
  // This one runs on every GET /data, so it is on the hottest path there is.
  const rows = await execute.rows(
    `select distinct cast(extract(year from date) as int) as year from transactions ${historyFloor} order by year desc`,
  );
  return rows.map((r) => r.year);
}
```

(`Number(features.historyMonths)` is interpolated directly rather than bound as a parameter because it's a code constant from `plans.js` — never client-supplied — and Postgres `interval` arithmetic doesn't cleanly accept a bind parameter as the multiplier; this is the same class of already-accepted trade-off as the file's own `cast(...)` comment above, not a new injection surface since no request data reaches this string.)

- [ ] **Step 5: Update `handler.js`'s `handleGet` to resolve and pass `features`**

Add the import:

```js
import { FEATURES } from "./plans.js";
```

Modify `handleGet`'s `Promise.all` to also fetch the tenant's plan, and pass `features` to the three calls above:

```js
async function handleGet(user, event) {
  const qs = event.queryStringParameters || {};
  const year = qs.year ? Number(qs.year) : undefined;
  const txYear = qs.txYear !== undefined ? Number(qs.txYear) : undefined;

  return runInTenantTransaction(user.tenantId, user.sub, async (execute) => {
    const [tenantRow] = await execute.rows(
      `select plan, status, stripe_customer_id from tenants where id = cast(current_setting('app.tenant_id', true) as uuid)`,
    );
    const features = FEATURES[tenantRow.plan] || FEATURES.free;

    const [
      transactions,
      budgetRows,
      balanceRows,
      debtRows,
      years,
      membership,
      members,
    ] = await Promise.all([
      tx.listTransactions(execute, { txYear }, features),
      budget.getBudgetRows(execute, year || new Date().getFullYear()),
      balances.listBalances(execute, features),
      debts.listDebts(execute),
      tx.listTransactionYears(execute, features),
      tenants.getMembership(execute, user.sub),
      tenants.listMembers(execute),
    ]);
    const role = membership?.role || "member";
    const invites =
      role === "owner" || role === "admin"
        ? await tenants.listPendingInvites(execute)
        : [];
    return {
      ok: true,
      transactions,
      budget: budgetRowsToShape(budgetRows),
      budgetYear: year || new Date().getFullYear(),
      balances: balanceRows,
      debts: debtRows.map(fromDbDebt),
      transactionYearsAvailable: years,
      user: { email: user.email, role },
      members,
      invites,
      // hasStripeCustomer, not stripe_subscription_id: the webhook handler
      // (Task 4/7) CLEARS stripe_subscription_id on cancellation, so it can
      // never be true for a tenant who was just downgraded - it would be
      // useless as the "used to be subscribed" signal Task 9's downgrade
      // banner needs. stripe_customer_id is set once on first checkout and
      // never cleared by any handler, so it survives a downgrade and is the
      // correct durable signal.
      tenant: {
        plan: tenantRow.plan,
        status: tenantRow.status,
        hasStripeCustomer: !!tenantRow.stripe_customer_id,
      },
    };
  });
}
```

(The new `tenant: {plan, status}` field in the response is what Task 8/9's frontend work reads — this is the same field name/shape used throughout the design spec.)

- [ ] **Step 6: Run it to confirm it passes**

```bash
node --test test/feature-gate.test.js
```

Expected: PASS, all four.

- [ ] **Step 7: Run the full suite — this task changes call signatures other tests depend on**

```bash
npm test
```

Expected: all tests pass. If any existing test in `routes-write.test.js` or elsewhere calls `listBalances`/`listTransactions`/`listTransactionYears` directly without a `features` argument, update those call sites to pass `FEATURES.business` (unrestricted — those tests aren't testing feature gating, so the least-restrictive tier keeps their existing assertions valid).

- [ ] **Step 8: `node --check` and commit**

```bash
node --check src/handler.js src/routes/balances.js src/routes/transactions.js
git add src/handler.js src/routes/balances.js src/routes/transactions.js test/feature-gate.test.js
git commit -m "feat: enforce net-worth and transaction-history feature gates by plan"
```

---

### Task 7: SES notifications

**Files:**
- Create: `Expense_tracker_New/backend/src/notify.js`
- Create: `Expense_tracker_New/backend/test/notify.test.js`
- Modify: `Expense_tracker_New/backend/src/stripeWebhook.js`
- Modify: `Expense_tracker_New/backend/package.json`

**Interfaces:**
- Produces: `sendPastDueEmail(toEmail: string): Promise<void>`, `sendDowngradedEmail(toEmail: string): Promise<void>`.
- Consumes: `SESClient`/`SendEmailCommand` from `@aws-sdk/client-ses`. Wired into `stripeWebhook.js`'s `handleSubscriptionUpdated` (past_due branch) and `handleSubscriptionDeleted`.

- [ ] **Step 1: Add the SES SDK dependency**

`Expense_tracker_New/backend/package.json` — add to `dependencies` (matching the existing `@aws-sdk/client-*` version pattern):

```json
    "@aws-sdk/client-ses": "^3.600.0",
```

```bash
npm install
```

- [ ] **Step 2: Write the failing test**

`Expense_tracker_New/backend/test/notify.test.js`:

```js
import { test, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { SESClient } from "@aws-sdk/client-ses";
import { sendPastDueEmail, sendDowngradedEmail } from "../src/notify.js";

process.env.SES_FROM_ADDRESS = "billing@ledger.example.com";

let calls;
beforeEach(() => {
  calls = [];
  mock.method(SESClient.prototype, "send", async (command) => {
    calls.push(command.input);
    return {};
  });
});
afterEach(() => mock.restoreAll());

test("sendPastDueEmail sends to the given address from SES_FROM_ADDRESS", async () => {
  await sendPastDueEmail("owner@example.com");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].Destination.ToAddresses, ["owner@example.com"]);
  assert.equal(calls[0].Source, "billing@ledger.example.com");
  assert.match(calls[0].Message.Subject.Data, /payment failed/i);
});

test("sendDowngradedEmail sends to the given address", async () => {
  await sendDowngradedEmail("owner@example.com");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].Destination.ToAddresses, ["owner@example.com"]);
  assert.match(calls[0].Message.Subject.Data, /free plan/i);
});
```

- [ ] **Step 3: Run it to confirm it fails**

```bash
node --test test/notify.test.js
```

Expected: FAIL — `../src/notify.js` doesn't exist.

- [ ] **Step 4: Implement `notify.js`**

`Expense_tracker_New/backend/src/notify.js`:

```js
/* Two customer-facing billing emails, sent via SES. Same lazy-client shape
   as db.js/stripe.js - one module-scope client, env vars read at call
   time so tests can set them after import. */

import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";

const ses = new SESClient({});

async function send(toEmail, subject, bodyText) {
  await ses.send(
    new SendEmailCommand({
      Source: process.env.SES_FROM_ADDRESS,
      Destination: { ToAddresses: [toEmail] },
      Message: {
        Subject: { Data: subject },
        Body: { Text: { Data: bodyText } },
      },
    }),
  );
}

export async function sendPastDueEmail(toEmail) {
  await send(
    toEmail,
    "Your Ledger payment failed",
    "We couldn't process your latest payment. Please update your card in the Billing panel to keep full access. " +
      "We'll retry automatically for 30 days; if the payment still hasn't gone through by then, your account will move to the Free plan.",
  );
}

export async function sendDowngradedEmail(toEmail) {
  await send(
    toEmail,
    "Your Ledger account has moved to the Free plan",
    "After repeated failed payment attempts, your subscription was canceled and your account has moved to the Free plan. " +
      "Your existing data and members are unaffected. Resubscribe any time from the Billing panel.",
  );
}
```

- [ ] **Step 5: Run it to confirm it passes**

```bash
node --test test/notify.test.js
```

Expected: PASS, both tests.

- [ ] **Step 6: Wire into `stripeWebhook.js`**

Modify `handleSubscriptionUpdated` and `handleSubscriptionDeleted` in `Expense_tracker_New/backend/src/stripeWebhook.js` to look up the tenant's owner email and send the corresponding notification. Add the import:

```js
import { sendPastDueEmail, sendDowngradedEmail } from "./notify.js";
```

Replace both functions:

```js
async function handleSubscriptionUpdated(subscription) {
  const status = subscription.status === "past_due" ? "past_due" : "active";
  const ownerEmail = await withCustomerLookup(async (execute) => {
    await execute(`update tenants set status = :status where stripe_customer_id = :customerId`, {
      status,
      customerId: subscription.customer,
    });
    const rows = await execute.rows(
      `select tu.email from tenant_users tu
       join tenants t on t.id = tu.tenant_id
       where t.stripe_customer_id = :customerId and tu.role = 'owner'`,
      { customerId: subscription.customer },
    );
    return rows[0]?.email;
  });
  if (status === "past_due" && ownerEmail) await sendPastDueEmail(ownerEmail);
}

async function handleSubscriptionDeleted(subscription) {
  const ownerEmail = await withCustomerLookup(async (execute) => {
    await execute(
      `update tenants set plan = 'free', status = 'active', stripe_subscription_id = null
       where stripe_customer_id = :customerId`,
      { customerId: subscription.customer },
    );
    const rows = await execute.rows(
      `select tu.email from tenant_users tu
       join tenants t on t.id = tu.tenant_id
       where t.stripe_customer_id = :customerId and tu.role = 'owner'`,
      { customerId: subscription.customer },
    );
    return rows[0]?.email;
  });
  if (ownerEmail) await sendDowngradedEmail(ownerEmail);
}
```

Add two tests to `test/stripe-webhook.test.js` confirming the emails fire (mock `SESClient.prototype.send` the same way `notify.test.js` does):

```js
test("customer.subscription.updated to past_due sends the past-due email to the owner", async () => {
  const client = await freshDb();
  try {
    const tenantId = await seedTenant(client, { plan: "pro", status: "active" });
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

    await handler(fakeEvent("customer.subscription.updated", { customer: "cus_test123", status: "past_due" }));

    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].Destination.ToAddresses, ["owner@x.com"]);
  } finally {
    await client.end();
  }
});

test("customer.subscription.deleted sends the downgraded email to the owner", async () => {
  const client = await freshDb();
  try {
    const tenantId = await seedTenant(client, { plan: "family", status: "active" });
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

    await handler(fakeEvent("customer.subscription.deleted", { customer: "cus_test123" }));

    assert.equal(sent.length, 1);
    assert.match(sent[0].Message.Subject.Data, /Free plan/);
  } finally {
    await client.end();
  }
});
```

(Add `import { SESClient } from "@aws-sdk/client-ses";` to `stripe-webhook.test.js`'s existing import list.)

- [ ] **Step 7: Run it to confirm it passes**

```bash
node --test test/stripe-webhook.test.js test/notify.test.js
```

Expected: PASS, all tests including the two new ones.

- [ ] **Step 8: `node --check` and full suite**

```bash
node --check src/notify.js src/stripeWebhook.js
npm test
```

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json src/notify.js src/stripeWebhook.js test/notify.test.js test/stripe-webhook.test.js
git commit -m "feat: send SES notifications on past-due and downgrade"
```

---

### Task 8: Frontend `store.js` — billing methods

**Files:**
- Modify: `Expense_tracker_New/frontend/assets/store.js`

**Interfaces:**
- Produces on `ApiStore`: `getTenant(): Promise<{plan, status, hasStripeCustomer}>`, `createCheckoutSession(priceId, successUrl, cancelUrl): Promise<{url}>`, `createPortalSession(returnUrl): Promise<{url}>`.

- [ ] **Step 1: Extend `_fill()` and `_refreshMeta()` to cache `tenant`**

In `_fill()` (alongside the existing `this.cache.members`/`this.cache.invites` lines), add:

```js
    this.cache.tenant = d.tenant || { plan: "free", status: "active" };
```

In `_refreshMeta()` (alongside the existing equivalents), add:

```js
    this.cache.tenant = d.tenant || this.cache.tenant;
```

- [ ] **Step 2: Add the three new methods to `class ApiStore`**

Add near the other action-based methods (e.g. next to `createInvite`/`revokeInvite`):

```js
  async getTenant() {
    return (await this._ensure()).tenant || { plan: "free", status: "active" };
  }
  async createCheckoutSession(priceId, successUrl, cancelUrl) {
    return this._post({ action: "createCheckoutSession", priceId, successUrl, cancelUrl });
  }
  async createPortalSession(returnUrl) {
    return this._post({ action: "createPortalSession", returnUrl });
  }
```

(These two don't call `_refreshMeta()` — both result in a full-page redirect away from the app, so there's nothing to refresh before the browser navigates.)

- [ ] **Step 3: `node --check`**

```bash
node --check Expense_tracker_New/frontend/assets/store.js
```

Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add Expense_tracker_New/frontend/assets/store.js
git commit -m "feat: add billing methods to ApiStore"
```

---

### Task 9: Frontend `app.js` — Billing panel, banners, feature-gate UI

**Files:**
- Modify: `Expense_tracker_New/frontend/assets/app.js`

**Interfaces:**
- Consumes: `ApiStore.getTenant/createCheckoutSession/createPortalSession` (Task 8).

- [ ] **Step 1: Populate `state.tenant` in `refresh()`**

Add, immediately after the existing `state.role = (await state.store.getRole?.()) || "member";` line:

```js
  state.tenant = (await state.store.getTenant?.()) || { plan: "free", status: "active" };
```

- [ ] **Step 2: Global `past_due` banner in `boot()`**

Immediately after the existing `revealApp();` line in `boot()`, before the connection-retry `notice()` block, add:

```js
  if (state.tenant?.status === "past_due") {
    notice("Your payment failed — update your card to keep full access.", "bad", {
      label: "Manage billing →",
      onClick: async () => {
        const returnUrl = location.origin + location.pathname;
        const { url } = await state.store.createPortalSession(returnUrl);
        location.href = url;
      },
    });
  }
```

(This does not auto-hide — `notice()`'s existing auto-hide behavior only triggers for `kind === "ok"` with no action, and this call passes both `"bad"` and an action, so it persists until the user navigates away or triggers the action, matching the design's "persistent" requirement.)

- [ ] **Step 3: Add the Billing panel to `renderData()`**

At the top of `renderData()`, alongside the existing `const members = state.members || [];` block, add:

```js
  const tenant = state.tenant || { plan: "free", status: "active" };
  const PLANS = [
    { id: "free", label: "Free", price: "$0/mo", priceId: null },
    { id: "pro", label: "Pro", price: "$7/mo CAD", priceId: "STRIPE_PRICE_ID_PRO_PLACEHOLDER" },
    { id: "family", label: "Family", price: "$13/mo CAD", priceId: "STRIPE_PRICE_ID_FAMILY_PLACEHOLDER" },
    { id: "business", label: "Business", price: "$24/mo CAD", priceId: "STRIPE_PRICE_ID_BUSINESS_PLACEHOLDER" },
  ];
  const showDowngradeBanner = tenant.plan === "free" && !!tenant.hasStripeCustomer;
```

Note on the `priceId` placeholders: Stripe Price ids are not secrets, but they are deploy-specific (different per Stripe account/mode) — they need to reach the frontend the same way `API_ENDPOINT`/Cognito config already do. Add three new exports to `config.js` in this same step (`STRIPE_PRICE_ID_PRO`, `STRIPE_PRICE_ID_FAMILY`, `STRIPE_PRICE_ID_BUSINESS`, all empty strings, injected at deploy time the same way `API_ENDPOINT` is), import them into `app.js`, and use those imported values instead of the placeholder strings above.

Insert this new panel into the template literal, right before `<div class="eyebrow">Danger zone</div>`:

```html
  <div class="eyebrow">Billing</div>
  <div class="panel stack">
    <p class="note" style="margin:0">Current plan: <b>${esc(tenant.plan)}</b>${tenant.status === "past_due" ? ' — <b style="color:var(--danger,#c00)">payment failed</b>' : ""}.</p>
    ${
      showDowngradeBanner
        ? `<p class="note" style="margin:0">Your subscription was canceled after a failed payment — you're on the Free plan. <button class="btn ghost" id="resubscribe">Resubscribe</button></p>`
        : ""
    }
    <div class="actions" style="flex-wrap:wrap">
      ${PLANS.map(
        (p) => `
        <div class="panel" style="min-width:160px">
          <b>${esc(p.label)}</b><br>
          <span class="muted">${esc(p.price)}</span><br>
          ${
            p.id === tenant.plan
              ? '<span class="muted">Current plan</span>'
              : p.priceId
                ? `<button class="btn ghost" data-upgrade-plan="${esc(p.priceId)}">Choose ${esc(p.label)}</button>`
                : ""
          }
        </div>`,
      ).join("")}
    </div>
    ${
      tenant.plan !== "free"
        ? '<div class="actions"><button class="btn ghost" id="manage-billing">Manage billing</button></div>'
        : ""
    }
  </div>
```

- [ ] **Step 4: Wire the Billing panel's handlers**

Immediately after the existing `$("#data-signout")?.addEventListener("click", signOut);` line, add:

```js
  view.querySelectorAll("[data-upgrade-plan]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const base = location.origin + location.pathname;
      const done = await withBusy("Starting checkout", async () => {
        const { url } = await state.store.createCheckoutSession(
          btn.dataset.upgradePlan,
          `${base}#data`,
          `${base}#data`,
        );
        location.href = url;
      });
      if (!done) notice("Could not start checkout.", "bad");
    });
  });

  $("#manage-billing")?.addEventListener("click", async () => {
    const returnUrl = location.origin + location.pathname;
    const done = await withBusy("Opening billing portal", async () => {
      const { url } = await state.store.createPortalSession(returnUrl);
      location.href = url;
    });
    if (!done) notice("Could not open billing portal.", "bad");
  });

  $("#resubscribe")?.addEventListener("click", () => {
    // Scrolls to / re-renders the same panel's plan cards - resubscribing
    // is just choosing a plan again, no separate flow needed.
    renderData();
  });
```

- [ ] **Step 5: Feature-gate UI — hide Net Worth nav for Free tier**

Find wherever the Net Worth nav tab is rendered (search `app.js` for `data-tab="networth"` or the equivalent nav-building code) and wrap it so it's omitted when `state.tenant?.plan === "free"`. Since the exact surrounding markup wasn't captured verbatim in this plan's exploration, the implementer should: locate the nav tab list, find the Net Worth entry, and conditionally exclude it (or render it with a "🔒 Upgrade to unlock" label and no click handler) when `state.tenant?.plan === "free"`. This is cosmetic only — `getBalances` already returns `[]` server-side for Free tier regardless (Task 6), so nothing breaks if this step is imperfect; it only affects whether a Free-tier user sees a confusingly-empty tab or no tab at all.

- [ ] **Step 6: `node --check` and manual smoke test**

```bash
node --check Expense_tracker_New/frontend/assets/app.js
node --check Expense_tracker_New/frontend/assets/store.js
node --check Expense_tracker_New/frontend/assets/config.js
```

Manual check: serve `Expense_tracker_New/frontend/` locally (`python3 -m http.server 8080`), confirm the Data tab renders a Billing panel with four plan cards and no console errors, even with blank config (falls through to `LocalStore`, which has no `getTenant`, so `state.tenant` defaults to `{plan: "free", status: "active"}` via the `?.()` no-op pattern already established for `getMembers`/`getInvites`/`getRole`).

- [ ] **Step 7: Commit**

```bash
git add Expense_tracker_New/frontend/assets/app.js Expense_tracker_New/frontend/assets/config.js
git commit -m "feat: add Billing panel, past-due banner, and downgrade banner"
```

---

### Task 10: `template.yaml` wiring

**Files:**
- Modify: `Expense_tracker_New/backend/template.yaml`

- [ ] **Step 1: Add new Parameters**

After the existing `FrontendUrl` parameter:

```yaml
  StripeSecretKey:
    Type: String
    NoEcho: true
  StripeWebhookSecret:
    Type: String
    NoEcho: true
  StripePriceIdPro:
    Type: String
  StripePriceIdFamily:
    Type: String
  StripePriceIdBusiness:
    Type: String
  SesFromAddress:
    Type: String
    Description: Verified SES sender address for billing notification emails.
```

- [ ] **Step 2: Add the new env vars to `Globals.Function.Environment.Variables`**

```yaml
        STRIPE_SECRET_KEY: !Ref StripeSecretKey
        STRIPE_PRICE_ID_PRO: !Ref StripePriceIdPro
        STRIPE_PRICE_ID_FAMILY: !Ref StripePriceIdFamily
        STRIPE_PRICE_ID_BUSINESS: !Ref StripePriceIdBusiness
        SES_FROM_ADDRESS: !Ref SesFromAddress
```

(`STRIPE_WEBHOOK_SECRET` is intentionally NOT added here — only `StripeWebhookFunction` needs it, added directly on that resource in Step 4, so `DataFunction`/`PostConfirmationFunction` never hold a credential they don't use.)

- [ ] **Step 3: Add `DataFunction`'s new Policy for SES is NOT needed**

`DataFunction` calls Stripe (an HTTPS API, gated by `STRIPE_SECRET_KEY`, not IAM) but never calls SES directly — only `StripeWebhookFunction` sends email. No `DataFunction` policy change needed for this plan.

- [ ] **Step 4: Add the `StripeWebhookFunction` resource**

After the existing `PostConfirmationFunction` resource:

```yaml
  StripeWebhookFunction:
    Type: AWS::Serverless::Function
    Properties:
      CodeUri: src/
      Handler: stripeWebhook.handler
      Environment:
        Variables:
          STRIPE_WEBHOOK_SECRET: !Ref StripeWebhookSecret
      Policies:
        - Statement:
            - Effect: Allow
              Action:
                - rds-data:ExecuteStatement
                - rds-data:BeginTransaction
                - rds-data:CommitTransaction
                - rds-data:RollbackTransaction
              Resource: !GetAtt DbCluster.DBClusterArn
            - Effect: Allow
              Action: secretsmanager:GetSecretValue
              Resource: !Ref DbSecret
            - Effect: Allow
              Action: ses:SendEmail
              Resource: "*"
      Events:
        Post:
          Type: HttpApi
          Properties:
            ApiId: !Ref HttpApi
            Path: /webhooks/stripe
            Method: POST
```

(No `Options`/CORS event — Stripe calls this server-to-server, never from a browser, so no preflight is ever issued against it. No `requireUser()`-equivalent either — deliberately, per Task 4's design; Stripe's signature check inside the handler is the only gate.)

- [ ] **Step 5: Verify the YAML is well-formed**

```bash
cd /Users/rameshkrishnannarashimankrishnamurthy/Downloads/expense-tracker/Expense_tracker_New/backend
python3 -c "import yaml; yaml.safe_load(open('template.yaml'))" 2>&1 || echo "pyyaml not available - will be validated by sam build / GitHub Actions on push"
sam validate 2>&1 || echo "sam CLI not available in this environment - will be validated by CI's sam build step"
```

- [ ] **Step 6: Commit**

```bash
git add template.yaml
git commit -m "feat: wire Stripe billing resources into template.yaml"
```

---

## Self-Review Notes

- **Spec coverage:** Data model (Task 1), Stripe setup / plan constants (Task 2), Checkout+Portal flow (Task 3), webhook handler + all four event types (Tasks 4, 7), downgrade policy / seat caps (Task 5), feature enforcement (Task 6), notifications — SES + both banners (Tasks 7, 9), frontend Billing panel (Task 9), testing approach matching the spec (mocked SDKs + real Postgres, throughout), configuration (Task 10). Every section of the spec has a corresponding task.
- **Type/interface consistency:** `listBalances`/`listTransactions`/`listTransactionYears` gain a `features` parameter in Task 6 — checked that Task 6's own new test calls match, and flagged in Step 7 that any pre-existing call site elsewhere in the test suite needs updating to pass `FEATURES.business` (the least-restrictive tier) so it doesn't need to change its own assertions. `tenant: {plan, status}` in the GET /data response (Task 6) matches exactly what Task 8's `getTenant()` and Task 9's `state.tenant` consume.
- **Ambiguity fixed inline:** Task 9 Step 5 (hiding the Net Worth nav tab) couldn't be given an exact diff since the plan's file exploration didn't capture that specific markup — flagged explicitly as the one place needing the implementer's own judgment, with an explicit note that it's cosmetic-only and safe to get imperfect on the first pass, unlike every other step in this plan.
- **Bug caught and fixed during self-review:** the original draft's downgrade-banner signal (Task 9) checked `stripe_subscription_id` for presence, but Task 4/7's webhook handler *clears* that exact column on cancellation (`handleSubscriptionDeleted`) — the signal could never be true for a tenant who was actually downgraded. Fixed by switching to `stripe_customer_id` (set once on first checkout, never cleared by any handler), threaded through as a new `hasStripeCustomer` field in Task 6's GET /data response, Task 8's `getTenant()`, and Task 9's banner condition. Would have shipped a downgrade banner that silently never appears.
