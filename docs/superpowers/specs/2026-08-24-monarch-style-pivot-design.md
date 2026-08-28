# Monarch-Style Visual Pivot + Cash Flow/Spending Tabs

## Context

The prior pilot (`docs/superpowers/specs/2026-08-24-ui-motion-revamp-pilot-design.md`, shipped and merged into this branch as `worktree-bedrock-guardrails`) deliberately kept the app's flat "paper ledger" identity (amber/teal accents, cream paper background, hairline rules) while adding card elevation and GSAP motion to Dashboard and Transactions. The user has now asked for a much larger change: a full visual pivot to match Monarch Money's actual look (vibrant colors, dynamic/interactive charts, cards), plus two new tabs — **Cash Flow** and **Spending** — matching the chart types Monarch uses on its own tabs of those names (a Sankey flow diagram and a category-breakdown donut, respectively).

Decided in brainstorming (see chat log, 2026-08-24):

- **Direction:** full pivot, not an accent-only tweak. The paper/amber/teal identity is replaced by a vibrant palette; this reverses the prior pilot's explicit "keep the ledger DNA" choice.
- **Cash Flow / Spending:** added as two new top-level tabs (not folded into existing Dashboard sections), matching Monarch's real structure.
- **Token cascade:** because the app's colors are global CSS custom properties (`--ink`, `--paper`, `--amber`, `--teal`, ... in `assets/styles.css`'s `:root` block) referenced by every tab's rules, redefining them re-themes the _entire app_, not just the tabs this spec adds. This is treated as correct and intentional — a mixed old/new palette would look broken — not scope creep.
- **Dashboard content:** unchanged in this pass (chart set stays as-is), just re-themed. Trimming Dashboard's now-overlapping charts (income-vs-expense, actual-vs-budget, top-5) is explicitly deferred — see Non-Goals.

## Goals

1. Every existing tab (Dashboard, Add, Transactions, Budget, Net worth, Data, Billing, Profile) re-themes to the new vibrant palette and typography via the global token swap, with no visual "seams" between old and new.
2. Two new tabs, **Cash Flow** and **Spending**, built on real, correctly-shaped app data (not mocked), each centered on the chart type Monarch itself uses there:
   - Cash Flow: a Sankey diagram (income sources → Income → expense categories/Savings) plus a monthly net trend line.
   - Spending: a donut chart (top 6 categories + Other) plus a full category list and a monthly spend trend bar chart.
3. Real interactivity beyond hover tooltips: the Spending donut and its category list are two-way linked (click a segment to filter/highlight the list; hover a row to highlight the segment).
4. Chart colors (`assets/charts.js`) move off the old amber/teal/blue/red palette onto the new vibrant category spectrum and brand colors, consistently with the CSS token swap.
5. The existing motion system (`assets/motion.js` — `countUp`, `revealStagger`, `cardHoverable`, `exitCollapse`, `viewTransition`) is reused for the two new tabs' entrance/interaction, not reinvented.

## Non-Goals

- Dashboard's existing chart _content_ is not removed or restructured in this pass — it keeps its current six charts, just re-themed. A follow-up could trim charts that now duplicate Cash Flow/Spending, but that's out of scope here (avoids removing a just-shipped, reviewed feature as an unplanned side effect).
- No new tab-overflow/hamburger navigation. Ten tabs on the existing `.tabs` flex-wrap row just wrap to a second line at narrow widths, matching current behavior — no new responsive mechanism is being designed.
- No backend/API changes. Cash Flow and Spending are both derived entirely from `state.rows` (already fully loaded client-side, per the existing `aggregate()`/`state.store.list()` pattern) — no new endpoints.
- No dark mode. Out of scope, consistent with the rest of this app (none exists today).
- Net Worth tab's own charts (`netWorthTrend`, `assetSplit`, `personVsBudget` in `charts.js`) get the same global CSS token cascade (cards/shadows/fonts) but their _chart-level_ color constants are recolored too (see Chart Color Palette below) since leaving them on the old amber/teal values would look inconsistent — this is a small, mechanical part of the global recolor, not new scope.

## Global Design Tokens

