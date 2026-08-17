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
      assert.equal(
        row.relrowsecurity,
        true,
        `${row.relname} should have RLS enabled`,
      );
  } finally {
    await client.end();
  }
});

test("freshDb applies schema.sql - tenants has Stripe identifier columns", async () => {
  const client = await freshDb();
  try {
    const { rows } = await client.query(
      `select column_name from information_schema.columns
       where table_name = 'tenants' and column_name in ('stripe_customer_id', 'stripe_subscription_id')`,
    );
    assert.equal(rows.length, 2);
  } finally {
    await client.end();
  }
});
