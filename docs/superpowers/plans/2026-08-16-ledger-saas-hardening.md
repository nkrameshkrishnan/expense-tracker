# Ledger SaaS Backend Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take the `Expense_tracker_New/` scaffold (API Gateway + Lambda + Aurora Serverless v2 + Cognito, tenant isolation via Postgres RLS) from "parses and is internally consistent" to "tested, has a real invite/membership flow, ships via CI, and can be seeded from the existing household's data."

**Architecture:** Unchanged from the scaffold — one Lambda behind API Gateway speaking the same `{action, ...}` contract the original `Code.gs` used, tenant isolation enforced by Postgres RLS, Cognito Hosted UI for sign-in. This plan adds: a local-Postgres test harness to actually prove RLS holds, a `tenant_invites`-backed membership/invite flow (backend route + frontend panel), a CI workflow, and a data migration script.

**Tech Stack:** Node.js 20 (`node:test`/`node:assert` — no new test framework), `pg` as a **test-only** devDependency for a local Postgres harness (production code keeps using `@aws-sdk/client-rds-data` exclusively), Docker Compose for local Postgres, AWS SAM, GitHub Actions.

**Spec:** No separate spec file — the architecture was brainstormed and approved directly in conversation; `Expense_tracker_New/README.md` documents the resulting design and its "what's left" list, which this plan implements. This plan document is the closest thing to a spec for the additions below (the invite/membership flow and the RLS bootstrap fix were not part of the original design conversation — they're new, worked out here).

## Global Constraints

- **No new production dependency for testing.** `pg` is a `backend/package.json` **devDependency only** — nothing under `backend/src/` may import it. Production always talks to Postgres through the RDS Data API (`@aws-sdk/client-rds-data`), matching the scaffold's original design rationale (no VPC networking for the Lambdas).
- **Every new/modified JS file must pass `node --check`**, matching the original repo's CI pattern (see the root repo's `.github/workflows/deploy.yml`).
- **All new backend actions follow the existing `{action, ...}` POST / query-param GET contract** already used by `handler.js` and mirrored by `ApiStore` in `store.js` — no new endpoints, no new transport shape.
- **Billing is explicitly out of scope for this plan.** `tenants.plan`/`tenants.status` columns already exist in `db/schema.sql` for future use; no Stripe integration, no plan enforcement, no tasks for it here. This matches the user's own pre-validation-stage decision recorded in `Expense_tracker_New/README.md`.
- **Tenant-switching UI is explicitly out of scope for this plan.** Every user belongs to exactly one tenant, set once at signup by `postConfirmation.js` (either a brand-new tenant, or the tenant of the invite token they signed up with). There is no code path today for an *already-registered* user to join a second tenant, so a switcher has nothing to switch between yet. `auth.js`'s optional `X-Tenant-Id` header stays in place for future multi-membership work, but nothing sets it and this plan doesn't change that.
- **RLS correctness is the highest-priority fix in this plan.** While preparing the test tasks below, a real bug was found: Postgres table *owners* bypass their own RLS policies unless `FORCE ROW LEVEL SECURITY` is also set, and `backend/template.yaml`'s `DataFunction`/`PostConfirmationFunction` both authenticate via `DbSecret` — the same master/owner credentials `DbCluster` was created with. Without `FORCE ROW LEVEL SECURITY`, every RLS policy in `db/schema.sql` is currently a no-op in production. Tasks 2–3 fix this.

---

## File Structure

New files this plan creates:

```
Expense_tracker_New/
  db/
    docker-compose.yml          # local Postgres for tests only
  backend/
    test/
      pg-harness.js              # freshDb()/withTenant() test helpers (pg, not Data API)
      pg-harness.test.js
      provisioning.test.js       # Task 2
      rls.test.js                 # Task 3
      auth.test.js                 # Task 4
      db.test.js                   # Task 5
      tenants-route.test.js        # Task 6
      handler-gating.test.js       # Task 6
    src/
      routes/
        tenants.js                # Task 6 — new
    migrate-to-api.mjs             # Task 10 — new
.github/
  workflows/
    ledger-new-ci.yml              # Task 9 — new (separate from the root repo's existing deploy.yml)
```

Modified files: `Expense_tracker_New/db/schema.sql` (Tasks 2–3), `Expense_tracker_New/backend/src/db.js` (Task 2), `Expense_tracker_New/backend/src/postConfirmation.js` (Task 2), `Expense_tracker_New/backend/src/auth.js` (Task 4), `Expense_tracker_New/backend/src/handler.js` (Task 6), `Expense_tracker_New/backend/package.json` (Task 1), `Expense_tracker_New/frontend/assets/store.js` (Task 7), `Expense_tracker_New/frontend/assets/app.js` (Task 8).

---

### Task 1: Local Postgres test harness

**Files:**
- Create: `Expense_tracker_New/db/docker-compose.yml`
- Create: `Expense_tracker_New/backend/test/pg-harness.js`
- Create: `Expense_tracker_New/backend/test/pg-harness.test.js`
- Modify: `Expense_tracker_New/backend/package.json`

**Interfaces:**
- Produces: `freshDb(): Promise<pg.Client>` — connects to the local test Postgres, drops/recreates the `public` schema, applies `db/schema.sql`, returns a connected client the caller must `.end()`.
- Produces: `withTenant(client: pg.Client, tenantId: string, userSub: string, fn: (client) => Promise<T>): Promise<T>` — mirrors `db.js`'s `runInTenantTransaction`, but against a plain `pg` client instead of the Data API, so RLS policies can be exercised directly.
- Produces: `withProvisioning(client: pg.Client, userSub: string, fn: (client) => Promise<T>): Promise<T>` — mirrors `db.js`'s `runProvisioningTransaction` (Task 2): sets only `app.user_id`, leaves `app.tenant_id` genuinely unset. **This is the only correct way to seed a "first tenant" fixture row in any test** — never call `withTenant(client, "<placeholder>", ...)` for that purpose; see the doc comment on this function for why a placeholder string breaks differently (and worse) than leaving the var unset.

- [ ] **Step 1: Add the `pg` devDependency and test script, write the compose file**

`Expense_tracker_New/backend/package.json` — add to `dependencies`... no, add a new `devDependencies` block, and a `test` script:

```json
{
  "name": "ledger-backend",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Server-mediated API for Ledger's multi-tenant SaaS backend (API Gateway + Lambda + Aurora Serverless v2 + Cognito).",
  "dependencies": {
    "@aws-sdk/client-rds-data": "^3.600.0",
    "@aws-sdk/client-cognito-identity-provider": "^3.600.0",
    "aws-jwt-verify": "^4.0.1"
  },
  "devDependencies": {
    "pg": "^8.12.0"
  },
  "scripts": {
    "build": "sam build",
    "deploy": "sam deploy --guided",
    "local": "sam local start-api",
    "test": "node --test test/"
  }
}
```

`Expense_tracker_New/db/docker-compose.yml`:

```yaml
services:
  postgres:
    image: postgres:15
    environment:
      POSTGRES_USER: ledger_test
      POSTGRES_PASSWORD: ledger_test
      POSTGRES_DB: ledger_test
    ports:
      - "5433:5432" # not 5432, so it never collides with a local Postgres install
```

- [ ] **Step 2: Write the failing test**

`Expense_tracker_New/backend/test/pg-harness.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./pg-harness.js";

test("freshDb applies schema.sql - every tenant-owned table has RLS enabled", async () => {
  const client = await freshDb();
  try {
    const { rows } = await client.query(
      `select relname, relrowsecurity from pg_class
       where relname in ('tenants','tenant_users','tenant_invites','transactions','budget','balances','debts')
       order by relname`,
    );
    assert.equal(rows.length, 7);
    for (const row of rows)
      assert.equal(row.relrowsecurity, true, `${row.relname} should have RLS enabled`);
  } finally {
    await client.end();
  }
});
```