**Correction made during this spec's self-review:** an earlier draft of this section retired the `--teal`/`--amber`/`--red` token _names_ in favor of new ones (`--brand`/`--accent`/`--negative`). Grepping `assets/styles.css` for `var(--teal)`, `var(--amber)`, `var(--red)`, `var(--blue)` turns up **over 50 call sites** across every tab's CSS — success/positive accents, warning callouts, the recurring-badge color, budget-bar fills, person chips, the focus ring, and more — all of which would have silently broken (an undefined custom property resolves to nothing: invisible text, missing borders/backgrounds) the moment those names were removed from `:root`. The corrected, much safer approach below **keeps all 4 existing token names and only changes their values** — every one of those 50+ existing, correctly-scoped call sites inherits the new color automatically, with zero rewrites needed anywhere else in the file. No new color-token names are introduced; new code written for Cash Flow/Spending (below) reuses `--teal`/`--amber`/`--red`/`--blue` directly, matching the existing codebase's own convention of reusing these 4 names for multiple semantic roles (positive/brand, attention/accent, danger, info) rather than inventing single-purpose names.

Current `:root` block (`assets/styles.css:3-36`, from the prior pilot) gets these value changes (names unchanged except the two noted):

```css
--ink: #14151a; /* was #12161c — near-black, neutral (not navy) so it doesn't fight vivid accents */
--ink-2: #4b4d57; /* was #3c4653 */
--ink-3: #8a8d99; /* was #6b7684 */
--paper: #f6f7f9; /* was #faf7f2 — clean near-white, replaces the warm cream paper tone */
--paper-2: #eef0f3; /* was #f2eee6 */
--rule: #e7e8ed; /* was #ddd5c8 */
--rule-2: #d7d9e0; /* was #c6bcab */
--teal: #00a389; /* was #0f766e — Monarch's actual vibrant teal-green; same semantic role (positive/primary accent) at every existing call site */
--amber: #ff6b4a; /* was #b45309 — warm coral; same semantic role (attention/secondary accent) at every existing call site */
--red: #e5484d; /* was #b3261e — punchier, same semantic role (danger/negative) */
--blue: #3b82f6; /* was #1d4ed8 — same semantic role (info/misc accent) */
--mono:
  "Inter", ui-monospace, SFMono-Regular, Menlo, monospace; /* was "JetBrains Mono" — token NAME kept for tabular-numeral contexts, now points at Inter, not a separate monospace family */
--disp:
  "Sora", system-ui, -apple-system, Segoe UI, sans-serif; /* was "Space Grotesk" */
```

Tokens from the prior pilot's revamp (`--radius-sm`, `--radius-md`, `--card-bg`, `--shadow-card`, `--shadow-card-hover`, `--shadow-focus`, `--motion-fast/base/slow/ease`, `--cat-color-0..7`) are kept as token _names_ (nothing that references them needs renaming) but several get new values:

```css
--radius-sm: 10px; /* was 8px */
--radius-md: 18px; /* was 12px — bigger, more "card" than "panel" */
--card-bg: #ffffff; /* unchanged */
--shadow-card:
  0 2px 8px rgba(20, 21, 26, 0.06), 0 12px 32px -8px rgba(20, 21, 26, 0.14); /* more visible than the pilot's subtle version */
--shadow-card-hover:
  0 4px 12px rgba(20, 21, 26, 0.08), 0 20px 48px -12px rgba(20, 21, 26, 0.2);
--shadow-focus: 0 0 0 3px rgba(0, 163, 137, 0.35); /* now brand-teal, was amber */
```

`--cat-color-0` through `--cat-color-7` (8 slots, used by `.category-chip`/`.person-chip` CSS classes) are replaced with the 12-color vivid spectrum, extended from 8 to 12 slots (both `CATEGORY_PALETTE_SIZE` in `assets/store.js` and `PERSON_PALETTE_SIZE` move from 8/5 to 12, so more categories/people get visually distinct colors before the hash starts repeating):

```css
--cat-color-0: #3b82f6; /* blue */
--cat-color-1: #a855f7; /* purple */
--cat-color-2: #ec4899; /* pink */
--cat-color-3: #f59e0b; /* amber */
--cat-color-4: #10b981; /* emerald */
--cat-color-5: #06b6d4; /* cyan */
--cat-color-6: #f97316; /* orange */
--cat-color-7: #8b5cf6; /* violet */
--cat-color-8: #ef4444; /* red */
--cat-color-9: #14b8a6; /* teal */
--cat-color-10: #eab308; /* yellow */
--cat-color-11: #84cc16; /* lime */
```

**Google Fonts `<link>` in `index.html`** changes from Space Grotesk + JetBrains Mono to Sora + Inter:

```html
<link
  href="https://fonts.googleapis.com/css2?family=Sora:wght@500;600;700;800&family=Inter:wght@400;500;600;700&display=swap"
  rel="stylesheet"
/>
```

`body`'s `font-family: var(--disp)` stays (now resolves to Sora); anywhere the CSS currently sets `font-family: var(--mono)` for tabular figures keeps doing so (now resolves to Inter) — `font-variant-numeric: tabular-nums` (already applied via the existing `.num`/`td.n`/`th.n` selectors, unchanged) is what actually aligns the digits, not the font family itself, so this swap is safe without touching those rules.

