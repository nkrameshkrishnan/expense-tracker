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
