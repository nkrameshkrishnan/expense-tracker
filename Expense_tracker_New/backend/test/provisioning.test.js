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
