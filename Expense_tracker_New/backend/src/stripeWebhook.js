/* Separate, UNAUTHENTICATED Lambda entry point - Stripe calls this
   directly with no Cognito JWT, so requireUser() never runs here.
   Authenticity comes entirely from Stripe's own signature scheme
   (stripe.webhooks.constructEvent), checked before anything touches the
   database. Every handler below is written to be safe to process the
   same event twice - Stripe redelivers on any non-2xx response, and an
   `update ... where stripe_customer_id = ...` is naturally idempotent.

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
    await runProvisioningTransaction("stripe-webhook", async (execute) => {
      switch (stripeEvent.type) {
        case "checkout.session.completed":
          await handleCheckoutCompleted(execute, stripeEvent.data.object);
          break;
        case "customer.subscription.updated":
          await handleSubscriptionUpdated(execute, stripeEvent.data.object);
          break;
        case "customer.subscription.deleted":
          await handleSubscriptionDeleted(execute, stripeEvent.data.object);
          break;
        default:
          // Unhandled event types are a normal, expected state (Stripe sends
          // many more event types than this app acts on) - 200 tells Stripe
          // not to retry, silently ignoring is correct here.
          break;
      }
    });
    return { statusCode: 200, body: "ok" };
  } catch (err) {
    console.error(`Webhook handling failed for ${stripeEvent.type}:`, err.message, err.stack);
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
export async function handleCheckoutCompleted(execute, session) {
  const lineItems = await stripe.checkout.sessions.listLineItems(session.id);
  const priceId = lineItems.data[0]?.price?.id;
  const plan = planFromPriceId(priceId);

  await execute(
    `update tenants set plan = :plan, status = 'active', stripe_subscription_id = :subscriptionId
     where stripe_customer_id = :customerId`,
    { plan, subscriptionId: session.subscription, customerId: session.customer },
  );
}

/** Looks up the email of the tenant's `owner`-role member from a
    stripe_customer_id alone - the same no-app.tenant_id-set provisioning
    context handleSubscriptionUpdated/handleSubscriptionDeleted already run
    under, relying on the tenant_users_provisioning_select RLS policy
    (db/schema.sql) the same way the update statements below rely on
    tenants_provisioning_update. */
async function ownerEmailForCustomer(execute, customerId) {
  const rows = await execute.rows(
    `select tu.email from tenant_users tu
     join tenants t on t.id = tu.tenant_id
     where t.stripe_customer_id = :customerId and tu.role = 'owner'`,
    { customerId },
  );
  return rows[0]?.email;
}

export async function handleSubscriptionUpdated(execute, subscription) {
  // Stripe subscription statuses collapse to the two this app branches on:
  // 'past_due' maps directly; everything else that still represents a live,
  // paying subscription (active, trialing) maps to 'active'. A status this
  // app doesn't otherwise act on (e.g. 'incomplete') still lands safely in
  // 'active' rather than an unrecognized value the rest of the code doesn't
  // know how to handle.
  const status = subscription.status === "past_due" ? "past_due" : "active";
  await execute(`update tenants set status = :status where stripe_customer_id = :customerId`, {
    status,
    customerId: subscription.customer,
  });
  if (status === "past_due") {
    const ownerEmail = await ownerEmailForCustomer(execute, subscription.customer);
    if (ownerEmail) await sendPastDueEmail(ownerEmail);
  }
}

export async function handleSubscriptionDeleted(execute, subscription) {
  await execute(
    `update tenants set plan = 'free', status = 'active', stripe_subscription_id = null
     where stripe_customer_id = :customerId`,
    { customerId: subscription.customer },
  );
  const ownerEmail = await ownerEmailForCustomer(execute, subscription.customer);
  if (ownerEmail) await sendDowngradedEmail(ownerEmail);
}