- [ ] **Step 3: Run it to confirm it fails**

```bash
cd Expense_tracker_New/backend && npm install
node --test test/pg-harness.test.js
```

Expected: FAIL — `Cannot find module './pg-harness.js'` (it doesn't exist yet).

- [ ] **Step 4: Start local Postgres and implement the harness**

```bash
docker compose -f ../db/docker-compose.yml up -d
```

`Expense_tracker_New/backend/test/pg-harness.js`:

```js
import pg from "pg";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const SCHEMA_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "db",
  "schema.sql",
);

const CONNECTION = {
  host: "localhost",
  port: 5433,
  user: "ledger_test",
  password: "ledger_test",
  database: "ledger_test",
};

/** Connects to the local test Postgres, drops and recreates the public
    schema, applies db/schema.sql fresh, and returns a connected client.
    Callers must call client.end() when done. */
export async function freshDb() {
  const client = new pg.Client(CONNECTION);
  await client.connect();
  await client.query("drop schema public cascade; create schema public;");
  const schema = readFileSync(SCHEMA_PATH, "utf8");
  await client.query(schema);
  return client;
}

/** Mirrors backend/src/db.js's runInTenantTransaction, but against a plain
    pg client instead of the RDS Data API - this is what lets the RLS
    policies in db/schema.sql be exercised directly without AWS. */
export async function withTenant(client, tenantId, userSub, fn) {
  await client.query("begin");
  try {
    await client.query("select set_config('app.tenant_id', $1, true)", [
      String(tenantId),
    ]);
    await client.query("select set_config('app.user_id', $1, true)", [
      String(userSub),
    ]);
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback");
    throw err;
  }
}

/** Mirrors backend/src/db.js's runProvisioningTransaction (Task 2) - sets
    ONLY app.user_id, deliberately leaves app.tenant_id unset entirely.
    This is the ONLY correct way to seed a "first tenant" fixture row in
    tests: setting app.tenant_id to any placeholder string (e.g. "seed")
    is NOT equivalent to leaving it unset. tenants_isolation is a FOR ALL
    policy with only a USING clause, and Postgres uses that same
    expression as the WITH CHECK for INSERT/UPDATE when none is given —
    so an INSERT would evaluate `id = current_setting('app.tenant_id',
    true)::uuid` regardless of the separate permissive provisioning
    policy. With app.tenant_id genuinely unset, current_setting(...,
    true) returns NULL, and NULL::uuid is NULL (not an error) — the
    check evaluates to NULL (treated as reject) but the permissive
    tenants_provisioning_insert policy's `WITH CHECK (true)` still ORs in
    and the insert succeeds. With a placeholder STRING instead, the cast
    ('seed'::uuid) throws an error outright before any OR logic applies,
    and the insert fails. Always use this helper, never
    withTenant(client, "<placeholder>", ...), for bootstrap inserts. */
export async function withProvisioning(client, userSub, fn) {
  await client.query("begin");
  try {
    await client.query("select set_config('app.user_id', $1, true)", [
      String(userSub),
    ]);
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback");
    throw err;
  }
}
```

- [ ] **Step 5: Run it to confirm it passes**

```bash
node --test test/pg-harness.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add Expense_tracker_New/db/docker-compose.yml Expense_tracker_New/backend/test/pg-harness.js Expense_tracker_New/backend/test/pg-harness.test.js Expense_tracker_New/backend/package.json
git commit -m "test: add local Postgres harness for RLS/schema tests"
```

---

### Task 2: Fix the RLS provisioning bootstrap gap

**Context:** Creating a brand-new tenant, or consuming an invite, necessarily happens *before* any `app.tenant_id` session var can exist — there's nothing to scope to yet. The scaffold's `postConfirmation.js` papered over this with a placeholder tenant id string (`"__provisioning__"`), which only "worked" because the owner-bypass bug (fixed in Task 3) made RLS a no-op anyway. Fixing that bug without also fixing this would break signups outright. This task adds narrow, explicitly-scoped policies for exactly the provisioning path, and removes the placeholder-string hack.

**Files:**
- Modify: `Expense_tracker_New/db/schema.sql`
- Modify: `Expense_tracker_New/backend/src/db.js`
- Modify: `Expense_tracker_New/backend/src/postConfirmation.js`
- Create: `Expense_tracker_New/backend/test/provisioning.test.js`

**Interfaces:**
- Consumes: `freshDb`, `withTenant` from `./pg-harness.js` (Task 1)
- Produces: `runProvisioningTransaction(userSub: string, fn: (execute) => Promise<T>): Promise<T>` in `db.js`, alongside the existing `runInTenantTransaction`.

- [ ] **Step 1: Write the failing test**

`Expense_tracker_New/backend/test/provisioning.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { freshDb, withTenant, withProvisioning } from "./pg-harness.js";

test("a brand-new tenant can be created with no app.tenant_id set", async () => {
  const client = await freshDb();
  try {
    await withProvisioning(client, "new-owner-sub", async (c) => {
      const { rows } = await c.query(
        `insert into tenants (name) values ('New Household') returning id`,
      );
      assert.ok(rows[0].id);
    });
  } finally {
    await client.end();
  }
});

test("an invite can be looked up and marked used with no app.tenant_id set", async () => {
  const client = await freshDb();
  try {
    // Seed via a normal provisioning transaction, same as real tenant creation.
    const tenantId = await withProvisioning(client, "seed-user", async (c) => {
      const { rows } = await c.query(
        `insert into tenants (name) values ('Household A') returning id`,
      );
      return rows[0].id;
    });
    await withTenant(client, tenantId, "owner-sub", async (c) => {
      await c.query(`insert into tenant_users (user_sub, tenant_id, email, role)
                      values ('owner-sub', $1, 'owner@x.com', 'owner')`, [tenantId]);
      await c.query(`insert into tenant_invites (tenant_id, email) values ($1, 'new@x.com')`, [tenantId]);
    });

    // Now the provisioning-path query: no app.tenant_id set at all.
    await client.query("begin");
    const { rows: invites } = await client.query(
      `select token, tenant_id from tenant_invites where email = 'new@x.com' and used_at is null`,
    );
    assert.equal(invites.length, 1);
    await client.query(
      `update tenant_invites set used_at = now() where token = $1`,
      [invites[0].token],
    );
    await client.query("commit");
  } finally {
    await client.end();
  }
});

test("provisioning policies do NOT allow reading another tenant's data", async () => {
  const client = await freshDb();
  try {
    const tenantId = await withProvisioning(client, "seed-user", async (c) => {
      const { rows } = await c.query(`insert into tenants (name) values ('Household B') returning id`);
      return rows[0].id;
    });
    await withTenant(client, tenantId, "owner-sub", async (c) => {
      await c.query(`insert into transactions (tenant_id, date, amount) values ($1, '2026-01-01', 10)`, [tenantId]);
    });
    // No app.tenant_id set - transactions has no provisioning carve-out, so this must see nothing.
    const { rows } = await client.query(`select * from transactions`);
    assert.equal(rows.length, 0);
  } finally {
    await client.end();
  }
});
```

Note: every "create the first tenant" fixture above uses `withProvisioning` (Task 1), never `withTenant(client, "<placeholder>", ...)` — see `withProvisioning`'s doc comment in Task 1 for exactly why a placeholder tenant-id string breaks (a hard `::uuid` cast error) where leaving `app.tenant_id` genuinely unset does not (evaluates to `NULL`, which the permissive `tenants_provisioning_insert` policy correctly ORs past).

- [ ] **Step 2: Run it to confirm it fails**

```bash
docker compose -f ../db/docker-compose.yml up -d  # if not already running
node --test test/provisioning.test.js
```

Expected: FAIL on the first test — `new row violates row-level security policy for table "tenants"` (the existing `tenants_isolation` policy is `FOR ALL`, which includes INSERT, and requires `id = current_setting(...)::uuid` — impossible to satisfy for a row whose `id` doesn't exist yet).

- [ ] **Step 3: Fix `db/schema.sql`**

Find the tenants/tenant_users/tenant_invites policy block:

```sql
create policy tenant_users_isolation on tenant_users
  using (tenant_id = current_setting('app.tenant_id', true)::uuid);
create policy tenants_isolation on tenants
  using (id = current_setting('app.tenant_id', true)::uuid);
create policy tenant_invites_isolation on tenant_invites
  using (tenant_id = current_setting('app.tenant_id', true)::uuid);
```

Replace it with:

```sql
-- Steady-state access: scoped strictly to the caller's own tenant. These
-- policies default to FOR ALL (every command), which is what every query
-- in the codebase EXCEPT postConfirmation.js's provisioning path runs
-- under - that path is the only code that ever runs without app.tenant_id
-- set, and the three provisioning-specific policies below are the only
-- carve-outs from this isolation, scoped as narrowly as the bootstrap
-- problem allows.
create policy tenant_users_isolation on tenant_users
  using (tenant_id = current_setting('app.tenant_id', true)::uuid);
create policy tenants_isolation on tenants
  using (id = current_setting('app.tenant_id', true)::uuid);
create policy tenant_invites_isolation on tenant_invites
  using (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- Provisioning bootstrap (see backend/src/db.js's runProvisioningTransaction
-- and backend/src/postConfirmation.js): creating a brand-new tenant or
-- consuming an invite happens before any tenant_id is knowable. Safe only
-- because Postgres here is reached exclusively by our own backend code
-- (via the RDS Data API), never directly by end users - the real
-- authorization boundary is "which Lambda code path runs this query", the
-- same trust model the RDS Data API access pattern already relies on
-- everywhere else in this schema.
create policy tenants_provisioning_insert on tenants
  for insert with check (true);
create policy tenant_users_provisioning_insert on tenant_users
  for insert with check (true);
create policy tenant_invites_provisioning_select on tenant_invites
  for select using (true);
create policy tenant_invites_provisioning_update on tenant_invites
  for update using (true);
```

- [ ] **Step 4: Run it again to confirm it still fails, then add FORCE**

At this point `alter table tenants enable row level security;` etc. are already present, but since `DbCluster`'s master user OWNS these tables, RLS is currently a no-op for it regardless of the policies just added — so the third test ("provisioning policies do NOT allow reading another tenant's data") will currently FAIL (it'll see the row, because RLS isn't actually enforced yet against the owner). This is expected and is exactly the Task 3 bug — leave it failing for now; Task 3 makes it pass. Confirm the first two tests pass and the third fails for the *documented* reason:

```bash
node --test test/provisioning.test.js
```

Expected: 2 pass, 1 fail (the isolation one — that's Task 3's job).

- [ ] **Step 5: Refactor `db.js` to add `runProvisioningTransaction`**

Replace the body of `Expense_tracker_New/backend/src/db.js` from `export async function runInTenantTransaction` through its closing brace with:

```js
async function withDataApiTransaction(setup, fn) {
  const { transactionId } = await client.send(
    new BeginTransactionCommand({ resourceArn, secretArn, database }),
  );
  const execute = async (sql, params = {}) =>
    client.send(
      new ExecuteStatementCommand({
        resourceArn,
        secretArn,
        database,
        transactionId,
        sql,
        parameters: toParams(params),
        includeResultMetadata: true,
      }),
    );
  execute.rows = async (sql, params = {}) => recordsToObjects(await execute(sql, params));
  try {
    await setup(execute);
    const result = await fn(execute);
    await client.send(new CommitTransactionCommand({ resourceArn, secretArn, transactionId }));
    return result;
  } catch (err) {
    await client
      .send(new RollbackTransactionCommand({ resourceArn, secretArn, transactionId }))
      .catch(() => {});
    throw err;
  }
}

/** Runs `fn(execute)` inside one Data API transaction, tenant-scoped via
    session GUCs. See the top-of-file comment for why every tenant-table
    query relies on this having run first. */
export async function runInTenantTransaction(tenantId, userSub, fn) {
  return withDataApiTransaction(async (execute) => {
    await execute(`select set_config('app.tenant_id', :tenantId, true)`, {
      tenantId: String(tenantId),
    });
    await execute(`select set_config('app.user_id', :userSub, true)`, {
      userSub: String(userSub),
    });
  }, fn);
}

/** The ONLY other way into a transaction against these tables - used
    exclusively by postConfirmation.js, which by definition runs before any
    tenant_id exists to scope to. Relies on the narrow "provisioning"
    policies in db/schema.sql (tenants/tenant_users INSERT, tenant_invites
    SELECT/UPDATE), not on app.tenant_id being set at all - deliberately
    does NOT set it, so any query here that isn't covered by one of those
    specific policies correctly sees/changes nothing. */
export async function runProvisioningTransaction(userSub, fn) {
  return withDataApiTransaction(async (execute) => {
    await execute(`select set_config('app.user_id', :userSub, true)`, {
      userSub: String(userSub),
    });
  }, fn);
}
```

- [ ] **Step 6: Update `postConfirmation.js` to use it**

In `Expense_tracker_New/backend/src/postConfirmation.js`, change the import:

```js
import { runProvisioningTransaction } from "./db.js";
```

And change the call site in `resolveTenant`:

```js
return runProvisioningTransaction(sub, async (execute) => {
```

(replacing the old `return runInTenantTransaction("__provisioning__", sub, async (execute) => {`). Also delete the comment block above that line that explains the `"__provisioning__"` placeholder and "relies on TenantAdmin policies being permissive" — it's no longer accurate; replace it with:

```js
  // Runs with NO app.tenant_id set at all - there is no tenant yet. Relies
  // entirely on the narrow provisioning-* policies in db/schema.sql; see
  // db.js's runProvisioningTransaction for why this is the one legitimate
  // caller of that carve-out.
```

- [ ] **Step 7: Run the provisioning tests again**

```bash
node --test test/provisioning.test.js
```

Expected: the first two PASS (unchanged); the third still FAILS — that's correct, it's Task 3's fix, not this task's.

- [ ] **Step 8: Commit**

```bash
git add Expense_tracker_New/db/schema.sql Expense_tracker_New/backend/src/db.js Expense_tracker_New/backend/src/postConfirmation.js Expense_tracker_New/backend/test/provisioning.test.js
git commit -m "fix: add explicit RLS bootstrap policies for tenant/invite provisioning"
```

---

### Task 3: Close the RLS owner-bypass gap

**Context:** As found while writing Task 2: Postgres table owners bypass their own RLS policies unless `FORCE ROW LEVEL SECURITY` is set, and the Lambdas connect as the table-owning master user. Every `alter table X enable row level security;` in `db/schema.sql` is currently unenforced for the app's own connection. This task fixes it and proves it with a cross-tenant isolation test on the four "business" tables.

**Files:**
- Modify: `Expense_tracker_New/db/schema.sql`
- Create: `Expense_tracker_New/backend/test/rls.test.js`

**Interfaces:**
- Consumes: `freshDb`, `withTenant` from `./pg-harness.js` (Task 1)

- [ ] **Step 1: Write the failing test**

`Expense_tracker_New/backend/test/rls.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { freshDb, withTenant, withProvisioning } from "./pg-harness.js";

async function seedTenant(client, name) {
  return withProvisioning(client, "seed-user", async (c) => {
    const { rows } = await c.query(`insert into tenants (name) values ($1) returning id`, [name]);
    return rows[0].id;
  });
}

test("a tenant cannot see another tenant's transactions", async () => {
  const client = await freshDb();
  try {
    const tenantA = await seedTenant(client, "Household A");
    const tenantB = await seedTenant(client, "Household B");

    await withTenant(client, tenantA, "a-user", async (c) => {
      await c.query(`insert into transactions (tenant_id, date, amount) values ($1, '2026-01-01', 100)`, [tenantA]);
    });
    await withTenant(client, tenantB, "b-user", async (c) => {
      await c.query(`insert into transactions (tenant_id, date, amount) values ($1, '2026-01-01', 200)`, [tenantB]);
    });

    const seenByA = await withTenant(client, tenantA, "a-user", async (c) => {
      const { rows } = await c.query(`select amount from transactions`);
      return rows;
    });
    assert.equal(seenByA.length, 1);
    assert.equal(Number(seenByA[0].amount), 100);
  } finally {
    await client.end();
  }
});

test("a tenant cannot insert a row tagged with a different tenant_id", async () => {
  const client = await freshDb();
  try {
    const tenantA = await seedTenant(client, "Household C");
    const tenantB = await seedTenant(client, "Household D");
    await assert.rejects(
      withTenant(client, tenantA, "a-user", async (c) => {
        await c.query(`insert into transactions (tenant_id, date, amount) values ($1, '2026-01-01', 50)`, [tenantB]);
      }),
      /row-level security/,
    );
  } finally {
    await client.end();
  }
});

test("no session context at all sees zero rows across every business table", async () => {
  const client = await freshDb();
  try {
    const tenantA = await seedTenant(client, "Household E");
    await withTenant(client, tenantA, "a-user", async (c) => {
      await c.query(`insert into transactions (tenant_id, date, amount) values ($1, '2026-01-01', 10)`, [tenantA]);
      await c.query(`insert into budget (tenant_id, year, category, month, amount) values ($1, 2026, 'Groceries', 1, 500)`, [tenantA]);
      await c.query(`insert into balances (tenant_id, date, account, amount) values ($1, '2026-01-01', 'Chequing', 1000)`, [tenantA]);
      await c.query(`insert into debts (tenant_id, name, amount) values ($1, 'Car loan', 5000)`, [tenantA]);
    });
    for (const table of ["transactions", "budget", "balances", "debts"]) {
      const { rows } = await client.query(`select * from ${table}`);
      assert.equal(rows.length, 0, `${table} should be invisible with no session context set`);
    }
  } finally {
    await client.end();
  }
});
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
node --test test/rls.test.js
```

Expected: FAIL on all three tests — with FORCE not yet set, the owner sees every tenant's rows and can insert mismatched `tenant_id` values freely.

- [ ] **Step 3: Add `FORCE ROW LEVEL SECURITY`**

In `Expense_tracker_New/db/schema.sql`, after each of the seven `alter table X enable row level security;` lines, add the matching `force` line. There are seven: `tenants`, `tenant_users`, `tenant_invites` (from Task 2's section) and `transactions`, `budget`, `balances`, `debts`. For example:

```sql
alter table tenants enable row level security;
alter table tenants force row level security;
alter table tenant_users enable row level security;
alter table tenant_users force row level security;
alter table tenant_invites enable row level security;
alter table tenant_invites force row level security;
```

and further down:

```sql
alter table transactions enable row level security;
alter table transactions force row level security;
```

```sql
alter table budget enable row level security;
alter table budget force row level security;
```

```sql
alter table balances enable row level security;
alter table balances force row level security;
```

```sql
alter table debts enable row level security;
alter table debts force row level security;
```

- [ ] **Step 4: Run the RLS tests again**

```bash
node --test test/rls.test.js
```

Expected: PASS, all three.

- [ ] **Step 5: Re-run the provisioning tests from Task 2 to confirm they still all pass**

```bash
node --test test/provisioning.test.js
```

Expected: PASS, all three (the third one — "provisioning policies do NOT allow reading another tenant's data" — now passes because FORCE is in effect).

- [ ] **Step 6: Run the full test suite**

```bash
npm test
```

Expected: all tests across `pg-harness.test.js`, `provisioning.test.js`, `rls.test.js` PASS.

- [ ] **Step 7: Commit**

```bash
git add Expense_tracker_New/db/schema.sql Expense_tracker_New/backend/test/rls.test.js
git commit -m "fix: force RLS so the owner-credentialed backend connection is actually scoped"
```

---

### Task 4: `auth.js` — testable JWT verification

**Files:**
- Modify: `Expense_tracker_New/backend/src/auth.js`
- Create: `Expense_tracker_New/backend/test/auth.test.js`

**Interfaces:**
- Produces: `createAuthChecker(verifier: { verify(token: string): Promise<object> }): (event) => Promise<{sub, email, tenantId}>` — factory so tests can inject a fake verifier instead of hitting Cognito's real JWKS endpoint.
- Produces: `requireUser` — unchanged export name/signature, now built via `createAuthChecker(realCognitoVerifier)`. `handler.js`'s existing `import { requireUser, AuthError } from "./auth.js"` needs no changes.

- [ ] **Step 1: Write the failing test**

`Expense_tracker_New/backend/test/auth.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createAuthChecker, AuthError } from "../src/auth.js";

function fakeVerifier(claims) {
  return {
    verify: async (token) => {
      if (token !== "valid-token") throw new Error("signature verification failed");
      return claims;
    },
  };
}

test("throws AuthError with no Authorization header", async () => {
  const requireUser = createAuthChecker(fakeVerifier({}));
  await assert.rejects(requireUser({ headers: {} }), AuthError);
});

test("throws AuthError on an invalid token", async () => {
  const requireUser = createAuthChecker(fakeVerifier({}));
  await assert.rejects(
    requireUser({ headers: { authorization: "Bearer garbage" } }),
    AuthError,
  );
});

test("throws AuthError when the token has no tenant claim and no X-Tenant-Id header", async () => {
  const requireUser = createAuthChecker(
    fakeVerifier({ sub: "u1", email: "a@x.com" }),
  );
  await assert.rejects(
    requireUser({ headers: { authorization: "Bearer valid-token" } }),
    AuthError,
  );
});

test("resolves sub/email/tenantId from a valid token's custom:tenant_id claim", async () => {
  const requireUser = createAuthChecker(
    fakeVerifier({ sub: "u1", email: "a@x.com", "custom:tenant_id": "t1" }),
  );
  const user = await requireUser({ headers: { authorization: "Bearer valid-token" } });
  assert.deepEqual(user, { sub: "u1", email: "a@x.com", tenantId: "t1" });
});

test("an X-Tenant-Id header overrides the token's own tenant claim", async () => {
  const requireUser = createAuthChecker(
    fakeVerifier({ sub: "u1", email: "a@x.com", "custom:tenant_id": "t1" }),
  );
  const user = await requireUser({
    headers: { authorization: "Bearer valid-token", "x-tenant-id": "t2" },
  });
  assert.equal(user.tenantId, "t2");
});
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
node --test test/auth.test.js
```

Expected: FAIL — `createAuthChecker` is not exported yet.

- [ ] **Step 3: Refactor `auth.js`**

Replace the full contents of `Expense_tracker_New/backend/src/auth.js` with:

```js
/* Verifies the Cognito ID token the frontend sends as `Authorization:
   Bearer <token>`, and resolves which tenant the caller is acting as.

   This is the server-mediated backend's equivalent of Code.gs's
   requireUser() — called unconditionally at the top of every request in
   handler.js, exactly the same "always-on gate" shape the security review
   in Security_Analysis.md validated for the Sheets/Supabase backends. */

import { CognitoJwtVerifier } from "aws-jwt-verify";

export class AuthError extends Error {}

/** Factory so tests can inject a fake verifier instead of hitting Cognito's
    real JWKS endpoint over the network - see backend/test/auth.test.js.
    Production wiring (the exported `requireUser` below) is the only
    caller that passes the real CognitoJwtVerifier. */
export function createAuthChecker(verifier) {
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

    // Which tenant this request acts as. A user can belong to more than one
    // tenant (tenant_users has no uniqueness constraint on user_sub alone),
    // so the active one is either explicit (X-Tenant-Id header, validated
    // against membership by the caller) or the token's own default claim set
    // at signup — see postConfirmation.js. Route modules never accept a
    // tenant id from the request body; only from here.
    const requestedTenantId = event.headers?.["x-tenant-id"];
    const tenantId = requestedTenantId || claims["custom:tenant_id"];
    if (!tenantId) throw new AuthError("No tenant associated with this user.");

    return {
      sub: claims.sub,
      email: claims.email,
      tenantId,
    };
  };
}

const verifier = CognitoJwtVerifier.create({
  userPoolId: process.env.COGNITO_USER_POOL_ID,
  tokenUse: "id",
  clientId: process.env.COGNITO_CLIENT_ID,
});

export const requireUser = createAuthChecker(verifier);
```

- [ ] **Step 4: Run the tests again**

```bash
node --test test/auth.test.js
```

Expected: PASS, all five.

- [ ] **Step 5: `node --check` the whole backend to confirm nothing else broke**

```bash
for f in src/*.js src/routes/*.js; do node --check "$f" || echo "FAIL: $f"; done
```

Expected: no FAIL lines.

- [ ] **Step 6: Commit**

```bash
git add Expense_tracker_New/backend/src/auth.js Expense_tracker_New/backend/test/auth.test.js
git commit -m "refactor: make auth.js's JWT check testable via an injectable verifier"
```

---

### Task 5: `db.js` — transaction sequencing unit tests

**Files:**
- Create: `Expense_tracker_New/backend/test/db.test.js`

**Interfaces:**
- Consumes: `runInTenantTransaction`, `runProvisioningTransaction` from `../src/db.js` (Task 2)
- No production code changes — `RDSDataClient.prototype.send` is mocked directly, so `db.js` needs no dependency-injection refactor.

- [ ] **Step 1: Write the tests**

`Expense_tracker_New/backend/test/db.test.js`:

```js
import { test, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { RDSDataClient } from "@aws-sdk/client-rds-data";
import { runInTenantTransaction, runProvisioningTransaction } from "../src/db.js";

let calls;

beforeEach(() => {
  calls = [];
  mock.method(RDSDataClient.prototype, "send", async (command) => {
    calls.push(command.constructor.name);
    if (command.constructor.name === "BeginTransactionCommand")
      return { transactionId: "tx-1" };
    if (command.constructor.name === "ExecuteStatementCommand")
      return { records: [], columnMetadata: [] };
    return {};
  });
});

afterEach(() => {
  mock.restoreAll();
});

test("runInTenantTransaction sets tenant_id then user_id before calling fn, then commits", async () => {
  const order = [];
  await runInTenantTransaction("tenant-1", "user-1", async () => {
    order.push("fn");
  });
  assert.deepEqual(calls, [
    "BeginTransactionCommand",
    "ExecuteStatementCommand", // set_config app.tenant_id
    "ExecuteStatementCommand", // set_config app.user_id
    "CommitTransactionCommand",
  ]);
  assert.deepEqual(order, ["fn"]);
});

test("runInTenantTransaction rolls back if fn throws", async () => {
  await assert.rejects(
    runInTenantTransaction("tenant-1", "user-1", async () => {
      throw new Error("boom");
    }),
    /boom/,
  );
  assert.ok(calls.includes("RollbackTransactionCommand"));
  assert.ok(!calls.includes("CommitTransactionCommand"));
});

test("runProvisioningTransaction only sets user_id, never tenant_id", async () => {
  await runProvisioningTransaction("user-1", async () => {});
  const executeCalls = calls.filter((c) => c === "ExecuteStatementCommand");
  assert.equal(executeCalls.length, 1); // just the one set_config(app.user_id, ...) call
});
```

- [ ] **Step 2: Run them**

```bash
node --test test/db.test.js
```

Expected: PASS, all three, immediately (no implementation change needed — `db.js`'s existing structure from Task 2 already supports this).

- [ ] **Step 3: Commit**

```bash
git add Expense_tracker_New/backend/test/db.test.js
git commit -m "test: cover db.js's transaction sequencing with a mocked RDS Data client"
```

---

### Task 6: Membership & invites — backend route

**Files:**
- Create: `Expense_tracker_New/backend/src/routes/tenants.js`
- Modify: `Expense_tracker_New/backend/src/handler.js`
- Create: `Expense_tracker_New/backend/test/tenants-route.test.js`
- Create: `Expense_tracker_New/backend/test/handler-gating.test.js`

**Interfaces:**
- Produces (`routes/tenants.js`): `getMembership(execute, userSub): Promise<{role}|null>`, `listMembers(execute): Promise<Array<{user_sub,email,role,created_at}>>`, `listPendingInvites(execute): Promise<Array<{token,email,role,created_at,expires_at}>>`, `createInvite(execute, {email, role}): Promise<{token,email,role,expires_at}>`, `revokeInvite(execute, token): Promise<void>`.
- Produces (`handler.js`): `assertManagesInvites(membership)` — throws unless `membership?.role` is `"owner"` or `"admin"`.
- Consumes: `freshDb`, `withTenant` from `./pg-harness.js` (Task 1).

- [ ] **Step 1: Write the failing route test**

`Expense_tracker_New/backend/test/tenants-route.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { freshDb, withProvisioning } from "./pg-harness.js";
import * as tenants from "../src/routes/tenants.js";

test("listMembers/getMembership/createInvite/revokeInvite round-trip", async () => {
  const client = await freshDb();
  try {
    const tenantId = await withProvisioning(client, "seed-user", async (c) => {
      const { rows } = await c.query(`insert into tenants (name) values ('Household') returning id`);
      return rows[0].id;
    });

    const execute = async (sql, params = {}) => {
      const namedToPositional = [];
      const converted = sql.replace(/:(\w+)/g, (_, name) => {
        namedToPositional.push(params[name]);
        return `$${namedToPositional.length}`;
      });
      return client.query(converted, namedToPositional);
    };
    execute.rows = async (sql, params) => (await execute(sql, params)).rows;

    await client.query("begin");
    await client.query("select set_config('app.tenant_id', $1, true)", [String(tenantId)]);
    await client.query("select set_config('app.user_id', $1, true)", ["owner-sub"]);

    await execute(
      `insert into tenant_users (user_sub, tenant_id, email, role) values (:sub, :tenantId, :email, 'owner')`,
      { sub: "owner-sub", tenantId, email: "owner@x.com" },
    );

    const membership = await tenants.getMembership(execute, "owner-sub");
    assert.equal(membership.role, "owner");

    const members = await tenants.listMembers(execute);
    assert.equal(members.length, 1);

    const invite = await tenants.createInvite(execute, { email: "new@x.com", role: "member" });
    assert.equal(invite.email, "new@x.com");
    assert.ok(invite.token);

    const pending = await tenants.listPendingInvites(execute);
    assert.equal(pending.length, 1);

    await tenants.revokeInvite(execute, invite.token);
    const afterRevoke = await tenants.listPendingInvites(execute);
    assert.equal(afterRevoke.length, 0);

    await client.query("commit");
  } finally {
    await client.end();
  }
});
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
node --test test/tenants-route.test.js
```

Expected: FAIL — `../src/routes/tenants.js` doesn't exist yet.

- [ ] **Step 3: Implement `routes/tenants.js`**

`Expense_tracker_New/backend/src/routes/tenants.js`:

```js
/* Membership/invite management for the current tenant. Every function here
   assumes it's called inside an already tenant-scoped transaction (see
   db.js's runInTenantTransaction) - same trust boundary as the other
   routes/*.js modules. Invite creation/consumption across the provisioning
   boundary is handled separately in postConfirmation.js. */

export async function getMembership(execute, userSub) {
  const rows = await execute.rows(
    `select role from tenant_users where user_sub = :userSub`,
    { userSub },
  );
  return rows[0] || null;
}

export async function listMembers(execute) {
  return execute.rows(
    `select user_sub, email, role, created_at from tenant_users order by created_at`,
  );
}

export async function listPendingInvites(execute) {
  return execute.rows(
    `select token, email, role, created_at, expires_at from tenant_invites
     where used_at is null and expires_at > now()
     order by created_at desc`,
  );
}

export async function createInvite(execute, { email, role }) {
  const rows = await execute.rows(
    `insert into tenant_invites (tenant_id, email, role)
     values (current_setting('app.tenant_id', true)::uuid, :email, :role)
     returning token, email, role, expires_at`,
    { email, role: role || "member" },
  );
  return rows[0];
}

export async function revokeInvite(execute, token) {
  await execute(
    `delete from tenant_invites where token = :token and used_at is null`,
    { token },
  );
}
```

- [ ] **Step 4: Run the route test again**

```bash
node --test test/tenants-route.test.js
```

Expected: PASS.

- [ ] **Step 5: Write the failing gating test**

`Expense_tracker_New/backend/test/handler-gating.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertManagesInvites } from "../src/handler.js";

test("throws for a member", () => {
  assert.throws(() => assertManagesInvites({ role: "member" }));
});
test("throws for no membership at all", () => {
  assert.throws(() => assertManagesInvites(null));
});
test("does not throw for an owner", () => {
  assert.doesNotThrow(() => assertManagesInvites({ role: "owner" }));
});
test("does not throw for an admin", () => {
  assert.doesNotThrow(() => assertManagesInvites({ role: "admin" }));
});
```

- [ ] **Step 6: Run it to confirm it fails**

```bash
node --test test/handler-gating.test.js
```

Expected: FAIL — `assertManagesInvites` isn't exported yet.

- [ ] **Step 7: Wire `handler.js`**

Add the import near the other route imports:

```js
import * as tenants from "./routes/tenants.js";
```

Add the gating helper (export it, near the top-level functions, e.g. right after the `json` helper):

```js
export function assertManagesInvites(membership) {
  if (!membership || !["owner", "admin"].includes(membership.role))
    throw new Error("Only owners or admins can manage invites.");
}
```

Replace `handleGet`'s body with:

```js
async function handleGet(user, event) {
  const qs = event.queryStringParameters || {};
  const year = qs.year ? Number(qs.year) : undefined;
  const txYear = qs.txYear !== undefined ? Number(qs.txYear) : undefined;

  return runInTenantTransaction(user.tenantId, user.sub, async (execute) => {
    const [transactions, budgetRows, balanceRows, debtRows, years, membership, members] =
      await Promise.all([
        tx.listTransactions(execute, { txYear }),
        budget.getBudgetRows(execute, year || new Date().getFullYear()),
        balances.listBalances(execute),
        debts.listDebts(execute),
        tx.listTransactionYears(execute),
        tenants.getMembership(execute, user.sub),
        tenants.listMembers(execute),
      ]);
    const role = membership?.role || "member";
    const invites =
      role === "owner" || role === "admin"
        ? await tenants.listPendingInvites(execute)
        : [];
    return {
      ok: true,
      transactions,
      budget: budgetRowsToShape(budgetRows),
      budgetYear: year || new Date().getFullYear(),
      balances: balanceRows,
      debts: debtRows.map(fromDbDebt),
      transactionYearsAvailable: years,
      user: { email: user.email, role },
      members,
      invites,
    };
  });
}
```

In `handlePost`'s `switch (action)`, add two cases (anywhere among the existing ones, e.g. right before `default:`):

```js
      case "createInvite": {
        const membership = await tenants.getMembership(execute, user.sub);
        assertManagesInvites(membership);
        return { ok: true, invite: await tenants.createInvite(execute, payload) };
      }
      case "revokeInvite": {
        const membership = await tenants.getMembership(execute, user.sub);
        assertManagesInvites(membership);
        await tenants.revokeInvite(execute, payload.token);
        return { ok: true };
      }
```

- [ ] **Step 8: Run the gating test again**

```bash
node --test test/handler-gating.test.js
```

Expected: PASS, all four.

- [ ] **Step 9: `node --check` and full suite**

```bash
node --check src/handler.js && node --check src/routes/tenants.js
npm test
```

Expected: no syntax errors; every test file passes.

- [ ] **Step 10: Commit**

```bash
git add Expense_tracker_New/backend/src/routes/tenants.js Expense_tracker_New/backend/src/handler.js Expense_tracker_New/backend/test/tenants-route.test.js Expense_tracker_New/backend/test/handler-gating.test.js
git commit -m "feat: add tenant membership/invite backend route"
```

---

### Task 7: Frontend `store.js` — membership/invite methods

**Files:**
- Modify: `Expense_tracker_New/frontend/assets/store.js`

**Interfaces:**
- Consumes: the enriched GET `/data` response and `createInvite`/`revokeInvite` POST actions from Task 6.
- Produces on `ApiStore`: `getMembers(): Promise<Array>`, `getInvites(): Promise<Array>`, `getRole(): Promise<string>`, `createInvite(email, role): Promise<object>`, `revokeInvite(token): Promise<void>`.
- Produces: `cognitoAuthorizeUrl` gains an optional invite-token parameter — actually implemented in `app.js` (Task 8), not here; this task only adds the cache fields it reads.

- [ ] **Step 1: Extend `_fill()` to cache the new fields**

In `Expense_tracker_New/frontend/assets/store.js`, inside `class ApiStore`'s `_fill(d)` method, add after the existing `this.user = d.user || null;` line:

```js
    this.cache.members = d.members || [];
    this.cache.invites = d.invites || [];
```

- [ ] **Step 2: Add the new methods**

Add these methods to `class ApiStore`, near `getBalances()`/`getDebts()`:

```js
  async getMembers() {
    return (await this._ensure()).members || [];
  }
  async getInvites() {
    return (await this._ensure()).invites || [];
  }
  async getRole() {
    return this.user?.role || "member";
  }
  async createInvite(email, role) {
    const r = await this._post({ action: "createInvite", email, role });
    await this._refreshMeta();
    return r.invite;
  }
  async revokeInvite(token) {
    await this._post({ action: "revokeInvite", token });
    await this._refreshMeta();
  }
```

- [ ] **Step 3: Extend `_refreshMeta()` to also refresh members/invites**

Find `_refreshMeta()` in `class ApiStore` and add two lines:

```js
  async _refreshMeta() {
    if (!this.cache) return;
    const d = await this._get({ txYear: -1 });
    this.cache.budget = d.budget;
    this.cache.budgetYear = d.budgetYear || currentYear();
    this.cache.balances = d.balances || [];
    this.cache.debts = d.debts || [];
    this.cache.members = d.members || [];
    this.cache.invites = d.invites || [];
    this.user = d.user || this.user;
  }
```

- [ ] **Step 4: Syntax-check**

```bash
node --check Expense_tracker_New/frontend/assets/store.js
```

Expected: no output (success).

- [ ] **Step 5: Commit**

```bash
git add Expense_tracker_New/frontend/assets/store.js
git commit -m "feat: add membership/invite methods to ApiStore"
```

---

### Task 8: Frontend `app.js` — Household panel + invite-aware sign-in

**Files:**
- Modify: `Expense_tracker_New/frontend/assets/app.js`

**Interfaces:**
- Consumes: `ApiStore.getMembers/getInvites/getRole/createInvite/revokeInvite` (Task 7).

- [ ] **Step 1: Make `cognitoAuthorizeUrl` invite-aware**

Find `cognitoAuthorizeUrl()` (added when the sign-in gate was first rewritten) and replace it with a version that accepts an optional token and forwards it as Cognito's `client_metadata` query param, which Cognito passes through to `postConfirmation.js`'s `event.request.clientMetadata`:

```js
function cognitoAuthorizeUrl(inviteToken) {
  const { domain, clientId } = getCognitoConfig();
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "token",
    scope: "openid email profile",
    redirect_uri: location.origin + location.pathname,
    identity_provider: "Google",
  });
  if (inviteToken)
    params.set("client_metadata", JSON.stringify({ inviteToken }));
  return `https://${domain}/oauth2/authorize?${params}`;
}
```

Find where `showGate()` wires up the click handler:

```js
  $("#cognito-signin").onclick = () => {
    location.href = cognitoAuthorizeUrl();
  };
```

Replace with a version that reads an invite token from the URL if present (e.g. someone followed an invite link like `.../#invite=abc123`):

```js
  $("#cognito-signin").onclick = () => {
    const inviteMatch = location.hash.match(/invite=([\w-]+)/);
    location.href = cognitoAuthorizeUrl(inviteMatch?.[1]);
  };
```

- [ ] **Step 2: Populate `state.members`/`state.invites`/`state.role` in `refresh()`, then add a "Household" panel to the Data tab**

Every other view function in this codebase reads data through top-level `state.*` fields that `refresh()` populates (`state.rows`, `state.budget`, `state.balances`, `state.debts`) — never through `state.store.cache` directly, which is a private implementation detail of `ApiStore` that `LocalStore`/`MemoryStore` don't even have. Follow that same pattern here rather than reading `state.store.cache` from a render function.

Find `refresh()` in `app.js` and add three lines immediately after the existing `state.debts = (await state.store.getDebts?.()) || [];` line:

```js
  state.members = (await state.store.getMembers?.()) || [];
  state.invites = (await state.store.getInvites?.()) || [];
  state.role = (await state.store.getRole?.()) || "member";
```

(The `?.()` optional-call matches the existing `getBalances?.()`/`getDebts?.()` lines exactly — `LocalStore`/`MemoryStore` don't implement `getMembers`/`getInvites`/`getRole` at all, so these correctly no-op to `undefined` → `[]`/`"member"` for those backends, the same graceful-degradation the balances/debts lines already rely on.)

In `renderData()`, after the closing `</div>` of the "People" panel and before the "Danger zone" `eyebrow`, insert a new panel. First read the current members/invites/role at the top of `renderData()` — add these lines right after the existing `const who = state.store.user?.email || "";`:

```js
  const members = state.members || [];
  const invites = state.invites || [];
  const myRole = state.role || "member";
  const canManageInvites = myRole === "owner" || myRole === "admin";
```

Then insert this block into the template literal (right before the `<div class="eyebrow">Danger zone</div>` line):

```html
  <div class="eyebrow">Household</div>
  <div class="panel stack">
    <p class="note" style="margin:0">Your role: <b>${esc(myRole)}</b>. ${members.length} member${members.length === 1 ? "" : "s"}.</p>
    <ul class="stack" style="margin:0;padding-left:1.2em">
      ${members.map((m) => `<li>${esc(m.email)} — ${esc(m.role)}</li>`).join("")}
    </ul>
    ${
      canManageInvites
        ? `
    <div class="stack" style="max-width:420px">
      <label class="f"><span>Invite by email</span>
        <input id="invite-email" type="email" placeholder="name@example.com"></label>
      <div class="actions"><button class="btn" id="send-invite">Send invite</button></div>
    </div>
    ${
      invites.length
        ? `<p class="note" style="margin:0">Pending invites:</p>
    <ul class="stack" style="margin:0;padding-left:1.2em">
      ${invites
        .map(
          (inv) => `<li>${esc(inv.email)}
            <button class="btn ghost" data-copy-invite="${esc(inv.token)}">Copy link</button>
            <button class="btn ghost" data-revoke-invite="${esc(inv.token)}">Revoke</button></li>`,
        )
        .join("")}
    </ul>`
        : ""
    }`
        : ""
    }
  </div>
```

- [ ] **Step 3: Wire the new panel's handlers**

After `createInvite`/`revokeInvite` succeed, also refresh the top-level state so the panel re-renders with current data (both handlers below call `renderData()` after a successful `withBusy`, but `renderData()` itself doesn't call `refresh()` — add a `await refresh();` before `renderData();` in both success branches so `state.members`/`state.invites` are current, not stale from before the invite was sent/revoked).

Immediately after the existing `$("#data-signout")?.addEventListener("click", signOut);` line in `renderData()`, add:

```js
  $("#send-invite")?.addEventListener("click", async () => {
    const email = $("#invite-email").value.trim();
    if (!email) return notice("Enter an email address.", "bad");
    const done = await withBusy("Sending invite", async () => {
      await state.store.createInvite(email, "member");
      await refresh();
    });
    if (done) {
      notice(`Invited ${email}.`, "ok");
      renderData();
    }
  });

  view.querySelectorAll("[data-copy-invite]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const token = btn.dataset.copyInvite;
      const link = `${location.origin}${location.pathname}#invite=${token}`;
      await navigator.clipboard.writeText(link);
      notice("Invite link copied.", "ok");
    });
  });

  view.querySelectorAll("[data-revoke-invite]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const token = btn.dataset.revokeInvite;
      const done = await withBusy("Revoking invite", async () => {
        await state.store.revokeInvite(token);
        await refresh();
      });
      if (done) {
        notice("Invite revoked.", "ok");
        renderData();
      }
    });
  });
