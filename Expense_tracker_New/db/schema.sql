-- Ledger SaaS schema — multi-tenant Postgres (Aurora Serverless v2).
--
-- Isolation model: every tenant-owned table carries a `tenant_id` column and
-- an RLS policy scoped to current_setting('app.tenant_id'). The backend sets
-- that session variable (plus app.user_id) at the start of every request
-- transaction, right after verifying the caller's Cognito JWT — see
-- backend/src/db.js. No query anywhere is trusted to filter by tenant_id
-- itself; RLS is the enforcement boundary, the same role Code.gs's
-- ALLOWED_EMAILS check and the original supabase/schema.sql RLS policies
-- played in the previous two backends.

create extension if not exists pgcrypto;

-- ------------------------------------------------------------------ tenants
create table tenants (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  plan        text not null default 'free',
  status      text not null default 'active', -- active | past_due
  currency    text not null default 'CAD', -- CAD | USD | EUR | GBP | INR | AUD - display only, see routes/tenants.js's CURRENCIES
  stripe_customer_id     text,
  stripe_subscription_id text,
  created_at  timestamptz not null default now()
);

-- The Stripe webhook handler's only route back to a tenant is this column
-- (no app.tenant_id exists on that code path - see
-- backend/src/stripeWebhook.js), which makes it both the hot WHERE-clause
-- path and a correctness boundary: two tenants sharing a customer id would
-- let one webhook silently update both. Partial, because the column stays
-- null for every tenant that has never reached checkout.
create unique index tenants_stripe_customer_idx on tenants (stripe_customer_id)
  where stripe_customer_id is not null;

-- One row per (Cognito user, tenant). A user could belong to more than one
-- tenant later (e.g. accepting an invite to a second household); role is
-- scoped per-membership, not per-user.
create table tenant_users (
  user_sub    text not null,        -- Cognito `sub` claim, stable per user
  tenant_id   uuid not null references tenants(id) on delete cascade,
  email       text not null,
  role        text not null default 'member', -- owner | admin | member
  created_at  timestamptz not null default now(),
  primary key (user_sub, tenant_id)
);

-- Pending invites: a signup carrying ?invite=<token> joins this tenant
-- instead of creating a new one. See backend/src/postConfirmation.js.
create table tenant_invites (
  -- 18 random bytes -> 24-char base64 with no padding (18 is a multiple of
  -- 3); translate makes it URL-safe. Postgres's encode() only gained a
  -- native 'base64url' mode in v18, which is newer than both this test
  -- harness (Postgres 15) and Aurora Serverless v2's supported versions,
  -- so this constructs the equivalent by hand.
  token       text primary key default rtrim(translate(encode(gen_random_bytes(18), 'base64'), '+/', '-_'), '='),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  email       text not null,
  role        text not null default 'member',
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '7 days',
  used_at     timestamptz
);

alter table tenants enable row level security;
alter table tenants force row level security;
alter table tenant_users enable row level security;
alter table tenant_users force row level security;
alter table tenant_invites enable row level security;
alter table tenant_invites force row level security;

-- Membership rows are only ever read/written by the backend using the
-- tenant-scoped session var below; there is no separate "admin bypass" role
-- configured here — the Lambda's DB credential is the only writer, and it
-- always sets app.tenant_id first (see db.js).
--
-- Steady-state access: scoped strictly to the caller's own tenant. These
-- policies default to FOR ALL (every command), which is what every query
-- in the codebase EXCEPT postConfirmation.js's provisioning path runs
-- under - that path is the only code that ever runs without app.tenant_id
-- set, and the three provisioning-specific policies below are the only
-- carve-outs from this isolation, scoped as narrowly as the bootstrap
-- problem allows.
create policy tenant_users_isolation on tenant_users
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
create policy tenants_isolation on tenants
  using (id = nullif(current_setting('app.tenant_id', true), '')::uuid);
