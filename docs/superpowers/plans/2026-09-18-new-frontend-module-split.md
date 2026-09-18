# Expense_tracker_New Frontend Module Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split `Expense_tracker_New/frontend/assets/app.js` (4,751 lines), `store.js` (927 lines), and `styles.css` (2,660 lines) into the same modular file layout root Ledger's `assets/` already uses — same file names, same responsibility boundaries — with zero behavior change.

**Architecture:** Pure code relocation. Every function/constant moves verbatim into its new file; only `import`/`export` statements are added or changed. No function body is rewritten, no new logic is added. Extraction proceeds bottom-up: shared infrastructure (`constants.js`, `auth-config.js`, `store-helpers.js`, the two store classes) first, then `core.js` (needed by almost everything else), then the remaining infrastructure (`tenant.js`, `categories.js`, `auth.js`), then each page file, then `router.js` and the final thin `app.js` last (router.js is the one file that must import every page, so it can only be finished once they all exist).

**Tech Stack:** Vanilla ES modules, no bundler, no test runner (this frontend has none — verification is `node --check` per file plus manual grep/diff review, consistent with this repo's existing `.github/workflows/ledger-new-ci.yml`, which also only runs `node --check` on frontend files).

**Spec:** `docs/superpowers/specs/2026-09-18-new-frontend-module-split-design.md`

## Global Constraints

- Every new/changed `.js` file must pass `node --check <file>` before a task is considered done.
- No function or constant's implementation changes — only its file location and the `import`/`export` wiring around it. If a task's diff contains anything beyond moved code + import/export lines, that's a scope violation.
- After each extraction, `grep -n "functionName"` in `app.js`/`store.js` must show zero remaining definitions of what was moved (no duplicates) and the call sites that used it must now come from an `import`, not a local definition.
- `Expense_tracker_New/frontend/assets/motion.js`, `charts.js`, `xlsxio.js`, `config.js` are not touched by this plan.
- Root's documented circular-import pattern applies here (see `assets/core.js:1-12` and `assets/router.js:1-7` in the root app for the precedent): a binding from a module that imports back from you is safe to import as long as it's only ever read inside a function body, never at module top-level. This plan relies on it for `core.js` ↔ `tenant.js` (via `refresh()`/`switchActiveTenant()`), `core.js` ↔ `router.js` (via `renderPeopleSwitch()`/`go()`), and `core.js` ↔ `auth.js` (via `withBusy()`/`showGate()`).
- Commit after every task using its own commit message — do not batch multiple tasks into one commit.

---

### Task 1: Extract `constants.js`, `auth-config.js`, `store-helpers.js` from `store.js`

**Files:**

- Create: `Expense_tracker_New/frontend/assets/constants.js`
- Create: `Expense_tracker_New/frontend/assets/auth-config.js`
- Create: `Expense_tracker_New/frontend/assets/store-helpers.js`
- Modify: `Expense_tracker_New/frontend/assets/store.js`

**Interfaces:**

- Produces (for every later task that still does `import { X } from "./store.js"`): `store.js` re-exports everything these three files export, so no other file's imports need to change yet.

- [ ] **Step 1: Read the current `store.js` in full** to get exact current line numbers (they won't match the design spec's table exactly — re-derive them here).

- [ ] **Step 2: Create `constants.js`** containing, moved verbatim: `currentYear`, `CATEGORIES`, `CAT_NAMES`, `EXPENSE_CATS`, `CAT_TYPE`, `TYPES`, `CURRENCIES`, `PAYMENTS`, `ACCOUNTS`, `MONTHS`, `UNASSIGNED`, `PERSON_KEY`, `NET_WORTH_ACCOUNTS`, `CUSTOM_KEY`, `setCurrency`, `currentCurrency`, `formatMoney`, `PERSON_PALETTE_SIZE`, `personColorIndex`, `CATEGORY_PALETTE_SIZE`, `categoryColorIndex`. Each keeps its `export` keyword. Add a one-line file header comment: `/* Static lists, formatting helpers, and color-index helpers shared across every page. */` (matches root's `assets/constants.js` header style).

- [ ] **Step 3: Create `auth-config.js`** containing, moved verbatim: `getCognitoConfig`, the `ID_TOKEN_KEY` constant, `getIdToken`, `setIdToken`, `API_ENDPOINT_KEY`, `getApiEndpoint`, `apiEndpointSource`. Header comment: `/* Cognito config accessors and API-endpoint/token storage — read by auth.js and store.js. */`.

- [ ] **Step 4: Create `store-helpers.js`** containing, moved verbatim: `sleep`, `emptyBudget`, `normalise`. (`currentYear` stays in `constants.js`, not duplicated here — it's a general-purpose helper other pages call directly, matching root's placement.) Header comment: `/* Small helpers used by the store classes and elsewhere. */`.

- [ ] **Step 5: Reduce `store.js`'s top** (everything before the `ApiStore`/`DisconnectedStore` classes and `openStore`) to:

  ```js
  export * from "./constants.js";
  export * from "./auth-config.js";
  export * from "./store-helpers.js";
  ```

  placed where the moved code used to be. Anything inside `ApiStore`/`DisconnectedStore`/`openStore` that references a moved symbol (e.g. `normalise`, `emptyBudget`, `getApiEndpoint`) needs an explicit `import { normalise, emptyBudget, ... } from "./store-helpers.js";` / `from "./auth-config.js";` etc. at the top of `store.js`, since `export * from` does not itself bind those names inside `store.js`'s own module scope.

- [ ] **Step 6: Verify.** Run `node --check` on all four files. `grep -n "^export function currentYear\|^export const CATEGORIES\|^export function getCognitoConfig\|^export function sleep\|^export function normalise"` against `store.js` must return nothing (all moved out). `grep -n "normalise(\|emptyBudget(\|getApiEndpoint(\|getCognitoConfig(" store.js` must still resolve (via the new imports) — confirm every such call site has a matching import.

- [ ] **Step 7: Commit.**
  ```bash
  git add Expense_tracker_New/frontend/assets/constants.js Expense_tracker_New/frontend/assets/auth-config.js Expense_tracker_New/frontend/assets/store-helpers.js Expense_tracker_New/frontend/assets/store.js
  git commit -m "Split constants/auth-config/store-helpers out of New's store.js"
  ```

---

### Task 2: Extract `stores/api-store.js`, `stores/disconnected-store.js`; finish `store.js` as a barrel

**Files:**

- Create: `Expense_tracker_New/frontend/assets/stores/api-store.js`
- Create: `Expense_tracker_New/frontend/assets/stores/disconnected-store.js`
- Modify: `Expense_tracker_New/frontend/assets/store.js`

**Interfaces:**

- Consumes: `normalise`, `emptyBudget`, `sleep` (from `store-helpers.js`), `getApiEndpoint`, `getIdToken`, `setIdToken` (from `auth-config.js`) — exact names from Task 1.
- Produces: `store.js` exports `ApiStore`, `DisconnectedStore`, `openStore` exactly as before — no consumer of `store.js` needs to change.

- [ ] **Step 1: Create `stores/api-store.js`** with the `ApiStore` class moved verbatim, plus whatever `import`s it needs from `../constants.js`, `../auth-config.js`, `../store-helpers.js` (check the class body for references to any symbol from those three files — e.g. `normalise`, `sleep`, `getApiEndpoint`, `getIdToken`, `setIdToken`, `emptyBudget`). `export class ApiStore { ... }`.

- [ ] **Step 2: Create `stores/disconnected-store.js`** the same way for the `DisconnectedStore` class. `export class DisconnectedStore { ... }`.

- [ ] **Step 3: Finish `store.js` as a barrel.** After Task 1's re-exports, add:

  ```js
  export { ApiStore } from "./stores/api-store.js";
  export { DisconnectedStore } from "./stores/disconnected-store.js";
  ```

  Keep `openStore()` itself in `store.js` (it's the factory function, matches root's `assets/store.js` pattern where `openStore` also stays in the barrel) — it will need `import { ApiStore } from "./stores/api-store.js";` and `import { DisconnectedStore } from "./stores/disconnected-store.js";` at the top since barrel re-exports don't create local bindings.

- [ ] **Step 4: Verify.** `wc -l store.js` should now be small (barrel + `openStore` only — expect well under 100 lines, similar to root's 86-line `store.js`). `node --check` on both new files and `store.js`. `grep -n "^class ApiStore\|^class DisconnectedStore" store.js` must return nothing.

- [ ] **Step 5: Commit.**
  ```bash
  git add Expense_tracker_New/frontend/assets/stores/api-store.js Expense_tracker_New/frontend/assets/stores/disconnected-store.js Expense_tracker_New/frontend/assets/store.js
  git commit -m "Split ApiStore/DisconnectedStore into stores/, reduce store.js to a barrel"
  ```

---

### Task 3: Extract `core.js` from `app.js`

**Files:**

- Create: `Expense_tracker_New/frontend/assets/core.js`
- Modify: `Expense_tracker_New/frontend/assets/app.js`

**Interfaces:**

- Produces (used by every later task): `$`, `view`, `esc`, `state`, `renderPeopleSwitch`, `updateNetWorthGate`, `withBusy`, `notice`, `refresh`, `switchActiveTenant`.
- Consumes: `emptyBudget` (store.js barrel), `UNASSIGNED`, `PERSON_KEY`, `currentYear`, `setCurrency as setCurrentCurrency` (store.js barrel), `getIdToken`/`setIdToken` (store.js barrel), `getStoredActiveTenant`/`clearStoredActiveTenant` (from `tenant.js` — Task 4, creates a forward reference; see Step 4 below), `go`/`VIEWS` (from `router.js` — Task 19, forward reference), `showGate`/`signOut`/`isRemoteStore` (from `auth.js` — Task 6, forward reference).

Forward references to files that don't exist yet (`tenant.js`, `router.js`, `auth.js`) are expected and intentional here — this mirrors root's own `core.js`, which imports from `router.js` and `auth.js` too. Add the `import` lines now with the filenames this plan will create; `node --check` only checks syntax, not that imported files exist, so this does not block Task 3's verification. Confirm the imports resolve once Tasks 4, 6, and 19 land.

- [ ] **Step 1: Locate the exact current lines** in `app.js` for: the `$`/`view`/`esc` helpers, `YEAR_KEY`, the `state` object, `renderPeopleSwitch`, `updateNetWorthGate`, `withBusy`, `notice`, `refresh`, `switchActiveTenant` (grep `^function \|^const \$\|^const view\|^const esc\|^const state\|^let busy`).

- [ ] **Step 2: Create `core.js`** with a header comment matching root's `assets/core.js:1-12` style (adapted: mention `tenant.js`/`router.js`/`auth.js` circularity instead of root's `router.js`/`auth.js`). Move verbatim: `$`, `view`, `esc`, `YEAR_KEY`, `state`, `renderPeopleSwitch`, `updateNetWorthGate`, `withBusy`, `notice`, `refresh`, `switchActiveTenant`. Export every one of these (`state` included) except purely-internal helpers like the `busy` flag (keep `let busy = false;` local to `core.js`, unexported, exactly as root does).

- [ ] **Step 3: Add imports to `core.js`:**

  ```js
  import {
    emptyBudget,
    UNASSIGNED,
    PERSON_KEY,
    currentYear,
    getIdToken,
    setIdToken,
    setCurrency as setCurrentCurrency,
  } from "./store.js";
  import { getStoredActiveTenant, clearStoredActiveTenant } from "./tenant.js";
  import { go, VIEWS } from "./router.js";
  import { showGate, signOut, isRemoteStore } from "./auth.js";
  ```

  (Trim this list to exactly what the moved code actually references — check each moved function body.)

- [ ] **Step 4: In `app.js`, replace the moved code with:**

  ```js
  import {
    $,
    view,
    esc,
    state,
    renderPeopleSwitch,
    updateNetWorthGate,
    withBusy,
    notice,
    refresh,
    switchActiveTenant,
  } from "./core.js";
  ```

  Remove the old `import { ... } from "./store.js"` entries that are no longer directly used in `app.js` (most will still be needed by code not yet extracted — leave those).

- [ ] **Step 5: Verify.** `node --check core.js`. `node --check app.js` (this will very likely still pass even with the forward-reference imports to not-yet-created `tenant.js`/`router.js`/`auth.js`, since `node --check` is syntax-only and does not resolve import paths). `grep -n "^function renderPeopleSwitch\|^function withBusy\|^async function refresh" app.js` must return nothing.

- [ ] **Step 6: Commit.**
  ```bash
  git add Expense_tracker_New/frontend/assets/core.js Expense_tracker_New/frontend/assets/app.js
  git commit -m "Extract core.js (state, DOM helpers, notice/refresh) from New's app.js"
  ```

---

### Task 4: Extract `tenant.js` from `app.js`

**Files:**

- Create: `Expense_tracker_New/frontend/assets/tenant.js`
- Modify: `Expense_tracker_New/frontend/assets/app.js`

**Interfaces:**

- Produces: `planCopy`, `formatPlanAmount`, `formatPlanPeriod`, `planSeatsLabel`, `planFeatureList`, `ensurePlans`, `activeTenantKey`, `getStoredActiveTenant`, `setStoredActiveTenant`, `clearStoredActiveTenant`, `getPendingInviteToken`, `setPendingInviteToken`.
- Consumes: whatever `state`/`notice`/`withBusy` calls exist inside `ensurePlans` — import from `./core.js`.

This is a New-only file (no root equivalent) — see spec Goal 5.

- [ ] **Step 1: Locate current lines** for the plans-section functions (`planCopy` through `ensurePlans`) and the active-tenant/invite-token section (`activeTenantKey` through `setPendingInviteToken`) via `grep -n "^function planCopy\|^function ensurePlans\|^function activeTenantKey\|^function setPendingInviteToken"`.

- [ ] **Step 2: Create `tenant.js`** with header comment: `/* Multi-tenant plan metadata and active-tenant/invite-token storage — New-only, no root Ledger equivalent (root is single-household). */`. Move both sections verbatim, all exported.

- [ ] **Step 3: Wire imports/exports.** Add to `app.js`:

  ```js
  import {
    planCopy,
    formatPlanAmount,
    formatPlanPeriod,
    planSeatsLabel,
    planFeatureList,
    ensurePlans,
    activeTenantKey,
    getStoredActiveTenant,
    setStoredActiveTenant,
    clearStoredActiveTenant,
    getPendingInviteToken,
    setPendingInviteToken,
  } from "./tenant.js";
  ```

  Trim to what's actually still called directly from `app.js` after Task 3 already moved some usage into `core.js`. `core.js`'s own `import { getStoredActiveTenant, clearStoredActiveTenant } from "./tenant.js";` from Task 3 now resolves for real.

- [ ] **Step 4: Verify.** `node --check tenant.js`. `grep -n "^function planCopy\|^function activeTenantKey" app.js` returns nothing.

- [ ] **Step 5: Commit.**
  ```bash
  git add Expense_tracker_New/frontend/assets/tenant.js Expense_tracker_New/frontend/assets/app.js
  git commit -m "Extract tenant.js (plan metadata, active-tenant/invite storage) from New's app.js"
  ```

---

### Task 5: Extract `categories.js` from `app.js`

**Files:**

- Create: `Expense_tracker_New/frontend/assets/categories.js`
- Modify: `Expense_tracker_New/frontend/assets/app.js`

**Interfaces:**

- Produces: `loadCustom`, `addCustom`, `removeCustom`, `listFor`, `selectWithNew`, `wireNewOption`.
- Consumes: `CUSTOM_KEY` (store.js barrel), `esc` (core.js).

- [ ] **Step 1: Locate current lines** via `grep -n "^function loadCustom\|^function wireNewOption"`.

- [ ] **Step 2: Create `categories.js`**, header comment matching root's `assets/categories.js:1-6`. Move all six functions verbatim, exported.

- [ ] **Step 3: Wire imports.** `categories.js` needs `import { CUSTOM_KEY } from "./store.js";` and `import { esc } from "./core.js";`. In `app.js`, add `import { loadCustom, addCustom, removeCustom, listFor, selectWithNew, wireNewOption } from "./categories.js";`.

- [ ] **Step 4: Verify.** `node --check categories.js`. `grep -n "^function loadCustom" app.js` returns nothing.

- [ ] **Step 5: Commit.**
  ```bash
  git add Expense_tracker_New/frontend/assets/categories.js Expense_tracker_New/frontend/assets/app.js
  git commit -m "Extract categories.js from New's app.js"
  ```

---

### Task 6: Extract `auth.js` from `app.js`

**Files:**

- Create: `Expense_tracker_New/frontend/assets/auth.js`
- Modify: `Expense_tracker_New/frontend/assets/app.js`

**Interfaces:**

- Produces: `cognitoAuthorizeUrl`, `showGate`, `signOut`, `consumeAuthRedirect`, `isRemoteStore`, `boot`, `revealApp`, `startBootMessages`, `stopBootMessages`.
- Consumes: `getCognitoConfig` (store.js barrel), `getIdToken`/`setIdToken` (store.js barrel), `$`/`state`/`notice`/`withBusy`/`refresh` (core.js), `getPendingInviteToken`/`setPendingInviteToken`/`clearStoredActiveTenant`... (tenant.js — check `boot()`'s body for exact list, e.g. `planGateSeen`/invite handling), `go`/`VIEWS` (router.js — forward reference, resolved once Task 19 lands), `renderPlanGate` (pages/plan-gate.js — forward reference, resolved once Task 7 lands), `esc` (core.js).

- [ ] **Step 1: Locate current lines** for `cognitoAuthorizeUrl`, `showGate`, `signOut`, `consumeAuthRedirect` (app.js:277-369 per the spec, re-verify), `isRemoteStore` (near end of file), `boot()` (the large function near end of file), `revealApp`, `startBootMessages`, `stopBootMessages`.

- [ ] **Step 2: Create `auth.js`**, header comment describing the Cognito Hosted UI flow (base it on the existing `/* ------ Google sign-in` comment block already at that location in `app.js` — keep its content, it documents real, still-accurate behavior about the token living where it lives and Cognito federating to Google). Move all eight items verbatim, exported.

- [ ] **Step 3: Wire imports** in `auth.js`:

  ```js
  import { getCognitoConfig, getIdToken, setIdToken } from "./store.js";
  import { $, state, notice, withBusy, refresh } from "./core.js";
  import {
    getPendingInviteToken,
    setPendingInviteToken /* + whatever else boot() actually uses from tenant.js */,
  } from "./tenant.js";
  import { go, VIEWS } from "./router.js";
  import { renderPlanGate } from "./pages/plan-gate.js";
  ```

  Check `boot()`'s body carefully for every external reference (it's the largest function moved in this task, ~150 lines, and touches most of the app's shared state) and add whatever this sketch is missing.

- [ ] **Step 4: Update `app.js`.** Replace the moved code with:

  ```js
  import { showGate, boot } from "./auth.js";
  ```

  (only what the thin entry point in Task 19 will actually call — `app.js`'s own remaining content at this point is still the not-yet-thinned original file, so keep whatever other imports from `auth.js` are still directly referenced until Task 19 does the final cleanup).

- [ ] **Step 5: Verify.** `node --check auth.js`. `grep -n "^function showGate\|^async function boot" app.js` returns nothing.

- [ ] **Step 6: Commit.**
  ```bash
  git add Expense_tracker_New/frontend/assets/auth.js Expense_tracker_New/frontend/assets/app.js
  git commit -m "Extract auth.js (Cognito sign-in, boot sequence) from New's app.js"
  ```

---

### Task 7: Extract `pages/plan-gate.js`

**Files:**

- Create: `Expense_tracker_New/frontend/assets/pages/plan-gate.js`
- Modify: `Expense_tracker_New/frontend/assets/app.js`

**Interfaces:**

- Produces: `renderPlanGate` (consumed by `auth.js`'s `boot()`, Task 6 — this resolves that forward reference).
- Consumes: `$`, `state`, `esc` (core.js), `ensurePlans`, plan-copy helpers (tenant.js).

- [ ] **Step 1: Locate current lines** for `renderPlanGate` (`grep -n "^function renderPlanGate"`).
- [ ] **Step 2: Create `pages/plan-gate.js`**, move `renderPlanGate` verbatim, exported, with the needed imports from `../core.js` and `../tenant.js`.
- [ ] **Step 3: Remove it from `app.js`.**
- [ ] **Step 4: Verify.** `node --check pages/plan-gate.js`. Re-run `node --check` on `auth.js` now that `./pages/plan-gate.js` actually exists — its import should resolve as a real file even though `node --check` doesn't verify import resolution; the point of this check is just to confirm no syntax regression.
- [ ] **Step 5: Commit.**
  ```bash
  git add Expense_tracker_New/frontend/assets/pages/plan-gate.js Expense_tracker_New/frontend/assets/app.js
  git commit -m "Extract pages/plan-gate.js from New's app.js"
  ```

---

### Task 8: Extract `pages/dashboard.js`

**Files:**

- Create: `Expense_tracker_New/frontend/assets/pages/dashboard.js`
- Modify: `Expense_tracker_New/frontend/assets/app.js`

**Interfaces:**

- Produces: `renderDashboard` (consumed by `router.js`'s `VIEWS` map, Task 19).
- Consumes: `availableYears`, `periodSelect`, `dashboardShape`, `sameShape` (moved in this same task — they're dashboard-only helpers per the spec), `$`/`state`/`view`/`esc`/`kpi`-equivalent (core.js — check whether New has a `kpi()` helper like root's `core.js:177`; if so it belongs in `core.js`, extracted as part of Task 3, not here), `aggregate`/`money`/`pct`/`monthOf`/`personBreakdown`/`personSeries` (xlsxio.js, already a standalone file — just import), `charts` (charts.js), motion helpers (`motion.js`).

- [ ] **Step 1: Locate current lines** for `availableYears`, `periodSelect`, `dashboardShape`, `sameShape`, `renderDashboard`, `wireDashboard`, `buildDashboardShell`, `updateDashboardValues`, `overBudgetRows`, `personCards`, `catDetailRows`.
- [ ] **Step 2: Create `pages/dashboard.js`**, move all of the above verbatim, exporting only `renderDashboard` (the rest are page-internal, unexported — matching root's `assets/pages/dashboard.js` pattern where only `renderDashboard` is exported).
- [ ] **Step 3: Wire imports** from `../core.js`, `../categories.js` (if any custom-list dropdowns appear on Dashboard filters), `../store.js`, `../xlsxio.js`, `../charts.js`, `../motion.js` — check the moved code for exact references.
- [ ] **Step 4: Update `app.js`**: add `import { renderDashboard } from "./pages/dashboard.js";` where still needed directly; remove the moved function bodies.
- [ ] **Step 5: Verify.** `node --check pages/dashboard.js`. `grep -n "^function renderDashboard" app.js` returns nothing.
- [ ] **Step 6: Commit.**
  ```bash
  git add Expense_tracker_New/frontend/assets/pages/dashboard.js Expense_tracker_New/frontend/assets/app.js
  git commit -m "Extract pages/dashboard.js from New's app.js"
  ```

---

### Task 9: Extract `pages/cashflow.js`

**Files:**

- Create: `Expense_tracker_New/frontend/assets/pages/cashflow.js`
- Modify: `Expense_tracker_New/frontend/assets/app.js`

**Interfaces:**

- Produces: `renderCashFlow`.
- Consumes: `cashFlowData` (moved in this same task, page-internal), `$`/`state`/`view` (core.js), `charts.js`, `xlsxio.js`, `motion.js` as referenced.

- [ ] **Step 1: Locate current lines** for `cashFlowData`, `renderCashFlow`.
- [ ] **Step 2: Create `pages/cashflow.js`**, move both verbatim, export only `renderCashFlow`.
- [ ] **Step 3: Wire imports**, update `app.js`.
- [ ] **Step 4: Verify.** `node --check pages/cashflow.js`. Confirm no leftover definition in `app.js`.
- [ ] **Step 5: Commit.**
  ```bash
  git add Expense_tracker_New/frontend/assets/pages/cashflow.js Expense_tracker_New/frontend/assets/app.js
  git commit -m "Extract pages/cashflow.js from New's app.js"
  ```

---

### Task 10: Extract `pages/spending.js`

**Files:**

- Create: `Expense_tracker_New/frontend/assets/pages/spending.js`
- Modify: `Expense_tracker_New/frontend/assets/app.js`

**Interfaces:**

- Produces: `renderSpending`.
- Consumes: `setActiveSpendRow`, `wireSpendingList` (moved in this same task, page-internal).

- [ ] **Step 1: Locate current lines** for `renderSpending`, `setActiveSpendRow`, `wireSpendingList`.
- [ ] **Step 2: Create `pages/spending.js`**, move all three verbatim, export only `renderSpending`.
- [ ] **Step 3: Wire imports**, update `app.js`.
- [ ] **Step 4: Verify.** `node --check pages/spending.js`. Confirm no leftover definition in `app.js`.
- [ ] **Step 5: Commit.**
  ```bash
  git add Expense_tracker_New/frontend/assets/pages/spending.js Expense_tracker_New/frontend/assets/app.js
  git commit -m "Extract pages/spending.js from New's app.js"
  ```

---

### Task 11: Extract `pages/add.js`

**Files:**

- Create: `Expense_tracker_New/frontend/assets/pages/add.js`
- Modify: `Expense_tracker_New/frontend/assets/app.js`

**Interfaces:**

- Produces: `renderAdd`.
- Consumes: `categories.js` (`selectWithNew`, `wireNewOption`, `listFor`), `core.js`, `store.js` barrel, `xlsxio.js`.

- [ ] **Step 1: Locate current lines** for `renderAdd` and any helper functions defined only within its region (`grep -n "^function " app.js` between its start and the next section comment).
- [ ] **Step 2: Create `pages/add.js`**, move verbatim, export only `renderAdd`.
- [ ] **Step 3: Wire imports**, update `app.js`.
- [ ] **Step 4: Verify.** `node --check pages/add.js`. Confirm no leftover definition in `app.js`.
- [ ] **Step 5: Commit.**
  ```bash
  git add Expense_tracker_New/frontend/assets/pages/add.js Expense_tracker_New/frontend/assets/app.js
  git commit -m "Extract pages/add.js from New's app.js"
  ```

---

### Task 12: Extract `pages/transactions.js`

**Files:**

- Create: `Expense_tracker_New/frontend/assets/pages/transactions.js`
- Modify: `Expense_tracker_New/frontend/assets/app.js`

**Interfaces:**

- Produces: `renderTransactions`.
- Consumes: `core.js`, `store.js` barrel, `xlsxio.js`, `categories.js`.

- [ ] **Step 1: Locate current lines** for `renderTransactions` and any internal-only helpers in its region.
- [ ] **Step 2: Create `pages/transactions.js`**, move verbatim, export only `renderTransactions`.
- [ ] **Step 3: Wire imports**, update `app.js`.
- [ ] **Step 4: Verify.** `node --check pages/transactions.js`. Confirm no leftover definition in `app.js`.
- [ ] **Step 5: Commit.**
  ```bash
  git add Expense_tracker_New/frontend/assets/pages/transactions.js Expense_tracker_New/frontend/assets/app.js
  git commit -m "Extract pages/transactions.js from New's app.js"
  ```

---

### Task 13: Extract `pages/budget.js`

**Files:**

- Create: `Expense_tracker_New/frontend/assets/pages/budget.js`
- Modify: `Expense_tracker_New/frontend/assets/app.js`

**Interfaces:**

- Produces: `renderBudget`.
- Consumes: `core.js`, `store.js` barrel, `xlsxio.js`.

- [ ] **Step 1: Locate current lines** for `renderBudget` and internal-only helpers in its region.
- [ ] **Step 2: Create `pages/budget.js`**, move verbatim, export only `renderBudget`.
- [ ] **Step 3: Wire imports**, update `app.js`.
- [ ] **Step 4: Verify.** `node --check pages/budget.js`. Confirm no leftover definition in `app.js`.
- [ ] **Step 5: Commit.**
  ```bash
  git add Expense_tracker_New/frontend/assets/pages/budget.js Expense_tracker_New/frontend/assets/app.js
  git commit -m "Extract pages/budget.js from New's app.js"
  ```

---

### Task 14: Extract `pages/networth.js`

**Files:**

- Create: `Expense_tracker_New/frontend/assets/pages/networth.js`
- Modify: `Expense_tracker_New/frontend/assets/app.js`

**Interfaces:**

- Produces: `renderNetWorth`.
- Consumes: `core.js`, `store.js` barrel.

- [ ] **Step 1: Locate current lines** for `nwAccounts`, `nwOwners`, `addNwAccount`, `removeNwAccount`, `isCustomNwAccount`, `renderNetWorth`, `renderBalanceForm`.
- [ ] **Step 2: Create `pages/networth.js`**, move all seven verbatim, export only `renderNetWorth` (matching root's `assets/pages/networth.js`, which exports just `renderNetWorth` and keeps `renderBalanceForm` as an internal helper called from within it).
- [ ] **Step 3: Wire imports**, update `app.js`.
- [ ] **Step 4: Verify.** `node --check pages/networth.js`. Confirm no leftover definitions in `app.js`.
- [ ] **Step 5: Commit.**
  ```bash
  git add Expense_tracker_New/frontend/assets/pages/networth.js Expense_tracker_New/frontend/assets/app.js
  git commit -m "Extract pages/networth.js from New's app.js"
  ```

---

### Task 15: Extract `pages/debts.js`

**Files:**

- Create: `Expense_tracker_New/frontend/assets/pages/debts.js`
- Modify: `Expense_tracker_New/frontend/assets/app.js`

**Interfaces:**

- Produces: `renderDebtSection` (matching root's `assets/pages/debts.js` export name).
- Consumes: `core.js`, `store.js` barrel; check whether `relatedTransactions` needs anything from `pages/transactions.js` (Task 12) — if so, import it directly (page-to-page imports are fine, root does this too where needed).

- [ ] **Step 1: Locate current lines** for `debtSummary`, `debtNetWorth`, `relatedTransactions`, `wireDebtHandlers`, `debtDialog`, `paymentDialog`, `renderDebtSection`.
- [ ] **Step 2: Create `pages/debts.js`**, move all seven verbatim. Export `debtSummary`, `debtNetWorth`, `relatedTransactions`, `renderDebtSection` (matching root's `assets/pages/debts.js` export set — `debtSummary`/`debtNetWorth`/`relatedTransactions` are exported there because Dashboard/other pages call them too; verify actual cross-page callers via `grep -n "debtSummary(\|debtNetWorth(\|relatedTransactions("` across all of `app.js` before finalizing which stay internal-only).
- [ ] **Step 3: Wire imports**, update `app.js` and any other page file (e.g. `pages/dashboard.js`) that calls the now-exported helpers, changing its local call to an import from `./debts.js`.
- [ ] **Step 4: Verify.** `node --check pages/debts.js`. Confirm no leftover definitions in `app.js`.
- [ ] **Step 5: Commit.**
  ```bash
  git add Expense_tracker_New/frontend/assets/pages/debts.js Expense_tracker_New/frontend/assets/app.js
  git commit -m "Extract pages/debts.js from New's app.js"
  ```

---

### Task 16: Extract `pages/data.js`

**Files:**

- Create: `Expense_tracker_New/frontend/assets/pages/data.js`
- Modify: `Expense_tracker_New/frontend/assets/app.js`

**Interfaces:**

- Produces: `renderData`.
- Consumes: `core.js` (including `switchActiveTenant`), `tenant.js`, `store.js` barrel, `xlsxio.js` (export/import), `categories.js`.

- [ ] **Step 1: Locate current lines** for `renderData` and `renderAiReviewTable` (the AI-import review table, called only from within `renderData`'s CSV-import flow).
- [ ] **Step 2: Create `pages/data.js`**, move both verbatim, export only `renderData`.
- [ ] **Step 3: Wire imports**, update `app.js`.
- [ ] **Step 4: Verify.** `node --check pages/data.js`. Confirm no leftover definitions in `app.js`.
- [ ] **Step 5: Commit.**
  ```bash
  git add Expense_tracker_New/frontend/assets/pages/data.js Expense_tracker_New/frontend/assets/app.js
  git commit -m "Extract pages/data.js from New's app.js"
  ```

---

### Task 17: Extract `pages/billing.js`

**Files:**

- Create: `Expense_tracker_New/frontend/assets/pages/billing.js`
- Modify: `Expense_tracker_New/frontend/assets/app.js`

**Interfaces:**

- Produces: `renderBilling`.
- Consumes: `core.js`, `tenant.js` (plan-copy helpers), `store.js` barrel.

- [ ] **Step 1: Locate current lines** for `renderBilling`.
- [ ] **Step 2: Create `pages/billing.js`**, move verbatim, export `renderBilling`.
- [ ] **Step 3: Wire imports**, update `app.js`.
- [ ] **Step 4: Verify.** `node --check pages/billing.js`. Confirm no leftover definition in `app.js`.
- [ ] **Step 5: Commit.**
  ```bash
  git add Expense_tracker_New/frontend/assets/pages/billing.js Expense_tracker_New/frontend/assets/app.js
  git commit -m "Extract pages/billing.js from New's app.js"
  ```

---

### Task 18: Extract `pages/profile.js`

**Files:**

- Create: `Expense_tracker_New/frontend/assets/pages/profile.js`
- Modify: `Expense_tracker_New/frontend/assets/app.js`

**Interfaces:**

- Produces: `renderProfile`.
- Consumes: `core.js`, `store.js` barrel.

- [ ] **Step 1: Locate current lines** for `renderProfile`.
- [ ] **Step 2: Create `pages/profile.js`**, move verbatim, export `renderProfile`.
- [ ] **Step 3: Wire imports**, update `app.js`.
- [ ] **Step 4: Verify.** `node --check pages/profile.js`. Confirm no leftover definition in `app.js`.
- [ ] **Step 5: Commit.**
  ```bash
  git add Expense_tracker_New/frontend/assets/pages/profile.js Expense_tracker_New/frontend/assets/app.js
  git commit -m "Extract pages/profile.js from New's app.js"
  ```

---

### Task 19: Extract `router.js`; reduce `app.js` to a thin entry point

**Files:**

- Create: `Expense_tracker_New/frontend/assets/router.js`
- Modify: `Expense_tracker_New/frontend/assets/app.js`

**Interfaces:**

- Produces: `VIEWS`, `go` (resolves the forward references in `core.js`'s Task 3 import and `auth.js`'s Task 6 import).
- Consumes: `renderDashboard`, `renderCashFlow`, `renderSpending`, `renderAdd`, `renderTransactions`, `renderBudget`, `renderNetWorth`, `renderDebtSection`, `renderData`, `renderBilling`, `renderProfile` (one import per `pages/*.js` file from Tasks 8-18), `charts.js` (`destroyAll`-equivalent if present — check), `view`/`state`/`renderPeopleSwitch` (core.js), `viewTransition` (motion.js — New's `go()` wraps view changes in `viewTransition`, unlike root's plain `go()`).

- [ ] **Step 1: Locate current lines** for the `VIEWS` object and `go()` and the `#tabs button` wiring (end of file, per the spec's table: app.js:4462-4501 as of this plan's writing — re-verify against the file's current state after 18 prior extractions).

- [ ] **Step 2: Create `router.js`**, header comment matching root's `assets/router.js:1-7` (adapted for New's actual page-file set and the `viewTransition` wrapper). Move `VIEWS`, `go()`, and the tab-button wiring verbatim.

- [ ] **Step 3: Wire imports** in `router.js`:

  ```js
  import { view, state, renderPeopleSwitch } from "./core.js";
  import { viewTransition } from "./motion.js";
  import { renderDashboard } from "./pages/dashboard.js";
  import { renderCashFlow } from "./pages/cashflow.js";
  import { renderSpending } from "./pages/spending.js";
  import { renderAdd } from "./pages/add.js";
  import { renderTransactions } from "./pages/transactions.js";
  import { renderBudget } from "./pages/budget.js";
  import { renderNetWorth } from "./pages/networth.js";
  import { renderDebtSection } from "./pages/debts.js";
  import { renderData } from "./pages/data.js";
  import { renderBilling } from "./pages/billing.js";
  import { renderProfile } from "./pages/profile.js";
  ```

  Check `go()`'s body for any `charts.destroyAll()`-equivalent call (root's `go()` calls `charts.destroyAll()`; confirm whether New's does the same or relies on `viewTransition` for cleanup) and import from `./charts.js` if needed.

- [ ] **Step 4: Reduce `app.js` to the thin entry point.** After this task, `app.js` should contain only: the top `import`s it still actually needs (`getCognitoConfig`/`getIdToken` no longer needed here if `auth.js` owns the gate check — compare against root's 45-line `app.js`, which imports only `getClientId`/`getIdToken`/`setIdToken`/`setNonce` from `store.js` and `showGate`/`boot`/`revealApp` from `auth.js`), and the `main()` IIFE (Chart.js-ready wait, `consumeAuthRedirect()`, gate check via `getIdToken()`, `boot()` call, catch block calling `showGate`). Everything else must already be gone by this point — if `grep -n "^function \|^class "  app.js` shows anything besides the `main` IIFE's internals, something wasn't fully extracted in an earlier task; go back and finish it rather than leaving orphaned code in `app.js`.

- [ ] **Step 5: Verify.** `node --check router.js` and `node --check app.js`. `wc -l app.js` should now be small (root's is 45 lines — New's will be a bit larger since it also awaits `consumeAuthRedirect()` and has no Google-specific `needsAuth` branch, but should be well under 100 lines, not thousands). Grep every new file created in Tasks 1-19 once more for `node --check` cleanliness as a final syntax sweep:

  ```bash
  for f in Expense_tracker_New/frontend/assets/*.js Expense_tracker_New/frontend/assets/stores/*.js Expense_tracker_New/frontend/assets/pages/*.js; do node --check "$f" || echo "FAILED: $f"; done
  ```

- [ ] **Step 6: Commit.**
  ```bash
  git add Expense_tracker_New/frontend/assets/router.js Expense_tracker_New/frontend/assets/app.js
  git commit -m "Extract router.js; reduce New's app.js to a thin entry point"
  ```

---

### Task 20: Split `styles.css` into `auth.css` + `pages/*.css`; update `index.html`

**Files:**

- Create: `Expense_tracker_New/frontend/assets/auth.css`
- Create: `Expense_tracker_New/frontend/assets/pages/dashboard.css`, `cashflow.css`, `spending.css`, `add.css`, `transactions.css`, `budget.css`, `networth.css`, `debts.css`, `data.css`, `billing.css`, `profile.css`, `plan-gate.css`
- Modify: `Expense_tracker_New/frontend/assets/styles.css`
- Modify: `Expense_tracker_New/frontend/index.html`

**Interfaces:** None (CSS has no import graph; page association is by class-name convention only, same as root).

- [ ] **Step 1: Read `styles.css` in full** and identify each page's section boundaries by its existing section comments (e.g. `/* =========================================================== DASHBOARD */`-style banners, if present — New's `styles.css` may or may not already have root's exact comment style; check and note where sections actually start/end by which class names each page's `render*` function emits, cross-referencing the `.js` files from Tasks 7-18).

- [ ] **Step 2: Create `auth.css`** with the `#gate`, `.gate-*`, `#gsi-button`-or-Cognito-equivalent, `#boot-loading`, `.boot-*` rules moved verbatim (compare against root's `assets/auth.css`, adjusting only for any class-name differences specific to New's Cognito sign-in button markup from `auth.js`'s `showGate()`, Task 6).

- [ ] **Step 3: Create each `pages/<name>.css`** file by moving that page's rules verbatim out of `styles.css`, matching the class names actually emitted by that page's `.js` file (Tasks 7-18). For `cashflow.css`/`spending.css`/`plan-gate.css` — no root file to diff against, since these are New-only tabs; just move whatever rules `styles.css` has for `.cashflow-*`/`.spending-*`/`.plan-gate-*` (or whatever the actual class-name convention turns out to be once Step 1's read is done).

- [ ] **Step 4: Update `index.html`.** After the existing `<link rel="stylesheet" href="./assets/styles.css" />`, add one `<link rel="stylesheet" href="./assets/auth.css" />` plus one per page file, in the same order as `VIEWS` in `router.js` (Task 19) — matching root's `index.html:59-64` pattern and its explanatory comment about page-specific stylesheets.

- [ ] **Step 5: Verify.** Confirm every class name that appears in each new `pages/*.js` file (Tasks 7-18) has its CSS rules in the matching `pages/*.css` file, not left behind in `styles.css` and not duplicated in both. `grep -c "^\." styles.css` before and after should show `styles.css` shrank substantially (root's went from 2,660 to under 900 lines in its own split).

- [ ] **Step 6: Commit.**
  ```bash
  git add Expense_tracker_New/frontend/assets/auth.css Expense_tracker_New/frontend/assets/pages/*.css Expense_tracker_New/frontend/assets/styles.css Expense_tracker_New/frontend/index.html
  git commit -m "Split New's styles.css into auth.css + pages/*.css, update index.html links"
  ```

---

### Task 21: Final whole-repo review

**Files:** None created; review only.

- [ ] **Step 1: Confirm no dead code.** `grep -c "^function \|^class \|^const [A-Z]" Expense_tracker_New/frontend/assets/app.js` should be near zero beyond the `main()` IIFE itself.
- [ ] **Step 2: Confirm no duplicate definitions.** For every exported symbol name used across the new files, `grep -rn "^export (function|const|class) <name>"` across all of `Expense_tracker_New/frontend/assets/` should return exactly one hit.
- [ ] **Step 3: Confirm every new `.js` file passes `node --check`** (one final sweep, same loop as Task 19 Step 5, now covering every file including `tenant.js`, `categories.js`, `auth.js`, `router.js`).
- [ ] **Step 4: Confirm `index.html`'s CSP** (`script-src`/`style-src` in its `<meta http-equiv="Content-Security-Policy">` tag) doesn't need changes — new files are same-origin (`'self'`), same as root's after its own split.
- [ ] **Step 5: Diff review.** `git log --oneline` over this plan's commits, `git diff <first-task-commit>~1..HEAD --stat` to confirm the net effect is file moves + import wiring, not net-new logic (line count added should roughly equal line count removed from `app.js`/`store.js`/`styles.css`, plus import/export boilerplate).
- [ ] **Step 6: Update `Expense_tracker_New/README.md`** if it documents the old flat file layout (check for a files/architecture section listing `app.js`/`store.js`/`styles.css` as monolithic — if found, update it to describe the new modular layout, matching how root's own `CLAUDE.md` describes root's structure).
- [ ] **Step 7: Final commit** for the README update (and any stray fixups found during this review), if any were needed.