```

- [ ] **Step 4: Syntax-check and manual smoke test**

```bash
node --check Expense_tracker_New/frontend/assets/app.js
node --check Expense_tracker_New/frontend/assets/store.js
```

Expected: no output. Manual check (no automated frontend tests in this plan, matching the original repo's zero-build/zero-test-runner approach): serve `Expense_tracker_New/frontend/` locally (`python3 -m http.server 8080` from that directory) and confirm the Data tab renders without a console error even with `API_ENDPOINT` blank (falls through to `LocalStore`, which has no `getMembers`/`getInvites`/`getRole` methods, so `refresh()`'s `?.()` calls correctly no-op and `state.members`/`state.invites`/`state.role` default to `[]`/`[]`/`"member"`).

- [ ] **Step 5: Commit**

```bash
git add Expense_tracker_New/frontend/assets/app.js Expense_tracker_New/frontend/assets/store.js
git commit -m "feat: add Household member/invite panel to the Data tab"
```

---

### Task 9: CI workflow

**Files:**
- Create: `.github/workflows/ledger-new-ci.yml`

- [ ] **Step 1: Write the workflow**

```yaml
name: Ledger New — CI

on:
  push:
    paths:
      - "Expense_tracker_New/**"
      - ".github/workflows/ledger-new-ci.yml"
  pull_request:
    paths:
      - "Expense_tracker_New/**"

