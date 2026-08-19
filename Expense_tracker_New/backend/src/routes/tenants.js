/* Membership/invite management for the current tenant. Every function here
   assumes it's called inside an already tenant-scoped transaction (see
   db.js's runInTenantTransaction) - same trust boundary as the other
   routes/*.js modules. Invite creation/consumption across the provisioning
   boundary is handled separately in postConfirmation.js. */

import { SEAT_CAPS } from "../plans.js";

export async function getMembership(execute, userSub) {
  const rows = await execute.rows(
    `select role from tenant_users where user_sub = :userSub`,
    { userSub },
  );
  return rows[0] || null;
}

/** Same lookup as getMembership, but scoped to an explicit tenant rather
    than the caller's default. Used by auth.js's X-Active-Tenant handling to
    confirm real membership before letting a request act as a tenant other
    than the one on the caller's token - called inside
    runProvisioningTransaction (no app.tenant_id set yet), same reason
    getMembership's callers are, so this can't rely on RLS scoping and
    filters by tenant_id explicitly. */
export async function getMembershipInTenant(execute, userSub, tenantId) {
  const rows = await execute.rows(
    `select role from tenant_users where user_sub = :userSub and tenant_id = cast(:tenantId as uuid)`,
    { userSub, tenantId },
  );
  return rows[0] || null;
}

export async function listMembers(execute) {
  return execute.rows(
    `select user_sub, email, role, created_at from tenant_users order by created_at`,
  );
}

export async function listPendingInvites(execute) {
  return execute.rows(
    `select token, email, role, created_at, expires_at from tenant_invites
     where used_at is null and expires_at > now()
     order by created_at desc`,
  );
}

export async function createInvite(execute, { email, role }) {
  const [{ plan }] = await execute.rows(
    `select plan from tenants where id = cast(current_setting('app.tenant_id', true) as uuid)`,
  );
  // cast(... as int) rather than `::int`, same reason as
  // listTransactionYears (transactions.js) and this function's own
  // `cast(... as uuid)` below: the second colon of `::` is indistinguishable
  // from a `:name` bind param to both the RDS Data API's named-parameter
  // parser and this repo's test harness shim (test/pg-harness.js), so it
  // fails the statement with an unbound `:int` parameter instead of casting.
  const [{ count: memberCount }] = await execute.rows(
    `select cast(count(*) as int) as count from tenant_users`,
  );
  const [{ count: pendingCount }] = await execute.rows(
    `select cast(count(*) as int) as count from tenant_invites where used_at is null and expires_at > now()`,
  );
  if (memberCount + pendingCount >= SEAT_CAPS[plan]) {
    throw new Error(
      `This plan is limited to ${SEAT_CAPS[plan]} seat${SEAT_CAPS[plan] === 1 ? "" : "s"} - upgrade to invite more members.`,
    );
  }

  // cast(...) rather than the `::uuid` shorthand: the latter's second colon
  // is indistinguishable from a `:name` bind param to any regex-based
  // named-parameter translator (see test/tenants-route.test.js's execute
  // shim), so it silently corrupts the query there. Functionally identical
  // to `::uuid` in real Postgres, but doesn't collide with that convention.
  const rows = await execute.rows(
    `insert into tenant_invites (tenant_id, email, role)
     values (cast(current_setting('app.tenant_id', true) as uuid), :email, :role)
     returning token, email, role, expires_at`,
    { email, role: role || "member" },
  );
  return rows[0];
}

export async function revokeInvite(execute, token) {
  await execute(
    `delete from tenant_invites where token = :token and used_at is null`,
    { token },
  );
}
