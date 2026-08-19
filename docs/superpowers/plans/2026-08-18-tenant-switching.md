# Tenant-Switching UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user who belongs to more than one tenant act as whichever
one they choose, switching between them without signing out — validated
against real `tenant_users` membership on every request, never trusted
from client input.

**Architecture:** `auth.js` gains a validated `X-Active-Tenant` header
path (falls back to the JWT's default tenant when absent or matching);
`postConfirmation.js`'s invite-redemption logic is extracted into a shared
`redeemInvite()` so an already-signed-in user can join a second tenant
through a new `joinTenant` action without touching their default tenant;
a new `listMyTenants` action powers a switcher inside the existing
Household panel. No schema or RLS changes — the provisioning-scoped
policies added for seat-caps and the Stripe webhook already grant
everything this needs.

**Tech Stack:** Same as the rest of `Expense_tracker_New/backend` — `node:test`,
real Postgres via `pg-harness.js`'s `withTenant`/`withProvisioning` fixtures,
mocked AWS SDK (Cognito) only where a real call would otherwise happen.

**Spec:** `docs/superpowers/specs/2026-08-18-tenant-switching-design.md`

## Global Constraints

- `cast(x as type)` for every SQL comparison against a `uuid` column bound
  from a `:name` parameter — never `x::type` (the second colon is
  indistinguishable from a `:name` bind param to both the RDS Data API's
  parser and this repo's `pg-harness.js` test-harness regex).
- Every DB-touching function takes `execute` as a parameter — never calls
  `db.js`'s transaction wrappers (`runInTenantTransaction`/
  `runProvisioningTransaction`) internally. Callers (handler.js,
  postConfirmation.js, auth.js) open the transaction; route functions just
  use the `execute` they're handed.
- No schema/RLS changes. Every access pattern this plan needs is already
  granted by `tenants_provisioning_select`, `tenant_users_provisioning_select`,
  `tenant_users_provisioning_insert`, `tenant_invites_provisioning_select`,
  and `tenant_invites_provisioning_update` in `db/schema.sql`.
- `node --check` every touched JS file before committing.
- The header is `X-Active-Tenant`, never `X-Tenant-Id` — that name is
  attached to a fixed vulnerability finding (C3) in this repo's history;
  reusing it would read as reopening that bug on a future diff, even
  though this mechanism is validated and that one wasn't.

---

### Task 1: `auth.js` — validated `X-Active-Tenant` header

**Files:**

- Modify: `Expense_tracker_New/backend/src/auth.js`
- Modify: `Expense_tracker_New/backend/src/routes/tenants.js`
- Modify: `Expense_tracker_New/backend/src/handler.js` (CORS_HEADERS only)
- Modify: `Expense_tracker_New/backend/template.yaml`
- Test: `Expense_tracker_New/backend/test/auth.test.js`

**Interfaces:**

- Produces: `routes/tenants.js` exports a new
  `getMembershipInTenant(execute, userSub, tenantId): Promise<{role: string} | null>`.
  `createAuthChecker(verifier, runProvisioning?)` — `requireUser`'s factory
  gains an optional second parameter (default: the real
  `runProvisioningTransaction` from `db.js`) so tests can inject a fake,
  matching the existing `verifier`-injection pattern in this same file.
- Consumes: `db.js`'s existing `runProvisioningTransaction(actorLabel, fn)`.

- [ ] **Step 1: Write the failing tests**

Add to `test/auth.test.js` (read the existing file first for its fake-verifier
fixture shape and reuse it — these tests add a fake `runProvisioning` the
same way):

```js
test("X-Active-Tenant matching the caller's default tenant never touches the DB", async () => {
  const verifier = fakeVerifier({
    sub: "user-1",
    email: "a@b.com",
    "custom:tenant_id": "tenant-A",
  });
  let dbCalls = 0;
  const runProvisioning = async () => {
    dbCalls++;
  };
  const requireUser = createAuthChecker(verifier, runProvisioning);

  const user = await requireUser({
    headers: { authorization: "Bearer x", "x-active-tenant": "tenant-A" },
  });

  assert.equal(user.tenantId, "tenant-A");
  assert.equal(dbCalls, 0);
});

test("X-Active-Tenant for a tenant the caller genuinely belongs to switches", async () => {
  const verifier = fakeVerifier({
    sub: "user-1",
    email: "a@b.com",
    "custom:tenant_id": "tenant-A",
  });
  const runProvisioning = async (actorLabel, fn) =>
    fn({ rows: async () => [{ role: "member" }] });
  const requireUser = createAuthChecker(verifier, runProvisioning);

  const user = await requireUser({
    headers: { authorization: "Bearer x", "x-active-tenant": "tenant-B" },
  });

  assert.equal(user.tenantId, "tenant-B");
});

test("X-Active-Tenant for a tenant the caller does not belong to rejects", async () => {
  const verifier = fakeVerifier({
    sub: "user-1",
    email: "a@b.com",
    "custom:tenant_id": "tenant-A",
  });
  const runProvisioning = async (actorLabel, fn) =>
    fn({ rows: async () => [] });
  const requireUser = createAuthChecker(verifier, runProvisioning);

  await assert.rejects(
    () =>
      requireUser({
        headers: { authorization: "Bearer x", "x-active-tenant": "tenant-B" },
      }),
    AuthError,
  );
});

test("a malformed X-Active-Tenant value is rejected before any DB call", async () => {
  const verifier = fakeVerifier({
    sub: "user-1",
    email: "a@b.com",
    "custom:tenant_id": "tenant-A",
  });
  let dbCalls = 0;
  const runProvisioning = async () => {
    dbCalls++;
  };
  const requireUser = createAuthChecker(verifier, runProvisioning);

  await assert.rejects(
    () =>
      requireUser({
        headers: { authorization: "Bearer x", "x-active-tenant": "not-a-uuid" },
      }),
    AuthError,
  );
  assert.equal(dbCalls, 0);
});

test("the CORS allow-list advertises x-active-tenant in both places", async () => {
  // Mirrors the existing "does not advertise x-tenant-id" test just above
  // this one in the same file (reads handler.js and template.yaml as raw
  // text) — both must independently list the new header, since a browser
  // preflight only ever consults one of them depending on which layer
  // handles OPTIONS, and this codebase's convention is to keep both in
  // sync rather than pick one as authoritative.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const handlerSrc = readFileSync(
    path.join(here, "..", "src", "handler.js"),
    "utf8",
  );
  const template = readFileSync(path.join(here, "..", "template.yaml"), "utf8");
  assert.ok(
    /Allow-Headers"?:\s*"[^"]*x-active-tenant/.test(handlerSrc),
    "handler.js's Access-Control-Allow-Headers must list x-active-tenant",
  );
  assert.ok(
    /AllowHeaders:.*x-active-tenant/.test(template),
    "template.yaml's AllowHeaders must list x-active-tenant",
  );
});
```

Note: `fakeVerifier(claims)` is illustrative — read the actual existing
fixture helper in `test/auth.test.js` and use its real name/shape; do not
invent a new one if an equivalent already exists. `path`/`readFileSync`/
`fileURLToPath` are already imported at the top of this file (the
existing neighboring test uses them) — don't re-import.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- test/auth.test.js` (or the project's real single-file
test invocation)
Expected: FAIL — `createAuthChecker` does not yet accept a second
parameter, `x-active-tenant` header is not read.

