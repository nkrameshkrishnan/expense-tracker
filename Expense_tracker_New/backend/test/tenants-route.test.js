import { test } from "node:test";
import assert from "node:assert/strict";
import { freshDb, withProvisioning } from "./pg-harness.js";
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
