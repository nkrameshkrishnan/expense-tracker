-- Ledger: Google Sheets -> Supabase (Postgres) schema.
-- Run this exactly as-is in the Supabase SQL Editor for a real project.
-- The `auth` schema referenced below (auth.uid(), auth.jwt()) is provided
-- automatically by Supabase - it does NOT need to be created there.
-- (This repo's own test harness creates a faithful local stand-in for it
-- separately, in 000_local_auth_stub.sql, purely so RLS can be tested
-- against a real Postgres without a live Supabase project.)

create table transactions (
  id            bigint generated always as identity primary key,
  date          date          not null,
  type          text          not null check (type in ('Expense','Income','Transfer','Dividends')),
  category      text          not null,
  subcategory   text,
  description   text,
  amount        numeric(12,2) not null,
  payment       text,
  account       text,
  recurring     text          not null default 'No',
  notes         text,
  person        text
);
create index ix_tx_date on transactions (date);

create table budget (
  year int not null, category text not null, month smallint not null,
  amount numeric(12,2) not null,
  primary key (year, category, month)
);

create table balances (
  date date not null, account text not null, owner text,
  kind text not null check (kind in ('Asset','Liability')),
  balance numeric(14,2) not null, notes text,
  primary key (date, account)
);

create table debts (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('Debt','Payment')),
  parent_id bigint references debts(id) on delete cascade,
  counterparty text not null, direction text not null,
  description text, date date not null, amount numeric(12,2) not null,
  owner text, notes text
);

-- Row Level Security: mirrors Code.gs's ALLOWED_EMAILS exactly - "is this
-- signed-in user one of our two household members", granting access to the
-- SHARED tables. A per-row owner_id model would have meant Surya couldn't
-- see Ramesh's transactions - the opposite of the current shared-sheet
-- behaviour, so this deliberately checks household membership, not
-- row ownership.
alter table transactions enable row level security;
alter table budget       enable row level security;
alter table balances     enable row level security;
alter table debts        enable row level security;

create policy "household members only" on transactions
  for all
  using       (auth.jwt() ->> 'email' in ('ramesh@gmail.com', 'surya@gmail.com'))
  with check  (auth.jwt() ->> 'email' in ('ramesh@gmail.com', 'surya@gmail.com'));

create policy "household members only" on budget
  for all
  using       (auth.jwt() ->> 'email' in ('ramesh@gmail.com', 'surya@gmail.com'))
  with check  (auth.jwt() ->> 'email' in ('ramesh@gmail.com', 'surya@gmail.com'));

create policy "household members only" on balances
  for all
  using       (auth.jwt() ->> 'email' in ('ramesh@gmail.com', 'surya@gmail.com'))
  with check  (auth.jwt() ->> 'email' in ('ramesh@gmail.com', 'surya@gmail.com'));

create policy "household members only" on debts
  for all
  using       (auth.jwt() ->> 'email' in ('ramesh@gmail.com', 'surya@gmail.com'))
  with check  (auth.jwt() ->> 'email' in ('ramesh@gmail.com', 'surya@gmail.com'));
