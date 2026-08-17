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