create policy tenant_invites_isolation on tenant_invites
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- Provisioning bootstrap (see backend/src/db.js's runProvisioningTransaction
-- and backend/src/postConfirmation.js): creating a brand-new tenant or
-- consuming an invite happens before any tenant_id is knowable. Safe only
-- because Postgres here is reached exclusively by our own backend code
-- (via the RDS Data API), never directly by end users - the real
-- authorization boundary is "which Lambda code path runs this query", the
-- same trust model the RDS Data API access pattern already relies on
-- everywhere else in this schema.
--
-- EVERY provisioning policy below is scoped to "no app.tenant_id set".
-- That scoping is load-bearing, not stylistic: permissive Postgres RLS
-- policies combine with OR, so an unconditional `true` here does not just
-- permit the provisioning session, it ORs itself into every steady-state
-- tenant-scoped query too and silently cancels the corresponding
-- *_isolation policy for the whole application. (That is exactly what
-- happened to tenant_invites_provisioning_select: any tenant's owner/admin
-- could read every other tenant's pending invite tokens via
-- routes/tenants.js's listPendingInvites, and a token alone is enough to
-- join that tenant - see postConfirmation.js.) Never write `using (true)`
-- or `with check (true)` in this block.
--
-- runProvisioningTransaction (db.js) deliberately leaves app.tenant_id
-- unset, so nullif(current_setting('app.tenant_id', true), '') is null is
-- true for exactly those sessions and false for every request that went
-- through runInTenantTransaction.
create policy tenants_provisioning_insert on tenants
  for insert with check (nullif(current_setting('app.tenant_id', true), '') is null);
-- Needed alongside the insert policy above: postConfirmation.js's
-- `insert into tenants (name) values (...) returning id` requires the new
-- row to be visible under RLS for RETURNING to succeed, not just
-- insertable - an INSERT policy's WITH CHECK alone does not grant that
-- visibility. Without this, FORCE ROW LEVEL SECURITY (see below) makes
-- every brand-new-tenant signup fail.
--
-- Scoped to "no app.tenant_id set" for the reason spelled out above.
create policy tenants_provisioning_select on tenants
  for select using (nullif(current_setting('app.tenant_id', true), '') is null);
-- Needed by src/stripeWebhook.js: Stripe webhook events identify a tenant
-- only by stripe_customer_id, never by tenant_id, so those handlers run
-- under runProvisioningTransaction the same way postConfirmation.js does -
-- no app.tenant_id is set. Without this policy, an
-- `update tenants ... where stripe_customer_id = ...` issued in that
-- session matches zero rows under FORCE ROW LEVEL SECURITY (tenants_isolation
-- alone rejects it, and there is no provisioning UPDATE policy to OR in) -
-- the write silently no-ops instead of erroring. Mirrors
-- tenant_invites_provisioning_update's shape exactly, just for this table.
-- Scoped to "no app.tenant_id set" for the reason spelled out above.
create policy tenants_provisioning_update on tenants
  for update using (nullif(current_setting('app.tenant_id', true), '') is null)
  with check (nullif(current_setting('app.tenant_id', true), '') is null);
create policy tenant_users_provisioning_insert on tenant_users
  for insert with check (nullif(current_setting('app.tenant_id', true), '') is null);
-- Needed by postConfirmation.js's invite-redemption hard seat-cap check
-- (Task 5): it must count the tenant's CURRENT members at the moment of
-- actual join, inside runProvisioningTransaction, before app.tenant_id can
-- be set for the joining user. Without this, tenant_users_isolation alone
-- (a FOR ALL policy keyed on app.tenant_id) hides every row during
-- provisioning and the count query silently returns 0 regardless of the
-- tenant's real membership - not an error, just always the wrong,
-- always-safe-looking answer. Mirrors tenants_provisioning_select's shape
-- exactly, just for this table.
-- Scoped to "no app.tenant_id set" for the reason spelled out above.
create policy tenant_users_provisioning_select on tenant_users
  for select using (nullif(current_setting('app.tenant_id', true), '') is null);
