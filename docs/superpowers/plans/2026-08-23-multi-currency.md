# Multi-Currency Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let each tenant (household) pick a display currency (CAD, USD, EUR, GBP, INR, or AUD) from their Profile page, so every amount they see is formatted in that currency instead of hardcoded CAD.

**Architecture:** Currency is a per-tenant column (`tenants.currency`, default `'CAD'`), exposed via `GET /data`'s existing `tenant` object and settable via a new `setCurrency` POST action. The frontend reads it once per `refresh()` into a small shared "current currency" holder in `store.js`, which `xlsxio.js`'s `money()` and `charts.js`'s `money0()` both read via `Intl.NumberFormat` instead of their current hardcoded `"$"` + `en-CA` formatting. No currency conversion anywhere — this only changes how already-stored numbers are displayed.

**Tech Stack:** Node.js backend (Lambda + Aurora Postgres via RDS Data API), vanilla JS frontend, `Intl.NumberFormat` for currency formatting.

**Spec:** docs/superpowers/specs/2026-08-23-multi-currency-design.md

## Global Constraints

- Supported currencies (exact list, both ends): `CAD`, `USD`, `EUR`, `GBP`, `INR`, `AUD`.
- No currency conversion anywhere in this feature — switching currency only changes formatting of already-stored numbers, never the numbers themselves.
- Default currency for any tenant that has never set one: `CAD` (matches every existing tenant's actual current behavior — not a behavior change for anyone who doesn't touch the new control).
- Currency is a household-wide (tenant-level) setting, not per-user or per-transaction. Any signed-in member may change it (not restricted to owner/admin).
- Stripe subscription billing currency is untouched by this feature — out of scope.
- `backend/src/handler.js`'s Lambda `handler` export gets no new direct test, matching this codebase's established precedent (its entrypoint already has zero direct tests — only its small pure exported helper functions do, e.g. `assertManagesInvites`, `assertKnownPriceId`). The new `assertKnownCurrency`/`setCurrency` functions in `routes/tenants.js` get direct tests instead, the same way `assertKnownPriceId` and `debts.js`'s functions do.
- Frontend has no automated test runner in this codebase — frontend tasks are verified via `node --check` plus manual verification (local static server, console-error check), not automated tests.

---

### Task 1: Tenant currency data model + validation/mutation functions

**Files:**

- Modify: `Expense_tracker_New/db/schema.sql` (tenants table)
- Modify: `Expense_tracker_New/backend/src/routes/tenants.js`
- Test: `Expense_tracker_New/backend/test/tenants-route.test.js`
- Modify: `Expense_tracker_New/DEPLOYMENT.md`

**Interfaces:**