- [ ] **Step 3: Add `getMembershipInTenant` to `routes/tenants.js`**

Add near the existing `getMembership`:

```js
export async function getMembershipInTenant(execute, userSub, tenantId) {
  const rows = await execute.rows(
    `select role from tenant_users where user_sub = :userSub and tenant_id = cast(:tenantId as uuid)`,
    { userSub, tenantId },
  );
  return rows[0] || null;
}
```

- [ ] **Step 4: Implement the header validation in `auth.js`**

```js
import { CognitoJwtVerifier } from "aws-jwt-verify";
import { runProvisioningTransaction } from "./db.js";
import { getMembershipInTenant } from "./routes/tenants.js";

export class AuthError extends Error {}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createAuthChecker(
  verifier,
  runProvisioning = runProvisioningTransaction,
) {
  return async function requireUser(event) {
    const header =
      event.headers?.authorization || event.headers?.Authorization || "";
    const token = header.replace(/^Bearer\s+/i, "").trim();
    if (!token) throw new AuthError("Missing Authorization header.");

    let claims;
    try {
      claims = await verifier.verify(token);
    } catch (err) {
      throw new AuthError(`Invalid token: ${err.message}`);
    }

    const defaultTenantId = claims["custom:tenant_id"];
    if (!defaultTenantId)
      throw new AuthError("No tenant associated with this user.");

    const requested =
      event.headers?.["x-active-tenant"] || event.headers?.["X-Active-Tenant"];

    if (!requested || requested === defaultTenantId) {
      return {
        sub: claims.sub,
        email: claims.email,
        tenantId: defaultTenantId,
      };
    }

    // A client-supplied value reaching a `cast(... as uuid)` query as
    // garbage would surface as a raw Postgres error rather than a clean
    // 401/403 — reject the shape here, before any DB round trip, same as
    // rejecting a malformed token above.
    if (!UUID_RE.test(requested))
      throw new AuthError("Malformed X-Active-Tenant header.");

    const membership = await runProvisioning(claims.sub, (execute) =>
      getMembershipInTenant(execute, claims.sub, requested),
    );
    if (!membership)
      throw new AuthError("Not a member of the requested tenant.");

    return { sub: claims.sub, email: claims.email, tenantId: requested };
  };
}

const verifier = CognitoJwtVerifier.create({
  userPoolId: process.env.COGNITO_USER_POOL_ID,
  tokenUse: "id",
  clientId: process.env.COGNITO_CLIENT_ID,
});

export const requireUser = createAuthChecker(verifier);
```

Replace the file's existing header comment block (the one explaining why
`X-Tenant-Id` was removed and the `FUTURE WORK` note) with a comment
explaining that this IS that future work now, referencing
`docs/superpowers/specs/2026-08-18-tenant-switching-design.md` — don't
delete the historical context about why the old header was unsafe, just
update the "not built yet" framing since it's now built.

