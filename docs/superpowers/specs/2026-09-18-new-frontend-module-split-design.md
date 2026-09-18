# Expense_tracker_New Frontend Module Split

## Context

Root Ledger's `assets/` was split (see commits `0243e23` "App split refactor" and `c1dbb5d` "Css split refactor") from a monolithic `app.js`/`store.js`/`styles.css` into ~26 focused files: `router.js`, `core.js`, `auth.js`, `auth-config.js`, `categories.js`, `constants.js`, `store-helpers.js`, `stores/*.js` (one file per backend), and `pages/*.js`+`.css` (one file per tab).

`Expense_tracker_New/frontend/assets/` never went through the same split — it is still 7 flat files, dominated by `app.js` (4,751 lines) and `store.js` (927 lines) and `styles.css` (2,660 lines). The user asked to bring New's frontend to the same modular structure root already uses.

This is a pure reorganization: relocate code into files that mirror root's naming/responsibility pattern, update imports accordingly, and split `styles.css` along the same page boundaries. No behavior, UI, or API-contract changes. New's `charts.js`, `xlsxio.js`, `config.js`, `motion.js` already match root's single-purpose-file pattern and are unchanged.

## Goals

1. `Expense_tracker_New/frontend/assets/` file layout mirrors root's naming and responsibility boundaries as closely as New's actual (Cognito + API Gateway, multi-tenant) mechanics allow.
2. Every `render*` function that appears in New's `VIEWS` map (`app.js:4462`), plus `renderPlanGate`, gets its own `pages/<name>.js` file.
3. `styles.css` splits along the same page boundaries, plus a standalone `auth.css` for the sign-in gate / boot-loading overlay, matching root's `assets/auth.css` split.
4. No behavior change: same Cognito auth flow, same `ApiStore`/`DisconnectedStore` backends, same rendered markup. Verified via `node --check` on every new/changed `.js` file and a manual click-through smoke test (deferred — see Non-Goals) or, at minimum, careful diff review since this repo has no local AWS backend to run New against yet.
5. New's genuinely New-only concerns (multi-tenant plans, active-tenant/invite-token storage) get their own files rather than being force-fit into a root-named file that doesn't match their purpose.

## Non-Goals

- No new features, no behavior changes, no styling changes beyond moving CSS rules into new files unchanged.
- No attempt to actually run New's frontend end-to-end against a live backend — per `CLAUDE.md`, `Expense_tracker_New` is not deployed to a real AWS account, so verification here is `node --check` + import-graph review + `git diff` inspection, not a browser smoke test like the root theme-port work got. This is a real gap versus root's usual verification bar; flagged, not silently skipped.
- No changes to `backend/` at all — this is a `frontend/assets/` reorganization only.
- No renaming/restructuring of `charts.js`, `xlsxio.js`, `config.js`, or `motion.js` — they already match root's single-purpose-file convention.
- `stores/` gets two files (`api-store.js`, `disconnected-store.js`), not three — New only has two backend classes, unlike root's three (Supabase/Local/Memory). No placeholder third file is added.

## File Mapping

All line numbers are from the current `app.js` (4,751 lines) / `store.js` (927 lines) and will shift as extraction proceeds — each task re-reads the current file rather than trusting stale line numbers from this table.

### `store.js` → barrel + 4 files (mirrors root's `store.js`/`constants.js`/`auth-config.js`/`store-helpers.js`/`stores/*.js` split)