jobs:
  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:15
        env:
          POSTGRES_USER: ledger_test
          POSTGRES_PASSWORD: ledger_test
          POSTGRES_DB: ledger_test
        ports:
          - 5433:5432
        options: >-
          --health-cmd pg_isready
          --health-interval 5s
          --health-timeout 5s
          --health-retries 10
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
      - name: Syntax-check every JS file
        run: |
          for f in $(find Expense_tracker_New -name '*.js' -not -path '*/node_modules/*'); do
            node --check "$f" || exit 1
          done
      - name: Install backend dependencies
        working-directory: Expense_tracker_New/backend
        run: npm install
      - name: Run backend tests
        working-directory: Expense_tracker_New/backend
        run: npm test
      - name: SAM build (validates template.yaml)
        working-directory: Expense_tracker_New/backend
        run: |
          pip install aws-sam-cli
          sam build

  deploy:
    # Deliberately manual, not triggered by push — this deploys real AWS
    # infrastructure and needs GoogleClientId/GoogleClientSecret/FrontendUrl
    # supplied as real secrets first (see Expense_tracker_New/README.md).
    # Wire this up once those secrets exist in repo settings; left as a
    # manual trigger here rather than guessing credential names.
    if: false
    needs: test
    runs-on: ubuntu-latest
    steps:
      - run: echo "Deploy gate intentionally disabled until AWS credentials/secrets are configured."
