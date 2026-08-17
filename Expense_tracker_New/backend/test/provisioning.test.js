import { test } from "node:test";
import assert from "node:assert/strict";
import {
  freshDb,
  withTenant,
  withProvisioning,
  makeExecute,
} from "./pg-harness.js";
import * as tenants from "../src/routes/tenants.js";

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
      await c.query(
        `insert into tenant_users (user_sub, tenant_id, email, role)
                      values ('owner-sub', $1, 'owner@x.com', 'owner')`,
        [tenantId],
      );
      await c.query(
        `insert into tenant_invites (tenant_id, email) values ($1, 'new@x.com')`,
        [tenantId],
      );
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

/* Finding C2. tenant_invites_provisioning_select used to be `using (true)`.
   Permissive RLS policies combine with OR, so an unconditional `true`
   defeats tenant_invites_isolation for EVERY steady-state read, not just
   the provisioning bootstrap it was written for - and listPendingInvites()
   (called on every GET /data for owners/admins) has no tenant_id filter of
   its own. Since an invite token alone is enough to join that tenant (see
   postConfirmation.js), that was a full isolation defeat, not a leak of
   harmless metadata. The fix scopes the policy to "no app.tenant_id set",
   matching tenants_provisioning_select. */
test("listPendingInvites never returns another tenant's invites", async () => {
  const client = await freshDb();
  try {
    const tenantA = await withProvisioning(client, "seed-a", async (c) => {
      const { rows } = await c.query(
        `insert into tenants (name) values ('Household A') returning id`,
      );
      return rows[0].id;
    });
    const tenantB = await withProvisioning(client, "seed-b", async (c) => {
      const { rows } = await c.query(
        `insert into tenants (name) values ('Household B') returning id`,
      );
      return rows[0].id;
    });

    // Both tenants have a pending invite, created through the real route.
    await withTenant(client, tenantA, "a-owner", async (c) => {
      await c.query(
        `insert into tenant_users (user_sub, tenant_id, email, role) values ('a-owner', $1, 'a@x.com', 'owner')`,
        [tenantA],
      );
      await tenants.createInvite(makeExecute(c), {
        email: "invited-a@x.com",
        role: "member",
      });
    });
    const bToken = await withTenant(client, tenantB, "b-owner", async (c) => {
      await c.query(
        `insert into tenant_users (user_sub, tenant_id, email, role) values ('b-owner', $1, 'b@x.com', 'owner')`,
        [tenantB],
      );
      const invite = await tenants.createInvite(makeExecute(c), {
        email: "invited-b@x.com",
        role: "member",
      });
      return invite.token;
    });

    const seenByA = await withTenant(client, tenantA, "a-owner", async (c) =>
      tenants.listPendingInvites(makeExecute(c)),
    );
    assert.equal(seenByA.length, 1);
    assert.equal(seenByA[0].email, "invited-a@x.com");
    assert.ok(
      !seenByA.some((i) => i.token === bToken),
      "tenant A must never see tenant B's invite token",
    );

    const seenByB = await withTenant(client, tenantB, "b-owner", async (c) =>
      tenants.listPendingInvites(makeExecute(c)),
    );
    assert.equal(seenByB.length, 1);
    assert.equal(seenByB[0].email, "invited-b@x.com");
  } finally {
    await client.end();
  }
});

/* Finding C2, the other half: revokeInvite must not be able to reach across
   tenants either. tenant_invites_isolation covers DELETE, but only once the
   unconditional provisioning SELECT stops ORing itself into every read. */
test("revokeInvite cannot delete another tenant's invite", async () => {
  const client = await freshDb();
  try {
    const tenantA = await withProvisioning(client, "seed-a", async (c) => {
      const { rows } = await c.query(
        `insert into tenants (name) values ('Household A') returning id`,
      );
      return rows[0].id;
    });
    const tenantB = await withProvisioning(client, "seed-b", async (c) => {
      const { rows } = await c.query(
        `insert into tenants (name) values ('Household B') returning id`,
      );
      return rows[0].id;
    });
    const bToken = await withTenant(client, tenantB, "b-owner", async (c) => {
      const invite = await tenants.createInvite(makeExecute(c), {
        email: "invited-b@x.com",
      });
      return invite.token;
    });

    await withTenant(client, tenantA, "a-owner", async (c) =>
      tenants.revokeInvite(makeExecute(c), bToken),
    );

    const stillThere = await withTenant(client, tenantB, "b-owner", async (c) =>
      tenants.listPendingInvites(makeExecute(c)),
    );
    assert.equal(stillThere.length, 1);
    assert.equal(stillThere[0].token, bToken);
  } finally {
    await client.end();
  }
});

test("provisioning policies do NOT allow reading another tenant's data", async () => {
  const client = await freshDb();
  try {
    const tenantId = await withProvisioning(client, "seed-user", async (c) => {
      const { rows } = await c.query(
        `insert into tenants (name) values ('Household B') returning id`,
      );
      return rows[0].id;
    });
    await withTenant(client, tenantId, "owner-sub", async (c) => {
      await c.query(
        `insert into transactions (tenant_id, date, amount) values ($1, '2026-01-01', 10)`,
        [tenantId],
      );
    });
    // No app.tenant_id set - transactions has no provisioning carve-out, so this must see nothing.
    const { rows } = await client.query(`select * from transactions`);
    assert.equal(rows.length, 0);
  } finally {
    await client.end();
  }
});
