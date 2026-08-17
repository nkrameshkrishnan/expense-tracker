# Ledger — SaaS backend scaffold (Approach A)

This is a parallel build, not a replacement in place: the original repo (one
directory up) keeps working unchanged with its Google Sheets / Supabase
backends while this gets built out and validated. Nothing here is wired to a
real AWS account yet — see "What's actually done" below before deploying
anything.

## Why this exists

The original Ledger is a static site with public build-time config
(`assets/config.js`) — safe under its own model because access is enforced
server-side (Apps Script's `requireUser()`, Supabase RLS), not by keeping
values secret. See the root repo's `Security_Analysis.md` for the full
reasoning.

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

Full design rationale (why Aurora Serverless v2 + Data API over `pg` + VPC,
why RLS over schema-per-tenant, why one Lambda over per-resource functions)
was worked out in the brainstorming conversation that produced this scaffold
— ask if you want it written up as a formal spec before continuing.

## Layout

- `frontend/` — the static site. `app.js`, `charts.js`, `xlsxio.js`,
  `styles.css` are copied unchanged from the original project. `store.js` and
  `config.js` are new: `store.js` keeps `LocalStore`/`MemoryStore` as
  offline fallbacks and adds `ApiStore`, which speaks the same `{action,
...}` POST contract the original `SheetsStore` used against `Code.gs` —
  most of `app.js`'s data-layer code didn't need to change because of that.
  The sign-in gate and Data-tab connection panel in `app.js` **were**
  rewritten, since Cognito's Hosted UI redirect flow replaces Google Identity
  Services entirely.
- `backend/` — one Lambda (`src/handler.js`) behind API Gateway, routed
  internally by `action`. `src/routes/*.js` hold the actual SQL per resource
  (transactions, budget, balances, debts). `src/auth.js` verifies the Cognito
  JWT; `src/db.js` wraps the RDS Data API with tenant-scoped transactions.
  `src/postConfirmation.js` is a separate Lambda — a Cognito trigger that
  provisions a new tenant (or joins an invited one) right after signup.
  `template.yaml` is the AWS SAM template defining every resource.
- `db/schema.sql` — `tenants`, `tenant_users`, `tenant_invites`,
  `transactions`, `budget`, `balances`, `debts`, each tenant-owned table with
  an RLS policy keyed on `app.tenant_id`.

## What's actually done vs. what's left

**Done:** the shape of every piece — schema with RLS, Lambda routing that
mirrors the original action contract, JWT verification, tenant provisioning,
IaC for every resource, and a frontend that parses and points at the new
backend instead of Sheets/Supabase.

**Not done — needed before this deploys or runs for real:**

1. **`template.yaml`'s networking is now self-contained** (VPC, subnets, DB
   subnet group are created by the template itself — no account-specific IDs
   needed). What's left is supplying real values at `sam deploy --guided`
   time for the things that genuinely can't be generated: `GoogleClientId`/
   `GoogleClientSecret` (reuse the existing Google Cloud OAuth app the
   original project already has, or create one scoped to this API) and
   `FrontendUrl` (the exact URL the frontend will be served from — Cognito
   rejects a wildcard here, unlike the CORS `AllowedOrigin` parameter).
2. **Tests exist now, and they need Docker.** `backend/npm test` runs the
   whole suite against a local Postgres (`docker compose -f db/docker-compose.yml
   up -d`) with `db/schema.sql` applied fresh per test, so RLS is exercised
   for real rather than assumed. `db/init-nosuperuser.sql` strips the test
   role's superuser bit at container bootstrap — without that, the role
   bypasses RLS unconditionally (superusers are exempt even from `FORCE ROW
   LEVEL SECURITY`) and every isolation test passes vacuously. CI replicates
   that same stripping against its Postgres service container.
3. **CI runs; deploy is still a manual gate.**
   `.github/workflows/ledger-new-ci.yml` does `node --check`, the backend
   test suite, and `sam build`. The `deploy` job is deliberately `if: false`
   until real AWS credentials and the Google OAuth secrets exist.
4. **No data migration script.** Moving the existing household's data from
   Sheets/Supabase into this schema as "tenant #1" is straightforward
   (same shape as `migrate.mjs` in the original repo) but not written yet.
5. **Billing/plans are schema-ready, not built.** `tenants.plan`/`.status`
   exist as columns; no Stripe integration, no plan enforcement anywhere.
   Deliberately deferred — see the "pre-validation stage" decision this
   scaffold was built against.
6. **Frontend copy still says things like "Data" tab labels generically** —
   worth a pass once there's a real multi-tenant UI concern (switching
   tenants, inviting members) that the original single-household app never
   needed.
7. **Two Cognito assumptions are MUST-VERIFY-AGAINST-REAL-AWS before the
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