```

- [ ] **Step 2: Verify the YAML is well-formed**

```bash
python3 -c "import json,sys; import yaml" 2>/dev/null && python3 -c "
import yaml
with open('.github/workflows/ledger-new-ci.yml') as f:
    yaml.safe_load(f)
print('OK')
" || echo "pyyaml not available locally — will be validated by GitHub Actions on push"
```

Expected: `OK`, or the fallback message if `pyyaml` isn't installed locally (the workflow syntax will still be validated by GitHub itself on push).

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ledger-new-ci.yml
git commit -m "ci: add test/build workflow for Expense_tracker_New"
```

---

### Task 10: Data migration script

**Files:**
- Create: `Expense_tracker_New/backend/migrate-to-api.mjs`

**Context:** Reads the existing household's data from the original repo's Google Sheets backend (`Code.gs`) — the household's actual current backend per `CLAUDE.md`; the Supabase path was a parallel experiment, not what's live — creates "tenant #1" via a one-off admin call, and posts every transaction/budget/balance/debt row through the new API's existing actions (`bulk`, `setBudget`, `setBalances`, `importDebts`). This intentionally reuses the API's own write paths rather than writing directly to Postgres, so the migrated data goes through the exact same validation (`normalise()`-equivalent) production writes do.

- [ ] **Step 1: Write the script**

