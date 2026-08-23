/* The three pricing tiers' seat caps and feature restrictions, plus the
   Stripe price-id -> plan-name mapping the webhook handler needs to know
   what a customer actually bought. Deliberately code constants, not a DB
   table: there are exactly three fixed tiers, and making them
   data-configurable would need a Stripe Dashboard change (a new
   Product/Price) whenever they change anyway. Personal-finance app, not a
   team tool - Family (5 seats) is deliberately the top tier; there is no
   unlimited-seat "Business" plan. */

export const SEAT_CAPS = {
  free: 1,
  pro: 2,
  family: 5,
};

export const FEATURES = {
  free: { netWorth: false, historyMonths: 12 },
  pro: { netWorth: true, historyMonths: null },
  family: { netWorth: true, historyMonths: null },
};

/** Maps a Stripe Price id (from a checkout.session.completed event's line
    item) back to one of this app's plan names. Read lazily from
    process.env on each call, not at module load, so tests can set the env
    vars after import - matches how auth.js reads COGNITO_USER_POOL_ID. */
export function planFromPriceId(priceId) {
  const map = {
    [process.env.STRIPE_PRICE_ID_PRO]: "pro",
    [process.env.STRIPE_PRICE_ID_FAMILY]: "family",
  };
  const plan = map[priceId];
  if (!plan) throw new Error(`Unrecognized Stripe price id: ${priceId}`);
  return plan;
}
