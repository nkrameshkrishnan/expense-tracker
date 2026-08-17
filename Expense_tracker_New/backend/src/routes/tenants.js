/* Membership/invite management for the current tenant. Every function here
   assumes it's called inside an already tenant-scoped transaction (see
   db.js's runInTenantTransaction) - same trust boundary as the other
   routes/*.js modules. Invite creation/consumption across the provisioning
   boundary is handled separately in postConfirmation.js. */

export async function getMembership(execute, userSub) {
  const rows = await execute.rows(
    `select role from tenant_users where user_sub = :userSub`,
    { userSub },
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
