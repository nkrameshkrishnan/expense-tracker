# Precious Metals Tracking on Net Worth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a household record physical gold purchase lots (weight + price paid) on the Net Worth page, see 4 auto-computed KPI tiles (value, average cost/gram, unrealized gain, price appreciation) driven by a daily gold price fetched into Supabase by a GitHub Actions workflow, and have that value fold automatically into the page's existing "Assets" total.

**Architecture:** Two new Supabase tables — `precious_metal_holdings` (purchase lots, RLS read/write for the household) and `gold_price_history` (one row/day, RLS read-only for the household, written exclusively by a new scheduled GitHub Actions workflow using the service-role key, no Edge Function involved). `SupabaseStore` gets 4 new methods mirroring its existing `debts`/`balances` patterns. A new `assets/pages/metals.js` module (mirroring `assets/pages/debts.js`'s shape: pure summary/math functions + a render function + a handler-wiring function) is imported into `assets/pages/networth.js`, which renders its section and folds its computed value into the page's `assets` total. LocalStore/MemoryStore do not implement the new store methods — the section is hidden and replaced with a "connect to Supabase" notice when `!isRemoteStore(state.store)`, the same gating the page already uses for its top banner.

**Tech Stack:** Vanilla ES modules (no bundler, no test runner — this repo's established constraint), Supabase Postgres + RLS, GitHub Actions scheduled workflow, `api.goldprice.dev` (no API key required).

**Spec:** docs/superpowers/specs/2026-09-27-precious-metals-networth-design.md

## Global Constraints

- No test runner in this repo — every JS task is verified via `node --check` (copy to `.mjs` for real ES-module syntax checking, same trick `deploy.yml` already uses) plus manual verification against a real Supabase project. No `pytest`/`node --test` files get created for this feature.
- `metal in ('Gold')` is a deliberately narrow check constraint for now — only Gold is supported end-to-end in this pass (workflow, unit conversion, UI copy all assume Gold).
- Currency is always CAD — no conversion, matches the rest of this app.
- This feature is Supabase-only: LocalStore/MemoryStore never implement the 4 new store methods; the UI hides the section and shows a notice instead when `!isRemoteStore(state.store)`.
- `SUPABASE_SERVICE_ROLE_KEY` is a new, powerful repo secret — it must only ever be referenced inside `.github/workflows/fetch-gold-price.yml`, never written into `assets/config.js` or any client-visible file.
- 1 troy ounce = 31.1034768 grams (exact conversion factor used in both the GitHub Actions workflow and anywhere the UI needs it).
- All new SupabaseStore methods follow the existing `dbError()`-wrapping / cache-update pattern already used by `addDebt`/`deleteDebt`/`setBalances` in `assets/stores/supabase-store.js`.

---

### Task 1: Database schema — `precious_metal_holdings` and `gold_price_history`

**Files:**

- Modify: `supabase/schema.sql`

**Interfaces:**

- Consumes: nothing from other tasks.
- Produces: the `precious_metal_holdings` table (columns: `id`, `metal`, `weight_grams`, `price_per_gram`, `purchase_date`, `owner`, `notes`) and `gold_price_history` table (columns: `date` primary key, `metal`, `price_per_gram_cad`, `fetched_at`) that Task 2 (GitHub Actions workflow) writes to and Task 3 (SupabaseStore methods) reads/writes.

- [ ] **Step 1: Append the new tables to `supabase/schema.sql`**

Open `supabase/schema.sql` and find the end of the `debts` section (right after the `create policy "household can delete debts" on debts ...` block, before the `-- ============================================================ household access (Profile page)` comment). Insert this new section there:

```sql
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

- [ ] **Step 2: Apply the schema to your Supabase project**

Open your Supabase project's Dashboard → SQL Editor → New query, paste the full contents of `supabase/schema.sql` (or just the two new `create table`/policy blocks above, since `create table if not exists` is safe to re-run), and Run.

- [ ] **Step 3: Verify RLS on the new tables**

Run (substituting your project's values):

```bash
curl "$SUPABASE_URL/rest/v1/gold_price_history?select=*" \
  -H "apikey: $SUPABASE_ANON_KEY" -H "Authorization: Bearer $SUPABASE_ANON_KEY"
curl "$SUPABASE_URL/rest/v1/precious_metal_holdings?select=*" \
  -H "apikey: $SUPABASE_ANON_KEY" -H "Authorization: Bearer $SUPABASE_ANON_KEY"
```

Expected: both return `[]` (anon key alone, no signed-in session, is denied by RLS — same verification the file's own trailing comment already documents for other tables).

- [ ] **Step 4: Commit**

```bash
git add supabase/schema.sql
git commit -m "Add precious_metal_holdings and gold_price_history tables"
```

---

### Task 2: GitHub Actions workflow to fetch the daily gold price

**Files:**

- Create: `.github/workflows/fetch-gold-price.yml`

**Interfaces:**

- Consumes: `precious_metal_holdings`/`gold_price_history` schema from Task 1 (table names and column names must match exactly: `date`, `metal`, `price_per_gram_cad`, `fetched_at`).
- Produces: a daily upserted row in `gold_price_history` that Task 3's `getLatestGoldPrice()` reads.

- [ ] **Step 1: Write the workflow file**

Create `.github/workflows/fetch-gold-price.yml`:

```yaml
name: Fetch daily gold price

# Fetches the spot gold price (CAD, per troy ounce) from goldprice.dev, converts
# to price-per-gram, and upserts today's row into gold_price_history via the
# Supabase REST API using the service-role key (bypasses RLS - this table has
# no insert/update policy for anon/authenticated, see supabase/schema.sql).
# No Supabase Edge Function is involved; this workflow is the entire pipeline.

on:
  schedule:
    - cron: "0 13 * * *" # ~9am Eastern (UTC-4/5) daily
  workflow_dispatch:

jobs:
  fetch-price:
    runs-on: ubuntu-latest
    steps:
      - name: Fetch spot price and upsert into Supabase
        env:
          SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
          SUPABASE_SERVICE_ROLE_KEY: ${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}
        run: |
          set -euo pipefail

          if [ -z "$SUPABASE_URL" ] || [ -z "$SUPABASE_SERVICE_ROLE_KEY" ]; then
            echo "::error::SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not set as repo secrets. Skipping fetch."
            exit 1
          fi

          RESPONSE=$(curl -sf "https://api.goldprice.dev/v1/prices?symbol=XAU-CAD-SPOT")
          PRICE_PER_OUNCE=$(echo "$RESPONSE" | node -e '
            let data = "";
            process.stdin.on("data", d => data += d);
            process.stdin.on("end", () => {
              const parsed = JSON.parse(data);
              const price = Number(parsed.symbols[0].price);
              if (!isFinite(price) || price <= 0) { throw new Error("bad price: " + parsed.symbols[0].price); }
              console.log(price);
            });
          ')

          # 1 troy ounce = 31.1034768 grams.
          PRICE_PER_GRAM=$(node -e "console.log(($PRICE_PER_OUNCE / 31.1034768).toFixed(2))")
          TODAY=$(date -u +%F)

          echo "Gold price: \$$PRICE_PER_OUNCE/oz -> \$$PRICE_PER_GRAM/g on $TODAY"

          curl -sf -X POST "$SUPABASE_URL/rest/v1/gold_price_history" \
            -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
            -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
            -H "Content-Type: application/json" \
            -H "Prefer: resolution=merge-duplicates" \
            -d "{\"date\": \"$TODAY\", \"metal\": \"Gold\", \"price_per_gram_cad\": $PRICE_PER_GRAM}"

          echo "Upserted successfully."
```

- [ ] **Step 2: Validate the YAML and shell logic**

Run: `node --check .github/workflows/fetch-gold-price.yml 2>&1 | grep -v SyntaxError || true` — actually YAML isn't JS, so instead just visually confirm indentation and run a local dry run of the price-conversion math:

```bash
node -e 'console.log((6037.08378683 / 31.1034768).toFixed(2))'
```

Expected: prints a plausible gold price per gram (e.g. `194.10`), confirming the conversion formula is correct before it ever touches a real workflow run.

- [ ] **Step 3: Add the `SUPABASE_SERVICE_ROLE_KEY` repo secret**

In GitHub → repo Settings → Secrets and variables → Actions, add a new secret `SUPABASE_SERVICE_ROLE_KEY` with your Supabase project's service-role key (Project Settings → API → service_role key in the Supabase dashboard). Confirm `SUPABASE_URL` already exists as a secret (it does, per `deploy.yml`).

- [ ] **Step 4: Trigger the workflow manually and verify**

In GitHub → Actions → "Fetch daily gold price" → Run workflow (uses `workflow_dispatch`). After it completes, check the run's logs for "Upserted successfully", then verify the row landed:

```bash
curl "$SUPABASE_URL/rest/v1/gold_price_history?select=*&order=date.desc&limit=1" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"
```

Expected: one row with today's date and a plausible `price_per_gram_cad`.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/fetch-gold-price.yml
git commit -m "Add daily gold price fetch workflow"
```

---

### Task 3: `SupabaseStore` methods for holdings and price history

**Files:**

- Modify: `assets/stores/supabase-store.js`

**Interfaces:**

- Consumes: `precious_metal_holdings`/`gold_price_history` tables from Task 1.
- Produces (all on `SupabaseStore` instances):
  - `listMetalHoldings()` → `Promise<Array<{id: number, metal: string, weightGrams: number, pricePerGram: number, purchaseDate: string, owner: string, notes: string}>>`
  - `addMetalHolding({metal, weightGrams, pricePerGram, purchaseDate, owner, notes})` → `Promise<number>` (new row's id)
  - `deleteMetalHolding(id)` → `Promise<void>`
  - `getLatestGoldPrice()` → `Promise<{date: string, pricePerGramCad: number} | null>`

  Task 5 (`assets/pages/metals.js`) calls all four with these exact names/shapes. Task 6 (`assets/core.js`'s `refresh()`) calls `listMetalHoldings()` and `getLatestGoldPrice()`.

- [ ] **Step 1: Add cache fields and loading for metal holdings in `_loadYear`**

Open `assets/stores/supabase-store.js`. In `_loadYear(year)` (around line 106), add a 5th parallel query and a 5th destructured result:

```javascript
  async _loadYear(year) {
    const sb = await this._client();
    const [
      { data: tx, error: e1 },
      { data: bg, error: e2 },
      { data: bal, error: e3 },
      { data: debts, error: e4 },
      { data: holdings, error: e5 },
    ] = await Promise.all([
      selectAllRows((from, to) =>
        sb
          .from("transactions")
          .select("*")
          .gte("date", `${year}-01-01`)
          .lte("date", `${year}-12-31`)
          .order("date", { ascending: false })
          .range(from, to),
      ),
      selectAllRows((from, to) =>
        sb.from("budget").select("*").eq("year", year).range(from, to),
      ),
      selectAllRows((from, to) =>
        sb
          .from("balances")
          .select("*")
          .order("date", { ascending: false })
          .range(from, to),
      ),
      selectAllRows((from, to) => sb.from("debts").select("*").range(from, to)),
      selectAllRows((from, to) =>
        sb.from("precious_metal_holdings").select("*").range(from, to),
      ),
    ]);
    const err = e1 || e2 || e3 || e4 || e5;
    if (err) throw dbError(err);
    this.cache = {
      transactions: tx.map(normalise),
      loadedYears: new Set([year]),
      allYearsLoaded: false,
      budget: budgetRowsToShape(bg),
      budgetYear: year,
      balances: bal || [],
      debts: (debts || []).map((d) => this._normDebt(d)),
      metalHoldings: (holdings || []).map((h) => this._normMetalHolding(h)),
    };
    return this.cache;
  }
```

- [ ] **Step 2: Add `_normMetalHolding`/`_toDbMetalHolding` translation helpers and the 4 public methods**

Add these methods to the `SupabaseStore` class, right after `_toDbDebt`/before `addDebt` (or anywhere else in the class body — order doesn't matter to JS, but grouping near the debt translation helpers keeps the pattern visible):

```javascript
  /** snake_case (Postgres) <-> camelCase (app) translation, same reasoning
      as _normDebt/_toDbDebt: weight_grams/price_per_gram/purchase_date
      would otherwise leak snake_case into pages/metals.js and LocalStore/
      MemoryStore, which don't exist for this feature but would still need
      to agree on a shape if they ever did. */
  _normMetalHolding(h) {
    const { weight_grams, price_per_gram, purchase_date, ...rest } = h;
    return {
      ...rest,
      id: Number(h.id) || 0,
      weightGrams: Number(weight_grams) || 0,
      pricePerGram: Number(price_per_gram) || 0,
      purchaseDate: purchase_date,
    };
  }
  _toDbMetalHolding(record) {
    const { weightGrams, pricePerGram, purchaseDate, ...rest } = record;
    const out = { ...rest };
    if ("weightGrams" in record) out.weight_grams = weightGrams;
    if ("pricePerGram" in record) out.price_per_gram = pricePerGram;
    if ("purchaseDate" in record) out.purchase_date = purchaseDate;
    return out;
  }

  async listMetalHoldings() {
    return (await this._ensure()).metalHoldings;
  }
  async addMetalHolding(record) {
    const sb = await this._client();
    const { data, error } = await sb
      .from("precious_metal_holdings")
      .insert(this._toDbMetalHolding(record))
      .select()
      .single();
    if (error) throw dbError(error);
    const result = this._normMetalHolding(data);
    if (this.cache) this.cache.metalHoldings.push(result);
    return result.id;
  }
  async deleteMetalHolding(id) {
    const numId = Number(id);
    const sb = await this._client();
    const { error } = await sb
      .from("precious_metal_holdings")
      .delete()
      .eq("id", id);
    if (error) throw dbError(error);
    if (this.cache)
      this.cache.metalHoldings = this.cache.metalHoldings.filter(
        (h) => h.id !== numId,
      );
  }
  async getLatestGoldPrice() {
    const sb = await this._client();
    const { data, error } = await sb
      .from("gold_price_history")
      .select("*")
      .order("date", { ascending: false })
      .limit(1);
    if (error) throw dbError(error);
    if (!data || !data.length) return null;
    return {
      date: data[0].date,
      pricePerGramCad: Number(data[0].price_per_gram_cad) || 0,
    };
  }
```

- [ ] **Step 3: Verify with `node --check`**

Run:

```bash
cp assets/stores/supabase-store.js /tmp/supabase-store.mjs && node --check /tmp/supabase-store.mjs
```

Expected: no output (syntax OK).

- [ ] **Step 4: Manual verification against a real Supabase project**

This requires the app running locally against a configured Supabase project (see "Local development" in `.claude/CLAUDE.md`: `python3 -m http.server 8080`). In the browser console after signing in:

```javascript
await state.store.addMetalHolding({
  metal: "Gold",
  weightGrams: 10,
  pricePerGram: 85,
  purchaseDate: "2026-01-15",
  owner: "Ramesh",
  notes: "test lot",
});
await state.store.listMetalHoldings();
await state.store.getLatestGoldPrice();
```

Expected: `addMetalHolding` returns a number; `listMetalHoldings()` returns an array containing that lot with camelCase keys; `getLatestGoldPrice()` returns `null` (if Task 2's workflow hasn't run yet) or `{date, pricePerGramCad}`.

- [ ] **Step 5: Commit**

```bash
git add assets/stores/supabase-store.js
git commit -m "Add precious metal holdings and gold price methods to SupabaseStore"
```

---

### Task 4: Metals math module — `assets/pages/metals.js` (summary functions)

**Files:**

- Create: `assets/pages/metals.js`
- Test: none (no test runner in this repo — verified via `node --check` and manual browser verification in Task 5, once render/wiring functions exist to exercise them through)

**Interfaces:**

- Consumes: nothing from other tasks (pure functions operating on plain data).
- Produces (all exported from `assets/pages/metals.js`):
  - `metalsSummary(holdings, latestPrice)` → `{totalGrams: number, value: number, avgCostPerGram: number, unrealizedGain: number, unrealizedGainPct: number}` — `latestPrice` is `{date, pricePerGramCad} | null`; when `null`, all fields are `0`.
  - `priceAppreciation(holdings, priceHistory, latestPrice)` → `{baselinePrice: number, baselineDate: string, appreciationPct: number, sinceLabel: string} | null` — `priceHistory` is the full array of `gold_price_history` rows (`{date, pricePerGramCad}` each, any order); returns `null` if there are no holdings, no `latestPrice`, or no price history at all.

  Task 5's `renderMetalsSection()` calls both functions with data it has already loaded into `state`.

This task is pure logic with no DOM/store dependency, so it's written and manually exercised via a Node REPL before Task 5 wires it into the page — matching this repo's "no test runner, verify by running it" constraint while still catching logic bugs before they're wrapped in HTML.

- [ ] **Step 1: Write `assets/pages/metals.js` with the summary math**

```javascript
/* Precious metals tracking: purchase-lot math for the Net Worth page's
   "Precious metals" section. Rendering and store-wiring live in this same
   file (renderMetalsSection/wireMetalsHandlers), added in a later task -
   this file starts with the pure math so it can be checked independently
   of any DOM. */

/** Value, average cost, and unrealized gain across all lots, valued at
    latestPrice. Lots are purchase transactions (see supabase/schema.sql's
    precious_metal_holdings comment) - average cost is always the
    weighted average across every lot ever bought, never a stored running
    total, so it can't drift from the lots that produced it. */
export function metalsSummary(holdings, latestPrice) {
  const totalGrams = holdings.reduce((s, h) => s + h.weightGrams, 0);
  const totalCost = holdings.reduce(
    (s, h) => s + h.weightGrams * h.pricePerGram,
    0,
  );
  const avgCostPerGram = totalGrams > 0 ? totalCost / totalGrams : 0;
  const pricePerGram = latestPrice ? latestPrice.pricePerGramCad : 0;
  const value = totalGrams * pricePerGram;
  const unrealizedGain = latestPrice ? value - totalCost : 0;
  const unrealizedGainPct =
    latestPrice && totalCost > 0 ? unrealizedGain / totalCost : 0;
  return {
    totalGrams,
    value,
    avgCostPerGram,
    unrealizedGain,
    unrealizedGainPct,
  };
}

/** How far the market price has moved since your first purchase, using the
    earliest gold_price_history row on/after your first lot's purchase
    date as the baseline - the closest available proxy for "the market
    price on the day you bought", since the daily fetch may not have
    existed yet on that date. Falls back to the single earliest price
    point ever recorded if none exists on/after that date, with sinceLabel
    reflecting which baseline was actually used so the UI can be honest
    about it. */
export function priceAppreciation(holdings, priceHistory, latestPrice) {
  if (!holdings.length || !latestPrice || !priceHistory.length) return null;

  const firstPurchaseDate = holdings.map((h) => h.purchaseDate).sort()[0];

  const sorted = [...priceHistory].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0,
  );
  const onOrAfter = sorted.find((p) => p.date >= firstPurchaseDate);
  const baseline = onOrAfter || sorted[0];

  const appreciationPct =
    baseline.pricePerGramCad > 0
      ? (latestPrice.pricePerGramCad - baseline.pricePerGramCad) /
        baseline.pricePerGramCad
      : 0;

  return {
    baselinePrice: baseline.pricePerGramCad,
    baselineDate: baseline.date,
    appreciationPct,
    sinceLabel: onOrAfter
      ? `since your first purchase (${firstPurchaseDate})`
      : `since tracking began (${baseline.date})`,
  };
}
```

- [ ] **Step 2: Verify with `node --check`**

Run:

```bash
cp assets/pages/metals.js /tmp/metals.mjs && node --check /tmp/metals.mjs
```

Expected: no output (syntax OK).

- [ ] **Step 3: Manually exercise the math in a Node REPL**

Run:

```bash
node --input-type=module -e '
import { metalsSummary, priceAppreciation } from "./assets/pages/metals.js";

const holdings = [
  { weightGrams: 10, pricePerGram: 85, purchaseDate: "2026-01-15" },
  { weightGrams: 5, pricePerGram: 90, purchaseDate: "2026-03-01" },
];
const latestPrice = { date: "2026-09-27", pricePerGramCad: 100 };
const priceHistory = [
  { date: "2026-01-20", pricePerGramCad: 86 },
  { date: "2026-09-27", pricePerGramCad: 100 },
];

console.log(metalsSummary(holdings, latestPrice));
console.log(priceAppreciation(holdings, priceHistory, latestPrice));
console.log(metalsSummary([], null));
console.log(priceAppreciation([], [], null));
'
```

Expected:

- First `metalsSummary`: `totalGrams: 15`, `avgCostPerGram` = `(10*85 + 5*90)/15` = `86.666...`, `value: 1500`, `unrealizedGain` = `1500 - 1300` = `200`, `unrealizedGainPct` ≈ `0.1538`.
- First `priceAppreciation`: baseline picks the `2026-01-20` row (on/after `2026-01-15`), `appreciationPct` = `(100-86)/86` ≈ `0.1628`, `sinceLabel` mentions "since your first purchase (2026-01-15)".
- Second `metalsSummary`: all zeros.
- Second `priceAppreciation`: `null`.

- [ ] **Step 4: Commit**

```bash
git add assets/pages/metals.js
git commit -m "Add precious metals summary math (metalsSummary, priceAppreciation)"
```

---

### Task 5: Metals section render + handlers — `assets/pages/metals.js` (UI)

**Files:**

- Modify: `assets/pages/metals.js`

**Interfaces:**

- Consumes: `metalsSummary`, `priceAppreciation`, `GRAMS_PER_TROY_OUNCE` from Task 4 (same file); `state.metalHoldings` (array) and `state.goldPriceHistory`/`state.goldPrice` from Task 6; `state.store.addMetalHolding`/`deleteMetalHolding` from Task 3; `PEOPLE` from `../constants.js`; `money`, `pct` from `../xlsxio.js`; `$`, `view`, `esc`, `state`, `kpi`, `notice`, `withBusy` from `../core.js`; `isRemoteStore` from `../auth.js`.
- Produces: `renderMetalsSection(scopeOwner)` → returns an HTML string (same calling convention as `debts.js`'s `renderDebtSection`), and `wireMetalsHandlers()` → attaches event listeners after the HTML is in the DOM (same calling convention as `wireDebtHandlers`). Task 7 (`assets/pages/networth.js`) calls both.

- [ ] **Step 1: Add imports and the render/wiring functions to `assets/pages/metals.js`**

At the top of `assets/pages/metals.js`, add:

```javascript
import { PEOPLE } from "../constants.js";
import { money, pct } from "../xlsxio.js";
import { $, view, esc, state, kpi, notice, withBusy } from "../core.js";
import { isRemoteStore } from "../auth.js";
```

Then append to the end of the file:

```javascript
/** "Precious metals" section on the Net Worth page: 4 KPI tiles, a lots
    table, and an add-lot form. Mirrors renderDebtSection/wireDebtHandlers
    in debts.js - a returned HTML string plus a separate wiring function
    called once that HTML is actually in the DOM. */
export function renderMetalsSection(scopeOwner) {
  if (!isRemoteStore(state.store)) {
    return `
    <div class="eyebrow">Precious metals</div>
    <div class="nw-warn">
      <b>Not connected to Supabase.</b> Precious metals tracking needs a
      Supabase backend for the daily price feed. Connect under
      <b>Data &rarr; Supabase</b> to use this section.
    </div>`;
  }

  const holdings = (state.metalHoldings || []).filter(
    (h) => !scopeOwner || h.owner === scopeOwner,
  );
  const latestPrice = state.goldPrice || null;
  const summary = metalsSummary(holdings, latestPrice);
  const appreciation = priceAppreciation(
    holdings,
    state.goldPriceHistory || [],
    latestPrice,
  );

  const tiles = !latestPrice
    ? `<div class="kpis">
      ${kpi("Value", "—", "no price data yet")}
      ${kpi("Avg cost/gram", "—", "no price data yet")}
      ${kpi("Unrealized gain", "—", "no price data yet")}
      ${kpi("Price appreciation", "—", "no price data yet")}
    </div>
    <p class="note">No price data yet &mdash; the daily price fetch hasn't run.</p>`
    : `<div class="kpis">
      ${kpi("Value", money(summary.value), `${summary.totalGrams.toFixed(1)}g @ ${money(latestPrice.pricePerGramCad)}/g`)}
      ${kpi("Avg cost/gram", money(summary.avgCostPerGram), `${holdings.length} lot${holdings.length === 1 ? "" : "s"}`)}
      ${kpi(
        "Unrealized gain",
        (summary.unrealizedGain >= 0 ? "+" : "") +
          money(summary.unrealizedGain),
        pct(summary.unrealizedGainPct),
        summary.unrealizedGain < 0 ? "neg" : "pos",
      )}
      ${
        appreciation
          ? kpi(
              "Price appreciation",
              (appreciation.appreciationPct >= 0 ? "+" : "") +
                pct(appreciation.appreciationPct),
              appreciation.sinceLabel,
              appreciation.appreciationPct < 0 ? "neg" : "pos",
            )
          : kpi("Price appreciation", "—", "not enough data")
      }
    </div>`;

  const rows = holdings
    .map((h) => {
      const valueToday = latestPrice
        ? h.weightGrams * latestPrice.pricePerGramCad
        : null;
      return `<tr>
        <td class="num">${esc(h.purchaseDate)}</td>
        <td>${esc(h.metal)}</td>
        <td><span class="person-chip" data-p="${esc(h.owner)}">${esc(h.owner)}</span></td>
        <td class="n num">${h.weightGrams}g</td>
        <td class="n num">${money(h.pricePerGram)}</td>
        <td class="n num">${valueToday === null ? "—" : money(valueToday)}</td>
        <td><button class="rowbtn" data-delmetal="${h.id}" title="Delete this lot">✕</button></td>
      </tr>`;
    })
    .join("");

  return `
  <div class="eyebrow">Precious metals</div>
  ${tiles}
  ${
    holdings.length
      ? `<div class="tablewrap"><table><thead><tr>
      <th>Date</th><th>Metal</th><th>Owner</th><th class="n">Weight</th>
      <th class="n">Price paid/g</th><th class="n">Value today</th><th></th>
    </tr></thead><tbody>${rows}</tbody></table></div>`
      : `<div class="empty">No precious metal holdings recorded. Add a purchase lot below.</div>`
  }

  <div class="panel" style="margin-top:12px">
    <form id="metal-add-form" class="nw-add-row" autocomplete="off">
      <label class="f"><span>Metal</span>
        <select name="metal"><option>Gold</option></select></label>
      <label class="f"><span>Weight (grams)</span>
        <input type="number" name="weightGrams" step="0.001" min="0.001" required placeholder="e.g. 10"></label>
      <label class="f"><span>Price paid/gram</span>
        <input type="number" name="pricePerGram" step="0.01" min="0" required placeholder="0.00"></label>
      <label class="f"><span>Purchase date</span>
        <input type="date" name="purchaseDate" value="${new Date().toISOString().slice(0, 10)}" required></label>
      <label class="f"><span>Owner</span>
        <select name="owner">${PEOPLE.map((p) => `<option>${esc(p)}</option>`).join("")}</select></label>
      <button class="btn" type="submit">Add lot</button>
    </form>
    <div class="err" id="metal-err"></div>
  </div>
  <p class="note">Value updates automatically from the daily gold price &mdash;
    you never need to re-enter it. This is separate from the by-account
    table above; it does not use a manual balance entry.</p>`;
}

export function wireMetalsHandlers() {
  const reload = async () => {
    state.metalHoldings = (await state.store.listMetalHoldings?.()) || [];
    const { renderNetWorth } = await import("./networth.js");
    renderNetWorth();
  };

  $("#metal-add-form")?.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const f = Object.fromEntries(new FormData(ev.target));
    const weightGrams = Number(f.weightGrams);
    const pricePerGram = Number(f.pricePerGram);
    if (!(weightGrams > 0))
      return ($("#metal-err").textContent =
        "Weight must be greater than zero.");
    if (!(pricePerGram >= 0))
      return ($("#metal-err").textContent = "Price can't be negative.");
    const done = await withBusy("Adding lot", async () => {
      await state.store.addMetalHolding({
        metal: f.metal,
        weightGrams,
        pricePerGram,
        purchaseDate: f.purchaseDate,
        owner: f.owner,
        notes: "",
      });
    });
    if (done) {
      await reload();
      notice(`Added ${weightGrams}g of ${f.metal}.`, "ok");
    }
  });

  view.querySelectorAll("[data-delmetal]").forEach(
    (b) =>
      (b.onclick = async () => {
        if (!confirm("Delete this precious metal lot?")) return;
        const done = await withBusy("Deleting lot", async () => {
          await state.store.deleteMetalHolding(Number(b.dataset.delmetal));
        });
        if (done) {
          await reload();
          notice("Lot deleted.", "ok");
        }
      }),
  );
}
```

- [ ] **Step 2: Verify with `node --check`**

Run:

```bash
cp assets/pages/metals.js /tmp/metals.mjs && node --check /tmp/metals.mjs
```

Expected: no output (syntax OK). This will only fully pass once Task 7 wires the file in, since `../core.js`/`../auth.js` imports are real modules already in the repo — `node --check` only validates syntax, not that imports resolve, so this passes regardless of wiring order.

- [ ] **Step 3: Commit**

```bash
git add assets/pages/metals.js
git commit -m "Add precious metals section rendering and form handling"
```

---

### Task 6: Load metal holdings and gold price into app state

**Files:**

- Modify: `assets/core.js:170-178` (`refresh()`)

**Interfaces:**

- Consumes: `listMetalHoldings()`, `getLatestGoldPrice()` from Task 3.
- Produces: `state.metalHoldings` (array, `[]` on LocalStore/MemoryStore or before first load), `state.goldPrice` (`{date, pricePerGramCad} | null`), `state.goldPriceHistory` (array of `{date, pricePerGramCad}`, `[]` if unavailable) — all read by Task 5's `renderMetalsSection()` and Task 7's `renderNetWorth()`.

`state.goldPriceHistory` needs its own store method since `getLatestGoldPrice()` only returns one row — add `getGoldPriceHistory()` to `SupabaseStore` in this task (small enough to fold into this task rather than Task 3, since it's only consumed here and in Task 4/5, not part of the original 4-method interface list).

- [ ] **Step 1: Add `getGoldPriceHistory()` to `SupabaseStore`**

In `assets/stores/supabase-store.js`, add this method next to `getLatestGoldPrice()` (Task 3's addition):

```javascript
  async getGoldPriceHistory() {
    const sb = await this._client();
    const { data, error } = await sb
      .from("gold_price_history")
      .select("*")
      .order("date", { ascending: true });
    if (error) throw dbError(error);
    return (data || []).map((r) => ({
      date: r.date,
      pricePerGramCad: Number(r.price_per_gram_cad) || 0,
    }));
  }
```

- [ ] **Step 2: Load the new state in `refresh()`**

Open `assets/core.js`, find `refresh()` (around line 170):

```javascript
export async function refresh() {
  state.rows = await state.store.list();
  state.budget = await state.store.getBudget(state.year);
  state.balances = (await state.store.getBalances?.()) || [];
  state.debts = (await state.store.getDebts?.()) || [];
  $("#foot-count").textContent = `${state.rows.length} transactions stored`;
  renderPeopleSwitch();
  renderProfileMenu();
}
```

Add the 3 new state loads right after `state.debts`:

```javascript
export async function refresh() {
  state.rows = await state.store.list();
  state.budget = await state.store.getBudget(state.year);
  state.balances = (await state.store.getBalances?.()) || [];
  state.debts = (await state.store.getDebts?.()) || [];
  state.metalHoldings = (await state.store.listMetalHoldings?.()) || [];
  state.goldPrice = (await state.store.getLatestGoldPrice?.()) || null;
  state.goldPriceHistory = (await state.store.getGoldPriceHistory?.()) || [];
  $("#foot-count").textContent = `${state.rows.length} transactions stored`;
  renderPeopleSwitch();
  renderProfileMenu();
}
```

- [ ] **Step 3: Verify with `node --check`**

Run:

```bash
cp assets/core.js /tmp/core.mjs && node --check /tmp/core.mjs
cp assets/stores/supabase-store.js /tmp/supabase-store2.mjs && node --check /tmp/supabase-store2.mjs
```

Expected: no output (syntax OK) for both.

- [ ] **Step 4: Commit**

```bash
git add assets/core.js assets/stores/supabase-store.js
git commit -m "Load precious metal holdings and gold price into app state on refresh"
```

---

### Task 7: Wire the metals section into the Net Worth page

**Files:**

- Modify: `assets/pages/networth.js`

**Interfaces:**

- Consumes: `renderMetalsSection`, `wireMetalsHandlers`, `metalsSummary` from Task 5/4 (`./metals.js`); `state.metalHoldings`, `state.goldPrice` from Task 6.
- Produces: nothing new for later tasks — this is the final integration point.

- [ ] **Step 1: Import the new module**

At the top of `assets/pages/networth.js`, add alongside the existing `debts.js` import:

```javascript
import {
  metalsSummary,
  renderMetalsSection,
  wireMetalsHandlers,
} from "./metals.js";
```

- [ ] **Step 2: Fold metals value into the Assets total**

In `renderNetWorth()`, find:

```javascript
const dnw = debtNetWorth(state.debts || [], scopeOwner);
const assets = (latest ? sumOf(latest, "Asset") : 0) + dnw.receivable;
const liabs = (latest ? sumOf(latest, "Liability") : 0) + dnw.liability;
```

Replace with:

```javascript
const dnw = debtNetWorth(state.debts || [], scopeOwner);
const metalHoldings = (state.metalHoldings || []).filter(
  (h) => !scopeOwner || h.owner === scopeOwner,
);
const metalsValue = metalsSummary(metalHoldings, state.goldPrice || null).value;
const assets =
  (latest ? sumOf(latest, "Asset") : 0) + dnw.receivable + metalsValue;
const liabs = (latest ? sumOf(latest, "Liability") : 0) + dnw.liability;
```

Note: this makes the "Assets" tile include metals value even when `latest` is falsy (no balance snapshot recorded yet), matching how `dnw.receivable` already behaves — a household with only metal holdings and no balance snapshots yet still sees a nonzero Assets figure. This is intentional and consistent with the existing debt-receivable behavior on the same line.

- [ ] **Step 3: Render the section and wire its handlers**

`renderNetWorth()` currently calls `renderDebtSection(scopeOwner)` in two places: once inside the `!latest` empty-state branch, once inside the main content. Add `renderMetalsSection(scopeOwner)` right after each `renderDebtSection(scopeOwner)` call in the template string:

In the empty-state branch:

```javascript
      ? `<div class="empty">No balances recorded yet. Click <b>Record balances</b> to enter what each
     account is worth today &mdash; separate from your transactions, and never affects income or expense.</div>
     ${renderDebtSection(scopeOwner)}
     ${renderMetalsSection(scopeOwner)}`
```

In the main content, find:

```javascript
  ${renderDebtSection(scopeOwner)}

  <div class="eyebrow">Snapshots</div>
```

Replace with:

```javascript
  ${renderDebtSection(scopeOwner)}
  ${renderMetalsSection(scopeOwner)}

  <div class="eyebrow">Snapshots</div>
```

Then find where `wireDebtHandlers()` is called (near the end of `renderNetWorth()`, right after `$("#nw-record").onclick = ...`):

```javascript
$("#nw-record").onclick = () => renderBalanceForm(latest);
wireDebtHandlers();
```

Add `wireMetalsHandlers()` right after:

```javascript
$("#nw-record").onclick = () => renderBalanceForm(latest);
wireDebtHandlers();
wireMetalsHandlers();
```

- [ ] **Step 4: Verify with `node --check`**

Run:

```bash
cp assets/pages/networth.js /tmp/networth.mjs && node --check /tmp/networth.mjs
cp assets/pages/metals.js /tmp/metals-final.mjs && node --check /tmp/metals-final.mjs
```

Expected: no output (syntax OK) for both.

- [ ] **Step 5: Manual end-to-end verification**

Start the local server (`python3 -m http.server 8080`), sign in against a Supabase project with Tasks 1-2 applied, and:

1. Navigate to Net Worth. Confirm the "Precious metals" section renders below Debts & loans, with 4 tiles showing "—" if `gold_price_history` is empty, or real numbers if Task 2's workflow has already run once.
2. Use "Add lot" to add a test lot (e.g. 10g, $85/gram, today's date, any owner). Confirm it appears in the lots table and the tiles recompute.
3. Confirm the page's top "Assets" KPI increased by the new lot's value-today (or by its cost if no gold price is available yet, since `metalsValue` would be `0` in that case — re-check against Step 2's fallback behavior in `metalsSummary`).
4. Delete the test lot via its ✕ button; confirm it disappears and the Assets KPI drops back down.
5. Switch the header's person filter (if the household has more than one person) and confirm the section respects `scopeOwner` the same way Debts & loans does.
6. Sign out / switch to a non-Supabase backend (Data → Supabase, disconnect) and confirm the section is replaced by the "connect to Supabase" notice instead of erroring.

- [ ] **Step 6: Commit**

```bash
git add assets/pages/networth.js
git commit -m "Wire precious metals section into the Net Worth page"
```

---

### Task 8: Update `.claude/CLAUDE.md` architecture table

**Files:**

- Modify: `.claude/CLAUDE.md`

**Interfaces:**

- Consumes: nothing (documentation only).
- Produces: nothing consumed by other tasks — this is a documentation-accuracy task, done last so it reflects the final file layout.

- [ ] **Step 1: Add a line for `assets/pages/metals.js` and the new tables**

Find the "Architecture (root Ledger app)" section's note about `app.js`/`store.js`/etc., and the "### Supabase write rules" section's bullet list. Add one bullet under "### Supabase write rules (`supabase/schema.sql`)":

```markdown
- `precious_metal_holdings` (purchase lots) and `gold_price_history` (daily
  price, written only by `.github/workflows/fetch-gold-price.yml` via the
  service-role key — no client write path exists for this table) back the
  Net Worth page's "Precious metals" section (`assets/pages/metals.js`).
```

- [ ] **Step 2: Commit**

```bash
git add .claude/CLAUDE.md
git commit -m "Document precious metals tables and workflow in CLAUDE.md"
```
