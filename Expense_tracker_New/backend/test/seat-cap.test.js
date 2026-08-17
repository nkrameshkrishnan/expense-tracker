import { test } from "node:test";
import assert from "node:assert/strict";
import { RDSDataClient } from "@aws-sdk/client-rds-data";
import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { freshDb, withProvisioning, withTenant, makeExecute } from "./pg-harness.js";
import { createInvite } from "../src/routes/tenants.js";
import { handler as postConfirmationHandler } from "../src/postConfirmation.js";
import { SEAT_CAPS } from "../src/plans.js";

/** Runs the REAL postConfirmation.js `handler` - not a hand-copied
    reimplementation of its SQL - against a real Postgres connection, by
    mocking RDSDataClient.prototype.send (same technique test/db.test.js
    already uses) to translate each Begin/Execute/Commit/RollbackTransaction
    command onto the given pg client instead of AWS. This is the only way
    to exercise postConfirmation.js's actual code path in this harness:
    db.js's runProvisioningTransaction is wired to the RDS Data API, not a
    plain pg client, and the whole point of this bridge is to prove the
    hard seat-cap check works against REAL RLS-enforced Postgres, not a
    fake all-empty mock (test/db.test.js's own mock returns
    `{ records: [], columnMetadata: [] }` unconditionally, which would
    make memberCount silently 0 for a different reason than the RLS bug
    this is meant to catch).

    Also mocks CognitoIdentityProviderClient.prototype.send, since
    handler() unconditionally calls AdminUpdateUserAttributesCommand after
    resolveTenant() returns - irrelevant to the seat-cap check, but real
    handler() will throw without it. */
async function runPostConfirmation(client, t, { sub, email, inviteToken }) {
  let transactionId = null;
  t.mock.method(RDSDataClient.prototype, "send", async (command) => {
    const name = command.constructor.name;
    if (name === "BeginTransactionCommand") {
      await client.query("begin");
      transactionId = `tx-${Math.random()}`;
      return { transactionId };
    }
    if (name === "ExecuteStatementCommand") {
      const { sql, parameters = [] } = command.input;
      const values = [];
      const converted = sql.replace(/:(\w+)/g, (_, paramName) => {
        const param = parameters.find((p) => p.name === paramName);
        if (!param) throw new Error(`Missing bind param ":${paramName}" for query: ${sql}`);
        const v = param.value;
        values.push(
          v.isNull
            ? null
            : (v.stringValue ?? v.longValue ?? v.doubleValue ?? v.booleanValue),
        );
        return `$${values.length}`;
      });
      const result = await client.query(converted, values);
      const columnMetadata = (result.fields || []).map((f) => ({ name: f.name }));
      const records = result.rows.map((row) =>
        result.fields.map((f) => {
          const v = row[f.name];
          if (v === null || v === undefined) return { isNull: true };
          if (typeof v === "number")
            return Number.isInteger(v) ? { longValue: v } : { doubleValue: v };
          if (typeof v === "boolean") return { booleanValue: v };
          return { stringValue: String(v) };
        }),
      );
      return { records, columnMetadata };
    }
    if (name === "CommitTransactionCommand") {
      await client.query("commit");
      return {};
    }
    if (name === "RollbackTransactionCommand") {
      await client.query("rollback").catch(() => {});
      return {};
    }
    throw new Error(`Unexpected RDS Data API command in test bridge: ${name}`);
  });
  const cognitoMock = t.mock.method(
    CognitoIdentityProviderClient.prototype,
    "send",
    async () => ({}),
  );

  await postConfirmationHandler({
    request: {
      userAttributes: { sub, email },
      clientMetadata: inviteToken ? { inviteToken } : {},
    },
    userPoolId: "us-east-1_00000000000",
    userName: sub,
  });

  // Recover the tenant id handler() resolved, from the Cognito call it made
  // with it - handler() itself doesn't return it (Cognito triggers must
  // return the event unchanged).
  const attrs = cognitoMock.mock.calls[0].arguments[0].input.UserAttributes;
  return attrs.find((a) => a.Name === "custom:tenant_id").Value;
}

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

test("postConfirmation.js's hard check rejects invite redemption once the tenant is at its member cap", async (t) => {
  const client = await freshDb();
  try {
    const tenantId = await seedTenant(client, "free"); // cap 1
    const token = await withTenant(client, tenantId, "owner-sub", async (c) => {
      await c.query(
        `insert into tenant_users (user_sub, tenant_id, email, role) values ('owner-sub', $1, 'owner@x.com', 'owner')`,
        [tenantId],
      );
      // Direct insert, bypassing createInvite's own (now-enforced) soft
      // cap - this is exactly the scenario the hard check exists for: an
      // invite that was fine when it was created but the household is
      // full by the time this invitee actually redeems it (e.g. the
      // owner filled the last seat in the meantime).
      const { rows } = await c.query(
        `insert into tenant_invites (tenant_id, email) values ($1, 'invitee@x.com') returning token`,
        [tenantId],
      );
      return rows[0].token;
    });

    await assert.rejects(
      runPostConfirmation(client, t, {
        sub: "new-invitee-sub",
        email: "invitee@x.com",
        inviteToken: token,
      }),
      /seat|limit/i,
    );

    // Rejection must not have left a partial join: still just the owner,
    // and the invite still unredeemed (not consumed by a failed attempt).
    const after = await withTenant(client, tenantId, "owner-sub", (c) =>
      c.query(`select user_sub from tenant_users`),
    );
    assert.deepEqual(after.rows.map((r) => r.user_sub), ["owner-sub"]);
    const invite = await withTenant(client, tenantId, "owner-sub", (c) =>
      c.query(`select used_at from tenant_invites where token = $1`, [token]),
    );
    assert.equal(invite.rows[0].used_at, null);
  } finally {
    await client.end();
  }
});

test("postConfirmation.js's hard check allows redemption when under cap, and the resulting membership is real", async (t) => {
  const client = await freshDb();
  try {
    const tenantId = await seedTenant(client, "pro"); // cap 2
    const token = await withTenant(client, tenantId, "owner-sub", async (c) => {
      await c.query(
        `insert into tenant_users (user_sub, tenant_id, email, role) values ('owner-sub', $1, 'owner@x.com', 'owner')`,
        [tenantId],
      );
      const { rows } = await c.query(
        `insert into tenant_invites (tenant_id, email, role) values ($1, 'invitee@x.com', 'member') returning token`,
        [tenantId],
      );
      return rows[0].token;
    });

    const resolvedTenantId = await runPostConfirmation(client, t, {
      sub: "new-invitee-sub",
      email: "invitee@x.com",
      inviteToken: token,
    });
    assert.equal(resolvedTenantId, tenantId);

    // The load-bearing assertion for this whole fix: the new member row
    // must actually exist, and there must be exactly two - proving
    // resolveTenant's member count saw the real, current membership (1,
    // not a stale/always-0 value) and correctly allowed the join under
    // the pro plan's cap of 2.
    const members = await withTenant(client, tenantId, "owner-sub", (c) =>
      c.query(`select user_sub, role from tenant_users order by user_sub`),
    );
    assert.deepEqual(
      members.rows.map((r) => r.user_sub).sort(),
      ["new-invitee-sub", "owner-sub"],
    );
    assert.equal(SEAT_CAPS.pro, 2);

    const invite = await withTenant(client, tenantId, "owner-sub", (c) =>
      c.query(`select used_at from tenant_invites where token = $1`, [token]),
    );
    assert.ok(invite.rows[0].used_at !== null);
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
