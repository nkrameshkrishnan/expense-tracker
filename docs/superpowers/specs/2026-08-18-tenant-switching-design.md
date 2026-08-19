# Tenant-Switching UI — Design Spec

**Status:** Approved by user, ready for implementation planning.

## Goal

Let a user who belongs to more than one tenant (household or org) act as
whichever one they choose, switching between them without signing out —
while every request is validated against real `tenant_users` membership,
never trusted from client input.

## Background

Today, `Expense_tracker_New`'s backend (`auth.js`) resolves which tenant a
request acts as _only_ from the Cognito ID token's own `custom:tenant_id`
claim, set once by `postConfirmation.js` at signup (either creating a new
tenant, or joining one via an invite token carried through Cognito's
`clientMetadata`). There is no code path today for an already-registered
user to belong to more than one tenant — `tenant_users`' primary key,
`(user_sub, tenant_id)`, already supports it at the schema level, but
nothing ever inserts a second row for an existing user.

This was deliberately deferred earlier in this project's development
(scoping decision, not a rejected feature) for exactly one reason: a
security review (finding C3, already fixed and merged) found and removed
an `X-Tenant-Id` request header that used to be trusted as the caller's
tenant context with **zero membership validation** — any authenticated user
could act as any tenant just by setting a header. Building real
tenant-switching means reintroducing _some_ way for a request to act as a
tenant other than the JWT's default — the same shape of mechanism as the
bug that was just fixed. `auth.js` itself already carries a `FUTURE WORK`
comment describing the correct fix: validate real membership, server-side,
before trusting any such value. This spec is that work.

## Non-goals

- Self-service creation of a second tenant by an already-registered user
  (e.g. a "create another household" button). In scope only: joining a
  second tenant via an invite, same as first-tenant signup already works.
  A user still gets their _first_ tenant by signing up (new or via
  invite); this spec only adds a way to gain _additional_ memberships and
  move between them.
- Changing a user's _default_ tenant (the one their JWT claims at sign-in).
  Joining a second tenant never touches `custom:tenant_id`; the switch is
  purely a per-request, client-persisted preference layered on top.
- Any change to how a _brand-new_ user's first tenant is provisioned —
  `postConfirmation.js`'s Cognito-trigger flow is unchanged in shape, only
  refactored to share logic with the new signed-in join path.
- Handling a user being removed from their _currently active_ tenant
  mid-session with a dedicated UX flow. Their next request simply fails
  the membership check like any other invalid switch attempt; the
  existing generic request-failure `notice()` handling covers it.

## Architecture

### 1. Auth flow — validated per-request tenant selection

`auth.js`'s `requireUser(event)` gains one step between verifying the JWT
and returning the resolved user:

