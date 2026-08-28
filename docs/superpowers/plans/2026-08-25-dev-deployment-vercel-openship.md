# Dev Deployment: Vercel (Frontend) + Openship (Backend) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a faster, cheaper dev-only deployment path — frontend on
Vercel, backend on Openship (self-hosted Docker/VPS) — without touching
the existing AWS SAM production/dev flow or any business logic.

**Architecture:** `backend/src/handler.js`'s exported `handler` function
already takes a plain object and reads only a handful of fields off it —
it needs zero changes. A new `backend/src/server.js` builds that same
object shape from a real HTTP request and calls `handler()` directly, so
the exact same code path Lambda runs today also runs in a Docker
container. A new `Dockerfile` packages that server. Openship deploys the
container to a VPS; Vercel deploys the static frontend directly from
`Expense_tracker_New/frontend/`.

**Tech Stack:** Node.js 20 (matches the Lambda runtime), plain `node:http`
(no new dependencies), Docker, Openship, Vercel.

**Spec:** `docs/superpowers/specs/2026-08-25-dev-deployment-vercel-openship-design.md`

## Global Constraints

- Node 20 runtime everywhere (matches Lambda's `Node.js 20.x`).
- Zero changes to `backend/src/handler.js`, `backend/src/auth.js`,
  `backend/src/rateLimit.js`, or any file under `backend/src/routes/` —
  every task in this plan is additive only.
- Existing `npm test` (`node --test test/*.test.js`, run from
  `Expense_tracker_New/backend/`) must continue to pass completely
  unmodified — do not edit any existing test file.
- No secrets (IAM keys, Cognito values, etc.) are ever committed to git —
  real values are documented as "set this as an env var / Openship
  secret", never written into a checked-in file.
- No change to `backend/template.yaml`, `.github/workflows/deploy.yml`,
  or the production/dev AWS SAM deployment flow.

---

### Task 1: `backend/src/server.js` — HTTP adapter for the existing Lambda handler

**Files:**

- Create: `Expense_tracker_New/backend/src/server.js`
- Test: `Expense_tracker_New/backend/test/server.test.js`
- Modify: `Expense_tracker_New/backend/package.json` (add a `start` script)

**Interfaces:**

- Consumes: `handler` exported from `../src/handler.js` — signature
  `async (event) => ({ statusCode, headers, body })`, where `event` reads
  as: `event.requestContext.http.method`,
  `event.requestContext.http.sourceIp`, `event.headers` (a plain object,
  lowercase keys — Node's `http` module already lowercases incoming
  header names), `event.queryStringParameters` (plain object),
  `event.body` (raw string). This function is NOT modified by this task.
- Produces: `createApp()`, exported from `server.js`, returning a
  `node:http` `Server` instance not yet listening — tests call
  `.listen(0, ...)` themselves to get a random free port. This is the
  interface Task 2's Dockerfile CMD and Task 3's docs both build on.

- [ ] **Step 1: Write the failing tests**

Create `Expense_tracker_New/backend/test/server.test.js`:

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.js";

async function withServer(fn) {
  const app = createApp();
  await new Promise((resolve) => app.listen(0, resolve));
  const { port } = app.address();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => app.close(resolve));
  }
}

test("OPTIONS returns 204 with CORS headers", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/`, { method: "OPTIONS" });
    assert.equal(res.status, 204);
    assert.equal(
      res.headers.get("access-control-allow-methods"),
      "GET,POST,OPTIONS",
    );
  });
});

test("GET without an Authorization header returns 401 with the auth error shape", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/`, { method: "GET" });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.deepEqual(body, {
      ok: false,
      error: "Missing Authorization header.",
    });
  });
});

