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

/** Lists every tenant `userSub` belongs to, across all memberships - the
    backing query for the joinTenant/tenant-switching action set. Called
    from runProvisioningTransaction (no app.tenant_id set), same reason
    getMembershipInTenant is: this is inherently a cross-tenant query, so it
    can't rely on RLS scoping to a single tenant and instead filters by
    user_sub explicitly. */
export async function listMyTenants(execute, userSub) {
  return execute.rows(
    `select tu.tenant_id, tu.role, t.name, t.plan
     from tenant_users tu
     join tenants t on t.id = tu.tenant_id
     where tu.user_sub = :userSub
     order by tu.created_at`,
    { userSub },
  );
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

/** Marker error for "this invite token doesn't resolve to anything
    redeemable" (missing/expired/already used) - deliberately a plain
    Error subclass, not a ValidationError, and not surfaced to end users
    any differently than any other action failure today. Exists purely so
    callers can distinguish this one specific failure mode by type:
    postConfirmation.js's resolveTenant catches JUST this to silently fall
    through to creating a new tenant (an expired invite shouldn't block a
    real signup); every other error out of redeemInvite (e.g. the seat-cap
    Error below) is NOT caught there and propagates to block signup, same
    as today. */
export class InvalidInviteError extends Error {}

/** Redeems an invite token for `sub`/`email`, joining the tenant it
    points at. Shared by postConfirmation.js (first-signup invite
    redemption) and, from Task 3 onward, the joinTenant action (an
    already-signed-in user joining a second tenant) - both need the exact
    same lookup/seat-cap/insert/mark-used logic, so it lives here once
    rather than being duplicated.

    Called from runProvisioningTransaction (no app.tenant_id set), so -
    like getMembershipInTenant - every query here filters by tenant_id
    explicitly rather than relying on RLS scoping. */
export async function redeemInvite(execute, { sub, email, inviteToken }) {
  const invites = await execute.rows(
    `select tenant_id, role from tenant_invites
     where token = :token and used_at is null and expires_at > now()`,
    { token: inviteToken },
  );
  if (!invites[0]) {
    // The lookup above filters on `used_at is null` BEFORE any membership
    // check runs, so re-redeeming the SAME token a second time (the most
    // common case: a signed-out invitee signs up - postConfirmation.js
    // burns the token - and the app then replays the same link on the way
    // back in) found nothing and errored, contradicting the spec's
    // "re-redeeming a token for a tenant already joined -> silent success".
    // Re-look the token up WITHOUT the used_at/expires_at filters and let
    // it succeed only when the caller is genuinely already a member of the
    // tenant it points at. A stranger replaying someone else's spent token
    // has no such membership row and still falls through to the throw
    // below, so this cannot be used to bypass invite consumption.
    const spent = await execute.rows(
      `select tenant_id from tenant_invites where token = :token`,
      { token: inviteToken },
    );
    if (spent[0]) {
      const already = await getMembershipInTenant(
        execute,
        sub,
        spent[0].tenant_id,
      );
      if (already) return spent[0].tenant_id;
    }
    throw new InvalidInviteError("This invite is invalid or has expired.");
  }
  const { tenant_id: tenantId, role } = invites[0];

  const existing = await getMembershipInTenant(execute, sub, tenantId);
  if (existing) {
    // Re-clicking an old invite link for a tenant already joined - a
    // no-op success, not an error. tenant_users' primary key is
    // (user_sub, tenant_id); a naive second insert would otherwise hit a
    // constraint violation.
    //
    // Consume the token here too: this branch handles a DIFFERENT, still
    // valid invite to a tenant the caller already belongs to, and leaving
    // it unmarked left a live, redeemable token sitting in the table (and
    // in listPendingInvites) until its natural expiry. An invite is spent
    // whichever branch resolved it.
    await execute(
      `update tenant_invites set used_at = now() where token = :token`,
      { token: inviteToken },
    );
    return tenantId;
  }

  const [{ plan }] = await execute.rows(
    `select plan from tenants where id = cast(:tenantId as uuid)`,
    { tenantId },
  );
  const [{ count: memberCount }] = await execute.rows(
    `select cast(count(*) as int) as count from tenant_users where tenant_id = cast(:tenantId as uuid)`,
    { tenantId },
  );
  // Hard, authoritative check: state can have changed (plan downgraded,
  // another invite redeemed) since this invite was created - createInvite's
  // check at send time is only a soft, best-effort warning.
  if (memberCount >= SEAT_CAPS[plan]) {
    throw new Error(
      `Household is at its ${SEAT_CAPS[plan]}-seat limit for its current plan.`,
    );
  }

  await execute(
    `insert into tenant_users (user_sub, tenant_id, email, role)
     values (:sub, :tenantId, :email, :role)`,
    { sub, tenantId, email, role },
  );
  await execute(
    `update tenant_invites set used_at = now() where token = :token`,
    { token: inviteToken },
  );
  return tenantId;
}
