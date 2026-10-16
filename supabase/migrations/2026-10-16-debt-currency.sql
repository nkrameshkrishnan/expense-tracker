-- Multi-currency debts. Safe to re-run. Existing rows become CAD at rate 1.
alter table debts add column if not exists currency text not null default 'CAD';
alter table debts add column if not exists fx_rate numeric(12,6) not null default 1;
alter table debts add column if not exists paid_currency text;
alter table debts add column if not exists paid_amount numeric(12,2);

alter table debts drop constraint if exists debts_currency_check;
alter table debts add constraint debts_currency_check check (currency in ('CAD','INR','AED'));
alter table debts drop constraint if exists debts_fx_rate_check;
alter table debts add constraint debts_fx_rate_check check (fx_rate > 0);
alter table debts drop constraint if exists debts_paid_currency_check;
alter table debts add constraint debts_paid_currency_check check (paid_currency is null or paid_currency in ('CAD','INR','AED'));
alter table debts drop constraint if exists debts_paid_amount_check;
alter table debts add constraint debts_paid_amount_check check (paid_amount is null or paid_amount >= 0);
