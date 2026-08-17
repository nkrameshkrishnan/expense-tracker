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

// Arbitrary constant identifying this harness's schema-rebuild critical
// section for pg_advisory_lock. Any bigint works; it just needs to be
// unique enough not to collide with a lock some other tool in this
// database happens to use (nothing else here uses advisory locks).
const SCHEMA_REBUILD_LOCK_KEY = 72700118;

/** Connects to the local test Postgres, drops and recreates the public
    schema, applies db/schema.sql fresh, and returns a connected client.
    Callers must call client.end() when done.

    node:test runs multiple test FILES concurrently as separate processes
    by default (test-isolation=process), and every test file calls
    freshDb() against the same shared local Postgres instance. Without
    serialization, one file's `drop schema public cascade` can fire while
    another file's freshDb() caller is still mid-test against tables that
    call just dropped out from under it - corrupting results (and, worse,
    leaving a half-broken connection that never cleanly resolves,
    appearing to hang `node --test` indefinitely rather than failing
    fast). pg_advisory_lock is session-scoped and automatically released
    when the session ends, so acquiring it here - before the destructive
    DROP/CREATE - and holding it for the connection's entire lifetime (not
    just through schema setup) serializes whole freshDb()-using test
    bodies across concurrent files/processes without requiring every
    caller to remember to release anything; it releases itself on
    client.end(). */
export async function freshDb() {
  const client = new pg.Client(CONNECTION);
  await client.connect();
  await client.query("select pg_advisory_lock($1)", [SCHEMA_REBUILD_LOCK_KEY]);
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
