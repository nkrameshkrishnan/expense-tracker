-- Ledger — Supabase schema + Row Level Security policies.
--
-- Supabase Auth verifies the signed Google ID token (see assets/store.js
-- signInWithGoogleIdToken) and every query below is scoped by RLS to only
-- the emails listed in allowed_emails. Without this file applied,
-- SUPABASE_ANON_KEY grants the same effective access as
-- SUPABASE_SECRET_KEY to anyone who loads the page — see README.md
-- "Setting up Supabase" before using this.
--
-- Apply once: paste into Supabase Dashboard -> SQL Editor -> New query -> Run,
-- or `supabase db execute --file supabase/schema.sql` against your project.

-- ============================================================ allow-list
create table if not exists allowed_emails (
  email text primary key
);

-- Edit this list to the household's actual emails.
insert into allowed_emails (email) values
  ('ramesh@example.com'),
  ('surya@example.com')
on conflict (email) do nothing;

-- RLS, no policies: the table this whole access-control system is built on
-- must never be directly readable or writable by a client - not even by a
-- signed-in household member. With RLS enabled and zero policies, every
-- direct query against it is denied by default for anon/authenticated
-- roles; is_allowed_household_member() below can still read it because it
-- is SECURITY DEFINER, which runs as the function owner and bypasses RLS
-- for that one internal query. Without this, the default Supabase grants on
-- public-schema tables would let the anon key alone SELECT this list (an
-- email leak) or INSERT/DELETE it (self-granting access to every other
-- table by adding your own email to the allow-list).
alter table allowed_emails enable row level security;

-- Every policy below reuses this: true only for a signed-in session whose
-- JWT email claim is on the list. auth.jwt() is only populated for an
-- authenticated request, so an anonymous (anon-key-only, no session) request
-- always evaluates to false here — the anon key alone grants nothing.
create or replace function is_allowed_household_member()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from allowed_emails
    where email = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

