/* Lazy Stripe SDK client singleton - same shape as db.js's module-scope
   RDSDataClient. STRIPE_SECRET_KEY is read once at module load; tests
   mock individual resource methods (stripe.customers.create, etc.)
   directly rather than mocking a prototype, since the Stripe SDK exposes
   real per-resource objects, not one shared class the way AWS SDK v3
   commands do. */
import Stripe from "stripe";

export const stripe = new Stripe(
  process.env.STRIPE_SECRET_KEY || "sk_test_placeholder",
);