`Expense_tracker_New/backend/migrate-to-api.mjs`:

```js
#!/usr/bin/env node
/* One-time migration: pulls all data from the ORIGINAL repo's Google
   Sheets backend (Code.gs) and pushes it into the new API as tenant #1.

   Usage:
     node migrate-to-api.mjs \
       --source-endpoint=<original Sheets Apps Script /exec URL> \
       --api-endpoint=<new API base URL> \
       --id-token=<a valid Cognito ID token for the target tenant's owner>

   Run this AFTER the owner has signed up once through the new frontend
   (so a tenant + owner tenant_users row already exist) — this script does
   not create tenants itself, it only writes transactions/budget/balances/
   debts into whichever tenant the given id-token belongs to. */

import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    "source-endpoint": { type: "string" },
    "api-endpoint": { type: "string" },
    "id-token": { type: "string" },
  },
});

for (const required of ["source-endpoint", "api-endpoint", "id-token"]) {
  if (!args[required]) {
    console.error(`Missing --${required}`);
    process.exit(1);
  }
}

async function fetchSourceData() {
  const url = `${args["source-endpoint"]}?idToken=${encodeURIComponent(args["id-token"])}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Source Sheets endpoint responded ${res.status}`);
  return res.json();
}

async function postToApi(action, body) {
  const res = await fetch(`${args["api-endpoint"]}/data`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${args["id-token"]}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ action, ...body }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`${action} failed: ${data.error}`);
  return data;
}

async function main() {
  console.log("Fetching source data...");
  const source = await fetchSourceData();
  console.log(`Fetched ${source.transactions?.length || 0} transactions.`);

  if (source.transactions?.length) {
    const CHUNK = 500;
    for (let i = 0; i < source.transactions.length; i += CHUNK) {
      const chunk = source.transactions.slice(i, i + CHUNK);
      const { inserted } = await postToApi("bulk", { records: chunk });
      console.log(`Inserted ${inserted} (batch ${i / CHUNK + 1}).`);
    }
  }

  if (source.budget) {
    await postToApi("setBudget", {
      budget: source.budget,
      year: source.budgetYear || new Date().getFullYear(),
    });
    console.log("Budget migrated.");
  }

  if (source.balances?.length) {
    const byDate = {};
    for (const b of source.balances) (byDate[b.date] ||= []).push(b);
    for (const [date, entries] of Object.entries(byDate))
      await postToApi("setBalances", { date, entries });
    console.log(`Balances migrated (${Object.keys(byDate).length} snapshot dates).`);
  }

  if (source.debts?.length) {
    const { debts, payments, skipped } = await postToApi("importDebts", {
      records: source.debts,
    });
    console.log(`Debts migrated: ${debts} debts, ${payments} payments, ${skipped} skipped.`);
  }

  console.log("Migration complete.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Syntax-check**

```bash
node --check Expense_tracker_New/backend/migrate-to-api.mjs
```

Expected: no output.

- [ ] **Step 3: Dry-run against local test data (manual, no automated test)**

This script talks to real external services (the original Sheets/Supabase backend, and the new deployed API) by design — there's nothing meaningful to unit-test here beyond the syntax check above. Verify manually once Task 9's `deploy` job (or a manual `sam deploy`) has produced a real `--api-endpoint`, by running against a couple of hand-entered rows first, matching how the original repo's own `migrate.mjs` was verified (see the memory of exact-match verification against the Sheets dashboard: Income $80,214.45, Expense $43,222.74, 1,077 entries — repeat that same total-matching check here after migrating for real).

- [ ] **Step 4: Commit**

```bash
git add Expense_tracker_New/backend/migrate-to-api.mjs
git commit -m "feat: add data migration script from the original backend to the new API"
```

---

## Self-Review Notes

- **Spec coverage:** Tests (Tasks 1–6, including the RLS bootstrap bug found and fixed), CI/CD (Task 9), migration script (Task 10), multi-tenant UI pass (Tasks 6 backend + 7–8 frontend, with tenant-switching explicitly deferred per Global Constraints) — all four in-scope items are covered. Billing has no task, by design.
- **Ordering:** Tasks 1–5 (test infra + RLS fixes + auth/db unit tests) precede Task 6 (the `tenant_invites` route), which precedes Tasks 7–8 (frontend UI that depends on it). Tasks 9–10 come after tests exist, as requested; they don't depend on each other and could run in parallel if split across two workers.
- **Type/interface consistency check:** `routes/tenants.js`'s exports (`getMembership`, `listMembers`, `listPendingInvites`, `createInvite`, `revokeInvite`) are used with matching names/argument order in `handler.js` (Task 6), and `ApiStore`'s new methods (Task 7) match the actions those handler cases accept (`createInvite`/`revokeInvite`). `assertManagesInvites` is defined once (Task 6) and imported nowhere else — used inline in the same file, consistent with the test in the same task.
