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

### 2. Backend refactor: extract `handleRequest()`

`backend/src/handler.js` currently exports a single Lambda entrypoint
that inline-handles CORS, calls `requireUser()`, and dispatches to route
modules (`routes/transactions.js`, `routes/budget.js`, etc.) based on the
request. This gets split into:

- An exported pure function, e.g.
  `handleRequest({ method, path, headers, queryParams, body })` →
  `{ statusCode, headers, body }`, containing exactly the logic that
  exists in `handler.js` today (CORS headers, `requireUser`, action
  routing, error handling). No behavior changes — this is a decoupling
  refactor only.
- `handler.js`'s existing Lambda entrypoint becomes a thin adapter:
  unpack the API Gateway event into `handleRequest()`'s parameter shape,
  call it, return the result. Every existing test in
  `backend/test/*.test.js` continues to exercise the same behavior
  through this adapter.

### 3. New: `backend/src/server.js`

A plain Node `http` (or minimal Express) server that:

- Listens on `process.env.PORT`.
- Translates incoming HTTP requests (method, URL path, query string,
  headers, body) into `handleRequest()`'s parameter shape.
- Writes `handleRequest()`'s `{statusCode, headers, body}` result back as
  the HTTP response.
- Is the only new "runtime" code — it contains no business logic.

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
  unmodified — it tests `handleRequest()`'s behavior (via whatever the
  refactor calls it), not the transport it's invoked through.
- Add one smoke-test step to the deployment documentation: after
  deploying to Openship, `curl` the `/data` endpoint without a token and
  confirm the same 401 shape the AWS dev stage already returns for the
  same request — proves the wrapper and CORS headers behave identically
  to the Lambda path.

## Explicitly out of scope

- Stripe removal/replacement — separate spec, to follow this one.
- Any change to WAF or production edge protection — the Openship-hosted
  instance is dev-only; the existing in-app `backend/src/rateLimit.js`
  covers basic abuse protection for this lower-stakes environment, and
  production stays behind the real WAFv2 WebACL, unchanged.
- Any change to `sam deploy --guided` or the production/dev AWS SAM flow.
