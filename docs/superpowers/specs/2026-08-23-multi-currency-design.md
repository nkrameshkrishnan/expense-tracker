# Multi-Currency Support — Design

**Status:** Approved by user, ready for implementation planning.

## Problem

The app currently hardcodes CAD everywhere amounts are displayed:
`frontend/assets/xlsxio.js`'s `money()` formats with `"$"` + the `en-CA`
locale; `frontend/assets/charts.js`'s `money0()` does the same for chart
labels; a few template spots in `app.js` hardcode literal `$` or `CAD` text
(the Add-transaction form's currency prefix, the Net Worth table's "Balance
(CAD)" header). Nothing in the data model records a currency at all —
`backend/src/validate.js`'s `money()` validates and stores a plain number,
with no unit attached.

This is wrong for tenants outside Canada: every amount they enter displays
with a `$` and CAD-locale grouping/decimals regardless of what currency they
actually track their finances in.

## Scope

**In scope:** each tenant (household) picks one currency for how their
amounts are _displayed and formatted_. Every amount a tenant has ever
entered is treated as already being in that currency — this is a display/
formatting change only, not currency conversion.

**Out of scope:**

- **Currency conversion.** No exchange rates, no per-transaction currency,
  no converting between currencies. A tenant's stored numbers never change
  when they switch currency — only how those numbers are formatted changes.
  If a tenant switches currency after entering data, every past amount is
  immediately relabeled in the new currency (a $50 CAD entry displays as
  $50 USD the moment they switch) — this is the intended behavior of a
  no-conversion design, not a bug, and is called out explicitly in the UI
  copy so it isn't a surprise.
- **Stripe subscription billing currency.** A Pro/Family subscription keeps
  billing in whatever currency the configured Stripe Price IDs already use
  (currently CAD) — entirely unrelated to this feature. Billing already
  displays its own currency dynamically from the live Stripe Price object
  (`app.js`'s plan-price formatting, driven by `p.currency`), which is
  correct as-is.
- **AI transaction import.** `backend/src/routes/extract.js`'s Bedrock
  extraction deals in plain numbers already, same as the rest of the app —
  nothing there assumes CAD, so it needs no change.

## Supported currencies

A curated list, not the full ISO 4217 set: **CAD, USD, EUR, GBP, INR,
AUD**. Extending this list later is a one-line addition to the shared
constant on both the frontend and backend allow-list.

## Architecture

### 1. Data model

`tenants` gains one column:

```sql
alter table tenants add column currency text not null default 'CAD';
```

Applied to `db/schema.sql`'s `tenants` table definition directly (the
column belongs there from the start for a fresh deploy), plus a
`DEPLOYMENT.md` note for an already-deployed stack — same pattern already
used for the `ai_imports` table: run just the `alter table` statement
above rather than re-pasting the whole schema file.

Currency lives on `tenants`, not on individual transactions/balances/debts
rows or on a user — it's a household-wide shared display preference, the
same scope as `plan`/`status`. No RLS changes needed (the existing
`tenants` table policy already covers the new column).

### 2. Backend

**`GET /data`** (`handler.js`'s `handleGet`): the existing tenant query

```sql
select plan, status, stripe_customer_id from tenants where id = ...
```

gains `currency`, and the response's `tenant: {...}` object gains a
`currency` field alongside `plan`/`status`/`hasStripeCustomer` — the exact
same one-line-query, one-line-object-literal shape as those three fields.

**`POST` action `setCurrency`** (`handler.js`'s `handlePost`, inside the
existing `switch (action)` block that already handles `setBudget`/
`setBalances`/etc.): takes `{ action: "setCurrency", currency }`, validates
`currency` against the fixed supported-currency list (mirroring the
existing `assertKnownPriceId`-style validation precedent already used
elsewhere in this codebase — reject with a clear error on an unknown code,
never silently default), and updates `tenants.currency` for the current
tenant. Lives in a new small function alongside the existing tenant-related
route helpers (wherever `tenants.getMembership`/`tenants.listMembers` etc.
already live), following that file's established shape.

Any signed-in member can change it — this is a low-risk, fully-reversible
display preference (nothing is destroyed or mis-billed by changing it), not
a billing or security-sensitive action, so it does not need the
owner/admin restriction billing actions have.

### 3. Frontend

`store.js` (the existing shared constants/state module already imported by
`xlsxio.js`, `charts.js`, and `app.js`) gains:

- `export const CURRENCIES = ["CAD", "USD", "EUR", "GBP", "INR", "AUD"];`
- A small module-level "current currency" holder: `setCurrency(code)` /
  `currentCurrency()`.
- `formatMoney(n)`, using
  `new Intl.NumberFormat("en-US", { style: "currency", currency:
currentCurrency() }).format(n)`. A single, fixed formatting locale
  (`en-US`) combined with the real currency code is enough to get the
  correct symbol, decimal-place count, and symbol placement for every
  currency in the supported list, with no per-currency locale-mapping
  table to hand-maintain.

`xlsxio.js`'s existing `money` export becomes a thin re-export of
`formatMoney` — its hardcoded `"$"` + `en-CA` logic is removed. Every
existing `money(n)` call site across `app.js` (~40 call sites) is
unaffected, since the function's signature and import path don't change.

`charts.js`'s `money0` (chart-axis/label formatter, which additionally
wants 0 decimal places) gets the equivalent treatment with its own
`maximumFractionDigits: 0` `Intl.NumberFormat` call, reading
`currentCurrency()`.

`app.js`'s `refresh()` calls `setCurrency(state.tenant.currency || "CAD")`
immediately after `state.tenant` is populated (the same place
`aiImportAllowed`/`aiImportsRemaining` are derived for the AI-import
feature) — every render after a refresh automatically uses the right
currency, with no per-call-site plumbing.

The remaining hardcoded spots — the Add-transaction form's `$` prefix span,
the Net Worth table's "Balance (CAD)" column header — switch to the
tenant's actual 3-letter currency code (e.g. `Balance
(${state.tenant.currency})`), rather than trying to extract just a symbol
character. This keeps every spot correct for any of the six supported
currencies without new symbol-extraction logic.

**New Profile-tab section:** a `<select>` of `CURRENCIES`, defaulting to
`state.tenant.currency`, calling the new `setCurrency` action on change,
then `refresh()` + re-render so the whole app immediately reflects the new
formatting. Copy on this control states plainly that switching currency
only changes formatting, not the underlying stored amounts.

## Error handling & edge cases

- **Unknown currency code sent to `setCurrency`** → rejected server-side
  with a clear validation error (never silently defaulted or stored).
- **A tenant switches currency after entering data** → every existing
  amount is immediately relabeled — explicitly intended (no conversion),
  called out in the Profile control's copy.
- **A brand-new tenant, before ever setting a currency** → defaults to CAD
  (matches today's actual behavior for every existing tenant, so this is
  not a behavior change for anyone who never touches the new control).

## Testing

- **Backend:** a focused test for `setCurrency` (rejects an unknown code,
  accepts a valid one, persists via the existing `pg-harness` real-Postgres
  test pattern), plus an update to the existing `GET /data` test asserting
  `tenant.currency` is present with the correct default.
- **Frontend:** no automated test runner exists in this codebase (already
  confirmed during the AI-import feature's own frontend work this session)
  — verified manually: `node --check` on every changed file, a local
  static server, switching currency in Profile, and confirming Dashboard/
  Add/Transactions/Budget/Net Worth all reformat correctly for each of the
  six supported currencies.
