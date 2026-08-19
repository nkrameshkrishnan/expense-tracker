/* Separate, UNAUTHENTICATED Lambda entry point - Stripe calls this
   directly with no Cognito JWT, so requireUser() never runs here.
   Authenticity comes entirely from Stripe's own signature scheme
   (stripe.webhooks.constructEvent), checked before anything touches the
   database. Every handler below is written to be safe to process the
   same event twice - Stripe redelivers on any non-2xx response, and every
   handler below is a single `update ... where <stripe ids>` that lands on
   the same final state however many times it runs. The subscription
   handlers additionally key on stripe_subscription_id, not just
   stripe_customer_id, so a LATE redelivery of a superseded subscription's
   event matches nothing instead of clobbering the live one.

   handleCheckoutCompleted/handleSubscriptionUpdated/handleSubscriptionDeleted
   take `execute` as their first parameter - same shape as
   routes/billing.js's createCheckoutSession(execute, stripe, tenantId, ...)
   - rather than opening their own runProvisioningTransaction internally.
   That's what lets tests call them directly against a real Postgres
   `execute` built by test/pg-harness.js's makeExecute(), the same pattern
   every other route module in this app already uses, instead of requiring
   the real AWS RDS Data API (and its credentials/region config) just to
   exercise this file's business logic. The only place that talks to the
   real Data API is the top-level `handler` below, which is the one and
   only path that actually runs as a real Lambda invocation. */

import { stripe } from "./stripe.js";
import { planFromPriceId } from "./plans.js";
import { runProvisioningTransaction } from "./db.js";
import { sendPastDueEmail, sendDowngradedEmail } from "./notify.js";

export const handler = async (event) => {
  const signature =
    event.headers?.["stripe-signature"] || event.headers?.["Stripe-Signature"];
  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(
      event.body,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET,
    );
  } catch (err) {
    return {
      statusCode: 400,
      body: `Webhook signature verification failed: ${err.message}`,
    };
  }

  try {
    // A transaction is opened per handled event type rather than around the
    // whole switch: `default:` is a no-op, and opening (then committing) a
    // Data API transaction for every unhandled event type Stripe sends is
    // pure latency and lock churn for nothing.
    switch (stripeEvent.type) {
      case "checkout.session.completed": {
        // listLineItems is an outbound HTTPS round-trip to Stripe. It runs
        // BEFORE the transaction opens, deliberately: inside one, a slow
        // Stripe response would hold the tenants-row lock open for the
        // length of a third-party request, up to the Lambda's own timeout.
        const session = stripeEvent.data.object;
        const priceId = await fetchCheckoutPriceId(session);
        await runProvisioningTransaction("stripe-webhook", (execute) =>
          handleCheckoutCompleted(execute, session, priceId),
        );
        break;
      }
      case "customer.subscription.updated":
        await runProvisioningTransaction("stripe-webhook", (execute) =>
          handleSubscriptionUpdated(execute, stripeEvent.data.object),
        );
        break;
      case "customer.subscription.deleted":
        await runProvisioningTransaction("stripe-webhook", (execute) =>
          handleSubscriptionDeleted(execute, stripeEvent.data.object),
        );
        break;
      default:
        // Unhandled event types are a normal, expected state (Stripe sends
        // many more event types than this app acts on) - 200 tells Stripe
        // not to retry, silently ignoring is correct here.
        break;
    }
    return { statusCode: 200, body: "ok" };
  } catch (err) {
    console.error(
      `Webhook handling failed for ${stripeEvent.type}:`,
      err.message,
      err.stack,
    );
    return { statusCode: 500, body: "Webhook handler error" }; // Stripe retries on 5xx
  }
};

/** No app.tenant_id is knowable from a Stripe event alone - these queries
    scope by stripe_customer_id directly instead, same provisioning-style
    transaction postConfirmation.js uses for the same reason (no tenant
    context exists yet from this code path's point of view). Relies on the
    tenants_provisioning_update RLS policy (db/schema.sql) alongside the
    existing insert/select provisioning policies - see that policy's
    comment for why an update issued here would otherwise silently match
    zero rows. */
export async function handleCheckoutCompleted(execute, session, priceId) {
  const plan = planFromPriceId(priceId);

  const result = await execute(
    `update tenants set plan = :plan, status = 'active', stripe_subscription_id = :subscriptionId
     where stripe_customer_id = :customerId`,
    {
      plan,
      subscriptionId: session.subscription,
      customerId: session.customer,
    },
  );
  warnIfNoTenantMatched(result, session.customer);
}

/** The Stripe-side half of checkout.session.completed, split out so the
    HTTPS call can happen before the DB transaction opens (see the switch
    above). Kept exported so tests can drive the same two-step sequence the
    real handler does. */
export async function fetchCheckoutPriceId(session) {
  const lineItems = await stripe.checkout.sessions.listLineItems(session.id);
  return lineItems.data[0]?.price?.id;
}

