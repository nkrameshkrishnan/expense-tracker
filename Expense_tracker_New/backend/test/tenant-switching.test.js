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
      const { rows } = await c.query(`insert into tenants (name) values ('Household A') returning id`);
      return rows[0].id;
    });
    const tenantB = await withProvisioning(client, "seed-user", async (c) => {
      const { rows } = await c.query(`insert into tenants (name) values ('Household B') returning id`);
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
      const { rows } = await c.query(`insert into tenants (name) values ('Household A') returning id`);
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

    const token = await withTenant(client, tenantB, "owner-sub-b", async (c) => {
      const execute = makeExecute(c);
      await execute(
        `insert into tenant_users (user_sub, tenant_id, email, role) values ('owner-sub-b', :tenantId, 'ownerb@x.com', 'owner')`,
        { tenantId: tenantB },
      );
      const invite = await tenants.createInvite(execute, { email: "user1@x.com", role: "member" });
      return invite.token;
    });

    const joinedTenantId = await withProvisioning(client, "user-1", (c) =>
      tenants.redeemInvite(makeExecute(c), { sub: "user-1", email: "user1@x.com", inviteToken: token }),
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
