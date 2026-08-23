/* Checkout/Portal session creation, plus the live plan list. The first two
   assume they're called inside an already tenant-scoped transaction (see
   db.js's runInTenantTransaction), same trust boundary as every other
   routes/*.js module - tenantId is passed explicitly (rather than read
   back out of the DB) because the caller already has it from the
   verified JWT, and the customer-lookup UPDATE below needs to target the
   right row under RLS regardless. getPlans is different: it isn't tenant
   data at all (the same plan list for every tenant), so it takes no
   execute/tenantId and needs no transaction. */

import { SEAT_CAPS, FEATURES } from "../plans.js";

/** The full plan list - one entry per tier in SEAT_CAPS/FEATURES (plans.js
    is the only place a tier is declared to exist; this just adds each
    one's Stripe price id and live amount on top), in SEAT_CAPS' own
    insertion order. This is the single source frontend/assets/app.js
    renders Billing and the signup plan gate from, instead of keeping its
    own independent copy of which tiers exist and what they enforce - so
    seatCap/features can never silently drift out of sync with what's
    actually enforced server-side. priceId is null for a tier with no
    configured Stripe price (Free, or a dev/test env missing one); amount/
    currency are simply absent if that price id fails to resolve - a bad
    Stripe id shouldn't remove the whole tier, since seatCap/features are
    already known locally regardless of Stripe being reachable. */
export async function getPlans(stripe) {
  const priceIds = {
    pro: process.env.STRIPE_PRICE_ID_PRO || null,
    family: process.env.STRIPE_PRICE_ID_FAMILY || null,
  };
  return Promise.all(
    Object.keys(SEAT_CAPS).map(async (id) => {
      const priceId = priceIds[id] || null;
      const plan = {
        id,
        priceId,
        seatCap: SEAT_CAPS[id],
        features: FEATURES[id],
      };
      if (!priceId) return plan;
      try {
        const price = await stripe.prices.retrieve(priceId);
        return { ...plan, amount: price.unit_amount, currency: price.currency };
      } catch (err) {
        console.error(
          `[billing] could not resolve price for ${id}: ${err.message}`,
        );
        return plan;
      }
    }),
  );
}

export async function createCheckoutSession(
  execute,
  stripe,
  tenantId,
  { priceId, successUrl, cancelUrl },
) {
  // Checkout CREATES a subscription; it never modifies an existing one. A
  // tenant that already has one on file would end up billed twice, with the
  // app only ever tracking whichever subscription's webhook landed last and
  // no handle at all on the other. Changing or cancelling an existing
  // subscription is the Customer Portal's job (createPortalSession below),
  // which is why the Billing panel hides the plan-choice buttons once a
  // subscription exists - this is the server-side half of that rule, since
  // the frontend is not a trust boundary.
  const [tenant] = await execute.rows(
    `select stripe_subscription_id from tenants where id = cast(:tenantId as uuid)`,
    { tenantId },
  );
  if (tenant?.stripe_subscription_id)
    throw new Error(
      "This household already has an active subscription. Use Manage billing to change or cancel it.",
    );

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

export async function createPortalSession(
  execute,
  stripe,
  tenantId,
  { returnUrl },
) {
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
