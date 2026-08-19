/* Postgres access via the RDS Data API — chosen over a pooled `pg` client
   specifically so the Lambda never needs to live in a VPC (no NAT gateway,
   no RDS Proxy, no connection-pool exhaustion at low concurrency). That's
   the right trade for the pre-validation stage this scaffold targets; if
   traffic ever justifies it, swapping to `pg` + RDS Proxy is a contained
   change local to this file.

   Every call in this module runs inside a transaction that sets
   `app.tenant_id` / `app.user_id` as session-local GUCs BEFORE touching any
   tenant table — those are what the RLS policies in db/schema.sql key off
   of. There is no code path here that queries a tenant table without first
   setting them. */

import {
  RDSDataClient,
  ExecuteStatementCommand,
  BeginTransactionCommand,
  CommitTransactionCommand,
  RollbackTransactionCommand,
} from "@aws-sdk/client-rds-data";

const client = new RDSDataClient({});

const resourceArn = process.env.DB_CLUSTER_ARN;
const secretArn = process.env.DB_SECRET_ARN;
const database = process.env.DB_NAME || "ledger";

function toField(value) {
  if (value === null || value === undefined) return { isNull: true };
  if (typeof value === "number")
    return Number.isInteger(value)
      ? { longValue: value }
      : { doubleValue: value };
  if (typeof value === "boolean") return { booleanValue: value };
  return { stringValue: String(value) };
}

function toParams(params) {
  return Object.entries(params).map(([name, value]) => ({
    name,
    value: toField(value),
  }));
}

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
  execute.rows = async (sql, params = {}) =>
    recordsToObjects(await execute(sql, params));
  try {
    await setup(execute);
    const result = await fn(execute);
    await client.send(
      new CommitTransactionCommand({ resourceArn, secretArn, transactionId }),
    );
    return result;
  } catch (err) {
    await client
      .send(
        new RollbackTransactionCommand({
          resourceArn,
          secretArn,
          transactionId,
        }),
      )
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

/** The ONLY other way into a transaction against these tables - used by
    the operations that inherently cannot be scoped to one tenant:
    postConfirmation.js (which by definition runs before any tenant_id
    exists to scope to), auth.js's X-Active-Tenant membership check, and
    handler.js's joinTenant/listMyTenants actions. Relies on the narrow
    "provisioning" policies in db/schema.sql (tenants/tenant_users INSERT,
    tenant_invites SELECT/UPDATE), not on app.tenant_id being set at all -
    deliberately does NOT set it, so any query here that isn't covered by
    one of those specific policies correctly sees/changes nothing. */
export async function runProvisioningTransaction(userSub, fn) {
  return withDataApiTransaction(async (execute) => {
    await execute(`select set_config('app.user_id', :userSub, true)`, {
      userSub: String(userSub),
    });
  }, fn);
}

/** Data API returns column metadata separately from row values — this
    zips them into the {columnName: value} shape every route module works
    with, so callers never touch the raw Data API record format. */
export function recordsToObjects(result) {
  const columns = (result.columnMetadata || []).map((c) => c.name);
  return (result.records || []).map((record) =>
    Object.fromEntries(
      record.map((field, i) => [columns[i], unwrapField(field)]),
    ),
  );
}

function unwrapField(field) {
  if (field.isNull) return null;
  if ("stringValue" in field) return field.stringValue;
  if ("longValue" in field) return field.longValue;
  if ("doubleValue" in field) return field.doubleValue;
  if ("booleanValue" in field) return field.booleanValue;
  return null;
}