- [ ] **Step 5: Add `x-active-tenant` to the CORS allow-list — BOTH places**

There are two independent places a browser preflight learns which headers
are acceptable, and this codebase's own convention (see the comment
already in `handler.js`) is to keep both in sync rather than treat one as
authoritative:

In `Expense_tracker_New/backend/template.yaml`, line ~179:

```yaml
AllowHeaders: [authorization, content-type]
```

becomes

```yaml
AllowHeaders: [authorization, content-type, x-active-tenant]
```

In `Expense_tracker_New/backend/src/handler.js`'s `CORS_HEADERS` constant:

```js
  "Access-Control-Allow-Headers": "authorization,content-type",
```

becomes

```js
  "Access-Control-Allow-Headers": "authorization,content-type,x-active-tenant",
```

Update the comment above `handler.js`'s `CORS_HEADERS` (which currently
explains why `x-tenant-id` is deliberately absent) to explain why
`x-active-tenant` IS present and validated — don't leave the old
comment's reasoning contradicting the new header's existence. Update
`template.yaml`'s matching comment (`# Mirror any change here in
handler.js's CORS_HEADERS.`) only if it needs it — it may already be
generic enough to still apply.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test -- test/auth.test.js`
Expected: PASS, all new cases green.

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: PASS, no regressions — `handler.js` and every route module are
unaware anything changed, since `requireUser`'s return shape is unchanged.

- [ ] **Step 8: Commit**

```bash
git add src/auth.js src/routes/tenants.js src/handler.js template.yaml test/auth.test.js
git commit -m "feat: validate X-Active-Tenant header against real tenant_users membership"
```

---

### Task 2: Extract shared `redeemInvite`, refactor `postConfirmation.js`

**Files:**

- Modify: `Expense_tracker_New/backend/src/routes/tenants.js`
- Modify: `Expense_tracker_New/backend/src/postConfirmation.js`
- Test: `Expense_tracker_New/backend/test/tenants-route.test.js`

**Interfaces:**

- Produces: `routes/tenants.js` exports
  `redeemInvite(execute, { sub, email, inviteToken }): Promise<string>`
  (returns the tenant id joined) and `InvalidInviteError extends Error`
  (thrown when the token is missing/expired/already used — a plain,
  non-`ValidationError` marker class used for control flow, not shown to
  end users any differently than any other action failure today; see the
  spec's Error handling section for why this matches, not upgrades, the
  existing `createInvite` seat-cap error's treatment).
- Consumes: `getMembershipInTenant` (Task 1) and `SEAT_CAPS` (already
  imported from `../plans.js` in this file's neighbor, `postConfirmation.js`
  — moves into `routes/tenants.js` instead).

- [ ] **Step 1: Write the failing tests**

`test/tenants-route.test.js` currently imports only `freshDb, withProvisioning`
from `./pg-harness.js` and hand-rolls its own tenant-scoped `execute`
inline. Extend the import line to also pull in `withTenant, makeExecute`
(both already exist and are used this way elsewhere, e.g.
`test/validation.test.js`) — they make the new tests below much shorter
than hand-rolling the same transaction/RLS setup again:

```js
import {
  freshDb,
  withProvisioning,
  withTenant,
  makeExecute,
} from "./pg-harness.js";
```

Add these tests:

```js
test("redeemInvite joins the invited tenant and marks the token used", async () => {
  const client = await freshDb();
  try {
    const tenantId = await withProvisioning(client, "seed-user", async (c) => {
      const { rows } = await c.query(
        `insert into tenants (name, plan) values ('Household', 'family') returning id`,
      );
      return rows[0].id;
    });
    const token = await withTenant(client, tenantId, "owner-sub", async (c) => {
      const execute = makeExecute(c);
      await execute(
        `insert into tenant_users (user_sub, tenant_id, email, role) values ('owner-sub', :tenantId, 'owner@x.com', 'owner')`,
        { tenantId },
      );
      const invite = await tenants.createInvite(execute, {
        email: "new@x.com",
        role: "member",
      });
      return invite.token;
    });

    const joinedTenantId = await withProvisioning(client, "new-user", (c) =>
      tenants.redeemInvite(makeExecute(c), {
        sub: "new-user",
        email: "new@x.com",
        inviteToken: token,
      }),
    );
    assert.equal(joinedTenantId, tenantId);

    await withTenant(client, tenantId, "owner-sub", async (c) => {
      const membership = await tenants.getMembership(
        makeExecute(c),
        "new-user",
      );
      assert.equal(membership.role, "member");
    });
  } finally {
    await client.end();
  }
});