-- ============================================================ transactions
create table if not exists transactions (
  id bigint generated always as identity primary key,
  date date not null,
  type text not null check (type in ('Expense', 'Income', 'Transfer', 'Dividends', 'Refund')),
  category text not null default 'Miscellaneous',
  subcategory text not null default '',
  description text not null default '',
  -- Amount is always positive; type carries the sign — same rule enforced in
  -- assets/store.js normalise(). Enforced here too so a direct Supabase
  -- write can't bypass it.
  amount numeric(12, 2) not null check (amount >= 0),
  payment text not null default '',
  account text not null default '',
  recurring text not null default 'No' check (recurring in ('Yes', 'No')),
  notes text not null default '',
  person text not null default '',
  -- The currency `amount` is actually denominated in. Almost everything is
  -- CAD; INR/AED cover a purchase or remittance made in that currency.
  -- `amount` is NEVER converted in place - it stays exactly what was on the
  -- statement, and fx_rate is the separate, explicit multiplier that gets
  -- you to CAD (see assets/constants.js's amountCad()). Every dashboard/
  -- budget total is computed FROM these two fields, never from `amount`
  -- alone - a raw sum across currencies would add rupees to dollars.
  currency text not null default 'CAD' check (currency in ('CAD', 'INR', 'AED')),
  -- CAD per one unit of `currency` - 1 for a CAD row (amount is already CAD,
  -- so the multiplier is a no-op), the day's rate for INR/AED, filled from
  -- exchange_rates (see fetch-fx-rates.yml) but always hand-editable, since
  -- a card statement's own posted CAD-equivalent line is the more accurate
  -- number when it's available.
  fx_rate numeric(12, 6) not null default 1 check (fx_rate > 0)
);

-- 'Refund' was added to the allowed types after the table first shipped.
-- `create table if not exists` above never touches an existing table, so
-- re-running this file on an older database would keep the old 4-type check
-- and reject Refund rows - replace the constraint explicitly instead.
alter table transactions drop constraint if exists transactions_type_check;
alter table transactions add constraint transactions_type_check
  check (type in ('Expense', 'Income', 'Transfer', 'Dividends', 'Refund'));

-- currency/fx_rate were added after the table first shipped, same situation
-- as Refund above - `add column if not exists` backfills every existing row
-- with the default (CAD / 1), which is exactly correct: every row already in
-- the table really was recorded in CAD.
alter table transactions add column if not exists currency text not null default 'CAD';
alter table transactions drop constraint if exists transactions_currency_check;
alter table transactions add constraint transactions_currency_check
  check (currency in ('CAD', 'INR', 'AED'));
alter table transactions add column if not exists fx_rate numeric(12, 6) not null default 1;
alter table transactions drop constraint if exists transactions_fx_rate_check;
alter table transactions add constraint transactions_fx_rate_check check (fx_rate > 0);

alter table transactions enable row level security;

create policy "household can read transactions" on transactions
  for select using (is_allowed_household_member());
create policy "household can write transactions" on transactions
  for insert with check (is_allowed_household_member());
create policy "household can update transactions" on transactions
  for update using (is_allowed_household_member()) with check (is_allowed_household_member());
create policy "household can delete transactions" on transactions
  for delete using (is_allowed_household_member());

-- ============================================================ budget
create table if not exists budget (
  year int not null,
  category text not null,
  month int not null check (month between 1 and 12),
  -- Zero means "not budgeted" per assets/store.js emptyBudget() / README —
  -- stored as a real zero row rather than omitted, matching the Sheets model.
  amount numeric(12, 2) not null default 0,
  primary key (year, category, month)
);

alter table budget enable row level security;

create policy "household can read budget" on budget
  for select using (is_allowed_household_member());
create policy "household can write budget" on budget
  for insert with check (is_allowed_household_member());
create policy "household can update budget" on budget
  for update using (is_allowed_household_member()) with check (is_allowed_household_member());
create policy "household can delete budget" on budget
  for delete using (is_allowed_household_member());

-- ============================================================ balances
-- Net worth snapshots: one row per account per date. Composite key enforced
-- here the same way the Sheets Balances tab enforces it manually.
create table if not exists balances (
  date date not null,
  account text not null,
  owner text not null default '',
  kind text not null check (kind in ('Asset', 'Liability')),
  balance numeric(14, 2) not null,
  notes text not null default '',
  -- Same currency/fx_rate shape as transactions above, and the same reason:
  -- an INR bank account or AED cash balance is entered in its own currency,
  -- never converted in place, with fx_rate as the explicit CAD multiplier
  -- net worth totals apply (see assets/constants.js's amountCad()).
  currency text not null default 'CAD' check (currency in ('CAD', 'INR', 'AED')),
  fx_rate numeric(12, 6) not null default 1 check (fx_rate > 0),
  primary key (date, account)
);

alter table balances add column if not exists currency text not null default 'CAD';
alter table balances drop constraint if exists balances_currency_check;
alter table balances add constraint balances_currency_check
  check (currency in ('CAD', 'INR', 'AED'));
alter table balances add column if not exists fx_rate numeric(12, 6) not null default 1;
alter table balances drop constraint if exists balances_fx_rate_check;
alter table balances add constraint balances_fx_rate_check check (fx_rate > 0);

alter table balances enable row level security;

create policy "household can read balances" on balances
  for select using (is_allowed_household_member());
create policy "household can write balances" on balances
  for insert with check (is_allowed_household_member());
create policy "household can update balances" on balances
  for update using (is_allowed_household_member()) with check (is_allowed_household_member());
create policy "household can delete balances" on balances
  for delete using (is_allowed_household_member());

-- ============================================================ debts
-- Column shape verified against a real export (Expense_Tracker_2026.xlsx's
-- Debts tab: ID, Kind, ParentID, Counterparty, Direction, Description, Date,
-- Amount, Owner, Notes) rather than inferred - counterparty and direction
-- are always populated on both Debt and Payment rows in real data.
create table if not exists debts (
  id bigint generated always as identity primary key,
  parent_id bigint references debts (id) on delete cascade,
  kind text not null check (kind in ('Debt', 'Payment')),
  counterparty text not null,
  direction text not null check (direction in ('Owed', 'Lent')),
  description text not null default '',
  date date not null,
  amount numeric(12, 2) not null check (amount >= 0),
  owner text not null default '',
  notes text not null default ''
);

alter table debts enable row level security;

create policy "household can read debts" on debts
  for select using (is_allowed_household_member());
create policy "household can write debts" on debts
  for insert with check (is_allowed_household_member());
create policy "household can update debts" on debts
  for update using (is_allowed_household_member()) with check (is_allowed_household_member());
create policy "household can delete debts" on debts
  for delete using (is_allowed_household_member());

-- ============================================================ precious_metal_holdings
-- Purchase lots, not a running balance: each buy is its own row so average
-- cost/gram and unrealized gain are derived, never hand-calculated - the
-- same reasoning debts.outstanding uses payment history instead of a
-- stored running total.
create table if not exists precious_metal_holdings (
  id bigint generated always as identity primary key,
  metal text not null default 'Gold' check (metal in ('Gold')),
  weight_grams numeric(10, 3) not null check (weight_grams > 0),
  price_per_gram numeric(10, 2) not null check (price_per_gram >= 0),
  purchase_date date not null,
  owner text not null default '',
  notes text not null default ''
);

alter table precious_metal_holdings enable row level security;

create policy "household can read metal holdings" on precious_metal_holdings
  for select using (is_allowed_household_member());
create policy "household can write metal holdings" on precious_metal_holdings
  for insert with check (is_allowed_household_member());
create policy "household can update metal holdings" on precious_metal_holdings
  for update using (is_allowed_household_member()) with check (is_allowed_household_member());
create policy "household can delete metal holdings" on precious_metal_holdings
  for delete using (is_allowed_household_member());

-- ============================================================ gold_price_history
-- Written exclusively by the fetch-gold-price.yml GitHub Actions workflow
-- using the Supabase project's secret key (Project Settings -> API Keys ->
-- Secret keys - the current API key system's replacement for the older
-- service_role key), which bypasses RLS entirely (same trust boundary
-- migrate.mjs already uses over a raw pg connection) - so
-- this table gets a read policy for the household and deliberately no
-- insert/update/delete policy for anon/authenticated, the same
-- zero-direct-write shape allowed_emails uses for a different reason.
create table if not exists gold_price_history (
  date date primary key,
  metal text not null default 'Gold',
  price_per_gram_cad numeric(10, 2) not null,
  fetched_at timestamptz not null default now()
);

alter table gold_price_history enable row level security;

create policy "household can read gold price history" on gold_price_history
  for select using (is_allowed_household_member());

-- ============================================================ exchange_rates
-- One CAD-per-unit rate per (date, currency), written exclusively by the
-- fetch-fx-rates.yml GitHub Actions workflow via the Supabase secret key -
-- same trust boundary and same read-only-for-the-household shape as
-- gold_price_history just above. Only non-CAD currencies get a row here
-- (CAD-to-CAD is always exactly 1 and never needs a lookup).
create table if not exists exchange_rates (
  date date not null,
  currency text not null check (currency in ('INR', 'AED')),
  rate_to_cad numeric(12, 8) not null check (rate_to_cad > 0),
  fetched_at timestamptz not null default now(),
  primary key (date, currency)
);

alter table exchange_rates enable row level security;

create policy "household can read exchange rates" on exchange_rates
  for select using (is_allowed_household_member());

-- ============================================================ household access (Profile page)
-- Lets a signed-in household member see and manage who else is on the
-- allow-list, without ever granting direct SELECT/INSERT/DELETE on
-- allowed_emails itself (see the comment on that table above). Each
-- function re-checks is_allowed_household_member() itself, the same guard
-- every policy above relies on - a Google account that authenticates but
-- isn't on the list gets an empty list / a raised exception here, not a
-- crash, the same "silently see nothing" shape RLS already gives every
-- other table.
create or replace function list_allowed_emails()
returns setof text
language sql
stable
security definer
set search_path = public
as $$
  select email from allowed_emails
  where is_allowed_household_member()
  order by email;
$$;

create or replace function add_allowed_email(new_email text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_allowed_household_member() then
    raise exception 'Not authorized';
  end if;
  insert into allowed_emails (email) values (lower(trim(new_email)))
  on conflict (email) do nothing;
end;
$$;

create or replace function remove_allowed_email(target_email text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_allowed_household_member() then
    raise exception 'Not authorized';
  end if;
  -- Guards against locking every household member out at once - the same
  -- failure mode the allowed_emails RLS comment above warns about, just
  -- reachable this time through a legitimate management action instead of
  -- a compromised anon key.
  if (select count(*) from allowed_emails) <= 1 then
    raise exception 'Cannot remove the last remaining email — this would lock everyone out.';
  end if;
  delete from allowed_emails where email = lower(trim(target_email));
end;
$$;

-- ============================================================ verify
-- After applying, confirm RLS actually blocks an unauthenticated request:
--   curl "$SUPABASE_URL/rest/v1/transactions?select=*" \
--     -H "apikey: $SUPABASE_ANON_KEY" -H "Authorization: Bearer $SUPABASE_ANON_KEY"
-- Expected: an empty array `[]`, not real rows. If you see actual data back,
-- RLS is not enabled correctly on that table — stop and fix before setting
-- SUPABASE_URL/SUPABASE_ANON_KEY in this app.