## Chart Color Palette (`assets/charts.js`)

Current constants (`charts.js:5-14`):

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

Replace with values matching the new CSS tokens above — same naming discipline as the CSS fix: **keep the existing constant names, only change their values**, so `TEAL`/`AMBER`/`RED`/`BLUE` in JS stay aligned with `--teal`/`--amber`/`--red`/`--blue` in CSS rather than diverging into a parallel naming scheme:

```js
const INK = "#14151a",
  INK3 = "#8a8d99",
  RULE = "#e7e8ed";
const TEAL = "#00a389",
  AMBER = "#ff6b4a",
  RED = "#e5484d",
  BLUE = "#3b82f6",
  PURPLE = "#a855f7";
const SAND =
  "#c7cad1"; /* was #c6bcab — kept as a name, mid-gray-blue instead of the old warm tan, still reads as "neutral" against the new palette */
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

`SAND` is **kept** (checked its 4 real call sites via grep, not assumed): `PIE`'s 7th slot, `actualVsBudget`'s "Budget" bar fill (`charts.js:174`, deliberately neutral against the "Actual" bar's `RED`/`INK`), and `colorFor()`'s `"Unassigned"` person fallback (`charts.js:253`, explicitly commented as "the same neutral SAND it always has" — a semantic role, not a leftover). A vivid category color would be wrong in both of those roles (a bar meant to read as a neutral ceiling, and a "no one assigned yet" placeholder, shouldn't visually compete with real data). `PIE` itself is dropped in favor of `CATEGORY_SPECTRUM` (12 colors instead of 7, correctly named for what it now represents — every chart that colors by category). `PERSON_PALETTE` (`charts.js:249`, `[TEAL, AMBER, BLUE, RED, PURPLE]`) needs no changes — same 5 names, new values, inherited automatically. Every existing reference to `TEAL`/`AMBER`/`RED`/`BLUE`/`PURPLE`/`SAND` inside chart-builder functions (`incomeVsExpense`, `netByMonth`, `actualVsBudget`, `personSplit`, `netWorthTrend`, `assetSplit`, `personVsBudget`) needs no renaming at all — only `PIE` references become `CATEGORY_SPECTRUM`. `Chart.defaults.font.family` (`charts.js:46`, currently hardcoded to `"'JetBrains Mono', ui-monospace, monospace"`) changes to `"'Inter', ui-monospace, sans-serif"`.

## New Tab: Cash Flow

**Nav:** new `<button data-tab="cashflow">Cash Flow</button>` in `index.html`'s `#tabs`, placed right after Dashboard. New `cashflow: renderCashFlow` entry in `app.js`'s `VIEWS` object (`app.js:4159-4168`), placed correspondingly.

**Data shaping** (new, lives in `renderCashFlow()` itself — does not modify the existing `aggregate()` in `xlsxio.js`, which stays untouched since Transactions/Dashboard/Budget all depend on its exact current return shape):

```js
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

`monthOf` is the existing helper already imported/used elsewhere in `app.js` — reused, not redefined.

**Sankey rendering** — new function in `charts.js`, e.g. `cashFlow(flows)`. Its inner helper is named `flowColorFor`, not `colorFor` — `charts.js` already has a module-level `colorFor` (the person-palette helper at `charts.js:250`), and shadowing that name inside a new function, while technically legal, is confusing to read next to the real one:

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
```

`categoryColorIndex` is the existing hash function from `store.js` (added in the prior pilot for `.category-chip`); reused here to keep a category's Sankey-flow color consistent with its color everywhere else in the app (Transactions' chips, Spending's donut/list below). `mount()` is the existing shared Chart.js-instance-management helper (`charts.js:25-50`) — the Sankey chart participates in the same registry/`destroyAll()` lifecycle as every other chart, no special-casing needed since `chartjs-chart-sankey` registers `type: "sankey"` as a normal Chart.js controller.

**Loading the plugin** — `index.html`, immediately after the existing Chart.js and GSAP tags:

```html
<script
  src="https://cdn.jsdelivr.net/npm/chartjs-chart-sankey@0.15.0/dist/chartjs-chart-sankey.min.js"
  defer
></script>
```

Version is pinned exactly (`@0.15.0`, not `@latest`) — a prior release (0.14.1) shipped a build that broke registration, fixed in 0.14.2/0.14.3; pinning avoids inheriting a future regression silently. No CSP change needed (`script-src` already allows `https://cdn.jsdelivr.net`). No `Chart.register(...)` call needed — the browser/UMD build self-registers `SankeyController`/`Flow` on load, unlike the ESM/bundler import path.