test("redeemInvite is a no-op success for a token to a tenant already joined", async () => {
  const client = await freshDb();
  try {
    const tenantId = await withProvisioning(client, "seed-user", async (c) => {
      const { rows } = await c.query(
        `insert into tenants (name, plan) values ('Household', 'family') returning id`,
      );
      return rows[0].id;
    });
    const token = await withTenant(client, tenantId, "owner-sub", async (c) => {
      const execute = makeExecute(c);
      await execute(
        `insert into tenant_users (user_sub, tenant_id, email, role) values ('owner-sub', :tenantId, 'owner@x.com', 'owner')`,
        { tenantId },
      );
      // The redeemer is ALREADY a member before redeeming - simulates
      // re-clicking an old invite link.
      await execute(
        `insert into tenant_users (user_sub, tenant_id, email, role) values ('new-user', :tenantId, 'new@x.com', 'member')`,
        { tenantId },
      );
      const invite = await tenants.createInvite(execute, {
        email: "new@x.com",
        role: "member",
      });
      return invite.token;
    });

    const joinedTenantId = await withProvisioning(client, "new-user", (c) =>
      tenants.redeemInvite(makeExecute(c), {
        sub: "new-user",
        email: "new@x.com",
        inviteToken: token,
      }),
    );
    assert.equal(joinedTenantId, tenantId);

    await withTenant(client, tenantId, "owner-sub", async (c) => {
      const rows = await makeExecute(c).rows(
        `select count(*) as count from tenant_users where user_sub = 'new-user'`,
      );
      assert.equal(Number(rows[0].count), 1); // no duplicate row, no constraint-violation throw
    });
  } finally {
    await client.end();
  }
});

test("redeemInvite throws InvalidInviteError on an expired or unknown token", async () => {
  const client = await freshDb();
  try {
    await assert.rejects(
      () =>
        withProvisioning(client, "new-user", (c) =>
          tenants.redeemInvite(makeExecute(c), {
            sub: "new-user",
            email: "x@y.com",
            inviteToken: "does-not-exist",
          }),
        ),
      tenants.InvalidInviteError,
    );
  } finally {
    await client.end();
  }
});

