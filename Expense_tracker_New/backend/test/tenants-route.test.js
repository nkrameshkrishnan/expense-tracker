import { test } from "node:test";
import assert from "node:assert/strict";
import {
  freshDb,
  withProvisioning,
  withTenant,
  makeExecute,
} from "./pg-harness.js";
import * as tenants from "../src/routes/tenants.js";

test("listMembers/getMembership/createInvite/revokeInvite round-trip", async () => {
  const client = await freshDb();
  try {
    const tenantId = await withProvisioning(client, "seed-user", async (c) => {
      const { rows } = await c.query(
        // plan: 'family' (cap 5), not the 'free' default (cap 1) - this
        // test seats an owner AND sends an invite, which Task 5's seat-cap
        // check on createInvite would otherwise correctly reject.
        `insert into tenants (name, plan) values ('Household', 'family') returning id`,
      );
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
    await client.query("select set_config('app.tenant_id', $1, true)", [
      String(tenantId),
    ]);
    await client.query("select set_config('app.user_id', $1, true)", [
      "owner-sub",
    ]);

    await execute(
      `insert into tenant_users (user_sub, tenant_id, email, role) values (:sub, :tenantId, :email, 'owner')`,
      { sub: "owner-sub", tenantId, email: "owner@x.com" },
    );

    const membership = await tenants.getMembership(execute, "owner-sub");
    assert.equal(membership.role, "owner");

    const members = await tenants.listMembers(execute);
    assert.equal(members.length, 1);

    const invite = await tenants.createInvite(execute, {
      email: "new@x.com",
      role: "member",
    });
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
      const invite = await tenants.createInvite(execute, { email: "new@x.com", role: "member" });
      return invite.token;
    });

    const joinedTenantId = await withProvisioning(client, "new-user", (c) =>
      tenants.redeemInvite(makeExecute(c), { sub: "new-user", email: "new@x.com", inviteToken: token }),
    );
    assert.equal(joinedTenantId, tenantId);

    await withTenant(client, tenantId, "owner-sub", async (c) => {
      const membership = await tenants.getMembership(makeExecute(c), "new-user");
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
      const invite = await tenants.createInvite(execute, { email: "new@x.com", role: "member" });
      return invite.token;
    });

    const joinedTenantId = await withProvisioning(client, "new-user", (c) =>
      tenants.redeemInvite(makeExecute(c), { sub: "new-user", email: "new@x.com", inviteToken: token }),
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
      const { rows } = await c.query(`insert into tenants (name) values ('Household') returning id`);
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