**Empty state:** when `cashFlowData(...).hasData` is `false` (no income or expense rows in the selected period), `renderCashFlow()` renders a `<div class="empty">No income or expenses recorded for this period yet.</div>` in place of the chart canvas, matching the existing empty-state pattern already used on Transactions (`renderTransactions`'s `rows.length === 0` branch) and the Payment method split panel — never calls `charts.cashFlow()` with an empty `flows` array (the library's behavior with zero data rows is undocumented and untested; the safer, already-established app pattern is to not attempt the chart at all).

**Layout, top to bottom:** 3-KPI row (Income/Expenses/Net, same `.kpi` markup pattern as Dashboard) → `.panel` containing the Sankey canvas → `.panel` containing a monthly net-trend line chart (new `netTrendLine(series)` function in `charts.js`, reusing `aggregate()`'s existing `series` array — `series[i].net` — so this one chart DOES reuse `aggregate()`, unlike the Sankey data above, since `series` is exactly the right shape already).

**Motion:** identical pattern to Dashboard's `buildDashboardShell` — `cardHoverable` + `revealStagger` on the KPI tiles and panels, `countUp` on the KPI values (both initial-load-instant and patch-path-animated, following the same ruling as Dashboard's Task 4: no first-load count-up, patch-path only), chart `drawIn` animation on both the Sankey and the trend line.

## New Tab: Spending

**Nav:** new `<button data-tab="spending">Spending</button>`, placed right after Cash Flow. New `spending: renderSpending` entry in `VIEWS`.

**Data shaping:** reuses `aggregate()`'s existing `catRows` (already exactly `{category, actual, budget, variance, used}` per expense category) — no new aggregation function needed here, unlike Cash Flow. Top-6-plus-Other reduction, done inline in `renderSpending()`:

```js
const spendRows = [...a.catRows]
  .filter((r) => r.actual > 0)
  .sort((x, y) => y.actual - x.actual);
const top6 = spendRows.slice(0, 6);
const otherTotal = spendRows.slice(6).reduce((sum, r) => sum + r.actual, 0);
const donutRows =
  otherTotal > 0 ? [...top6, { category: "Other", actual: otherTotal }] : top6;
```