create policy tenant_invites_provisioning_select on tenant_invites
  for select using (nullif(current_setting('app.tenant_id', true), '') is null);
create policy tenant_invites_provisioning_update on tenant_invites
  for update using (nullif(current_setting('app.tenant_id', true), '') is null);

-- ------------------------------------------------------------- transactions
--
-- tenant_id DEFAULT on this and the three business tables below: no
-- routes/*.js INSERT supplies a tenant_id, by design - the whole point of
-- the RLS model is that route SQL never handles tenant ids at all. Under
-- FORCE ROW LEVEL SECURITY that means every insert would fail its WITH
-- CHECK with nothing to check against, so the column defaults to the same
-- session GUC the policies read, which db.js's runInTenantTransaction has
-- always set before the first statement of the transaction runs. The
-- default supplies the value; the policy still independently verifies it,
-- so a client-supplied tenant_id can never override the session's.
create table transactions (
  id           bigint generated always as identity primary key,
  tenant_id    uuid not null default nullif(current_setting('app.tenant_id', true), '')::uuid references tenants(id) on delete cascade,
  date         date not null,
  type         text not null default 'Expense',
  category     text not null default 'Miscellaneous',
  subcategory  text default '',
  description  text default '',
  amount       numeric(12, 2) not null default 0, -- always positive; type carries sign
  payment      text default '',
  account      text default '',
  recurring    text not null default 'No',
  notes        text default '',
  person       text default ''
);
create index transactions_tenant_date_idx on transactions (tenant_id, date desc);

alter table transactions enable row level security;
alter table transactions force row level security;
create policy transactions_isolation on transactions
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- ------------------------------------------------------------------- budget
create table budget (
  tenant_id  uuid not null default nullif(current_setting('app.tenant_id', true), '')::uuid references tenants(id) on delete cascade,
  year       int not null,
  category   text not null,
  month      int not null check (month between 1 and 12),
  amount     numeric(12, 2) not null default 0,
  primary key (tenant_id, year, category, month)
);

alter table budget enable row level security;
alter table budget force row level security;
create policy budget_isolation on budget
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- ----------------------------------------------------------------- balances
create table balances (
  tenant_id  uuid not null default nullif(current_setting('app.tenant_id', true), '')::uuid references tenants(id) on delete cascade,
  date       date not null,
  account    text not null,
  amount     numeric(12, 2) not null default 0,
  owner      text default '',
  kind       text default 'Asset', -- Asset | Liability
  primary key (tenant_id, date, account)
);

alter table balances enable row level security;
alter table balances force row level security;
create policy balances_isolation on balances
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- -------------------------------------------------------------------- debts
create table debts (
  id          bigint generated always as identity primary key,
  tenant_id   uuid not null default nullif(current_setting('app.tenant_id', true), '')::uuid references tenants(id) on delete cascade,
  parent_id   bigint references debts(id) on delete cascade, -- null = the debt itself; set = a payment against it
  kind        text not null default 'Debt', -- Debt | Payment
  name        text default '',
  amount      numeric(12, 2) not null default 0,
  date        date,
  notes       text default ''
);
create index debts_tenant_parent_idx on debts (tenant_id, parent_id);

alter table debts enable row level security;
alter table debts force row level security;
create policy debts_isolation on debts
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- --------------------------------------------------------------- ai_imports
-- One row per extraction attempt that reached Bedrock and got a response
-- back (see backend/src/extract.js) - this is a cost-control record, not
-- a log of successful imports. A request that fails before Bedrock
-- responds (throttled, service error) never reaches the insert that
-- creates one of these rows.
create table ai_imports (
  id          bigint generated always as identity primary key,
  tenant_id   uuid not null default nullif(current_setting('app.tenant_id', true), '')::uuid references tenants(id) on delete cascade,
  created_at  timestamptz not null default now()
);
create index ai_imports_tenant_created_idx on ai_imports (tenant_id, created_at);

alter table ai_imports enable row level security;
alter table ai_imports force row level security;
create policy ai_imports_isolation on ai_imports
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
