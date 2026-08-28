# Dev Deployment: Vercel (Frontend) + Openship (Backend) — Design

## Purpose

Add a faster, cheaper deployment path for day-to-day development, without
touching the existing AWS SAM production/dev flow documented in
`Expense_tracker_New/DEPLOYMENT.md`. That flow (`sam deploy --guided`,
manual, no CI/CD) remains the path to a real production-shaped deploy and
is unaffected by this work.

Two independent pieces, both additive:

1. **Frontend → Vercel**, replacing GitHub Pages as the frontend host.
2. **Backend (dev only) → Openship**, a self-hosted Docker/VPS deployment
   platform (https://github.com/oblien/openship), as a faster iteration
   loop than `sam deploy --guided` for backend code changes.

Explicitly out of scope: removing or replacing Stripe (separate spec),
and any change to the production AWS SAM deployment path.

## Background: why this is feasible without a backend rewrite

`Expense_tracker_New/backend/src/handler.js` is a single Lambda handler
behind API Gateway HTTP API, handling `GET`/`POST /data`. Every dependency
it uses — Aurora Serverless v2 (via `@aws-sdk/client-rds-data`, the Data
API), Cognito (`@aws-sdk/client-cognito-identity-provider`,
`aws-jwt-verify`), S3, SES, DynamoDB, and Bedrock — is called over HTTPS
via the AWS SDK. None of these require the code to actually execute
inside Lambda; they work identically from any host with valid AWS
credentials and network access. The only Lambda-specific parts are the
handler's I/O shape (`{statusCode, headers, body}` in/out) and where CORS
headers get attached.

This means the backend can run in a plain Docker container on a VPS,
talking to the exact same AWS-managed services the Lambda deployment
already uses, with a thin adapter layer — not a rewrite of business logic,
data access, or auth.

## Architecture

```
                    ┌─────────────────┐
                    │     Vercel       │   Frontend (static, replaces
                    │  (frontend host) │   GitHub Pages)
                    └────────┬─────────┘
                             │ HTTPS
                             ▼
        ┌────────────────────────────────────┐
        │   Dev backend on Openship (VPS)     │   NEW — fast iteration
        │   Docker container: server.js       │   loop for backend code
        │   → handleRequest() (shared logic)  │
        └───────────────┬──────────────────────┘
                         │ AWS SDK (HTTPS, IAM creds)
                         ▼
        ┌────────────────────────────────────┐
        │ Same AWS dev-stage resources already │
        │ documented in DEPLOYMENT.md:         │
        │ Aurora (Data API), Cognito, S3, SES, │
        │ DynamoDB, Bedrock                    │
        └────────────────────────────────────┘

        Production path (UNCHANGED):
        API Gateway → Lambda (handler.js) → same AWS resources
        Deployed via `sam deploy --guided`, per DEPLOYMENT.md
```

## Components

### 1. Frontend on Vercel

- `Expense_tracker_New/frontend/` is a static site (`index.html` +
  `assets/`), no build step today. Vercel is pointed at this directory
  as a static deployment — zero-config, no `vercel.json` required unless
  routing/rewrites are needed (none are, since there's a single
  `index.html`).
- Vercel becomes the only frontend host. GitHub Pages configuration is
  removed once Vercel is verified working, per the user's decision to
  replace rather than run both.
- Vercel's free tier includes automatic preview deployments per branch/PR
  — a genuine improvement over the current single-URL GitHub Pages setup,
  at no extra cost.
- **CORS/Cognito URL update required.** `backend/template.yaml` has two
  parameters that must match wherever the frontend is actually served:
  `AllowedOrigin` (wired into `ALLOWED_ORIGIN`, API Gateway CORS, and the
  S3 bucket CORS policy) and `FrontendUrl` (wired into Cognito's
  `CallbackURLs`/`LogoutURLs`). Moving the frontend to Vercel means these
  two parameters need to be updated to the new Vercel URL on the next
  `sam deploy --guided` run against the dev stack — this is a manual,
  documented step (see Testing/Documentation below), not something this
  plan automates, since it touches deployed AWS infrastructure.
- The existing `.github/workflows/deploy.yml` (GitHub Pages) and the
  legacy root-level `assets/` app it deploys are untouched — that
  workflow deploys the _entire repo_ to Pages, including
  `Expense_tracker_New/frontend/` as a nested path today, but the legacy
  app at the repo root is out of scope for this change and keeps working
  exactly as it does now.

### 2. No changes needed to `handler.js`

`backend/src/handler.js` already exports `handler = async (event) => ...`
as a value decoupled from actual Lambda invocation — it's a plain
function that reads exactly these fields off `event`, and nothing else:

- `event.requestContext.http.method`
- `event.requestContext.http.sourceIp` (used by `rateLimit.js`)
- `event.headers.authorization` / `event.headers.Authorization`
- `event.headers["x-active-tenant"]` / `event.headers["X-Active-Tenant"]`
- `event.queryStringParameters` (a plain object)
- `event.body` (raw JSON string)

Since this is already just a function taking a plain object, it needs no
refactor at all. `server.js` (below) calls `handler()` directly.

### 3. New: `backend/src/server.js`

A plain Node `http` server that:

- Listens on `process.env.PORT`.
- On each request, builds a fake API-Gateway-v2-shaped `event` object
  from the real request (method, source IP, headers, parsed query
  string, raw body), matching exactly the field list above — nothing
  more.
- Calls the existing, unmodified `handler(event)` from `handler.js`.
- Writes the returned `{statusCode, headers, body}` back as the HTTP
  response.
- Is the only new "runtime" code — it contains no business logic, and
  `handler.js` is imported, not duplicated.

### 4. New: `backend/Dockerfile`

- Node 20 base image (matches the Lambda runtime, `Node.js 20.x`, for
  behavioral parity).
- Multi-stage build: install production dependencies, copy `src/`, run
  `node src/server.js` as the entrypoint.
- No `sam`-specific tooling included — this image only needs to run
  `server.js`.

### 5. Openship deployment config

- A service definition (Openship's expected format — `openship up` or
  equivalent, per Openship's own docs at deploy time) pointing at the
  Dockerfile above, deployed to a VPS.
- Environment variables mirror the existing SAM template's dev-stage
  parameters (Aurora cluster/secret ARNs, Cognito pool/client IDs, S3
  bucket name, SES sender, DynamoDB table name, Bedrock model ID) — same
  values already used by the AWS dev stage, so this dev backend talks to
  the same dev-tier data, not a separate copy.

## Config and secrets — the one new risk

Lambda's execution role means the current backend needs zero static AWS
credentials — IAM permissions are attached to the function at deploy
time. A VPS-hosted container has no such role and needs a real, static
IAM access key.

Handling:

- Provision one new IAM user, scoped to exactly the actions the existing
  Lambda execution role already has (Aurora Data API `ExecuteStatement`,
  Cognito admin actions used by `auth.js`, S3 get/put on the existing
  bucket, SES `SendEmail`, DynamoDB read/write on the existing table,
  Bedrock `InvokeModel`) — no broader, and scoped to dev-stage resources
  only.
- The resulting access key/secret is stored as an encrypted secret in
  Openship's own secret store, never committed to the repo, never logged.
- This credential is a genuinely new artifact this design introduces;
  it should be rotated/revoked the same way any other credential is if
  this dev path is later decommissioned.

## Error handling

No new error-handling design is needed — `handleRequest()` is exactly the
existing `handler.js` logic (auth errors, validation errors, rate-limit
errors already return their existing shaped responses). `server.js` only
needs to catch and 500 on an unexpected throw from `handleRequest()`
itself, matching Lambda's own behavior of not crashing the process on a
handler exception.

## Testing

- Existing `npm test` (`node --test test/*.test.js`) continues to pass
  completely unmodified — `handler.js` isn't touched, so every existing
  test (including `handler-gating.test.js`'s direct import of
  `assertManagesInvites`/`assertKnownPriceId`) keeps working exactly as
  today.
- Add one smoke-test step to the deployment documentation: after
  deploying to Openship, `curl` the `/data` endpoint without a token and
  confirm the same 401 shape the AWS dev stage already returns for the
  same request — proves the wrapper and CORS headers behave identically
  to the Lambda path.
- Add a documentation step (in `DEPLOYMENT.md`) covering the
  `AllowedOrigin`/`FrontendUrl` SAM parameter update described above,
  including the `sam deploy --guided` re-run needed to apply it.

## Explicitly out of scope

- Stripe removal/replacement — separate spec, to follow this one.
- Any change to WAF or production edge protection — the Openship-hosted
  instance is dev-only; the existing in-app `backend/src/rateLimit.js`
  covers basic abuse protection for this lower-stakes environment, and
  production stays behind the real WAFv2 WebACL, unchanged.
- Any change to `sam deploy --guided` or the production/dev AWS SAM flow.