/** Every UPDATE below is keyed on Stripe-supplied ids, not on a tenant id
    this code looked up - so "matched zero rows" is indistinguishable from
    success at the SQL level and would otherwise fail completely silently
    (200 to Stripe, no retry, no alert) if the tenants_provisioning_update
    RLS policy were ever missing/stale, or if a customer id drifted out of
    sync. Returns whether anything matched so callers can also skip the
    follow-up email a no-op update must not send.

    Handles both `execute` shapes this file runs against: the RDS Data API's
    numberOfRecordsUpdated (production, see db.js) and node-pg's rowCount
    (test/pg-harness.js). */
function warnIfNoTenantMatched(result, customerId) {
  const rows = result?.numberOfRecordsUpdated ?? result?.rowCount ?? 0;
  if (rows === 0) {
    console.error(`Webhook matched no tenant for customer ${customerId}`);
    return false;
  }
  return true;
}

/** Looks up the email of the tenant's `owner`-role member from a
    stripe_customer_id alone - the same no-app.tenant_id-set provisioning
    context handleSubscriptionUpdated/handleSubscriptionDeleted already run
    under, relying on the tenant_users_provisioning_select RLS policy
    (db/schema.sql) the same way the update statements below rely on
    tenants_provisioning_update.

    Test note: the two DB-only tests further down in stripe-webhook.test.js
    that exercise a bare `status: "past_due"` update don't seed a
    tenant_users row for cus_test123, so this resolves to undefined there
    and no SES call is attempted - that's intentional, not an oversight;
    the SES-specific tests below seed an owner row explicitly. */
async function ownerEmailForCustomer(execute, customerId) {
  const rows = await execute.rows(
    `select tu.email from tenant_users tu
     join tenants t on t.id = tu.tenant_id
     where t.stripe_customer_id = :customerId and tu.role = 'owner'`,
    { customerId },
  );
  return rows[0]?.email;
}

/** Sends a billing notification without letting SES's own failure modes
    (throttling, unverified sender/sandbox mode, wrong region, any
    transient AWS error) roll back the tenant-state DB write these handlers
    just made. Both call sites below run inside the still-open
    runProvisioningTransaction opened by the top-level `handler` (see
    db.js's withDataApiTransaction: it rolls back and rethrows on ANY
    callback exception), so letting a rejected send() propagate would undo
    the `update tenants ...` that already succeeded and leave the tenant's
    billing state stuck until SES recovers - worse than the accepted
    "duplicate email on redelivery" tradeoff. Mirrors postConfirmation.js's
    choice to call the Cognito AdminUpdateUserAttributesCommand only after
    its own provisioning transaction has committed, for the same reason:
    a downstream side effect must never be able to undo a DB write that
    already succeeded. Logged and swallowed rather than silently dropped,
    so an operator can still see SES is failing. */
async function notifyBestEffort(sendFn, toEmail) {
  try {
    await sendFn(toEmail);
  } catch (err) {
    console.error(
      `Failed to send billing notification to ${toEmail}:`,
      err.message,
      err.stack,
    );
  }
}

export async function handleSubscriptionUpdated(execute, subscription) {
  // Stripe subscription statuses collapse to the two this app branches on:
  // 'past_due' maps directly; everything else that still represents a live,
  // paying subscription (active, trialing) maps to 'active'. A status this
  // app doesn't otherwise act on (e.g. 'incomplete') still lands safely in
  // 'active' rather than an unrecognized value the rest of the code doesn't
  // know how to handle.
  const status = subscription.status === "past_due" ? "past_due" : "active";
  // Scoped to the subscription ON FILE, not just the customer. Stripe
  // delivery is at-least-once and unordered: a retry of an OLD
  // subscription's event can land after the customer has already cancelled
  // and resubscribed, and a customer-only WHERE would let that stale event
  // overwrite the live subscription's state (mark a healthy subscription
  // past_due, or clear a genuine past_due). Keying on both means a stale
  // event matches zero rows and is logged, not applied.
  const result = await execute(
    `update tenants set status = :status
     where stripe_customer_id = :customerId and stripe_subscription_id = :subscriptionId`,
    {
      status,
      customerId: subscription.customer,
      subscriptionId: subscription.id,
    },
  );
  // No row matched -> this event is about a subscription this tenant is no
  // longer on. Returning early also stops a false "your payment failed"
  // email going to a customer whose current subscription is fine.
  if (!warnIfNoTenantMatched(result, subscription.customer)) return;
  if (status === "past_due") {
    const ownerEmail = await ownerEmailForCustomer(
      execute,
      subscription.customer,
    );
    if (ownerEmail) await notifyBestEffort(sendPastDueEmail, ownerEmail);
  }
}

export async function handleSubscriptionDeleted(execute, subscription) {
  // Same both-keys scoping as handleSubscriptionUpdated, for the same
  // reason: a redelivered `deleted` for a subscription the customer has
  // already replaced must not downgrade the replacement to free.
  const result = await execute(
    `update tenants set plan = 'free', status = 'active', stripe_subscription_id = null
     where stripe_customer_id = :customerId and stripe_subscription_id = :subscriptionId`,
    { customerId: subscription.customer, subscriptionId: subscription.id },
  );
  if (!warnIfNoTenantMatched(result, subscription.customer)) return;
  const ownerEmail = await ownerEmailForCustomer(
    execute,
    subscription.customer,
  );
  if (ownerEmail) await notifyBestEffort(sendDowngradedEmail, ownerEmail);
}