test("POST without an Authorization header returns 401, ignoring the body", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "getPlans" }),
    });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.deepEqual(body, {
      ok: false,
      error: "Missing Authorization header.",
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run from `Expense_tracker_New/backend/`:

```bash
COGNITO_USER_POOL_ID=us-east-1_00000000000 COGNITO_CLIENT_ID=test-client-id node --test test/server.test.js
```

Expected: FAIL — `Cannot find module '../src/server.js'` (or similar),
since `server.js` doesn't exist yet.

- [ ] **Step 3: Implement `server.js`**

Create `Expense_tracker_New/backend/src/server.js`:

```javascript
/* Thin HTTP adapter for the existing Lambda handler (src/handler.js),
   used by the Docker/Openship dev deployment path — see
   docs/superpowers/specs/2026-08-25-dev-deployment-vercel-openship-design.md.
   handler.js itself is unmodified: it already reads only a handful of
   fields off a plain `event` object, so this file's only job is to
   build that same shape from a real HTTP request and translate the
   {statusCode, headers, body} result back into an HTTP response. */

import { createServer } from "node:http";
import { handler } from "./handler.js";

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function buildEvent(req, body, url) {
  return {
    requestContext: {
      http: {
        method: req.method,
        sourceIp: req.socket.remoteAddress || "unknown",
      },
    },
    headers: req.headers,
    queryStringParameters: Object.fromEntries(url.searchParams),
    body,
  };
}

export function createApp() {
  return createServer(async (req, res) => {
    try {
      const body = await readBody(req);
      const url = new URL(req.url, "http://localhost");
      const event = buildEvent(req, body, url);
      const result = await handler(event);
      res.writeHead(result.statusCode, result.headers || {});
      res.end(result.body ?? "");
    } catch (err) {
      console.error("[server] unexpected error", err.stack || err.message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Request failed." }));
    }
  });
}

// Only start listening when run directly (`node src/server.js`), not
// when imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT) || 8080;
  createApp().listen(port, () => {
    console.log(`[server] listening on :${port}`);
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
COGNITO_USER_POOL_ID=us-east-1_00000000000 COGNITO_CLIENT_ID=test-client-id node --test test/server.test.js
```

Expected: PASS — all 3 tests green.

- [ ] **Step 5: Add a `start` script**

In `Expense_tracker_New/backend/package.json`, add to `"scripts"`:

```json
"start": "node src/server.js",
```

(Keep every existing script — `build`, `deploy`, `local`, `test` —
unchanged; this only adds one new entry.)

- [ ] **Step 6: Run the full existing test suite to confirm nothing broke**

```bash
COGNITO_USER_POOL_ID=us-east-1_00000000000 COGNITO_CLIENT_ID=test-client-id node --test test/*.test.js
```

Expected: PASS — every existing test file plus the new `server.test.js`,
all green. (Tests that need a real Postgres, e.g. `pg-harness.test.js`
and the route-write tests, behave exactly as they did before this task —
this task doesn't change their requirements.)

- [ ] **Step 7: Commit**

```bash
git add Expense_tracker_New/backend/src/server.js Expense_tracker_New/backend/test/server.test.js Expense_tracker_New/backend/package.json
git commit -m "feat: add HTTP adapter for the dev/Openship deployment path"
```

---

### Task 2: `backend/Dockerfile` — package the backend as a container

**Files:**

- Create: `Expense_tracker_New/backend/Dockerfile`
- Create: `Expense_tracker_New/backend/.dockerignore`

**Interfaces:**

- Consumes: `server.js`'s `start` script from Task 1
  (`CMD ["node", "src/server.js"]` — equivalent to `npm start`, called
  directly so the container's PID 1 is the Node process itself, not an
  npm wrapper).
- Produces: a Docker image, `ledger-backend-dev`, that Task 3's Openship
  deployment step points at.

- [ ] **Step 1: Write `.dockerignore`**

Create `Expense_tracker_New/backend/.dockerignore`:

```
node_modules
test
.aws-sam
*.md
.env
```

- [ ] **Step 2: Write the Dockerfile**

Create `Expense_tracker_New/backend/Dockerfile`:

```dockerfile
# Matches the Lambda runtime (Node.js 20.x) for behavioral parity.
FROM node:20-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:20-slim
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
ENV PORT=8080
EXPOSE 8080
CMD ["node", "src/server.js"]
```

- [ ] **Step 3: Build the image locally**

Run from `Expense_tracker_New/backend/`:

```bash
docker build -t ledger-backend-dev .
```

Expected: build succeeds (exit code 0). If `docker` is not available in
this environment, report BLOCKED with that detail rather than skipping
verification.

- [ ] **Step 4: Run the container and smoke-test it**

```bash
docker run -d -p 8080:8080 \
  -e COGNITO_USER_POOL_ID=us-east-1_00000000000 \
  -e COGNITO_CLIENT_ID=test-client-id \
  --name ledger-backend-dev-smoketest \
  ledger-backend-dev
sleep 1
curl -s -o /dev/null -w "%{http_code}\n" -X OPTIONS http://localhost:8080/
curl -s http://localhost:8080/
docker stop ledger-backend-dev-smoketest && docker rm ledger-backend-dev-smoketest
```

Expected: the `OPTIONS` request prints `204`; the plain `GET` prints
`{"ok":false,"error":"Missing Authorization header."}` — proving the
containerized server behaves identically to the test-runner version from
Task 1, with no real AWS resources required for this smoke test (no
`RATE_LIMIT_TABLE` is set, so `checkRateLimit` no-ops; no valid token is
sent, so `requireUser` fails before any Postgres/S3/Cognito network call
happens).

- [ ] **Step 5: Commit**

```bash
git add Expense_tracker_New/backend/Dockerfile Expense_tracker_New/backend/.dockerignore
git commit -m "feat: add Dockerfile for the dev/Openship backend deployment"
```

---

### Task 3: Document the Vercel + Openship dev deployment in `DEPLOYMENT.md`

**Files:**

- Modify: `Expense_tracker_New/DEPLOYMENT.md`

**Interfaces:**

- Consumes: Task 1's `server.js`/`start` script and Task 2's `Dockerfile`
  by name/path only — this task is documentation, no code.

This task is documentation because the two actions it covers are either
manual-by-nature (provisioning an IAM user is a security-sensitive AWS
action) or depend on Openship's own CLI, whose exact flags aren't fully
published yet (openship.io/docs states its reference section is still
being filled in) — pointing the reader at Openship's own `--help` for
those specific flags is more honest than guessing at syntax that could
be wrong.

- [ ] **Step 1: Add a new section at the end of
      `Expense_tracker_New/DEPLOYMENT.md`**

The file's existing headings run `## Phase 0` through
`## Phase 11 — Before real customers (production hardening)` (the last
section in the file). Append the following as a new, final, deliberately
un-numbered section — it's optional and parallel to the sequential
0-11 flow, not another step in it:

````markdown
## Optional — faster dev iteration with Vercel + Openship

Everything above (Phases 0-9) remains the path to a real,
production-shaped deploy. This phase adds two **dev-only** alternatives
that are faster to iterate on — neither replaces anything above, and
skipping this phase entirely is fine.

### Frontend on Vercel

1. In the Vercel dashboard, import this repository as a new project.
2. Set **Root Directory** to `Expense_tracker_New/frontend`.
3. Leave **Build Command** and **Output Directory** empty — this is a
   static site with no build step; `Expense_tracker_New/frontend/`
   already contains `index.html` and `assets/` ready to serve as-is.
4. Deploy. Note the resulting URL (e.g.
   `https://<project>.vercel.app`).
5. **Update CORS/Cognito to match.** `backend/template.yaml` has two
   parameters that must equal wherever the frontend is actually served:
   `AllowedOrigin` (feeds `ALLOWED_ORIGIN`, API Gateway CORS, and the S3
   bucket's CORS policy) and `FrontendUrl` (feeds Cognito's
   `CallbackURLs`/`LogoutURLs`). Re-run `sam deploy --guided` against
   your dev stack (see Phase 2) with both parameters set to the new
   Vercel URL from step 4.
6. Visit the Vercel URL and confirm sign-in works, the same way Phase 9
   step 4 verifies the GitHub Pages URL.

GitHub Pages keeps serving the repository exactly as it does today
(`.github/workflows/deploy.yml` is unchanged) — this step only changes
which URL you actually use for `Expense_tracker_New/frontend/`.

### Backend on Openship

This runs the exact same request-handling code the Lambda deployment
runs (`backend/src/handler.js`, unmodified) inside a Docker container on
a VPS, via [Openship](https://github.com/oblien/openship) — useful for
iterating on backend code without a `sam deploy --guided` round trip per
change.

1. **Provision a scoped IAM user.** A VPS container has no Lambda
   execution role, so it needs a real (but tightly scoped) IAM access
   key. Create one IAM user with an inline policy granting exactly:
   - `rds-data:ExecuteStatement`, `rds-data:BatchExecuteStatement` on
     your dev Aurora cluster's ARN
   - `cognito-idp:AdminGetUser` and whatever other `cognito-idp:Admin*`
     actions `backend/src/auth.js` and its callers use, scoped to your
     dev user pool's ARN
   - `s3:GetObject`, `s3:PutObject` on your dev AI-uploads bucket's ARN
   - `ses:SendEmail` scoped to your verified SES identity
   - `dynamodb:UpdateItem` on your dev `RateLimitTable`'s ARN (only
     needed if you also set `RATE_LIMIT_TABLE` for this deployment —
     otherwise rate limiting no-ops, which is fine for a dev-only
     instance)
   - `bedrock:InvokeModel` for your configured model, if the AI-import
     feature is exercised in this environment

   Save the resulting access key ID and secret access key somewhere
   outside git — you'll enter them as Openship secrets in step 4, never
   as committed files.

2. **Install Openship** on your VPS, following the current instructions
   at [openship.io/docs](https://openship.io/docs) (`openship up` for a
   self-hosted instance, per the project's README).

3. From `Expense_tracker_New/backend/`, run Openship's own deploy flow
   for this directory (`openship init` to link the project, then
   `openship deploy`, per the project's own CLI reference — check
   `openship deploy --help` for the exact current flags, since the
   project's own docs note their reference section is still being
   filled in). Openship auto-detects the `Dockerfile` added in this
   plan's Task 2; no additional Openship config file is required.

4. Set these environment variables as Openship secrets for the deployed
   service (same values as the dev-stage AWS resources from Phases 2-7
   of this guide, plus the IAM credentials from step 1):
   - `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`
   - `COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID`
   - `AI_UPLOADS_BUCKET`
   - `ALLOWED_ORIGIN` (set to your Vercel URL from the frontend section
     above, or `*` for local-only testing)
   - Any other env var `backend/template.yaml` passes to the Lambda
     function today, for parity — cross-check against that file's
     `Environment.Variables` block for the current full list.

5. **Smoke test**, matching Task 2's local container test but against
   the deployed Openship URL:
   ```bash
   curl -s -o /dev/null -w "%{http_code}\n" -X OPTIONS https://<your-openship-url>/
   curl -s https://<your-openship-url>/
   ```
   Expected: `204` for the first command, and
   `{"ok":false,"error":"Missing Authorization header."}` for the
   second — the same responses Phase 9's local smoke test would give,
   confirming this deployment behaves identically to Lambda.
````

- [ ] **Step 2: Sanity-check the inserted section**

Run:

```bash
node -e "require('fs').readFileSync('Expense_tracker_New/DEPLOYMENT.md','utf8')" && echo OK
```

And visually confirm (read the file) that the new Phase 10 section
appears once, in the right place, with no broken Markdown code fences —
this repo's git history includes a prior fix specifically for broken
code fences in this file, so check fence pairing carefully.

- [ ] **Step 3: Commit**

```bash
git add Expense_tracker_New/DEPLOYMENT.md
git commit -m "docs: add optional Vercel + Openship dev deployment guide"
```