| New file                       | Content                                                                                                                                                                                                                                                                                                               |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `constants.js`                 | `CATEGORIES`, `CAT_NAMES`, `EXPENSE_CATS`, `CAT_TYPE`, `TYPES`, `CURRENCIES`, `PAYMENTS`, `ACCOUNTS`, `MONTHS`, `UNASSIGNED`, `PERSON_KEY`, `NET_WORTH_ACCOUNTS`, `CUSTOM_KEY`, `PERSON_PALETTE_SIZE`/`personColorIndex`, `CATEGORY_PALETTE_SIZE`/`categoryColorIndex`, `setCurrency`/`currentCurrency`/`formatMoney` |
| `auth-config.js`               | `getCognitoConfig`, `ID_TOKEN_KEY`, `getIdToken`/`setIdToken`, `API_ENDPOINT_KEY`, `getApiEndpoint`, `apiEndpointSource`                                                                                                                                                                                              |
| `store-helpers.js`             | `sleep`, `currentYear`, `emptyBudget`, `normalise`                                                                                                                                                                                                                                                                    |
| `stores/api-store.js`          | the `ApiStore` class                                                                                                                                                                                                                                                                                                  |
| `stores/disconnected-store.js` | the `DisconnectedStore` class                                                                                                                                                                                                                                                                                         |
| `store.js` (barrel, stays)     | `export * from` the four files above, `export { ApiStore }`/`export { DisconnectedStore }`, `openStore()` (unchanged — already matches root's factory pattern)                                                                                                                                                        |

### `app.js` (4,751 lines) → entry point + 7 infrastructure files + 12 page files

| New file                                     | Source (current `app.js` line range)                                                                                                                                                                                                   |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tenant.js` _(New-only, no root equivalent)_ | 80-258: `planCopy`/`formatPlanAmount`/`formatPlanPeriod`/`planSeatsLabel`/`planFeatureList`/`ensurePlans`, active-tenant key storage, pending-invite-token storage                                                                     |
| `auth.js`                                    | 277-369 (`cognitoAuthorizeUrl`, `showGate`, `signOut`, `consumeAuthRedirect`) + 4544-4546 (`isRemoteStore`) + 4563-4713 (`boot()`) + 4536-4542 (`revealApp`) + 4512-4531 (`startBootMessages`/`stopBootMessages`)                      |
| `categories.js`                              | 472-616 (`loadCustom`/`addCustom`/`removeCustom`/`listFor`/`selectWithNew`/`wireNewOption`)                                                                                                                                            |
| `core.js`                                    | `$`/`view`/`esc` helpers, `state` object, `renderPeopleSwitch` (617-647), `notice` (694-832), `withBusy`-equivalent, `refresh`-equivalent — exact source lines confirmed during extraction (not yet individually located in this pass) |
| `router.js`                                  | 4462-4501 (`VIEWS`, `go()`, tab button wiring)                                                                                                                                                                                         |
| `pages/plan-gate.js`                         | 379-463 (`renderPlanGate`)                                                                                                                                                                                                             |
| `pages/dashboard.js`                         | 833-958 (`availableYears`/`periodSelect`/`dashboardShape`/`sameShape`) + 1190-1525 (`renderDashboard`, `wireDashboard`, `buildDashboardShell`, `updateDashboardValues`, `overBudgetRows`, `personCards`, `catDetailRows`)              |
| `pages/cashflow.js`                          | 904-1028 (`cashFlowData`, `renderCashFlow`)                                                                                                                                                                                            |
| `pages/spending.js`                          | 1029-1189 (`renderSpending`, `setActiveSpendRow`, `wireSpendingList`)                                                                                                                                                                  |
| `pages/add.js`                               | 1526-1999 (`renderAdd`)                                                                                                                                                                                                                |
| `pages/transactions.js`                      | 2000-2366 (`renderTransactions`)                                                                                                                                                                                                       |
| `pages/budget.js`                            | 2367-2648 (`renderBudget`)                                                                                                                                                                                                             |
| `pages/networth.js`                          | 2649-2696 (`nwAccounts`/`nwOwners`/`addNwAccount`/`removeNwAccount`/`isCustomNwAccount`) + 2759-2970 (`renderNetWorth`) + 3497-3809 (`renderBalanceForm`)                                                                              |
| `pages/debts.js`                             | 2709-2758 (`debtSummary`/`debtNetWorth`/`relatedTransactions`) + 2971-3496 (`wireDebtHandlers`, `debtDialog`, `paymentDialog`, `renderDebtSection` — these four appear in that order within this range per the structural grep)        |
| `pages/data.js`                              | 3810-4235 (`renderData`, `renderAiReviewTable`)                                                                                                                                                                                        |
| `pages/billing.js`                           | 4236-4385 (`renderBilling`)                                                                                                                                                                                                            |
| `pages/profile.js`                           | 4386-4461 (`renderProfile`)                                                                                                                                                                                                            |
| `app.js` (thin entry point, stays)           | 4714-4751 (the `main()` IIFE only: wait for Chart.js, `consumeAuthRedirect()`, gate check, call `boot()`)                                                                                                                              |

Root's known-safe circular-import pattern (`core.js` ↔ `router.js` ↔ `auth.js`, documented in each file's own header comment, verified via real `import()` resolution — see `assets/core.js:1-12`) applies here too: `core.js` will need to call `go()` (router.js) and `showGate()`/`signOut()` (auth.js), and `router.js`/`auth.js` call back into `core.js`'s `state`/`renderPeopleSwitch`/`notice`. This is safe in ES modules as long as the imported binding is only read inside a function body, never at module top-level — same rule root already relies on, not a new risk.

### `styles.css` (2,660 lines) → `auth.css` + `pages/*.css`

Same section boundaries as root's already-completed CSS split (`c1dbb5d`): sign-in gate + boot-loading overlay rules move to `auth.css`; each page's rules move to `pages/<name>.css`; shared rail/tabs/kpi/panel/table/banner/form rules stay in `styles.css`. New's two extra tabs (Cash Flow, Spending) each get their own `pages/cashflow.css`/`pages/spending.css` — no root equivalent to compare against, so these are new files rather than a port.

## Execution Approach

Given the size (~9,500 lines across ~15 new files) and that root's own prior split of comparable scope (`0243e23`, `c1dbb5d`) was done as its own dedicated effort, this will run as a sequence of small, independently-verifiable extraction tasks via subagent-driven-development — one task per target file (or a tightly related small group, e.g. `tenant.js` + `auth.js` together since they're both extracted from the same 80-378 region). Each task: move the named functions/constants verbatim into the new file, add the right imports/exports, update every caller, confirm `node --check` passes on every touched file, confirm no leftover reference to the moved code remains in `app.js`/`store.js`. Final task: whole-file review that `app.js` and `store.js` are down to their intended thin/barrel shape and nothing was dropped or duplicated.
