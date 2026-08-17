import { test } from "node:test";
import assert from "node:assert/strict";
import { freshDb, withProvisioning, withTenant, makeExecute } from "./pg-harness.js";
import { createInvite } from "../src/routes/tenants.js";

async function seedTenant(client, plan = "free") {
  return withProvisioning(client, "seed-user", async (c) => {
    const { rows } = await c.query(
      `insert into tenants (name, plan) values ($1, $2) returning id`,
      ["Household", plan],
    );
    return rows[0].id;
  });
}

test("createInvite rejects once a Free tenant (cap 1) already has its one member", async () => {
  const client = await freshDb();
  try {
    const tenantId = await seedTenant(client, "free");
    await withTenant(client, tenantId, "owner-sub", async (c) => {
      await c.query(
        `insert into tenant_users (user_sub, tenant_id, email, role) values ('owner-sub', $1, 'owner@x.com', 'owner')`,
        [tenantId],
      );
    });

    await assert.rejects(
      withTenant(client, tenantId, "owner-sub", (c) =>
        createInvite(makeExecute(c), { email: "new@x.com" }),
      ),
      /seat/i,
    );
  } finally {
    await client.end();
  }
});

test("createInvite counts pending invites toward the cap, not just members", async () => {
  const client = await freshDb();
  try {
    const tenantId = await seedTenant(client, "pro"); // cap 2
    await withTenant(client, tenantId, "owner-sub", async (c) => {
      await c.query(
        `insert into tenant_users (user_sub, tenant_id, email, role) values ('owner-sub', $1, 'owner@x.com', 'owner')`,
        [tenantId],
      );
      // One already-pending invite fills the second seat.
      await c.query(`insert into tenant_invites (tenant_id, email) values ($1, 'pending@x.com')`, [tenantId]);
    });

    await assert.rejects(
      withTenant(client, tenantId, "owner-sub", (c) =>
        createInvite(makeExecute(c), { email: "another@x.com" }),
      ),
      /seat/i,
    );
  } finally {
    await client.end();
  }
});

test("createInvite succeeds when under the cap", async () => {
  const client = await freshDb();
  try {
    const tenantId = await seedTenant(client, "family"); // cap 5
    await withTenant(client, tenantId, "owner-sub", async (c) => {
      await c.query(
        `insert into tenant_users (user_sub, tenant_id, email, role) values ('owner-sub', $1, 'owner@x.com', 'owner')`,
        [tenantId],
      );
    });

    const invite = await withTenant(client, tenantId, "owner-sub", (c) =>
      createInvite(makeExecute(c), { email: "new@x.com" }),
    );
    assert.ok(invite.token);
  } finally {
    await client.end();
  }
});