**Donut rendering** — new `spendingDonut(donutRows, onSliceClick)` in `charts.js`:

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
      plugins: { legend: { display: false } },
      onClick: (evt, elements) => {
        if (elements.length) onSliceClick(rows[elements[0].index].category);
      },
    },
  });
}
```

Legend is disabled on the chart itself (`legend: {display:false}`) because the category list below the donut IS the legend — duplicating it would be redundant and is explicitly the kind of thing the accessibility guidance behind this design (donut slices need a non-color-only, precise-value fallback) argues against having two competing versions of.

**Category list + two-way interactivity** (new markup in `renderSpending()`'s template, new wiring function `wireSpendingList()` mirroring the existing `wireDashboard`/`wireTransactions`-style post-render wiring pattern already used throughout `app.js`):

- Each row: `<div class="spend-row" data-cat="${esc(r.category)}">` containing a color dot (`background: var(--cat-color-N)` via the same `categoryColorClass` used elsewhere), category name, formatted amount, and a `<div class="spend-bar-fill" style="width:${pct}%">` inline percentage bar.
- Click on a row → same effect as clicking its donut slice: adds an `.active` class to that row (removing it from any previously-active row) and calls a new `charts.highlightSlice(index)` helper (uses Chart.js's `chart.setActiveElements([{datasetIndex:0, index}]); chart.update();` API) to visually pop that slice.
- Hover on a row → same highlight, without the persistent `.active` state (removed on `mouseleave`).
- Click/hover on a donut slice (via the `onSliceClick` callback wired above) → finds the matching `.spend-row[data-cat="..."]` and toggles the same `.active` class, so the link works in both directions from one small piece of state (the currently-active category name) rather than two independent code paths.

**Layout, top to bottom:** 3-KPI row (Total Spend / Top Category / Transaction Count) → `.panel` containing the donut (canvas) side-by-side with the category list (CSS grid, two columns above ~900px per the existing `.grid2` breakpoint pattern already in `styles.css`, stacked below it) → `.panel` containing a monthly-spend-only bar chart (new `spendTrend(series)` in `charts.js`, reusing `aggregate()`'s `series[i].expense`).

**Motion:** same pattern as Cash Flow — `cardHoverable`/`revealStagger`/`countUp` on KPIs and panels, `revealStagger` on the category list rows (reusing the exact `txRevealed`-style "first reveal only" gating Transactions already established, via a new `spendRevealed` Set-per-period-key so switching back to an already-seen month doesn't replay the stagger).

## File / Component Map

| File                                             | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Expense_tracker_New/frontend/index.html`        | New Google Fonts link (Sora+Inter), new `chartjs-chart-sankey@0.15.0` script tag, 2 new `<button data-tab>` entries in `#tabs`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `Expense_tracker_New/frontend/assets/styles.css` | `:root` token values replaced (names kept, per the correction above); `--cat-color-8` through `--cat-color-11` added; 4 matching new rules added immediately after the existing 8 (`.category-chip.category-color-8 { background: var(--cat-color-8); }` etc., exact pattern match to `styles.css:1666-1673`); font-family `<link>` swap reflected in `index.html`, not this file.                                                                                                                                                                                                                                                                                                                                                                     |
| `Expense_tracker_New/frontend/assets/store.js`   | `CATEGORY_PALETTE_SIZE` changes `8 → 12` (matches the extended `--cat-color-0..11` CSS tokens and the new `CATEGORY_SPECTRUM` JS array). `PERSON_PALETTE_SIZE` (`5`) is **unchanged** — checked: it indexes a separate, differently-structured 5-entry fixed list in both `styles.css` (`.person-chip.person-color-0..4`, each referencing a distinct named token) and `charts.js` (`PERSON_PALETTE = [TEAL, AMBER, BLUE, RED, PURPLE]`), not the 12-slot `--cat-color-N`/`CATEGORY_SPECTRUM` array — extending it isn't a natural fit for that structure, and it's out of this spec's scope (person colors, not category colors). Both palettes inherit new colors automatically via the token-value swap above; only the category one grows in size. |
| `Expense_tracker_New/frontend/assets/charts.js`  | Color constant values updated (names unchanged); `SAND` recolored not dropped; `PIE` replaced by `CATEGORY_SPECTRUM`; `Chart.defaults.font.family` updated; import line gains `categoryColorIndex` (`import { personColorIndex, categoryColorIndex, currentCurrency } from "./store.js";`); new `cashFlow()`, `netTrendLine()`, `spendingDonut()`, `spendTrend()`, `highlightSlice()` functions.                                                                                                                                                                                                                                                                                                                                                       |
| `Expense_tracker_New/frontend/assets/app.js`     | New `renderCashFlow()`, `renderSpending()`, `cashFlowData()` helper, `wireSpendingList()`; `VIEWS` object gains 2 entries.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

## Testing & Verification

Same constraints and approach as the prior pilot: no automated frontend test suite (confirmed unchanged) — `node --check` per touched JS file, plus manual browser verification via a locally-served instance with the Cognito gate bypassed (`sessionStorage.setItem('ledger.cognitoIdToken','fake-preview-token')`). This session's browser-automation tab runs backgrounded (`document.hidden === true`), which freezes GSAP's rAF-driven tweens — established during the prior pilot's implementation and its final review; verification steps account for this by using `gsap.globalTimeline.progress(1)` to force tween completion before asserting on end-state, and by independently checking reduced-motion behavior via synchronous state (not by trying to observe live animation in this environment).

Specific new things to verify beyond the prior pilot's checklist:

1. Every existing tab (not just Dashboard/Transactions) renders correctly with the new token values — no leftover old-palette hex values anywhere, no illegible text (contrast check against the new `--paper`/`--card-bg` backgrounds).
2. Cash Flow's Sankey renders correctly with real multi-category data, and shows the empty state (not a broken/blank canvas) when a period has no rows.
3. Cash Flow's Sankey omits the Savings node correctly when net is negative (does not fabricate a flow).
4. Spending's donut correctly aggregates categories beyond 6 into "Other", and the two-way donut↔list interactivity works in both directions.
5. `chartjs-chart-sankey`'s pinned CDN version actually loads and self-registers (console-check for "sankey is not a registered controller", the exact regression this spec's version-pinning is guarding against).
6. Person/category color palette extension (8/5 → 12) doesn't break any existing chip rendering on Transactions/Net Worth (spot-check a few different category/person names to confirm distinct colors, no `undefined` CSS class from an out-of-range index).

## Future Work (explicitly out of scope here)

- Trimming Dashboard's chart set now that Cash Flow/Spending exist as dedicated views.
- A tab-overflow/hamburger navigation pattern, if 10 tabs prove cramped in real use.
- Dark mode.
- Drilling from a Spending category row/slice into a filtered Transactions view (today's interactivity is scoped to highlighting within the Spending tab itself, not cross-tab navigation).