test("redeemInvite rejects when the tenant is at its seat cap", async () => {
  const client = await freshDb();
  try {
    // Default plan is 'free' (SEAT_CAPS.free === 1). The invite is
    // inserted directly rather than via createInvite, whose own SOFT
    // check would already reject sending an invite to a tenant that's
    // already full - this test is specifically about redeemInvite's HARD,
    // authoritative check catching what the soft check might have missed
    // (e.g. the plan was downgraded after the invite was sent).
    const tenantId = await withProvisioning(client, "seed-user", async (c) => {
      const { rows } = await c.query(
        `insert into tenants (name) values ('Household') returning id`,
      );
      return rows[0].id;
    });
    const token = await withTenant(client, tenantId, "owner-sub", async (c) => {
      const execute = makeExecute(c);
      await execute(
        `insert into tenant_users (user_sub, tenant_id, email, role) values ('owner-sub', :tenantId, 'owner@x.com', 'owner')`,
        { tenantId },
      );
      const rows = await execute.rows(
        `insert into tenant_invites (tenant_id, email, role) values (:tenantId, 'new@x.com', 'member') returning token`,
        { tenantId },
      );
      return rows[0].token;
    });

    await assert.rejects(
      () =>
        withProvisioning(client, "new-user", (c) =>
          tenants.redeemInvite(makeExecute(c), {
            sub: "new-user",
            email: "new@x.com",
            inviteToken: token,
          }),
        ),
      /seat limit/i,
    );
  } finally {
    await client.end();
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- test/tenants-route.test.js`
Expected: FAIL — `redeemInvite`/`InvalidInviteError` don't exist yet.

- [ ] **Step 3: Implement `redeemInvite` in `routes/tenants.js`**

```js
import { SEAT_CAPS } from "../plans.js";

export class InvalidInviteError extends Error {}

export async function redeemInvite(execute, { sub, email, inviteToken }) {
  const invites = await execute.rows(
    `select tenant_id, role from tenant_invites
     where token = :token and used_at is null and expires_at > now()`,
    { token: inviteToken },
  );
  if (!invites[0]) {
    throw new InvalidInviteError("This invite is invalid or has expired.");
  }
  const { tenant_id: tenantId, role } = invites[0];

  const existing = await getMembershipInTenant(execute, sub, tenantId);
  if (existing) {
    // Re-clicking an old invite link for a tenant already joined - a
    // no-op success, not an error. tenant_users' primary key is
    // (user_sub, tenant_id); a naive second insert would otherwise hit a
    // constraint violation.
    return tenantId;
  }

  const [{ plan }] = await execute.rows(
    `select plan from tenants where id = cast(:tenantId as uuid)`,
    { tenantId },
  );
  const [{ count: memberCount }] = await execute.rows(
    `select cast(count(*) as int) as count from tenant_users where tenant_id = cast(:tenantId as uuid)`,
    { tenantId },
  );
  // Hard, authoritative check: state can have changed (plan downgraded,
  // another invite redeemed) since this invite was created - createInvite's
  // check at send time is only a soft, best-effort warning.
  if (memberCount >= SEAT_CAPS[plan]) {
    throw new Error(
      `Household is at its ${SEAT_CAPS[plan]}-seat limit for its current plan.`,
    );
  }

  await execute(
    `insert into tenant_users (user_sub, tenant_id, email, role)
     values (:sub, :tenantId, :email, :role)`,
    { sub, tenantId, email, role },
  );
  await execute(
    `update tenant_invites set used_at = now() where token = :token`,
    { token: inviteToken },
  );
  return tenantId;
}
```

- [ ] **Step 4: Refactor `postConfirmation.js` to use it, preserving exact behavior**

Replace the `resolveTenant` function's invite branch. Before:

```js
async function resolveTenant({ sub, email, inviteToken }) {
  return runProvisioningTransaction(sub, async (execute) => {
    if (inviteToken) {
      const invites = await execute.rows(/* ... */);
      if (invites[0]) {
        /* ... seat-cap check, insert, mark used, return tenant_id ... */
      }
      // falls through to create a new tenant
    }
    const created = await execute.rows(/* ... */);
    /* ... */
  });
}
```

After:

```js
import { runProvisioningTransaction } from "./db.js";
import { redeemInvite, InvalidInviteError } from "./routes/tenants.js";
import {
  CognitoIdentityProviderClient,
  AdminUpdateUserAttributesCommand,
} from "@aws-sdk/client-cognito-identity-provider";

// SEAT_CAPS is no longer imported here directly - it moved into
// routes/tenants.js's redeemInvite, the only place in this file that used it.

async function resolveTenant({ sub, email, inviteToken }) {
  return runProvisioningTransaction(sub, async (execute) => {
    if (inviteToken) {
      try {
        return await redeemInvite(execute, { sub, email, inviteToken });
      } catch (err) {
        if (!(err instanceof InvalidInviteError)) throw err; // seat-cap and any other error still blocks signup, unchanged
        // falls through to create a new tenant below - unchanged behavior
        // for an invalid/expired token, same as before this refactor.
      }
    }
    const created = await execute.rows(
      `insert into tenants (name) values (:name) returning id`,
      { name: `${email}'s household` },
    );
    const tenantId = created[0].id;
    await execute(
      `insert into tenant_users (user_sub, tenant_id, email, role)
       values (:sub, :tenantId, :email, 'owner')`,
      { sub, tenantId, email },
    );
    return tenantId;
  });
}
```

The rest of `postConfirmation.js` (the `handler` export, the
`AdminUpdateUserAttributesCommand` call) is unchanged.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- test/tenants-route.test.js test/provisioning.test.js`
Expected: PASS. `test/provisioning.test.js` (the existing
`postConfirmation.js` behavior coverage) must pass **unchanged** — this
refactor preserves behavior exactly; if any of those tests need editing to
pass, that's a signal the refactor changed something it shouldn't have,
not a signal to adjust the test.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS, no regressions.

- [ ] **Step 7: Commit**

```bash
git add src/routes/tenants.js src/postConfirmation.js test/tenants-route.test.js
git commit -m "refactor: extract shared redeemInvite from postConfirmation.js"
```

---

### Task 3: `joinTenant` and `listMyTenants` backend actions

**Files:**

- Modify: `Expense_tracker_New/backend/src/handler.js`
- Modify: `Expense_tracker_New/backend/src/routes/tenants.js`
- Test: `Expense_tracker_New/backend/test/tenant-switching.test.js` (new)

**Interfaces:**

- Produces: `routes/tenants.js` exports
  `listMyTenants(execute, userSub): Promise<Array<{tenant_id, role, name, plan}>>`.
  `handler.js`'s POST action contract gains `joinTenant` (consumes
  `{ inviteToken }`, returns `{ ok: true, tenantId }`) and `listMyTenants`
  (consumes nothing beyond the action name, returns
  `{ ok: true, tenants: [...] }`).
- Consumes: `redeemInvite`, `InvalidInviteError` (Task 2),
  `runProvisioningTransaction` (already imported into `db.js`, newly
  imported into `handler.js`).

- [ ] **Step 1: Write the failing tests**

Create `test/tenant-switching.test.js`, following this codebase's
established pattern (see `test/billing-route.test.js` or
`test/seat-cap.test.js` for the exact shape of driving real route/handler
functions against real Postgres via `pg-harness.js`):

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  freshDb,
  withTenant,
  withProvisioning,
  makeExecute,
} from "./pg-harness.js";
import * as tenants from "../src/routes/tenants.js";

test("listMyTenants returns exactly the tenants a user belongs to", async () => {
  const client = await freshDb();
  try {
    const tenantA = await withProvisioning(client, "seed-user", async (c) => {
      const { rows } = await c.query(
        `insert into tenants (name) values ('Household A') returning id`,
      );
      return rows[0].id;
    });
    const tenantB = await withProvisioning(client, "seed-user", async (c) => {
      const { rows } = await c.query(
        `insert into tenants (name) values ('Household B') returning id`,
      );
      return rows[0].id;
    });
    await withTenant(client, tenantA, "owner-sub", (c) =>
      makeExecute(c)(
        `insert into tenant_users (user_sub, tenant_id, email, role) values ('user-1', :tenantId, 'x@y.com', 'owner')`,
        { tenantId: tenantA },
      ),
    );
    // user-1 does NOT belong to tenantB - confirms isolation, not just presence.

    const mine = await withProvisioning(client, "user-1", (c) =>
      tenants.listMyTenants(makeExecute(c), "user-1"),
    );

    assert.equal(mine.length, 1);
    assert.equal(mine[0].tenant_id, tenantA);
    assert.equal(mine[0].role, "owner");
  } finally {
    await client.end();
  }
});

test("redeemInvite lets an existing member of one tenant join a second, without touching the first", async () => {
  const client = await freshDb();
  try {
    const tenantA = await withProvisioning(client, "seed-user", async (c) => {
      const { rows } = await c.query(
        `insert into tenants (name) values ('Household A') returning id`,
      );
      return rows[0].id;
    });
    const tenantB = await withProvisioning(client, "seed-user", async (c) => {
      const { rows } = await c.query(
        `insert into tenants (name, plan) values ('Household B', 'family') returning id`,
      );
      return rows[0].id;
    });

    await withTenant(client, tenantA, "owner-sub-a", (c) =>
      makeExecute(c)(
        `insert into tenant_users (user_sub, tenant_id, email, role) values ('user-1', :tenantId, 'user1@x.com', 'owner')`,
        { tenantId: tenantA },
      ),
    );

    const token = await withTenant(
      client,
      tenantB,
      "owner-sub-b",
      async (c) => {
        const execute = makeExecute(c);
        await execute(
          `insert into tenant_users (user_sub, tenant_id, email, role) values ('owner-sub-b', :tenantId, 'ownerb@x.com', 'owner')`,
          { tenantId: tenantB },
        );
        const invite = await tenants.createInvite(execute, {
          email: "user1@x.com",
          role: "member",
        });
        return invite.token;
      },
    );

    const joinedTenantId = await withProvisioning(client, "user-1", (c) =>
      tenants.redeemInvite(makeExecute(c), {
        sub: "user-1",
        email: "user1@x.com",
        inviteToken: token,
      }),
    );
    assert.equal(joinedTenantId, tenantB);

    const mine = await withProvisioning(client, "user-1", (c) =>
      tenants.listMyTenants(makeExecute(c), "user-1"),
    );
    assert.equal(mine.length, 2);
    assert.deepEqual(
      mine.map((t) => t.tenant_id).sort(),
      [tenantA, tenantB].sort(),
    );
  } finally {
    await client.end();
  }
});
```

New file — its imports need `freshDb, withProvisioning, withTenant,
makeExecute` from `./pg-harness.js` (same set Task 2 adds to
`tenants-route.test.js`) plus `import * as tenants from "../src/routes/tenants.js";`.

Note: this task's tests exercise `redeemInvite`/`listMyTenants` directly
(the actual logic), matching Task 2's testing approach — driving
`handler.js`'s `joinTenant`/`listMyTenants` action cases end-to-end would
need a forged JWT and a live Data API connection, the same limitation
already accepted throughout this codebase's test suite (see e.g. the
`assertManagesInvites` tests in `test/handler-gating.test.js`). Don't
attempt to work around that here.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- test/tenant-switching.test.js`
Expected: FAIL — `listMyTenants` doesn't exist yet.

- [ ] **Step 3: Implement `listMyTenants` in `routes/tenants.js`**

```js
export async function listMyTenants(execute, userSub) {
  return execute.rows(
    `select tu.tenant_id, tu.role, t.name, t.plan
     from tenant_users tu
     join tenants t on t.id = tu.tenant_id
     where tu.user_sub = :userSub
     order by tu.created_at`,
    { userSub },
  );
}
```

- [ ] **Step 4: Wire `joinTenant`/`listMyTenants` into `handler.js`**

These two actions are inherently cross-tenant (joining a tenant not yet
belonged to, or listing every tenant belonged to) — they cannot run
inside `handlePost`'s existing `runInTenantTransaction` (single-tenant RLS
scope). Handle them before that transaction opens:

