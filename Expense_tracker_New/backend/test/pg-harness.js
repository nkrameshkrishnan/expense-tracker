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
