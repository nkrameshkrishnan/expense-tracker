# Monarch-Style Visual Pivot + Cash Flow/Spending Tabs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repaint the Ledger frontend's entire visual identity to a vibrant, Monarch-inspired palette and typography, and add two new tabs — Cash Flow (a Sankey flow diagram) and Spending (an interactive donut breakdown) — matching the chart types Monarch uses on its own tabs of those names.

**Architecture:** A global CSS custom-property value swap (names unchanged, so every existing rule across every tab inherits the new palette automatically with zero rewrites) plus a matching JS constant-value swap in `charts.js`. Two new tabs are built as vertical slices reusing the app's existing patterns end to end: `periodSelect()`/`kpi()` for the header/KPI row, `aggregate()` for Spending's category data, a small new local aggregation function for Cash Flow's income/expense-by-category shaping, `chartjs-chart-sankey` (new dependency) for the Sankey diagram, and the existing `assets/motion.js` primitives for entrance/hover motion — no new motion system.

**Tech Stack:** Vanilla JS (ES modules, no bundler), Chart.js 4.4.1 (existing), `chartjs-chart-sankey@0.15.0` (new, via jsdelivr), GSAP 3.12.5 (existing), plain CSS custom properties, Google Fonts (Sora + Inter, replacing Space Grotesk + JetBrains Mono).

**Spec:** `docs/superpowers/specs/2026-08-24-monarch-style-pivot-design.md`

## Global Constraints

- **Keep every existing CSS token _name_, change only values.** `--ink`, `--ink-2`, `--ink-3`, `--paper`, `--paper-2`, `--rule`, `--rule-2`, `--teal`, `--amber`, `--red`, `--blue`, `--mono`, `--disp` all stay as names — this was a real defect caught during this plan's own spec review (50+ existing CSS rules reference these names for their semantic roles; removing any of them silently breaks those rules). Same discipline applies to `charts.js`'s JS constants (`TEAL`, `AMBER`, `RED`, `BLUE`, `PURPLE`, `SAND`, `INK`, `INK3`, `RULE`) — keep the names, change the values.
- `SAND` is kept, not dropped — it's the deliberate neutral fill for the Budget-ceiling bar and the "Unassigned" person slot in `charts.js`, not dead code.
- `PERSON_PALETTE_SIZE` (5) is unchanged — it indexes a structurally separate, fixed 5-entry list (`[TEAL, AMBER, BLUE, RED, PURPLE]` in `charts.js`, matching named-token CSS rules), not the 12-slot category array. Only `CATEGORY_PALETTE_SIZE` extends, `8 → 12`.
- No new build tooling. `chartjs-chart-sankey` loads via one new pinned `<script>` tag (`@0.15.0` exactly, not `@latest` — an earlier release, 0.14.1, shipped a registration-breaking regression later fixed in 0.14.2/0.14.3).
- No backend/API changes. Cash Flow and Spending are both derived entirely from `state.rows` (already loaded client-side).
- Dashboard's existing six charts keep their current content — only re-themed, not restructured or trimmed, in this plan.
- This project has no automated frontend test suite (no `package.json`, no test files — confirmed by inspection). Every task's verification step uses `node --check <file>` for JS syntax plus a manual browser check via a locally-served static instance (`python3 -m http.server` from `Expense_tracker_New/frontend`), with the Cognito sign-in gate bypassed via `sessionStorage.setItem('ledger.cognitoIdToken', 'fake-preview-token')` then reload — this renders the full authenticated app shell in the honest "disconnected" state (no backend), which is sufficient to verify all UI/motion/interactivity described here since none of it depends on a live backend connection.
- This session's browser-automation tab runs backgrounded (`document.hidden === true`), which freezes GSAP's rAF-driven tweens. Verification steps that need to observe a chart/motion end-state, not live animation, should force tween completion first: `if (window.gsap) gsap.globalTimeline.progress(1);` via the console, then screenshot/inspect.

---

### Task 1: Global color and typography token repaint

**Files:**

- Modify: `Expense_tracker_New/frontend/assets/styles.css` (`:root` block, `.category-chip.category-color-N` rules)
- Modify: `Expense_tracker_New/frontend/index.html` (Google Fonts `<link>`)
- Modify: `Expense_tracker_New/frontend/assets/store.js` (`CATEGORY_PALETTE_SIZE`)

**Interfaces:**