```js
import { runInTenantTransaction, runProvisioningTransaction } from "./db.js";
import * as tenants from "./routes/tenants.js"; // already imported - add nothing new here, just confirm redeemInvite/listMyTenants/InvalidInviteError are exported from this same module

async function handlePost(user, event) {
  const payload = JSON.parse(event.body || "{}");
  const { action } = payload;

  if (action === "joinTenant") {
    const tenantId = await runProvisioningTransaction(user.sub, (execute) =>
      tenants.redeemInvite(execute, {
        sub: user.sub,
        email: user.email,
        inviteToken: payload.inviteToken,
      }),
    );
    return { ok: true, tenantId };
  }
  if (action === "listMyTenants") {
    const myTenants = await runProvisioningTransaction(user.sub, (execute) =>
      tenants.listMyTenants(execute, user.sub),
    );
    return { ok: true, tenants: myTenants };
  }

  return runInTenantTransaction(user.tenantId, user.sub, async (execute) => {
    switch (action) {
      /* ... every existing case, unchanged ... */
    }
  });
}
```

Both `redeemInvite`'s `InvalidInviteError` and its plain seat-cap `Error`
propagate up through `handler`'s existing top-level catch (added in an
earlier plan) exactly like `createInvite`'s existing seat-cap error does
today — a generic `500 "Request failed."` to the client, full detail to
the server log. This is a deliberate match to existing precedent, not an
oversight; see the spec's Error handling section.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- test/tenant-switching.test.js`
Expected: PASS.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS, no regressions.

