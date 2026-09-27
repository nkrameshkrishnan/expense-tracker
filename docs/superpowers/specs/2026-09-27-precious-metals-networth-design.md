# Precious Metals Tracking on Net Worth — Design

**Status:** Approved by user, ready for implementation planning.

## Problem

Net Worth today tracks account balances (`balances` table) and debts, but has
no way to record a physical asset like gold — something you hold a _weight_
of rather than a dollar balance, whose value moves with a daily market price
you don't control or manually track. Recording it as a plain balance would
require manually recalculating and re-entering its dollar value every time
gold's price changes, which defeats the point of having a live price.

## Scope

**In scope:**

- A `precious_metal_holdings` table: purchase lots (weight + price paid),
  generic across metals but defaulting to `Gold`.
- A `gold_price_history` table: one row per day, populated by a scheduled
  GitHub Actions workflow that calls `https://api.goldprice.dev` — no
  Supabase Edge Function involved.
- A new "Precious metals" section on the Net Worth page: an add/delete lot
  form, and 4 tiles (value, average cost/gram, unrealized gain, price
  appreciation).
- Holdings value folds automatically into the existing "Assets" KPI on Net
  Worth.
- Supabase-only feature, consistent with how Net Worth already treats
  non-Supabase backends as a degraded local-only mode.

**Out of scope:**

- Other metals beyond gold in practice — the schema supports a `metal`
  column for future silver/platinum support, but the price-fetch workflow,
  UI copy, and unit conversion in this pass are gold-only. Adding another
  metal later means adding another daily price-fetch job and extending the
  UI's metal picker — not a schema change.
- Currency conversion — the app is CAD-only throughout (see
  `2026-08-23-multi-currency-design.md`); `goldprice.dev`'s `XAU-CAD-SPOT`
  symbol is used directly.
- LocalStore/MemoryStore support — see "Backend scoping" below.
- Historical backfill of `gold_price_history` before this feature ships —
  the table starts recording from whenever the workflow first runs.

## Architecture

### 1. Data model (`supabase/schema.sql`)

```sql
-- ============================================================ precious_metal_holdings
-- Purchase lots, not a running balance: each buy is its own row so average
-- cost/gram and unrealized gain are derived, never hand-calculated, the
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
-- using the Supabase service-role key, which bypasses RLS entirely (same
-- trust boundary migrate.mjs already uses over a raw pg connection) - so
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
```

`metal in ('Gold')` is a deliberately narrow check constraint reflecting
"out of scope: other metals in practice" above — widening it later is a one-
line `alter table ... drop constraint / add constraint`, same pattern the
schema already uses for `transactions_type_check`.

### 2. GitHub Actions workflow (`.github/workflows/fetch-gold-price.yml`)

- `on: schedule` (daily, e.g. `cron: '0 13 * * *'` — mid-morning Eastern) plus
  `workflow_dispatch` for manual testing.
- Steps: `curl` `https://api.goldprice.dev/v1/prices?symbol=XAU-CAD-SPOT`,
  extract `.symbols[0].price` (CAD per troy ounce), divide by
  `31.1034768` to get price per gram, then `curl -X POST` to
  `$SUPABASE_URL/rest/v1/gold_price_history` with
  `Prefer: resolution=merge-duplicates` (upsert on the `date` primary key —
  makes a re-run same-day idempotent) using headers `apikey` and
  `Authorization: Bearer` set to a new repo secret,
  `SUPABASE_SERVICE_ROLE_KEY` (service-role, not anon — this is the only
  writer to a table with no client-facing write policy).
- Secrets needed: `SUPABASE_URL` (already exists for `deploy.yml`),
  `SUPABASE_SERVICE_ROLE_KEY` (new — must be added to repo Secrets; this key
  is powerful and must never be injected into `assets/config.js` or any
  client-visible file, unlike the anon key).
- Failure handling: if the curl to goldprice.dev fails or returns
  unexpected shape, the step exits non-zero and the workflow run shows
  failed in the Actions tab — no retry logic, no silent fallback. A missed
  day just means yesterday's price is still the latest row the UI reads.