1. Verify the JWT (unchanged) → `claims`, including
   `claims["custom:tenant_id"]` (the user's default tenant).
2. Read the `X-Active-Tenant` request header, if present.
3. **Absent, or equal to the default** → `tenantId = claims["custom:tenant_id"]`.
   No DB call — this is the path every single-tenant user takes, unchanged
   cost and behavior from today.
4. **Present and different from the default** → look up
   `tenant_users` for `(user_sub = claims.sub, tenant_id = requested)`
   inside a `runProvisioningTransaction`-style session (no `app.tenant_id`
   set yet — we don't know if the request is valid). This is exactly the
   access shape the existing `tenant_users_provisioning_select` RLS policy
   already grants (added for the seat-cap hard check in an earlier plan;
   scoped to "no tenant context set", not to any specific tenant, so no
   new RLS policy is needed here). Row found → `tenantId = requested`.
   No row → `AuthError`, same 401/403 shape every other auth rejection
   uses today.
5. Return `{ sub, email, tenantId }`, exactly the same shape as today.
   Nothing downstream — `handler.js`, `runInTenantTransaction`, every
   `routes/*.js` module — needs to know or care whether `tenantId` came
   from the default claim or a validated switch. Containing the change to
   `auth.js` alone is the point.

**Naming note:** the header is deliberately **not** called `X-Tenant-Id`,
even though the mechanism is now safe. That name is attached to the C3
finding in this repo's history; reusing it invites a future reader to
assume it's the same trust-the-header bug. It's `X-Active-Tenant` instead.

`template.yaml`'s CORS `Access-Control-Allow-Headers` gains
`x-active-tenant`. The existing test asserting the CORS allow-list does
_not_ advertise `x-tenant-id` is unaffected and should not be touched —
it's about the old, removed, unvalidated header; a new, validated,
differently-named header is not a regression of that finding. The
implementation plan should call this out explicitly so a reviewer doesn't
mistake the new header for reopening C3.

### 2. Joining a second tenant while signed in

`postConfirmation.js`'s invite-redemption logic (look up token by value →
check expiry/used → hard seat-cap check against live `tenant_users` count
→ insert `tenant_users` row → mark token used) is extracted into
`routes/tenants.js` as a shared, exported `redeemInvite(execute, { sub,
email, inviteToken })`. Two callers:

- **`postConfirmation.js`** (Cognito trigger, unchanged behavior) — new
  user, no existing tenant. After `redeemInvite` succeeds, this caller
  additionally writes `custom:tenant_id` onto the Cognito user via
  `AdminUpdateUserAttributes`, exactly as today, since this is the user's
  very first membership and therefore their default.
- **`joinTenant`** (new, `handler.js` action) — an already-registered,
  signed-in user redeeming an invite for a _second_ tenant. Calls the same
  `redeemInvite`, but **does not** touch `custom:tenant_id`. Their default
  tenant stays exactly what it was; the newly joined tenant becomes
  available in their tenant list and they switch to it (or not) via the
  mechanism in Section 1, on their own schedule.

`redeemInvite` handles two cases that never surface through today's single
caller in practice, but do reachable through this new path:

- **Re-redeeming a token for a tenant the caller already belongs to**
  (e.g. clicking an old invite link a second time). `tenant_users`'
  primary key is `(user_sub, tenant_id)`, so a naive second insert would
  hit a constraint violation. `redeemInvite` checks membership first and
  treats an existing membership as a no-op success, not an error.
- **Invite email vs. account email mismatch.** Today's flow never checks
  these match — possession of the unguessable 24-character token is
  treated as sufficient authorization, the same trust model as a
  password-reset link. `redeemInvite` keeps this as-is; the join path
  doesn't add a stricter check that the original signup path lacks, to
  avoid two invite-redemption code paths behaving differently for the
  same kind of token.

`joinTenant` runs inside `runProvisioningTransaction`, the same as
`postConfirmation.js` does — the caller doesn't have `app.tenant_id` set
for a tenant they're not (yet, or ever, by default) acting as.

### 3. Listing a user's tenants

A new `listMyTenants` action/route function:

```sql
select tu.tenant_id, tu.role, t.name, t.plan
from tenant_users tu
join tenants t on t.id = tu.tenant_id
where tu.user_sub = :sub
```

Runs inside a provisioning-style transaction — this query is inherently
cross-tenant (that's the entire point), so it cannot run inside any single
tenant's `runInTenantTransaction`. Both `tenant_users_provisioning_select`
and `tenants_provisioning_select` already grant exactly this access (added
in an earlier plan for unrelated reasons — the seat-cap check and the
Stripe webhook, respectively); no new RLS policy is needed for this query
either.

### 4. Frontend

**State & persistence:**

- `state.tenants` — populated from a new `getMyTenants()` `ApiStore`
  method (wrapping `listMyTenants`) at boot, alongside the existing
  `state.tenant`/`state.role`/`state.members` fetches.
- `state.activeTenantId` — read from `localStorage`, namespaced per signed
  -in user (`ledger:activeTenant:<sub>`, not a bare key — a shared-machine
  browser must never let one account's stored preference leak into a
  different account's session). Defaults to the JWT's own default tenant
  if unset, or if the stored value isn't present in the freshly-fetched
  `state.tenants` (e.g. the user was removed from that tenant since their
  last visit).
- `ApiStore` sends `X-Active-Tenant: <state.activeTenantId>` on every
  request whenever it's known. The backend already treats "equals the
  JWT's default" as a free, no-lookup path (Section 1), so there's no
  cost to sending it unconditionally rather than the frontend tracking
  which one is "the default" itself.

**Switcher UI:** lives inside the existing Household panel (Data tab),
_not_ a new standalone control. Unlike that panel's invite-management
actions (owner/admin only), the switcher itself is visible to **any**
member with 2+ tenants regardless of role — viewing a tenant you're a
plain member of is still a valid thing to do. Rendered only when
`state.tenants.length > 1`; the overwhelming majority of users belong to
exactly one tenant and see no new UI at all. Picking a different tenant
persists the new `state.activeTenantId` and triggers the same full data
`refresh()` path used elsewhere, so every tab reflects the newly active
tenant.

**Joining via an invite while already signed in:** invite links already
carry a `?invite=<token>` query param (today consumed only pre-signup, via
Cognito's `client_metadata`). `boot()` gains a check: if that param is
present _and_ the visitor already has a valid session, call the new
`joinTenant` action instead of routing through sign-up. Shows a "You've
joined `<tenant name>`" notice, refreshes `state.tenants`, and lets the
user switch to it via the normal Household-panel switcher — joining never
auto-switches, per Section 2.

## Error handling

- Invalid/unauthorized `X-Active-Tenant` value (not a member of that
  tenant, or a garbage string) → `AuthError`, the existing 401/403 path.
  No new error type.
- `joinTenant` with an expired/invalid/already-used token → the same
  message shape `postConfirmation.js` already throws today, reused via
  the shared `redeemInvite`, not reinvented.
- Re-redeeming a token for a tenant already joined → silent success
  (no-op), per Section 2.
- A user's active tenant revokes their membership mid-session → their
  next request simply fails the membership check like any other invalid
  switch attempt. No dedicated "you got kicked out" flow for this version
  (see Non-goals).

## Testing

Matches this codebase's established pattern throughout: real Postgres via
`pg-harness.js`'s `withTenant`/`withProvisioning` fixtures, AWS SDK mocked
only where a real call would otherwise happen (Cognito's
`AdminUpdateUserAttributes` in the `postConfirmation.js` path).

- `auth.test.js`: `X-Active-Tenant` matching the default (assert, via a
  spy, that the DB is never touched), valid non-default membership
  (switches), non-member tenant (rejects), malformed header value.
- `tenants-route.test.js`: `redeemInvite` shared-logic coverage — fresh
  join, re-redemption no-op, expired token, seat-cap hard rejection —
  largely carried over from `postConfirmation.js`'s existing tests, now
  exercised directly against the shared function.
- New `handler.js`-level test for the `joinTenant` action: confirms the
  join happens and confirms `custom:tenant_id` is _not_ touched — the one
  behavioral difference from signup-time redemption.
- `listMyTenants`: returns exactly the tenants a given `sub` belongs to,
  and nothing belonging to any other user.
- Frontend: `node --check`, plus a manual check (this codebase has no
  frontend test runner) that the switcher renders only for
  `state.tenants.length > 1` and is invisible otherwise.

## Summary of what does NOT change

- `db/schema.sql` — no new tables, columns, or RLS policies. Every access
  pattern this feature needs is already granted by the provisioning-scoped
  policies added for the seat-cap and Stripe-webhook work.
- Every existing route/handler downstream of `auth.js`'s returned
  `tenantId` — `runInTenantTransaction`, `routes/*.js`, RLS itself — is
  unaware tenant-switching exists. The entire mechanism is contained to
  `auth.js`'s tenant-resolution step and the frontend's header/state.