- [ ] **Step 7: Commit**

```bash
git add src/handler.js src/routes/tenants.js test/tenant-switching.test.js
git commit -m "feat: add joinTenant and listMyTenants actions"
```

---

### Task 4: Frontend `store.js` — tenant-switching methods

**Files:**

- Modify: `Expense_tracker_New/frontend/assets/store.js`

**Interfaces:**

- Produces on `ApiStore`: `setActiveTenant(tenantId)` (sets an instance
  field, no network call), `resetCache()` (clears `this.cache`/`this.user`
  so the next `_ensure()` call re-fetches from scratch — needed by Task 5's
  switcher, since switching tenants must not keep serving the previous
  tenant's cached transactions/budget/etc.), `getMyTenants(): Promise<Array<{tenant_id, role, name, plan}>>`,
  `joinTenant(inviteToken): Promise<{tenantId}>`, `getUserEmail(): Promise<string|null>`.
  `_headers()` sends `X-Active-Tenant` whenever an active tenant has been
  set.

- [ ] **Step 1: Add `activeTenantId` to the constructor and `_headers`**

```js
class ApiStore {
  constructor(endpoint, idToken) {
    this.endpoint = endpoint.replace(/\/+$/, "");
    this.idToken = idToken;
    this.kind = "api";
    this.cache = null;
    this.activeTenantId = null;
  }

  setActiveTenant(tenantId) {
    this.activeTenantId = tenantId || null;
  }

  resetCache() {
    // Switching tenants must not keep serving the previous tenant's
    // cached transactions/budget/balances/etc - the next _ensure() call
    // (triggered by refresh()) needs to hit the API fresh, scoped to
    // whatever tenant setActiveTenant() was just called with.
    this.cache = null;
    this.user = null;
  }

  _headers(extra = {}) {
    return {
      Authorization: `Bearer ${this.idToken}`,
      ...(this.activeTenantId ? { "X-Active-Tenant": this.activeTenantId } : {}),
      ...extra,
    };
  }
```

- [ ] **Step 2: Add the new methods**

Add near `getRole()`/`getTenant()`:

```js
  async getUserEmail() {
    return this.user?.email || null;
  }
  async getMyTenants() {
    const r = await this._post({ action: "listMyTenants" });
    return r.tenants || [];
  }
  async joinTenant(inviteToken) {
    return this._post({ action: "joinTenant", inviteToken });
  }
```

- [ ] **Step 3: `node --check`**

```bash
node --check Expense_tracker_New/frontend/assets/store.js
```

Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add Expense_tracker_New/frontend/assets/store.js
git commit -m "feat: add tenant-switching methods to ApiStore"
```

---

### Task 5: Frontend `app.js` — switcher UI, join-while-signed-in, active-tenant persistence

**Files:**

- Modify: `Expense_tracker_New/frontend/assets/app.js`

**Interfaces:**

- Consumes: `ApiStore.setActiveTenant/getMyTenants/joinTenant/getUserEmail`
  (Task 4).

- [ ] **Step 1: Populate `state.userEmail` and `state.tenants` in `refresh()`**

Add, alongside the existing `state.tenant = ...` line:

```js
state.userEmail = (await state.store.getUserEmail?.()) || null;
state.tenants = (await state.store.getMyTenants?.()) || [];
```

- [ ] **Step 2: Read/persist the active tenant, and set it on the store before every request**

Add a small helper near the top of the file, alongside the other
`localStorage`-key constants (e.g. `API_ENDPOINT_KEY`):

```js
function activeTenantKey() {
  return `ledger:activeTenant:${state.userEmail || "anon"}`;
}
function getStoredActiveTenant() {
  return localStorage.getItem(activeTenantKey());
}
function setStoredActiveTenant(tenantId) {
  localStorage.setItem(activeTenantKey(), tenantId);
}
```

In `refresh()`, after `state.tenants` is populated, resolve and apply the
active tenant:

```js
const stored = getStoredActiveTenant();
const validStored = state.tenants.some((t) => t.tenant_id === stored);
const activeTenantId = validStored ? stored : null; // null = the JWT's own default, no header needed
state.store.setActiveTenant?.(activeTenantId);
```

(`validStored` false — including "never set" — means no header is sent at
all, and `auth.js` falls back to the JWT's default tenant, exactly as
today for every existing single-tenant user.)

- [ ] **Step 3: Switching action**

Add a function used by the Household panel's switcher (Step 5):

```js
async function switchActiveTenant(tenantId) {
  setStoredActiveTenant(tenantId);
  state.store.setActiveTenant?.(tenantId);
  await withBusy("Switching household", async () => {
    state.store.resetCache?.(); // Task 4 — clears the previous tenant's cached data
    await refresh();
    state.rows = await state.store.list();
  });
  (VIEWS[state.tab] || renderDashboard)();
}
```

- [ ] **Step 4: Join-while-signed-in detection in `boot()`**

Add near the top of `boot()`, before `revealApp()`:

```js
const inviteToken = new URLSearchParams(location.search).get("invite");
if (inviteToken && isRemoteStore(state.store)) {
  const joined = await withBusy("Joining household", async () => {
    await state.store.joinTenant(inviteToken);
  });
  if (joined) {
    state.tenants = (await state.store.getMyTenants?.()) || [];
    notice(
      "You've joined the household. Switch to it from the Household panel whenever you're ready.",
      "ok",
    );
  } else {
    notice("That invite link is invalid or has expired.", "bad");
  }
  // Strip the query param so a refresh doesn't try to re-join.
  history.replaceState(null, "", location.pathname + location.hash);
}
```

Confirm the actual invite-link query-param name against
`cognitoAuthorizeUrl()`'s existing usage (search for how the pre-signup
flow reads/writes an invite token today) — reuse the same param name
rather than introducing a second one.

- [ ] **Step 5: Switcher UI inside the Household panel**

Find the Household panel's template in `renderData()` (added in an
earlier plan — search for the panel's `eyebrow` heading). Add, visible to
any member with more than one tenant regardless of role (unlike the
invite-management controls in the same panel, which stay owner/admin-only):

```html
${
  state.tenants.length > 1
    ? `<p class="note" style="margin:0">Viewing: <b>${esc(state.tenants.find((t) => t.tenant_id === (state.store.activeTenantId || state.tenants.find((x) => !state.store.activeTenantId)?.tenant_id))?.name || "")}</b></p>
       <select id="tenant-switcher">
         ${state.tenants
           .map(
             (t) =>
               `<option value="${esc(t.tenant_id)}" ${t.tenant_id === state.store.activeTenantId ? "selected" : ""}>${esc(t.name)} (${esc(t.role)})</option>`,
           )
           .join("")}
       </select>`
    : ""
}
```

Wire it after the panel's other handlers:

```js
$("#tenant-switcher")?.addEventListener("change", (e) => {
  switchActiveTenant(e.target.value);
});
```

Treat the exact markup above as a starting point, not verbatim final
code — match the Household panel's real existing template style (class
names, spacing) once you're looking at the actual current file, the same
way the earlier billing plan's Task 9 handled its one under-specified
step.

- [ ] **Step 6: `node --check` and manual smoke test**

```bash
node --check Expense_tracker_New/frontend/assets/app.js
```

Manual check: serve `Expense_tracker_New/frontend/` locally, confirm the
Household panel shows no switcher for a single-tenant account (the
overwhelming majority case) and that nothing else regresses.

- [ ] **Step 7: Commit**

```bash
git add Expense_tracker_New/frontend/assets/app.js
git commit -m "feat: add tenant switcher to Household panel and join-via-invite-while-signed-in"
```

---

## Self-Review Notes

- **Spec coverage:** Auth flow validation (Task 1), shared invite-redemption
  - signed-in join (Tasks 2-3), listing memberships (Task 3), frontend
    state/persistence/UI (Tasks 4-5). Every section of the spec has a
    corresponding task. No schema/RLS task, matching the spec's explicit
    "Summary of what does NOT change".
- **Type/interface consistency:** `getMembershipInTenant`'s
  `{role: string} | null` return shape (Task 1) matches what `redeemInvite`
  (Task 2) and the switch-validation path both expect. `listMyTenants`'
  `{tenant_id, role, name, plan}` row shape (Task 3) matches what the
  frontend's switcher (Task 5) reads (`t.tenant_id`, `t.name`, `t.role`).
  `joinTenant`'s `{ok, tenantId}` response matches `ApiStore.joinTenant`'s
  return value.
- **Ambiguity flagged inline, not silently guessed at:** Task 5 Step 5's
  exact Household-panel markup is explicitly marked as needing the
  implementer's own judgment against the real current file — consistent
  with how the prior billing plan handled its one similarly-underspecified
  frontend step (Task 9's Net Worth nav-gating), rather than inventing
  markup for a file this planning pass didn't have open to read verbatim.
  (Step 3's cache-invalidation question, initially left open in the same
  draft, was resolved during self-review instead — see the next bullet.)
- **Cross-task inconsistency caught and fixed during self-review:** an
  earlier draft of Task 5 Step 3 read/wrote `state.cache` directly to
  invalidate the previous tenant's cached data, but `ApiStore.cache` is a
  private field on the _store instance_, not on `state` — that line would
  have silently done nothing, leaving stale data visible after a switch.
  Fixed by adding a `resetCache()` method to `ApiStore` in Task 4 (this
  plan's actual method-signature source of truth) and having Task 5 call
  `state.store.resetCache?.()` instead of reaching into a field that was
  never really there.
- **Bug avoided during self-review:** the first draft of Task 3 put
  `joinTenant`/`listMyTenants` as ordinary `case` branches inside
  `handlePost`'s existing `switch`, which is unconditionally wrapped in
  `runInTenantTransaction` — both actions are inherently cross-tenant and
  would have silently run under the wrong (or no valid) tenant's RLS
  scope. Fixed by special-casing both actions before that transaction
  opens, matching the same "no `app.tenant_id` set yet" shape
  `postConfirmation.js` already uses via `runProvisioningTransaction`.