- Produces: 12 usable `--cat-color-0` through `--cat-color-11` CSS tokens and matching `.category-chip.category-color-0..11` rules, consumed by Task 2 (`charts.js`'s `CATEGORY_SPECTRUM` array must have exactly the same 12 hex values in the same order) and by the existing, unmodified `categoryColorClass()`/`categoryColorIndex()` functions in `app.js`/`store.js` (their hash output now ranges 0-11 instead of 0-7, and every CSS slot it can produce now exists).

- [ ] **Step 1: Replace the `:root` token values in `assets/styles.css`**

Find the current block (lines 3-36):

```css
:root {
  --ink: #12161c;
  --ink-2: #3c4653;
  --ink-3: #6b7684;
  --paper: #faf7f2;
  --paper-2: #f2eee6;
  --rule: #ddd5c8;
  --rule-2: #c6bcab;
  --teal: #0f766e;
  --amber: #b45309;
  --red: #b3261e;
  --blue: #1d4ed8;
  --mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
  --disp: "Space Grotesk", system-ui, -apple-system, Segoe UI, sans-serif;
  /* ---- elevation & motion (added for the card/motion revamp) ---- */
  --radius-sm: 8px;
  --radius-md: 12px;
  --card-bg: #ffffff;
  --shadow-card:
    0 1px 2px rgba(18, 22, 28, 0.04), 0 8px 24px -8px rgba(18, 22, 28, 0.1);
  --shadow-card-hover:
    0 2px 4px rgba(18, 22, 28, 0.06), 0 16px 32px -12px rgba(18, 22, 28, 0.16);
  --shadow-focus: 0 0 0 3px rgba(180, 83, 9, 0.25);
  --motion-fast: 150ms;
  --motion-base: 250ms;
  --motion-slow: 600ms;
  --motion-ease: cubic-bezier(0.22, 1, 0.36, 1);
  --cat-color-0: #7c9885;
  --cat-color-1: #7a92a8;
  --cat-color-2: #b98a6b;
  --cat-color-3: #9b7ba8;
  --cat-color-4: #c2a04a;
  --cat-color-5: #6b7684;
  --cat-color-6: #7f9270;
  --cat-color-7: #ab6f5c;
}
```

Replace it entirely with:

```css
:root {
  --ink: #14151a;
  --ink-2: #4b4d57;
  --ink-3: #8a8d99;
  --paper: #f6f7f9;
  --paper-2: #eef0f3;
  --rule: #e7e8ed;
  --rule-2: #d7d9e0;
  --teal: #00a389;
  --amber: #ff6b4a;
  --red: #e5484d;
  --blue: #3b82f6;
  --mono: "Inter", ui-monospace, SFMono-Regular, Menlo, monospace;
  --disp: "Sora", system-ui, -apple-system, Segoe UI, sans-serif;
  /* ---- elevation & motion (added for the card/motion revamp) ---- */
  --radius-sm: 10px;
  --radius-md: 18px;
  --card-bg: #ffffff;
  --shadow-card:
    0 2px 8px rgba(20, 21, 26, 0.06), 0 12px 32px -8px rgba(20, 21, 26, 0.14);
  --shadow-card-hover:
    0 4px 12px rgba(20, 21, 26, 0.08), 0 20px 48px -12px rgba(20, 21, 26, 0.2);
  --shadow-focus: 0 0 0 3px rgba(0, 163, 137, 0.35);
  --motion-fast: 150ms;
  --motion-base: 250ms;
  --motion-slow: 600ms;
  --motion-ease: cubic-bezier(0.22, 1, 0.36, 1);
  --cat-color-0: #3b82f6;
  --cat-color-1: #a855f7;
  --cat-color-2: #ec4899;
  --cat-color-3: #f59e0b;
  --cat-color-4: #10b981;
  --cat-color-5: #06b6d4;
  --cat-color-6: #f97316;
  --cat-color-7: #8b5cf6;
  --cat-color-8: #ef4444;
  --cat-color-9: #14b8a6;
  --cat-color-10: #eab308;
  --cat-color-11: #84cc16;
}
```

Every property name is unchanged except the 12 `--cat-color-*` entries, which grow from 8 to 12 — this is purely a value swap plus 4 new declarations, not a rename, per the Global Constraints above.

- [ ] **Step 2: Add the 4 new `.category-chip.category-color-N` rules**

Find the existing block in `assets/styles.css` (around line 1666-1673):

```css
.category-chip.category-color-0 {
  background: var(--cat-color-0);
}
.category-chip.category-color-1 {
  background: var(--cat-color-1);
}
.category-chip.category-color-2 {
  background: var(--cat-color-2);
}
.category-chip.category-color-3 {
  background: var(--cat-color-3);
}
.category-chip.category-color-4 {
  background: var(--cat-color-4);
}
.category-chip.category-color-5 {
  background: var(--cat-color-5);
}
.category-chip.category-color-6 {
  background: var(--cat-color-6);
}
.category-chip.category-color-7 {
  background: var(--cat-color-7);
}
```

Add 4 more lines immediately after, matching the exact same pattern:

```css
.category-chip.category-color-8 {
  background: var(--cat-color-8);
}
.category-chip.category-color-9 {
  background: var(--cat-color-9);
}
.category-chip.category-color-10 {
  background: var(--cat-color-10);
}
.category-chip.category-color-11 {
  background: var(--cat-color-11);
}
```

- [ ] **Step 3: Swap the Google Fonts `<link>` in `index.html`**

Find:

```html
<link
  href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&family=JetBrains+Mono:wght@400;600&display=swap"
  rel="stylesheet"
/>
```

Replace with:

```html
<link
  href="https://fonts.googleapis.com/css2?family=Sora:wght@500;600;700;800&family=Inter:wght@400;500;600;700&display=swap"
  rel="stylesheet"
/>
```

The two `<link rel="preconnect">` tags immediately above it (`fonts.googleapis.com`, `fonts.gstatic.com`) are unchanged — still needed for the same Google Fonts host.

- [ ] **Step 4: Bump `CATEGORY_PALETTE_SIZE` in `assets/store.js`**

Find:

```js
export const CATEGORY_PALETTE_SIZE = 8;
```

Replace with:

```js
export const CATEGORY_PALETTE_SIZE = 12;
```

Do **not** touch `PERSON_PALETTE_SIZE` (stays `5`) — see Global Constraints.

- [ ] **Step 5: Verify syntax**

Run: `node --check Expense_tracker_New/frontend/assets/store.js`
Expected: exits 0, no output.

(`styles.css` and `index.html` have no `node --check` equivalent — verified visually in Step 6.)

- [ ] **Step 6: Verify in browser**

Serve `Expense_tracker_New/frontend` (`python3 -m http.server 8099`), open `http://localhost:8099/index.html`, bypass the gate (`sessionStorage.setItem('ledger.cognitoIdToken','fake-preview-token')`, reload). Click through **every** tab (Dashboard, Add, Transactions, Budget, Net worth, Data, Billing, Profile):

- Background is the new clean near-white (`#f6f7f9`), not the old cream paper.
- Headings/large text render in Sora (a geometric sans, visibly different from the old Space Grotesk), body text in Inter.
- Any existing amber/teal/red-colored UI (warning callouts, positive/negative KPI values, badges, focus rings) now shows the new vibrant coral/teal/red values instead of the old muted ones — nothing renders as invisible text or a missing border (the exact failure mode the Global Constraints' token-name-preservation rule exists to prevent).
- No console errors on any tab.

Stop the server when done.

- [ ] **Step 7: Commit**

```bash
git add Expense_tracker_New/frontend/assets/styles.css Expense_tracker_New/frontend/index.html Expense_tracker_New/frontend/assets/store.js
git commit -m "feat(frontend): repaint global color and typography tokens to the Monarch-style palette"
```

---

### Task 2: Chart color constants repaint (`charts.js`)

**Files:**

- Modify: `Expense_tracker_New/frontend/assets/charts.js`

**Interfaces:**

- Consumes: the 12 `--cat-color-*` values from Task 1 (mirrored here as literal hex, since Chart.js configs need real color values, not CSS var references — Chart.js does not resolve `var()` inside canvas-rendered colors).
- Produces: `CATEGORY_SPECTRUM` (12-entry array of hex strings), consumed by Task 3 (`cashFlow()`) and Task 4 (`spendingDonut()`) for category coloring. `categoryColorIndex` import added to this file's `./store.js` import, consumed by the same two tasks.

- [ ] **Step 1: Replace the color constants**

Find (`charts.js:5-14`):

```js
const INK = "#12161c",
  INK3 = "#6b7684",
  RULE = "#ddd5c8";
const TEAL = "#0f766e",
  AMBER = "#b45309",
  RED = "#b3261e",
  BLUE = "#1d4ed8",
  PURPLE = "#7c3aed",
  SAND = "#c6bcab";
const PIE = [TEAL, AMBER, BLUE, RED, PURPLE, "#0891b2", SAND];
```

Replace with:

```js
const INK = "#14151a",
  INK3 = "#8a8d99",
  RULE = "#e7e8ed";
const TEAL = "#00a389",
  AMBER = "#ff6b4a",
  RED = "#e5484d",
  BLUE = "#3b82f6",
  PURPLE = "#a855f7",
  SAND = "#c7cad1";
const CATEGORY_SPECTRUM = [
  "#3b82f6",
  "#a855f7",
  "#ec4899",
  "#f59e0b",
  "#10b981",
  "#06b6d4",
  "#f97316",
  "#8b5cf6",
  "#ef4444",
  "#14b8a6",
  "#eab308",
  "#84cc16",
];
```

`PIE` is removed entirely (replaced by `CATEGORY_SPECTRUM`, which every former `PIE` consumer switches to in Step 2). `SAND`'s new value (`#c7cad1`, a mid-gray-blue) replaces its old warm-tan value — it keeps its existing role as the neutral fill for the Budget-ceiling bar and the "Unassigned" person slot, it is **not** dropped.

- [ ] **Step 2: Update the `./store.js` import to add `categoryColorIndex`**

Find (`charts.js:3`):

```js
import { personColorIndex, currentCurrency } from "./store.js";
```

Replace with:

```js
import {
  personColorIndex,
  categoryColorIndex,
  currentCurrency,
} from "./store.js";
```

- [ ] **Step 3: Find and replace every `PIE` reference**

Run: `grep -n "PIE" Expense_tracker_New/frontend/assets/charts.js`

Every match (expected: the `personSplit` function, and possibly one other category-coloring chart — confirm by reading each match's surrounding function) that reads `backgroundColor: PIE` or similar becomes `backgroundColor: CATEGORY_SPECTRUM`. Do not touch any match that's actually `PERSON_PALETTE` (a different, deliberately-unrelated constant — see Global Constraints) or a partial-word false positive.

- [ ] **Step 4: Update `Chart.defaults.font.family`**

Find (`charts.js:46`):

```js
Chart.defaults.font.family = "'JetBrains Mono', ui-monospace, monospace";
```

Replace with:

```js
Chart.defaults.font.family = "'Inter', ui-monospace, sans-serif";
```

- [ ] **Step 5: Verify syntax**

Run: `node --check Expense_tracker_New/frontend/assets/charts.js`
Expected: exits 0, no output.

- [ ] **Step 6: Verify in browser**

Serve and bypass the gate as in Task 1. Land on Dashboard: all 6 charts render with the new vibrant colors (teal/coral/red bars and lines instead of the old muted amber/teal, category-colored pie/bar segments spanning the new 12-hue spectrum where applicable). Land on Net Worth: its 3 charts (`netWorthTrend`, `assetSplit`, `personVsBudget`) also show the new colors. No console errors (specifically watch for any error mentioning `PIE is not defined`, which would mean Step 3 missed a reference).

Stop the server when done.

- [ ] **Step 7: Commit**

```bash
git add Expense_tracker_New/frontend/assets/charts.js
git commit -m "feat(frontend): repaint chart color constants to the Monarch-style palette"
```

---

### Task 3: Cash Flow tab

**Files:**

- Modify: `Expense_tracker_New/frontend/index.html` (new `chartjs-chart-sankey` script tag, new nav button)
- Modify: `Expense_tracker_New/frontend/assets/charts.js` (new `cashFlow()`, `netTrendLine()` functions)
- Modify: `Expense_tracker_New/frontend/assets/app.js` (new `cashFlowData()`, `renderCashFlow()`, `VIEWS` entry)

**Interfaces:**

- Consumes: `CATEGORY_SPECTRUM`, `TEAL`, `mount()`, `drawIn`, `legendTop`, `gridX`, `gridY` (existing, from Task 2 and earlier) in `charts.js`. `categoryColorIndex` (imported in Task 2). In `app.js`: `periodSelect`, `kpi`, `monthOf`, `money`, `state`, `cardHoverable`, `revealStagger`, `countUp` (all already imported/defined, no new imports needed — confirmed by reading the current import block).
- Produces: `cashFlowData(rows, month, year)` returning `{income, expense, net, flows, hasData}`, consumed only within `renderCashFlow()` in this task (no other task depends on it). `charts.cashFlow(flows)` and `charts.netTrendLine(series)`, consumed only within `renderCashFlow()`.

- [ ] **Step 1: Add the Sankey plugin script tag**

In `Expense_tracker_New/frontend/index.html`, immediately after the existing GSAP script tag:

```html
<script
  src="https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/gsap.min.js"
  defer
></script>
<script
  src="https://cdn.jsdelivr.net/npm/chartjs-chart-sankey@0.15.0/dist/chartjs-chart-sankey.min.js"
  defer
></script>
```

Version is pinned exactly at `0.15.0` — do not use `@latest` (see Global Constraints). No CSP change needed (`script-src` already allows `https://cdn.jsdelivr.net`). No `Chart.register(...)` call is needed anywhere — the UMD/browser build self-registers on load.

- [ ] **Step 2: Add the nav button**

In `Expense_tracker_New/frontend/index.html`, find:

```html
<nav class="tabs" id="tabs">
  <button data-tab="dashboard" class="on">Dashboard</button>
  <button data-tab="add">Add</button>
</nav>
```

Replace with:

```html
<nav class="tabs" id="tabs">
  <button data-tab="dashboard" class="on">Dashboard</button>
  <button data-tab="cashflow">Cash Flow</button>
  <button data-tab="add">Add</button>
</nav>
```

- [ ] **Step 3: Add `cashFlow()` and `netTrendLine()` to `charts.js`**

Add these two exported functions after the existing `dividendsTrend` function (the last chart-builder function currently in the file — append at the end of the file, before nothing else follows):

```js
export function cashFlow(flows) {
  const flowColorFor = (label) =>
    label === "Income" || label === "Savings"
      ? TEAL
      : CATEGORY_SPECTRUM[categoryColorIndex(label)];
  mount("c-cashflow", {
    type: "sankey",
    data: {
      datasets: [
        {
          data: flows,
          colorFrom: (c) => flowColorFor(c.dataset.data[c.dataIndex].from),
          colorTo: (c) => flowColorFor(c.dataset.data[c.dataIndex].to),
          colorMode: "gradient",
          alpha: 0.85,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: drawIn,
    },
  });
}

export function netTrendLine(series) {
  mount("c-net-trend", {
    type: "line",
    data: {
      labels: series.map((s) => s.month),
      datasets: [
        {
          label: "Net",
          data: series.map((s) => s.net),
          borderColor: TEAL,
          backgroundColor: (ctx) => {
            const { chart } = ctx;
            const { ctx: c, chartArea } = chart;
            if (!chartArea) return TEAL;
            const gradient = c.createLinearGradient(
              0,
              chartArea.top,
              0,
              chartArea.bottom,
            );
            gradient.addColorStop(0, "rgba(0, 163, 137, 0.25)");
            gradient.addColorStop(1, "rgba(229, 72, 77, 0.15)");
            return gradient;
          },
          fill: true,
          tension: 0.3,
          pointRadius: 3,
          pointBackgroundColor: (ctx) =>
            ctx.parsed && ctx.parsed.y < 0 ? RED : TEAL,
        },
      ],
    },
    options: {
      maintainAspectRatio: false,
      responsive: true,
      animation: drawIn,
      plugins: { legend: { display: false } },
      scales: { x: gridX, y: gridY },
    },
  });
}
```

`drawIn`, `gridX`, `gridY`, `mount`, `TEAL`, `RED`, `CATEGORY_SPECTRUM`, `categoryColorIndex` are all already defined/imported earlier in this file (from Task 2 and the prior pilot) — no new imports needed for this step.

- [ ] **Step 4: Add `cashFlowData()` to `app.js`**

Add this function in `app.js`, immediately before the existing `function renderDashboard() {` declaration:

```js
/** Cash Flow tab's own data shaping — deliberately NOT built on the shared
    aggregate() (xlsxio.js), since that function's contract (catRows keyed
    to the fixed EXPENSE_CATS list, a single income total with no
    per-category breakdown) is exactly what every other tab already
    depends on unchanged. Income-by-category has no other consumer today,
    so it's computed locally here instead of growing aggregate()'s return
    shape for one caller. */
function cashFlowData(rows, month, year) {
  const inScope = rows.filter(
    (r) =>
      Number(String(r.date).slice(0, 4)) === year &&
      (month === 0 || monthOf(r) === month),
  );
  const sumBy = (type) => {
    const byCategory = {};
    for (const r of inScope.filter((r) => r.type === type)) {
      byCategory[r.category] = (byCategory[r.category] || 0) + r.amount;
    }
    return byCategory;
  };
  const incomeByCat = sumBy("Income");
  const expenseByCat = sumBy("Expense");
  const income = Object.values(incomeByCat).reduce((a, v) => a + v, 0);
  const expense = Object.values(expenseByCat).reduce((a, v) => a + v, 0);
  const net = income - expense;

  const flows = [];
  for (const [cat, amt] of Object.entries(incomeByCat)) {
    if (amt > 0) flows.push({ from: cat, to: "Income", flow: amt });
  }
  const expenseEntries = Object.entries(expenseByCat)
    .filter(([, amt]) => amt > 0)
    .sort((a, b) => b[1] - a[1]);
  const top = expenseEntries.slice(0, 8);
  const rest = expenseEntries.slice(8);
  for (const [cat, amt] of top)
    flows.push({ from: "Income", to: cat, flow: amt });
  const otherTotal = rest.reduce((a, [, amt]) => a + amt, 0);
  if (otherTotal > 0)
    flows.push({ from: "Income", to: "Other", flow: otherTotal });
  if (net > 0) flows.push({ from: "Income", to: "Savings", flow: net });

  return { income, expense, net, flows, hasData: flows.length > 0 };
}
```

- [ ] **Step 5: Add `renderCashFlow()` to `app.js`**

Add this function immediately after `cashFlowData()`:

```js
function renderCashFlow() {
  const cf = cashFlowData(state.rows, state.month, state.year);
  const label =
    state.month === 0
      ? `Full year ${state.year}`
      : `${MONTHS[state.month - 1]} ${state.year}`;

  view.innerHTML = `
  <div class="head">
    <div><h1>Cash Flow</h1><p class="sub">${esc(personLabel())} &middot; ${esc(label)}</p></div>
    <div class="spacer"></div>${periodSelect(state.month, state.year)}
  </div>

  <div class="kpis">
    ${kpi("Income", money(cf.income), "", "", "cf-income")}
    ${kpi("Expenses", money(cf.expense), "", "", "cf-expense")}
    ${kpi("Net", money(cf.net), cf.net < 0 ? "spending exceeds income" : "", cf.net < 0 ? "neg" : "pos", "cf-net")}
  </div>

  <div class="eyebrow">Flow</div>
  <div class="panel">
    ${cf.hasData ? `<div class="chartbox tall"><canvas id="c-cashflow"></canvas></div>` : `<div class="empty">No income or expenses recorded for this period yet.</div>`}
  </div>

  <div class="eyebrow">Trend</div>
  <div class="panel">
    <h3>Net by month</h3>
    <div class="chartbox"><canvas id="c-net-trend"></canvas></div>
  </div>`;

  $("#m-sel").onchange = (e) => {
    state.month = Number(e.target.value);
    renderCashFlow();
  };
  $("#y-sel").onchange = async (e) => {
    state.year = Number(e.target.value);
    localStorage.setItem(YEAR_KEY, state.year);
    state.month = 0;
    await state.store.ensureYearLoaded?.(state.year);
    state.rows = await state.store.list();
    renderCashFlow();
  };

  view.querySelectorAll(".kpi, .panel").forEach(cardHoverable);
  revealStagger(view.querySelectorAll(".kpi"));
  revealStagger(view.querySelectorAll(".panel"), { delay: 0.35 });

  if (typeof Chart === "undefined") {
    notice(
      "Charts couldn't load. Everything else on this page still works.",
      "bad",
    );
    return;
  }
  if (cf.hasData) charts.cashFlow(cf.flows);
  const a = aggregate(state.rows, state.budget, 0, state.year);
  charts.netTrendLine(a.series);
}
```

`personLabel`, `esc`, `MONTHS`, `$`, `notice`, `YEAR_KEY`, `state` are all existing, already-used-elsewhere identifiers in `app.js` — no new imports. The month/year selector wiring is a direct copy of the same pattern `wireDashboard()` already uses (`app.js`, in the existing Dashboard render path) — same `#m-sel`/`#y-sel` ids, safe to reuse verbatim since each tab fully replaces `#view`'s contents, so only one tab's markup (and therefore only one set of those ids) exists in the DOM at a time. `netTrendLine` intentionally always shows the **full year's** monthly trend (`aggregate(..., 0, state.year)`, hardcoded month `0`) regardless of the KPI row's selected period — a trend chart showing a single month would just be one flat point, so it always plots all 12 months of the selected year.

- [ ] **Step 6: Wire the `cashflow` route into `VIEWS`**

Find (`app.js`, the `VIEWS` object):

```js
const VIEWS = {
  dashboard: renderDashboard,
  add: renderAdd,
```

Replace with:

```js
const VIEWS = {
  dashboard: renderDashboard,
  cashflow: renderCashFlow,
  add: renderAdd,
```

- [ ] **Step 7: Verify syntax**

Run: `node --check Expense_tracker_New/frontend/assets/app.js && node --check Expense_tracker_New/frontend/assets/charts.js`
Expected: both exit 0, no output.

- [ ] **Step 8: Verify in browser**

Serve and bypass the gate. Click the new "Cash Flow" tab:

- 3 KPI tiles render (Income/Expenses/Net), elevated and hoverable like Dashboard's.
- With no data (the honest disconnected/empty state), the Sankey panel shows the "No income or expenses recorded for this period yet." empty state, not a blank or broken canvas — confirm no console error about the Sankey chart type being unregistered (`sankey is not a registered controller` would mean Step 1's CDN tag failed to load or register — this is the exact regression Step 1's version pinning guards against).
- The "Net by month" trend line panel still renders (it doesn't depend on `hasData`) — with all-zero data it should just show a flat line at $0, not error.
- Switch the month/year selector: the tab re-renders correctly, KPI values update.
- No console errors.

If real transaction data is available in a connected environment, additionally confirm: the Sankey diagram shows income-category flows into a single "Income" node, and out to expense categories (top 8) + "Other" + "Savings" (only when net is positive) — hover over a flow to confirm Chart.js's default tooltip shows a value.

Stop the server when done.

- [ ] **Step 9: Commit**

```bash
git add Expense_tracker_New/frontend/index.html Expense_tracker_New/frontend/assets/charts.js Expense_tracker_New/frontend/assets/app.js
git commit -m "feat(frontend): add Cash Flow tab with a Sankey diagram and net trend line"
```

---

### Task 4: Spending tab

**Files:**

- Modify: `Expense_tracker_New/frontend/index.html` (new nav button)
- Modify: `Expense_tracker_New/frontend/assets/charts.js` (new `spendingDonut()`, `spendTrend()`, `highlightSlice()` functions)
- Modify: `Expense_tracker_New/frontend/assets/app.js` (new `renderSpending()`, `wireSpendingList()`, `VIEWS` entry)
- Modify: `Expense_tracker_New/frontend/assets/styles.css` (`.spend-row`/`.spend-bar-fill` styles)

**Interfaces:**

- Consumes: `aggregate()`'s existing `catRows` return shape (unchanged — this task reads it, does not modify `xlsxio.js`). `CATEGORY_SPECTRUM`, `RULE`, `mount()`, `drawIn` from Task 2/3. `categoryColorClass`, `kpi`, `periodSelect`, `state`, motion primitives — all already available in `app.js` (no new imports).
- Produces: nothing consumed by other tasks (this is the last task in the plan).

- [ ] **Step 1: Add the nav button**

In `Expense_tracker_New/frontend/index.html`, find (after Task 3's edit):

```html
<button data-tab="cashflow">Cash Flow</button>
<button data-tab="add">Add</button>
```

Replace with:

```html
<button data-tab="cashflow">Cash Flow</button>
<button data-tab="spending">Spending</button>
<button data-tab="add">Add</button>
```

- [ ] **Step 2: Add `spendingDonut()`, `spendTrend()`, `highlightSlice()` to `charts.js`**

Append after the `netTrendLine` function added in Task 3:

```js
export function spendingDonut(rows, onSliceClick) {
  mount("c-spend-donut", {
    type: "doughnut",
    data: {
      labels: rows.map((r) => r.category),
      datasets: [
        {
          data: rows.map((r) => r.actual),
          backgroundColor: rows.map((r) =>
            r.category === "Other"
              ? RULE
              : CATEGORY_SPECTRUM[categoryColorIndex(r.category)],
          ),
          borderWidth: 2,
          borderColor: "#ffffff",
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: drawIn,
      cutout: "62%",
      plugins: { legend: { display: false } },
      onClick: (evt, elements) => {
        if (elements.length) onSliceClick(rows[elements[0].index].category);
      },
    },
  });
}

export function spendTrend(series) {
  mount("c-spend-trend", {
    type: "bar",
    data: {
      labels: series.map((s) => s.month),
      datasets: [
        {
          label: "Spend",
          data: series.map((s) => s.expense),
          backgroundColor: AMBER,
        },
      ],
    },
    options: {
      maintainAspectRatio: false,
      responsive: true,
      animation: drawIn,
      plugins: { legend: { display: false } },
      scales: { x: gridX, y: gridY },
    },
  });
}

export function highlightSlice(index) {
  const chart = registry.get("c-spend-donut");
  if (!chart) return;
  chart.setActiveElements(index === null ? [] : [{ datasetIndex: 0, index }]);
  chart.update();
}
```

`registry` is the existing module-level `Map` already defined near the top of `charts.js` (used internally by `mount()`/`destroyAll()`) — `highlightSlice` is the first function to read from it directly rather than only through `mount()`, which is fine since it's the same module and `registry` is already in scope, not a new export.

- [ ] **Step 3: Add `.spend-row`/`.spend-bar-fill` CSS**

Append to the end of `assets/styles.css`:

```css
/* ---------- Spending tab category list ---------- */
.spend-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.spend-row {
  display: grid;
  grid-template-columns: 12px 1fr auto;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background var(--motion-fast);
}
.spend-row:hover,
.spend-row.active {
  background: var(--paper-2);
}
.spend-dot {
  width: 12px;
  height: 12px;
  border-radius: 50%;
}
.spend-row-main {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.spend-row-label {
  display: flex;
  justify-content: space-between;
  font-size: 13px;
  font-weight: 500;
}
.spend-bar {
  height: 4px;
  border-radius: 2px;
  background: var(--rule);
  overflow: hidden;
}
.spend-bar-fill {
  height: 100%;
  border-radius: 2px;
}
```

- [ ] **Step 4: Add `renderSpending()` and `wireSpendingList()` to `app.js`**

Add both functions immediately after `renderCashFlow()` (from Task 3):

```js
function renderSpending() {
  const a = aggregate(state.rows, state.budget, state.month, state.year);
  const label =
    state.month === 0
      ? `Full year ${state.year}`
      : `${MONTHS[state.month - 1]} ${state.year}`;

  const spendRows = [...a.catRows]
    .filter((r) => r.actual > 0)
    .sort((x, y) => y.actual - x.actual);
  const top6 = spendRows.slice(0, 6);
  const otherTotal = spendRows.slice(6).reduce((sum, r) => sum + r.actual, 0);
  const donutRows =
    otherTotal > 0
      ? [...top6, { category: "Other", actual: otherTotal }]
      : top6;
  const totalSpend = spendRows.reduce((sum, r) => sum + r.actual, 0);
  const topCategory = spendRows[0]?.category || "—";

  view.innerHTML = `
  <div class="head">
    <div><h1>Spending</h1><p class="sub">${esc(personLabel())} &middot; ${esc(label)}</p></div>
    <div class="spacer"></div>${periodSelect(state.month, state.year)}
  </div>

  <div class="kpis">
    ${kpi("Total spend", money(totalSpend), "", "", "sp-total")}
    ${kpi("Top category", esc(topCategory), "", "", "sp-top")}
    ${kpi("Transactions", String(a.count), "", "", "sp-count")}
  </div>

  <div class="eyebrow">By category</div>
  ${
    donutRows.length === 0
      ? `<div class="panel"><div class="empty">No spending recorded for this period yet.</div></div>`
      : `<div class="grid2">
    <div class="panel"><div class="chartbox tall"><canvas id="c-spend-donut"></canvas></div></div>
    <div class="panel"><div class="spend-list">
      ${donutRows
        .map((r) => {
          const pctOfTotal = totalSpend > 0 ? (r.actual / totalSpend) * 100 : 0;
          const colorVar =
            r.category === "Other"
              ? "var(--rule-2)"
              : `var(--cat-color-${categoryColorIndex(r.category)})`;
          return `
        <div class="spend-row" data-cat="${esc(r.category)}">
          <span class="spend-dot" style="background:${colorVar}"></span>
          <div class="spend-row-main">
            <div class="spend-row-label"><span>${esc(r.category)}</span><span class="num">${money(r.actual)}</span></div>
            <div class="spend-bar"><div class="spend-bar-fill" style="width:${pctOfTotal.toFixed(1)}%;background:${colorVar}"></div></div>
          </div>
          <span class="muted num">${pctOfTotal.toFixed(0)}%</span>
        </div>`;
        })
        .join("")}
    </div></div>
  </div>`
  }

  <div class="eyebrow">Trend</div>
  <div class="panel">
    <h3>Spend by month</h3>
    <div class="chartbox"><canvas id="c-spend-trend"></canvas></div>
  </div>`;

  $("#m-sel").onchange = (e) => {
    state.month = Number(e.target.value);
    renderSpending();
  };
  $("#y-sel").onchange = async (e) => {
    state.year = Number(e.target.value);
    localStorage.setItem(YEAR_KEY, state.year);
    state.month = 0;
    await state.store.ensureYearLoaded?.(state.year);
    state.rows = await state.store.list();
    renderSpending();
  };

  wireSpendingList(donutRows);

  view.querySelectorAll(".kpi, .panel").forEach(cardHoverable);
  revealStagger(view.querySelectorAll(".kpi"));
  revealStagger(view.querySelectorAll(".panel"), { delay: 0.35 });

  if (typeof Chart === "undefined") {
    notice(
      "Charts couldn't load. Everything else on this page still works.",
      "bad",
    );
    return;
  }
  if (donutRows.length > 0) {
    charts.spendingDonut(donutRows, (category) => setActiveSpendRow(category));
  }
  const fullYear = aggregate(state.rows, state.budget, 0, state.year);
  charts.spendTrend(fullYear.series);
}

/** Two-way donut<->list highlight, both directions funnel through this one
    function so there's a single source of truth for "which category is
    active" instead of two independent code paths that could drift apart. */
function setActiveSpendRow(category) {
  view.querySelectorAll(".spend-row").forEach((el) => {
    el.classList.toggle("active", el.dataset.cat === category);
  });
  const rows = Array.from(view.querySelectorAll(".spend-row"));
  const idx = rows.findIndex((el) => el.dataset.cat === category);
  charts.highlightSlice(idx === -1 ? null : idx);
}

function wireSpendingList(donutRows) {
  view.querySelectorAll(".spend-row").forEach((el) => {
    el.onclick = () => setActiveSpendRow(el.dataset.cat);
    el.onmouseenter = () => {
      if (!el.classList.contains("active")) {
        const idx = donutRows.findIndex((r) => r.category === el.dataset.cat);
        charts.highlightSlice(idx === -1 ? null : idx);
      }
    };
    el.onmouseleave = () => {
      const activeEl = view.querySelector(".spend-row.active");
      const idx = activeEl
        ? donutRows.findIndex((r) => r.category === activeEl.dataset.cat)
        : -1;
      charts.highlightSlice(idx === -1 ? null : idx);
    };
  });
}
```

`spendTrend`'s `backgroundColor: AMBER` reference (Step 2 above) needs no new import or export — `AMBER` is already a module-level `const` in `charts.js` (repainted in Task 2), in scope for every function in that same file.

- [ ] **Step 5: Wire the `spending` route into `VIEWS`**

Find (`app.js`, after Task 3's edit):

```js
const VIEWS = {
  dashboard: renderDashboard,
  cashflow: renderCashFlow,
  add: renderAdd,
```

Replace with:

```js
const VIEWS = {
  dashboard: renderDashboard,
  cashflow: renderCashFlow,
  spending: renderSpending,
  add: renderAdd,
```

- [ ] **Step 6: Verify syntax**

Run: `node --check Expense_tracker_New/frontend/assets/app.js && node --check Expense_tracker_New/frontend/assets/charts.js`
Expected: both exit 0, no output.

- [ ] **Step 7: Verify in browser**

Serve and bypass the gate. Click the new "Spending" tab:

- 3 KPI tiles render (Total spend / Top category / Transactions).
- With no data, the donut panel shows the "No spending recorded for this period yet." empty state.
- The "Spend by month" trend panel still renders (doesn't depend on donut data).
- No console errors.

If real transaction data spanning more than 6 categories is available: confirm the donut shows exactly 6 named slices + one "Other" slice (never more than 7 total), the category list below it matches those same 7 rows with a percentage bar each, clicking a donut slice highlights the matching list row (`.active` class, visible background change), clicking a list row highlights the matching donut slice (via `chart.setActiveElements`), and hovering a row (without clicking) also highlights its slice but reverts on mouse-leave (unless that row is the currently-active/clicked one, which stays highlighted).

Stop the server when done.

- [ ] **Step 8: Commit**

```bash
git add Expense_tracker_New/frontend/index.html Expense_tracker_New/frontend/assets/charts.js Expense_tracker_New/frontend/assets/app.js Expense_tracker_New/frontend/assets/styles.css
git commit -m "feat(frontend): add Spending tab with an interactive donut chart and category list"
```

---

## Final Verification (after all tasks)

- [ ] Serve `Expense_tracker_New/frontend` and bypass the gate. Click through all 10 tabs (Dashboard, Cash Flow, Spending, Add, Transactions, Budget, Net worth, Data, Billing, Profile) — confirm every tab renders with the new palette/typography, no tab throws a console error, and the `.tabs` nav row correctly wraps to a second line rather than overflowing/clipping (resize the browser window narrower to confirm).
- [ ] Confirm no leftover reference to the old font names (Space Grotesk, JetBrains Mono) or old hex values (`#12161c`, `#faf7f2`, `#0f766e`, `#b45309`, `#b3261e`, `#1d4ed8`, `#7c9885` through `#ab6f5c`) anywhere in `styles.css`, `charts.js`, or `index.html` — `grep -rn` for each as a final sweep.
- [ ] Confirm `chartjs-chart-sankey`'s pinned version actually loads with no console error (the exact regression its version-pinning guards against).
- [ ] In Chrome DevTools, enable "Emulate CSS media feature prefers-reduced-motion: reduce", reload, and repeat the Cash Flow and Spending tab checks — entrance stagger/hover-lift should resolve instantly with no animation, consistent with the existing `assets/motion.js` guard this plan reuses unchanged.
