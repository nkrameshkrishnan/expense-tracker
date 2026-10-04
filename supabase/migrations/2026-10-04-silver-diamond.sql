-- Adds silver and diamond support to an existing database. Safe to re-run.
-- (supabase/schema.sql already contains all of this for brand-new databases.)

alter table precious_metal_holdings
  drop constraint if exists precious_metal_holdings_metal_check;
alter table precious_metal_holdings
  add constraint precious_metal_holdings_metal_check
  check (metal in ('Gold', 'Silver', 'Diamond'));
alter table precious_metal_holdings
  add column if not exists purity_fineness numeric(5, 1)
  check (purity_fineness > 0 and purity_fineness <= 1000);
alter table precious_metal_holdings
  add column if not exists current_value numeric(12, 2)
  check (current_value >= 0);

-- Price history becomes one row per (date, metal) so silver can sit beside gold.
alter table gold_price_history drop constraint if exists gold_price_history_pkey;
alter table gold_price_history add primary key (date, metal);
alter table gold_price_history drop constraint if exists gold_price_history_metal_check;
alter table gold_price_history add constraint gold_price_history_metal_check
  check (metal in ('Gold', 'Silver'));