- Consumes: nothing from other tasks.
- Produces: `CURRENCIES` (array of 6 ISO codes), `assertKnownCurrency(currency)` (throws a plain `Error` on an unrecognized code), `setCurrency(execute, currency)` (updates the current tenant's `currency` column) — all exported from `backend/src/routes/tenants.js`. Task 2 imports all three.

- [ ] **Step 1: Add the `currency` column to the schema**

Open `Expense_tracker_New/db/schema.sql`, find the `tenants` table definition:

```sql
create table tenants (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  plan        text not null default 'free',
  status      text not null default 'active', -- active | past_due
  stripe_customer_id     text,
  stripe_subscription_id text,
  created_at  timestamptz not null default now()
);
```

Add a `currency` column right after `status`:

```sql
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
```

- [ ] **Step 2: Write the failing tests for `assertKnownCurrency` and `setCurrency`**

Open `Expense_tracker_New/backend/test/tenants-route.test.js`. It already imports `freshDb`, `withProvisioning`, `withTenant`, `makeExecute` from `./pg-harness.js` and `* as tenants` from `../src/routes/tenants.js` — reuse those same imports. Add these tests at the end of the file:

```javascript
test("assertKnownCurrency accepts every supported code", () => {
  for (const code of tenants.CURRENCIES) {
    assert.doesNotThrow(() => tenants.assertKnownCurrency(code));
  }
});

test("assertKnownCurrency rejects an unknown code", () => {
  assert.throws(() => tenants.assertKnownCurrency("XYZ"), Error);
  assert.throws(() => tenants.assertKnownCurrency(""), Error);
  assert.throws(() => tenants.assertKnownCurrency(undefined), Error);
});

test("setCurrency updates the tenant's currency column", async () => {
  const client = await freshDb();
  try {
    const tenantId = await withProvisioning(client, "seed-user", async (c) => {
      const { rows } = await c.query(
        `insert into tenants (name) values ('Household') returning id`,
      );
      return rows[0].id;
    });

    await withTenant(client, tenantId, "owner-sub", (c) =>
      tenants.setCurrency(makeExecute(c), "INR"),
    );

    await withTenant(client, tenantId, "owner-sub", async (c) => {
      const { rows } = await c.query(
        `select currency from tenants where id = $1`,
        [tenantId],
      );
      assert.equal(rows[0].currency, "INR");
    });
  } finally {
    await client.end();
  }
});

test("setCurrency is isolated per tenant (RLS)", async () => {
  const client = await freshDb();
  try {
    const tenantA = await withProvisioning(client, "seed-a", async (c) => {
      const { rows } = await c.query(
        `insert into tenants (name) values ('Household A') returning id`,
      );
      return rows[0].id;
    });
    const tenantB = await withProvisioning(client, "seed-b", async (c) => {
      const { rows } = await c.query(
        `insert into tenants (name) values ('Household B') returning id`,
      );
      return rows[0].id;
    });

    await withTenant(client, tenantA, "owner-a", (c) =>
      tenants.setCurrency(makeExecute(c), "EUR"),
    );

    await withTenant(client, tenantB, "owner-b", async (c) => {
      const { rows } = await c.query(
        `select currency from tenants where id = $1`,
        [tenantB],
      );
      assert.equal(rows[0].currency, "CAD");
    });
  } finally {
    await client.end();
  }
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd Expense_tracker_New/backend && node --test test/tenants-route.test.js`
Expected: FAIL — `tenants.CURRENCIES`/`tenants.assertKnownCurrency`/`tenants.setCurrency` are not exported yet (`TypeError: tenants.assertKnownCurrency is not a function` or similar), and `setCurrency` tests fail because the `currency` column doesn't exist yet either.

- [ ] **Step 4: Implement**

Open `Expense_tracker_New/backend/src/routes/tenants.js`. Add near the top, right after the existing `import { SEAT_CAPS } from "../plans.js";` line:

```javascript
/** The six currencies this app formats amounts in - a curated list, not
    the full ISO 4217 set (~180 codes), since most would never actually
    be used and a short list is easy to keep correctly formatted (see
    frontend/assets/store.js's formatMoney). Extending this list later is
    a one-line addition here AND in store.js's matching CURRENCIES export -
    keep them in sync. */
export const CURRENCIES = ["CAD", "USD", "EUR", "GBP", "INR", "AUD"];

/** Throws if `currency` isn't one of CURRENCIES. Mirrors this file's
    sibling validation pattern (handler.js's assertKnownPriceId): a
    client-supplied value gets checked against a known-good list before
    it's trusted, rather than stored/used as-is. */
export function assertKnownCurrency(currency) {
  if (!CURRENCIES.includes(currency))
    throw new Error(`Unknown currency: ${currency}`);
}

/** Sets the current tenant's display currency. No conversion happens
    anywhere - this only changes how already-stored amounts are
    formatted on the frontend (see this feature's spec). Caller must
    validate with assertKnownCurrency first; this function trusts its
    input. */
export async function setCurrency(execute, currency) {
  await execute(
    `update tenants set currency = :currency where id = cast(current_setting('app.tenant_id', true) as uuid)`,
    { currency },
  );
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd Expense_tracker_New/backend && node --test test/tenants-route.test.js`
Expected: PASS, all tests including the 4 new ones.

- [ ] **Step 6: Run the full suite**

Run: `cd Expense_tracker_New/backend && npm test`
Expected: all tests pass (the new `currency` column with a `not null default 'CAD'` doesn't change any existing row's data, so no other test should be affected).

- [ ] **Step 7: Add the DEPLOYMENT.md migration note**

Open `Expense_tracker_New/DEPLOYMENT.md`, find the existing "Already-deployed stack picking up AI import" callout in Phase 4 (search for that exact phrase). Add a second callout right after it, same style:

````markdown
**Already-deployed stack picking up multi-currency:** the same problem
applies here - re-running the whole file fails on tables that already
exist. Instead, run just this one statement against your existing
database:

```sql
alter table tenants add column currency text not null default 'CAD';
```
````

- [ ] **Step 8: Commit**

```bash
git add Expense_tracker_New/db/schema.sql Expense_tracker_New/backend/src/routes/tenants.js Expense_tracker_New/backend/test/tenants-route.test.js Expense_tracker_New/DEPLOYMENT.md
git commit -m "feat: add tenant currency column and validation/mutation functions"
```

---

### Task 2: Wire currency into GET /data and add the setCurrency action

**Files:**

- Modify: `Expense_tracker_New/backend/src/handler.js`

**Interfaces:**

- Consumes: `routes/tenants.js`'s `CURRENCIES`, `assertKnownCurrency(currency)`, `setCurrency(execute, currency)` (Task 1).
- Produces: `GET /data`'s response gains `tenant.currency` (a string, one of `CURRENCIES`). A new `POST` action `setCurrency` accepting `{ action: "setCurrency", currency }`, returning `{ ok: true }` on success or throwing a validation error that `handler.js`'s existing catch-all maps to a 500 (matching how every other action-level validation error in this switch already behaves — there's no per-action try/catch here, `handlePost`'s caller already handles it). Task 4 (frontend `ApiStore.setCurrency`) calls this action by name.

This task is thin wiring over Task 1's already-tested functions — no new test file, matching this codebase's established precedent that `handler.js`'s Lambda entrypoint itself has zero direct tests (see this plan's Global Constraints).

