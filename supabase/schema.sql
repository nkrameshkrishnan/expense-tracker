-- Ledger — Supabase schema + Row Level Security policies.
--
-- Mirrors ALLOWED_EMAILS in google-apps-script/Code.gs: instead of a signed
-- Google ID token being checked server-side by Apps Script, here Supabase
-- Auth itself verifies the token (see assets/store.js signInWithGoogleIdToken)
-- and every query below is scoped by RLS to only the emails listed in
-- allowed_emails. Without this file applied, SUPABASE_ANON_KEY grants the
-- same effective access as SUPABASE_SECRET_KEY to anyone who loads the page —
-- see README.md "Supabase (optional, experimental)" before using this.
--
-- Apply once: paste into Supabase Dashboard -> SQL Editor -> New query -> Run,
-- or `supabase db execute --file supabase/schema.sql` against your project.

-- ============================================================ allow-list
create table if not exists allowed_emails (
  email text primary key
);

-- Edit this list to match ALLOWED_EMAILS in Code.gs.
insert into allowed_emails (email) values
  ('ramesh@example.com'),
  ('surya@example.com')
on conflict (email) do nothing;

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
  type text not null check (type in ('Expense', 'Income', 'Transfer', 'Dividends')),
  category text not null default 'Miscellaneous',
  subcategory text not null default '',
  description text not null default '',
  -- Amount is always positive; type carries the sign — same rule enforced in
  -- assets/store.js normalise() and google-apps-script/Code.gs. Enforced here
  -- too so a direct Supabase write can't bypass it.
  amount numeric(12, 2) not null check (amount >= 0),
  payment text not null default '',
  account text not null default '',
  recurring text not null default 'No' check (recurring in ('Yes', 'No')),
  notes text not null default '',
  person text not null default ''
);

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
  primary key (date, account)
);

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
-- assets/store.js's SupabaseStore passes debt records through mostly
-- unshaped (insert(record) / update(record)), so this schema is inferred
-- from the accounting model in README.md ("Debts & Loans") rather than a
-- hardcoded client-side shape — adjust columns here if your actual records
-- carry different fields before applying.
create table if not exists debts (
  id bigint generated always as identity primary key,
  parent_id bigint references debts (id) on delete cascade,
  kind text not null check (kind in ('Debt', 'Payment')),
  direction text check (direction in ('Owed', 'Lent')),
  date date not null,
  person text not null default '',
  amount numeric(12, 2) not null check (amount >= 0),
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

-- ============================================================ verify
-- After applying, confirm RLS actually blocks an unauthenticated request:
--   curl "$SUPABASE_URL/rest/v1/transactions?select=*" \
--     -H "apikey: $SUPABASE_ANON_KEY" -H "Authorization: Bearer $SUPABASE_ANON_KEY"
-- Expected: an empty array `[]`, not real rows. If you see actual data back,
-- RLS is not enabled correctly on that table — stop and fix before setting
-- SUPABASE_URL/SUPABASE_ANON_KEY in this app.
