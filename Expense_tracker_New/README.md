# Ledger — SaaS backend (Approach A)

This is a parallel build, not a replacement in place: the original repo (one
directory up) keeps working unchanged with its Google Sheets / Supabase
backends while this gets built out and validated. Nothing here is wired to a
real AWS account yet — see "What's actually done" below before deploying
anything.

The backend is implemented and tested (40 passing tests against a real local
Postgres, tenant isolation verified empirically, not just by reading the
SQL) — what remains is deploy-time configuration and two Cognito behaviors
that can only be confirmed against a real AWS account.

## Why this exists

The original Ledger is a static site with public build-time config
(`assets/config.js`) — safe under its own model because access is enforced
server-side (Apps Script's `requireUser()`, Supabase RLS), not by keeping
values secret. See the root repo's `README.md`, under "Read this before you
deploy," for the full reasoning.

This folder is the first step toward a different goal: **multi-tenant SaaS**,
where other households/organizations sign up as isolated tenants rather than
this being a single household's tool. That needs a server-mediated backend —
a real API in front of the database — rather than the browser talking to
Sheets/Supabase directly.

## Architecture

```
Browser (frontend/)
  │  Cognito Hosted UI redirect for sign-in (federates to Google)
  │  Authorization: Bearer <Cognito ID token> on every API call
  ▼
API Gateway (HTTP API)
  ▼
Lambda (backend/src/handler.js)
  │  1. requireUser() verifies the JWT, resolves the caller's tenant
  │  2. runInTenantTransaction() sets Postgres session vars, opens a transaction
  ▼
Aurora Serverless v2 (Postgres, via RDS Data API)
  │  Row-Level Security scopes every query to current_setting('app.tenant_id')
```

**A real bug was found and fixed while building the test suite:** Postgres
table _owners_ bypass their own RLS policies unless `FORCE ROW LEVEL
SECURITY` is also set — and `template.yaml`'s Lambdas authenticate as the
same master/owner credentials `DbCluster` was created with, so every RLS
policy was silently a no-op until `FORCE ROW LEVEL SECURITY` was added to
all seven tenant-owned tables in `db/schema.sql`. This is exactly the kind
of thing that only surfaces when you actually run it against a real
Postgres instance — see `db/init-nosuperuser.sql` and `backend/test/rls.test.js`.

Full design rationale (why Aurora Serverless v2 + Data API over `pg` + VPC,
why RLS over schema-per-tenant, why one Lambda over per-resource functions)
was worked out in the brainstorming conversation that produced this scaffold
— ask if you want it written up as a formal spec before continuing.

## Layout

- `frontend/` — the static site. `charts.js`, `xlsxio.js`, `styles.css` are
  copied unchanged from the original project. `store.js`, `config.js`, and
  `app.js` were adapted: `store.js` keeps `LocalStore`/`MemoryStore` as
  offline fallbacks and adds `ApiStore`, which speaks the same `{action,
...}` POST contract the original `SheetsStore` used against `Code.gs`, plus
  `getMembers`/`getInvites`/`getRole`/`createInvite`/`revokeInvite` for the
  household/membership panel. The sign-in gate uses Cognito's Hosted UI
  redirect flow (implicit grant — `template.yaml`'s `AllowedOAuthFlows` must
  match `app.js`'s `cognitoAuthorizeUrl()`, or Cognito rejects every sign-in).
  `app.js`'s Data tab has a "Household" panel: lists members, lets an
  owner/admin send/copy/revoke invites.
- `backend/src/` — one Lambda (`handler.js`) behind API Gateway, routed
  internally by `action`. `routes/*.js` hold the actual SQL per resource
  (`transactions`, `budget`, `balances`, `debts`, `tenants` — the last for
  membership/invite management). `auth.js` verifies the Cognito JWT and
  resolves the caller's tenant _only_ from the token's own `custom:tenant_id`
  claim (an earlier `X-Tenant-Id` header override was removed — it let any
  authenticated user impersonate any tenant with no validation). `db.js`
  wraps the RDS Data API with tenant-scoped transactions
  (`runInTenantTransaction`) and a separate provisioning-only path
  (`runProvisioningTransaction`) for the one code path that legitimately runs
  before any tenant context exists. `validate.js` validates/coerces every
  client-supplied write (amount, date, type, required fields) before it ever
  reaches SQL. `postConfirmation.js` is a separate Lambda — a Cognito trigger
  that provisions a new tenant (or joins an invited one) right after signup.
  `template.yaml` is the AWS SAM template defining every resource, including
  a self-contained VPC/subnet group (no account-specific IDs needed).
- `backend/test/` — 40 tests (`node --test`) against a real local Postgres
  (`db/docker-compose.yml`), not mocks: RLS/tenant-isolation, the
  provisioning bootstrap, JWT verification, transaction sequencing, the
  membership/invite route, and input validation. `pg-harness.js`'s
  `freshDb()`/`withTenant()`/`withProvisioning()` are the shared test
  fixtures every other test file builds on.
- `backend/migrate-to-api.mjs` — one-time script to pull the existing
  household's data out of the original Sheets backend and push it into this
  API as tenant #1, through the API's own write actions (so migrated data
  gets the same validation real writes do).
- `db/schema.sql` — `tenants`, `tenant_users`, `tenant_invites`,
  `transactions`, `budget`, `balances`, `debts`. Every tenant-owned table has
  `FORCE ROW LEVEL SECURITY` and an isolation policy keyed on
  `app.tenant_id`; `tenants`/`tenant_users`/`tenant_invites` additionally
  have narrow, explicitly-scoped provisioning policies (see the comment
  block in the schema) for the one bootstrap case where no tenant context
  exists yet — creating the very first tenant.
- `.github/workflows/ledger-new-ci.yml` — `node --check`, the backend test
  suite (against a Postgres service container with the same superuser-bit
  stripping `db/init-nosuperuser.sql` does locally, replicated as a
  post-checkout step since service containers start before checkout), and
  `sam build`. The `deploy` job is gated off (`if: false`) until real AWS
  credentials exist.

## What's actually done vs. what's left

**Done — implemented and tested:**

- Schema with RLS, correctly enforced (`FORCE ROW LEVEL SECURITY` on all
  seven tenant tables — see the callout in "Architecture" above), including
  the narrow provisioning-bootstrap policies needed to create the very first
  tenant before any `app.tenant_id` context exists.
- Lambda routing that mirrors the original `{action, ...}` contract, with
  server-side input validation on every write (`validate.js`).
- JWT verification and tenant resolution _only_ from the token's own claim
  — no client-supplied header can override it.
- Tenant provisioning and invite-based signup (`postConfirmation.js`).
- A full membership/invite flow: backend route (`routes/tenants.js`) plus a
  frontend "Household" panel (list members, send/copy/revoke invites).
- IaC for every resource, including self-contained VPC/subnet networking (no
  account-specific IDs needed) — `sam deploy --guided` only needs the values
  in item 1 below.
- CI: `node --check`, the full backend test suite (against a properly
  RLS-hardened Postgres service container), and `sam build` on every push.
- A data migration script (`migrate-to-api.mjs`) to bring the existing
  household's data in as tenant #1.
- 40 tests, run against a real local Postgres, not mocks — tenant isolation,
  the provisioning bootstrap, JWT verification, transaction sequencing, the
  membership/invite route, and input validation are all exercised for real.

**Not done — needed before this deploys or runs for real:**

1. **Deploy-time secrets.** `sam deploy --guided` needs real values for
   `GoogleClientId`/`GoogleClientSecret` (reuse the existing Google Cloud
   OAuth app the original project already has, or create one scoped to this
   API) and `FrontendUrl` (the exact URL the frontend will be served from —
   Cognito rejects a wildcard here, unlike the CORS `AllowedOrigin`
   parameter).
2. **Billing/plans are schema-ready, not built.** `tenants.plan`/`.status`
   exist as columns; no Stripe integration, no plan enforcement anywhere.
   Deliberately deferred — see the "pre-validation stage" decision this
   scaffold was built against.
3. **Tenant-switching UI is deferred by design.** Every user belongs to
   exactly one tenant, set once at signup (either a brand-new tenant, or the
   tenant of the invite token they signed up with) — there's no code path
   today for an _already-registered_ user to join a second tenant, so a
   switcher has nothing to switch between yet. `auth.js`'s tenant resolution
   would need to change (safely, with real membership validation) if this
   becomes a real requirement.
4. **Two Cognito assumptions are MUST-VERIFY-AGAINST-REAL-AWS before the
   first deploy.** Neither can be checked from this repo, by reading docs,
   or by any test here — both need a deployed User Pool and a real
   Google-federated signup walked end to end. If either turns out false,
   the invite flow silently breaks (a user lands in a brand-new tenant of
   their own instead of the household that invited them) rather than
   erroring, so verify them deliberately, not by waiting for a bug report.
   - **Does Hosted UI forward `client_metadata` from `/oauth2/authorize`
     into the Lambda trigger event?** `frontend/assets/app.js`'s
     `cognitoAuthorizeUrl()` puts the invite token in a `client_metadata`
     query param, and `backend/src/postConfirmation.js` reads it from
     `event.request.clientMetadata`. `client_metadata` is documented for
     the Cognito API operations (`InitiateAuth`, `SignUp`, …); whether the
     **Hosted UI's** authorize endpoint passes a query param through to
     `PostConfirmation` the same way is the thing to confirm. If it does
     not, the invite token needs a different carrier — e.g. stash it
     client-side and have the frontend call an explicit "join tenant"
     endpoint after first sign-in, which is a backend route that does not
     exist yet.
   - **Do Google-federated signups fire `PostConfirmation` at all?** The
     trigger is wired in `template.yaml` as the only tenant-provisioning
     hook. Federated (external IdP) users are created differently from
     native sign-ups, and the relevant trigger may be `PreSignUp` /
     `PostAuthentication` instead. If `PostConfirmation` never fires for
     Google users, **no tenant is ever provisioned** and every sign-in ends
     at `requireUser()`'s "No tenant associated with this user."

   Deliberately not "fixed" here: guessing at AWS behaviour and rewriting
   working-looking code against the guess would be worse than leaving both
   flagged.

## Billing setup

Billing is only half code. The five steps below are all manual, all done in
the Stripe or AWS consoles, and the feature is either broken or quietly
wrong without them. Nothing in this repo can detect that they were skipped,
so treat them as part of the deploy rather than as optional polish.

**1. Create the two Products/Prices, then transcribe each price id twice.**
Create a recurring monthly Price for Pro and Family in the Stripe
Dashboard — personal-finance app, not a team tool, so there is no
unlimited-seat Business tier. Each resulting `price_...` id has to be
copied into **two independent places**:

- `frontend/assets/config.js` — `STRIPE_PRICE_ID_PRO` / `_FAMILY`, which
  is what the Billing panel's plan buttons send up as `priceId`.
- the SAM deploy parameters `StripePriceIdPro` / `StripePriceIdFamily`,
  which is what `planFromPriceId` (`backend/src/plans.js`) maps back to a
  plan name when the webhook arrives.

Nothing keeps those two copies in sync. They must match exactly, and they
must come from the **same mode** — a test-mode id on one side and a
live-mode id on the other is the easiest way to break this feature.
`handler.js` validates the incoming `priceId` against the backend's own
two before creating a Checkout Session, so a mismatch fails the request
outright instead of charging a card the webhook then cannot interpret; the
failure is loud, but it is still a misconfiguration only you can fix.

**2. Register the webhook endpoint and copy its signing secret.** In
Stripe → Developers → Webhooks, add an endpoint pointing at the stack's
`{ApiUrl}/webhooks/stripe`, subscribed to at least
`checkout.session.completed`, `customer.subscription.updated` and
`customer.subscription.deleted`. Copy that endpoint's signing secret
(`whsec_...`) into the `StripeWebhookSecret` deploy parameter. Until this
exists, checkout completes and takes the customer's money but the tenant is
never moved off the free plan — this webhook is the app's _only_ channel
for learning that anyone paid.

**3. Set Stripe's failed-payment retries to 30 days before cancel.** In
Stripe → Settings → Billing → Subscriptions and emails → "Manage failed
payments", configure the retry schedule to run for 30 days and then cancel
the subscription. **That Dashboard setting IS the 30-day grace period this
app promises.** The past-due email in `backend/src/notify.js` tells the
customer they have 30 days to fix their card; no application code anywhere
enforces, tracks or extends that window. Set it shorter and the app is
lying to customers; leave it at the account default and a failed payment
behaves however that default happens to be configured.

**4. Configure the Customer Portal with plan switching DISABLED.** In
Stripe → Settings → Billing → Customer portal, allow payment-method
updates, invoice history and cancellation, but turn **off** "Customers can
switch plans". `handleSubscriptionUpdated` derives only `status` from
`customer.subscription.updated`; it never re-derives `plan` from the
subscription's current price. A portal that let a customer move from
Family to Pro themselves would leave them billed for one plan and
entitled to another indefinitely, with nothing in the app aware of the
drift. Mid-subscription plan changes are intentionally unsupported — the
customer cancels and re-subscribes through Checkout, which is also why the
Billing panel hides the plan buttons while a subscription exists.

**5. Verify the SES sender identity and leave the SES sandbox.** Billing
notifications (past-due, downgraded-to-free) are sent through SES from the
address in the `SesFromAddress` parameter. That identity must be verified,
and while the account is in the SES sandbox SES will only deliver to _other
verified addresses_ — so every notification to a real customer fails. Those
failures are deliberately swallowed: `stripeWebhook.js`'s
`notifyBestEffort` logs and continues, so an SES outage can never roll back
the tenant-state DB write the webhook just made. The practical consequence
is that an unverified sender or a sandboxed account produces **no error
anywhere you or the customer would notice** — just a CloudWatch log line,
and a customer who never hears that their payment failed. Check the logs
after the first real past-due event.

## Running tests locally

```bash
cd db && docker compose up -d && cd ../backend
npm install
npm test
```

`db/init-nosuperuser.sql` runs automatically on first container start (via
Postgres's `docker-entrypoint-initdb.d`) and strips the test role's
superuser bit — without that, `FORCE ROW LEVEL SECURITY` has no effect on
that role and every isolation test would pass vacuously. If you've already
started the container once before this mattered, reset the volume first:
`docker compose -f db/docker-compose.yml down -v && docker compose -f db/docker-compose.yml up -d`.

## Deploying (once the TODOs above are filled in)

```bash
cd backend
npm install
sam build
sam deploy --guided   # prompts for GoogleClientId, GoogleClientSecret, AllowedOrigin, FrontendUrl
```

Then apply `db/schema.sql` to the resulting Aurora cluster (via the RDS Data
API or the query editor in the RDS console — no direct network path is
opened to it by design), copy the stack's `ApiUrl`/`UserPoolId`/
`UserPoolClientId`/`UserPoolDomain` outputs into `frontend/assets/config.js`,
and serve `frontend/` the same way the original repo does (static hosting,
no build step).