- [ ] **Step 1: Add `currency` to the `GET /data` tenant query and response**

Open `Expense_tracker_New/backend/src/handler.js`, find `handleGet`'s tenant query:

```javascript
const [tenantRow] = await execute.rows(
  `select plan, status, stripe_customer_id from tenants where id = cast(current_setting('app.tenant_id', true) as uuid)`,
);
```

Add `currency` to the selected columns:

```javascript
const [tenantRow] = await execute.rows(
  `select plan, status, currency, stripe_customer_id from tenants where id = cast(current_setting('app.tenant_id', true) as uuid)`,
);
```

Then find the `tenant: {...}` object further down in the same function:

```javascript
      tenant: {
        plan: tenantRow.plan,
        status: tenantRow.status,
        hasStripeCustomer: !!tenantRow.stripe_customer_id,
      },
```

Add `currency`:

```javascript
      tenant: {
        plan: tenantRow.plan,
        status: tenantRow.status,
        currency: tenantRow.currency,
        hasStripeCustomer: !!tenantRow.stripe_customer_id,
      },
```

- [ ] **Step 2: Import Task 1's tenants.js exports**

Find the existing `import * as tenants from "./routes/tenants.js";` line near the top of `handler.js` — it's already there (tenants.js is already imported as a namespace for `getMembership`/`listMembers`/etc.), so `tenants.CURRENCIES`/`tenants.assertKnownCurrency`/`tenants.setCurrency` are already reachable through it. No new import statement needed.

- [ ] **Step 3: Add the `setCurrency` action**

Find `handlePost`'s action switch (inside `return runInTenantTransaction(user.tenantId, user.sub, async (execute) => { switch (action) { ... }`), specifically the `case "setBudget":` entry:

```javascript
      case "setBudget":
        await budget.setBudgetRows(execute, payload.year, payload.budget);
        return { ok: true };
```

Add a new case right after it:

```javascript
      case "setBudget":
        await budget.setBudgetRows(execute, payload.year, payload.budget);
        return { ok: true };
      case "setCurrency":
        tenants.assertKnownCurrency(payload.currency);
        await tenants.setCurrency(execute, payload.currency);
        return { ok: true };
```

- [ ] **Step 4: Run the full backend test suite**