### 3. `assets/stores/supabase-store.js`

Four new methods on `SupabaseStore`, following the existing
`_normDebt`/`_toDbDebt` snake_case⇄camelCase translation pattern:

- `listMetalHoldings()` → reads `precious_metal_holdings`, maps
  `weight_grams`/`price_per_gram`/`purchase_date` to camelCase.
- `addMetalHolding({ metal, weightGrams, pricePerGram, purchaseDate, owner, notes })`
  → inserts one row.
- `deleteMetalHolding(id)` → deletes one row.
- `getLatestGoldPrice()` → `select * from gold_price_history order by date desc limit 1`,
  returns `{ date, pricePerGramCad }` or `null` if the table is empty (e.g.
  workflow hasn't run yet).

LocalStore and MemoryStore do **not** implement these methods — see backend
scoping below.

### 4. `assets/pages/networth.js`

A new "Precious metals" section, rendered only when `isRemoteStore(state.store)`
is true (same gating as the existing Supabase-only warning banner already on
this page); when false, render a short notice in its place: "Connect to
Supabase under Data → Supabase to track precious metals — this section isn't
available on the local/offline backend."

When available:

- **Lots table**: date, metal, weight (g), price paid/g, owner, a computed
  "value today" column (`weight × latest price`), delete button per row.
- **Add-lot form**: metal (a `<select>` with just `Gold` for now, matching
  the schema's current constraint), weight in grams, price paid per gram,
  purchase date (defaults to today), owner (reuses `PEOPLE`).
- **4 KPI tiles**, computed from `listMetalHoldings()` + `getLatestGoldPrice()`:
  1. **Value** — Σ(`weightGrams`) × latest price/gram.
  2. **Avg cost/gram** — Σ(`weightGrams × pricePerGram`) / Σ(`weightGrams`),
     i.e. weighted average across all lots.
  3. **Unrealized gain** — (latest price/gram − avg cost/gram) × total grams,
     shown as both a $ amount and a % (`/ total cost basis`). Colored
     pos/neg like the existing "Change" tile.
  4. **Price appreciation** — latest price/gram vs. the earliest
     `gold_price_history` row dated on/after the earliest lot's
     `purchaseDate`; if no such row exists (tracking started after the
     oldest lot was bought), fall back to the _earliest available_
     `gold_price_history` row and label the tile's subtext "since tracking
     began <date>" instead of "since first purchase" so the number isn't
     misleading.
  - If `getLatestGoldPrice()` returns `null` (workflow hasn't populated the
    table yet), all four tiles show "—" with a note: "No price data yet —
    the daily price fetch hasn't run."

- **Net worth integration**: in `renderNetWorth()`, `assets` gains a third
  term — `metalsValue` (tile 1's number) — alongside the existing
  `sumOf(latest, "Asset")` and `dnw.receivable`. The by-account table and
  "By account" section are unaffected; metals are a separate line, not
  folded into the accounts table, to avoid conflating a computed value with
  a manually-recorded balance.

### Backend scoping

Per user decision: this feature is Supabase-only. LocalStore/MemoryStore
users see a "connect to Supabase" notice instead of the section, the same
pattern the page already uses for its top-of-page banner when
`!isRemoteStore(state.store)`. No IndexedDB schema changes, no MemoryStore
in-memory array for holdings.

### Testing

- `node --check` on all touched JS files (existing CI step in
  `deploy.yml` already does this on push; run locally during development
  too).
- Manual verification against a real Supabase project: apply the schema
  additions, run the workflow once via `workflow_dispatch`, confirm a row
  lands in `gold_price_history`, add a test lot in the UI, confirm all 4
  tiles compute correctly and the Net Worth "Assets" KPI includes the
  metals value.
- Verify RLS: an anon-key-only request to `gold_price_history` should
  return `[]` (same verification pattern as the file's existing trailing
  comment), confirming the read policy requires a signed-in household
  member and the missing write policies block anon/authenticated writes.
