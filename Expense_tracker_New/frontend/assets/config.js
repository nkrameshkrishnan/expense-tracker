/* Overwritten at deploy time from repository secrets — same pattern the
   original project uses (see the root repo's .github/workflows/deploy.yml
   and its assets/config.js). The committed version here is intentionally
   blank.

   WARNING: whatever lands here IS SERVED TO EVERY VISITOR, same as before.
   That's still fine under this architecture for the same reason it was
   fine under the Sheets/Supabase one (see the root README.md's "GitHub
   Secrets cannot keep a secret in a static site"): none of these values are
   secrets. API_ENDPOINT is just a URL. COGNITO_CLIENT_ID identifies the app
   to Cognito's Hosted UI, it does not authorize anything by itself. Access
   is decided server-side: API Gateway validates the Cognito-issued JWT on
   every request, and Postgres RLS (db/schema.sql) scopes every query to the
   token's tenant. The real secrets (STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET,
   DB credentials) never reach this file — they're Lambda environment
   variables sourced from AWS Secrets Manager (see backend/template.yaml). */

/* API Gateway base URL from template.yaml's ApiUrl output, e.g.
   https://abc123.execute-api.us-east-1.amazonaws.com/dev */
export const API_ENDPOINT = "";

/* Cognito Hosted UI / User Pool values from template.yaml's outputs. */
export const COGNITO_USER_POOL_ID = "";
export const COGNITO_CLIENT_ID = "";
export const COGNITO_DOMAIN = ""; // e.g. ledger-dev-123456789012.auth.us-east-1.amazoncognito.com
export const COGNITO_REGION = "";

/* No Stripe Price ids here any more - backend/src/routes/billing.js's
   getPlans() is now the only place the frontend learns a plan's Stripe
   price id (along with everything else about it: seats, features, live
   amount). Previously this file duplicated STRIPE_PRICE_ID_PRO/_FAMILY
   for app.js's own PLANS array to reference directly; that array is gone,
   so there's nothing left here to inject them into. */