Run: `cd Expense_tracker_New/backend && npm test`
Expected: all tests pass (no test exercises `handler.js`'s `handleGet`/`handlePost` directly, so this change has no test surface of its own to break — the important thing is that nothing else broke).

- [ ] **Step 5: Commit**

```bash
git add Expense_tracker_New/backend/src/handler.js
git commit -m "feat: expose tenant currency in GET /data and add setCurrency action"
```

---

### Task 3: Frontend currency formatters and store.js wiring

**Files:**

- Modify: `Expense_tracker_New/frontend/assets/store.js`
- Modify: `Expense_tracker_New/frontend/assets/xlsxio.js`
- Modify: `Expense_tracker_New/frontend/assets/charts.js`

**Interfaces:**

- Consumes: nothing from other tasks (this task is frontend-only and doesn't depend on Task 1/2 being deployed to run its own verification — it reads `state.tenant.currency`, which Task 4 wires up, but the formatter functions themselves work standalone).
- Produces: `store.js` exports `CURRENCIES` (same 6 codes as the backend's, kept in sync by hand), `setCurrency(code)`, `currentCurrency()`, `formatMoney(n)`. `ApiStore` gains a `setCurrency(currency)` method; `DisconnectedStore` gains a matching stub. `xlsxio.js`'s existing `money` export and `charts.js`'s existing `money0` both become thin wrappers around `store.js`'s `formatMoney`/`currentCurrency` — their call signatures are unchanged, so every existing call site elsewhere in `app.js` needs no changes. Task 4 imports `CURRENCIES`/`setCurrency` from `store.js` and calls `state.store.setCurrency(code)`.

No automated tests (no frontend test runner in this codebase — see Global Constraints). Verified with `node --check` and a manual console check.

- [ ] **Step 1: Add currency state and formatting to `store.js`**

Open `Expense_tracker_New/frontend/assets/store.js`. Find the existing `TYPES`/`PAYMENTS`/`ACCOUNTS` constants block:

```javascript
export const TYPES = ["Expense", "Income", "Transfer", "Dividends"];
export const PAYMENTS = [
  "Credit Card",
  "Debit Card",
  "Cash",
  "e-Transfer",
  "Pre-authorized Debit",
  "Other",
];
```

Add `CURRENCIES` right after `TYPES` (before `PAYMENTS`):

```javascript
export const TYPES = ["Expense", "Income", "Transfer", "Dividends"];
// Must match backend/src/routes/tenants.js's CURRENCIES exactly - the
// backend is the source of truth for what it accepts; this list is what
// the Profile picker offers. Keep both in sync by hand if this ever grows.
export const CURRENCIES = ["CAD", "USD", "EUR", "GBP", "INR", "AUD"];
export const PAYMENTS = [
  "Credit Card",
  "Debit Card",
  "Cash",
  "e-Transfer",
  "Pre-authorized Debit",
  "Other",
];
```

Then, near the bottom of the file's shared-state section (right after the existing `export const CUSTOM_KEY = "ledger.customLists";` line), add:

```javascript
// The tenant's chosen display currency, set once per refresh() (see
// app.js) and read by formatMoney below - not React/observable state,
// just a module-level value every formatter call reads fresh, the same
// "shared singleton other modules import" shape as CAT_NAMES/ACCOUNTS
// above. No currency conversion anywhere (see this feature's spec) - this
// only changes how already-stored numbers are formatted.
let _currency = "CAD";
export function setCurrency(code) {
  _currency = code;
}
export function currentCurrency() {
  return _currency;
}

/** Formats `n` as money in the tenant's current currency - symbol,
    decimal places, and placement all come from Intl.NumberFormat's own
    knowledge of the currency code, not a hand-maintained per-currency
    table. */
export function formatMoney(n) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: _currency,
  }).format(n);
}
```

- [ ] **Step 2: Add the `setCurrency` action to `ApiStore` and a stub to `DisconnectedStore`**

Open `Expense_tracker_New/frontend/assets/store.js`. Find `ApiStore`'s existing `setBudget` method:

```javascript
  async setBudget(budget, year) {
    await this._post({ action: "setBudget", budget, year });
    await this._refreshMeta();
    return budget;
  }
```

Add a new method right after it:

```javascript
  async setBudget(budget, year) {
    await this._post({ action: "setBudget", budget, year });
    await this._refreshMeta();
    return budget;
  }
  async setCurrency(currency) {
    await this._post({ action: "setCurrency", currency });
    await this._refreshMeta();
    return currency;
  }
```

Then find `DisconnectedStore`'s existing `setBudget` stub:

```javascript
  async setBudget() {
    notConnected();
  }
```

Add a matching stub right after it:

```javascript
  async setBudget() {
    notConnected();
  }
  async setCurrency() {
    notConnected();
  }
```

- [ ] **Step 3: Rewrite `xlsxio.js`'s `money` to use `formatMoney`**

Open `Expense_tracker_New/frontend/assets/xlsxio.js`. Find:

```javascript
import {
  CAT_NAMES,
  EXPENSE_CATS,
  CAT_TYPE,
  MONTHS,
  PAYMENTS,
  UNASSIGNED,
  currentYear,
  normalise,
} from "./store.js";
```

Add `formatMoney` to the import list:

```javascript
import {
  CAT_NAMES,
  EXPENSE_CATS,
  CAT_TYPE,
  MONTHS,
  PAYMENTS,
  UNASSIGNED,
  currentYear,
  normalise,
  formatMoney,
} from "./store.js";
```

Then find:

```javascript
export const money = (n) =>
  (n < 0 ? "-" : "") +
  "$" +
  Math.abs(n).toLocaleString("en-CA", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
```

Replace it with:

```javascript
export const money = (n) => formatMoney(n);
```

- [ ] **Step 4: Rewrite `charts.js`'s `money0` to use `currentCurrency`**

Open `Expense_tracker_New/frontend/assets/charts.js`. Find:

```javascript
import { personColorIndex } from "./store.js";
```

Add `currentCurrency`:

```javascript
import { personColorIndex, currentCurrency } from "./store.js";
```

Then find:

```javascript
const money0 = (v) =>
  "$" + Number(v).toLocaleString("en-CA", { maximumFractionDigits: 0 });
```

Replace it with:

```javascript
const money0 = (v) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currentCurrency(),
    maximumFractionDigits: 0,
  }).format(v);
```

- [ ] **Step 5: Verify syntax**

Run: `cd Expense_tracker_New/frontend/assets && node --check store.js && node --check xlsxio.js && node --check charts.js`
Expected: no output (syntax OK) from all three.

- [ ] **Step 6: Manual verification**

In a browser console (or Node REPL with the file's logic pasted in), confirm:

```javascript
new Intl.NumberFormat("en-US", { style: "currency", currency: "INR" }).format(
  1234.5,
);
// → "₹1,234.50"
new Intl.NumberFormat("en-US", { style: "currency", currency: "EUR" }).format(
  -42,
);
// → "-€42.00"
```

Both should produce a correctly-symboled, correctly-signed string — confirming `Intl.NumberFormat` handles every supported currency's symbol and sign placement without per-currency code in this app.

- [ ] **Step 7: Commit**

```bash
git add Expense_tracker_New/frontend/assets/store.js Expense_tracker_New/frontend/assets/xlsxio.js Expense_tracker_New/frontend/assets/charts.js
git commit -m "feat: add currency-aware money formatting to store.js/xlsxio.js/charts.js"
```

---

### Task 4: Profile currency picker and remaining hardcoded spots

**Files:**

- Modify: `Expense_tracker_New/frontend/assets/app.js`

**Interfaces:**

- Consumes: `store.js`'s `CURRENCIES`, `setCurrency` (Task 3); `ApiStore`/`DisconnectedStore`'s `setCurrency(currency)` method (Task 3); `GET /data`'s `tenant.currency` field (Task 2).
- Produces: nothing further downstream — this is the last task in this plan.

- [ ] **Step 1: Import `CURRENCIES` and `setCurrency` from store.js**

Open `Expense_tracker_New/frontend/assets/app.js`. Find the existing `store.js` import block:

```javascript
import {
  openStore,
  CAT_NAMES,
  EXPENSE_CATS,
  CAT_TYPE,
  TYPES,
  PAYMENTS,
  ACCOUNTS,
  MONTHS,
  currentYear,
  getCognitoConfig,
  emptyBudget,
  UNASSIGNED,
  PERSON_KEY,
  CUSTOM_KEY,
  getIdToken,
  setIdToken,
  NET_WORTH_ACCOUNTS,
  personColorIndex,
} from "./store.js";
```

Add `CURRENCIES` and `setCurrency` (renamed on import to `setCurrentCurrency` to avoid shadowing `state.store.setCurrency`, the API call added in Task 3):

```javascript
import {
  openStore,
  CAT_NAMES,
  EXPENSE_CATS,
  CAT_TYPE,
  TYPES,
  PAYMENTS,
  ACCOUNTS,
  MONTHS,
  currentYear,
  getCognitoConfig,
  emptyBudget,
  UNASSIGNED,
  PERSON_KEY,
  CUSTOM_KEY,
  getIdToken,
  setIdToken,
  NET_WORTH_ACCOUNTS,
  personColorIndex,
  CURRENCIES,
  setCurrency as setCurrentCurrency,
} from "./store.js";
```

- [ ] **Step 2: Wire `refresh()` to set the current currency**

Find `refresh()`'s existing tenant-loading line:

```javascript
state.tenant = (await state.store.getTenant?.()) || {
  plan: "free",
  status: "active",
};
```

Add the currency wiring right after it:

```javascript
state.tenant = (await state.store.getTenant?.()) || {
  plan: "free",
  status: "active",
};
setCurrentCurrency(state.tenant.currency || "CAD");
```

- [ ] **Step 3: Replace the hardcoded `$`/`CAD` spots**

Find the Add-transaction form's currency prefix:

```javascript
<span class="add-currency">$</span>
```

Replace with the tenant's actual currency code:

```javascript
<span class="add-currency">${esc(state.tenant?.currency || "CAD")}</span>
```

Find the same pattern again a few lines later:

```javascript
<span class="add-currency-code">CAD</span>
```

Replace with:

```javascript
<span class="add-currency-code">${esc(state.tenant?.currency || "CAD")}</span>
```

Find the Net Worth section's currency prefix:

```javascript
<span class="nw-currency">$</span>
```

Replace with:

```javascript
<span class="nw-currency">${esc(state.tenant?.currency || "CAD")}</span>
```

Find the Net Worth table's column header:

```javascript
    <div class="tablewrap"><table><thead><tr><th>Account</th><th>Kind</th><th class="n" style="width:190px">Balance (CAD)</th></tr></thead>
```

Replace `(CAD)` with the tenant's actual currency:

```javascript
    <div class="tablewrap"><table><thead><tr><th>Account</th><th>Kind</th><th class="n" style="width:190px">Balance (${esc(state.tenant?.currency || "CAD")})</th></tr></thead>
```

- [ ] **Step 4: Add the currency picker to the Profile tab**

Find `renderProfile()`'s existing "Account" panel:

```javascript
  <div class="eyebrow">Account</div>
  <div class="panel stack">
    ${
      signedIn
        ? `
    <p class="note" style="margin:0">Signed in as <b>${esc(email || "unknown")}</b>.</p>
    <p class="note" style="margin:0">Your role: <b>${esc(myRole)}</b>. ${esc(roleInfo)}</p>
    <p class="note" style="margin:0">Sign-in is Google-only — there's no separate Ledger password to set or reset.</p>`
        : `<p class="note" style="margin:0">Not signed in to a Ledger account.</p>`
    }
  </div>
```

Add a new "Currency" panel right after it, before the existing `${ signedIn ? ... "Household" ... }` block:

```javascript
  <div class="eyebrow">Account</div>
  <div class="panel stack">
    ${
      signedIn
        ? `
    <p class="note" style="margin:0">Signed in as <b>${esc(email || "unknown")}</b>.</p>
    <p class="note" style="margin:0">Your role: <b>${esc(myRole)}</b>. ${esc(roleInfo)}</p>
    <p class="note" style="margin:0">Sign-in is Google-only — there's no separate Ledger password to set or reset.</p>`
        : `<p class="note" style="margin:0">Not signed in to a Ledger account.</p>`
    }
  </div>

  ${
    signedIn
      ? `
  <div class="eyebrow">Currency</div>
  <div class="panel stack">
    <label>Display currency
      <select id="profile-currency">
        ${CURRENCIES.map(
          (c) =>
            `<option value="${esc(c)}"${c === (state.tenant?.currency || "CAD") ? " selected" : ""}>${esc(c)}</option>`,
        ).join("")}
      </select>
    </label>
    <p class="note" style="margin:0">Changes how amounts are formatted everywhere in this household's ledger. Every amount already entered keeps its original number — only the currency label changes, nothing is converted.</p>
  </div>`
      : ""
  }
```

- [ ] **Step 5: Wire the currency picker's change handler**

Find `renderProfile()`'s existing sign-out wiring at the end of the function:

```javascript
  $("#profile-signout")?.addEventListener("click", signOut);
}
```

Add the currency picker's handler right before it:

```javascript
  $("#profile-currency")?.addEventListener("change", async (e) => {
    const currency = e.target.value;
    await withBusy(`Switching to ${currency}`, async () => {
      await state.store.setCurrency(currency);
      await refresh();
    });
    renderProfile();
  });
  $("#profile-signout")?.addEventListener("click", signOut);
}
```

- [ ] **Step 6: Verify syntax**

Run: `cd Expense_tracker_New/frontend/assets && node --check app.js`
Expected: no output (syntax OK).

- [ ] **Step 7: Manual verification**

1. `cd Expense_tracker_New/frontend && python3 -m http.server 8080`, open `http://localhost:8080`.
2. Without a real backend connected, confirm every tab still renders with no new console errors (Dashboard, Add, Transactions, Budget, Net Worth, Data, Billing, Profile) — `state.tenant` falls back to `{ plan: "free", status: "active" }` (no `currency` key), so every `state.tenant?.currency || "CAD"` fallback should keep showing CAD, and `formatMoney`/`money0` should keep using the default `"CAD"` from `store.js`'s `_currency` initial value.
3. Confirm the Profile tab shows a "Currency" panel with a 6-option dropdown, CAD pre-selected.
4. If a real deployed backend is available: sign in, switch currency in Profile, confirm the whole app (Dashboard KPIs, Add form, Transactions table, Budget, Net Worth, charts) immediately reformats every amount in the new currency, and that switching back to CAD restores the original formatting with no data loss.

```bash
git add Expense_tracker_New/frontend/assets/app.js
git commit -m "feat: add currency picker to Profile and use tenant currency throughout the UI"
```

---

## Self-Review Notes

**Spec coverage:** every section of the spec maps to a task — Data model → Task 1, Backend (`GET /data`/`setCurrency` action) → Task 2, Frontend formatters (`store.js`/`xlsxio.js`/`charts.js`) → Task 3, Profile picker + remaining hardcoded spots → Task 4. Error handling (unknown currency code rejected server-side) is Task 1's `assertKnownCurrency`, wired into Task 2's action. The "brand-new tenant defaults to CAD" edge case is the schema column's own `default 'CAD'` plus every frontend fallback (`state.tenant?.currency || "CAD"`, `store.js`'s `_currency` initial value) — no single task owns it alone, it falls out of the default value chosen consistently everywhere.

**Type/name consistency verified:** `CURRENCIES` (Task 1's backend list and Task 3's frontend list — same 6 codes, called out explicitly in both to keep in sync by hand), `setCurrency` (Task 1's `routes/tenants.js` function, Task 2's action name, Task 3's `store.js` module function AND `ApiStore` method — same name reused deliberately across different modules for the same concept, the same pattern `getPlans`/`extractTransactions` already use elsewhere in this codebase), `currentCurrency`/`formatMoney` (Task 3 defines, Task 3's own `charts.js` step and Task 4's nothing — Task 4 doesn't call these directly, it only sets currency via `setCurrentCurrency` and reads `state.tenant?.currency` for display).

**Placeholder scan:** no TBD/TODO, no "add appropriate error handling"-style steps — every step has real code. No task references a type/function not defined in an earlier task.
