# UI Elevation & Motion Revamp — Pilot (Dashboard + Transactions) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Dashboard and Transactions tabs of the Ledger frontend a card-and-shadow visual treatment plus a GSAP-driven motion system (count-ups, staggered reveal, chart draw-in, hover-lift, exit animations), while keeping the existing paper/amber/mono ledger identity intact.

**Architecture:** Purely presentation-layer, no build step. New design tokens and elevated component styles are added to the existing single `assets/styles.css`. A new `assets/motion.js` ES module wraps GSAP calls behind small named functions (`countUp`, `revealStagger`, `cardHoverable`, `exitCollapse`, `viewTransition`) so `app.js`/`charts.js` call intent, not raw GSAP, and reduced-motion is one guard instead of scattered checks. GSAP loads from the CDN already whitelisted in `index.html`'s CSP for Chart.js.

**Tech Stack:** Vanilla JS (ES modules, no bundler), GSAP 3.12.5 (new, via jsdelivr), Chart.js 4.4.1 (existing), plain CSS custom properties.

**Spec:** `docs/superpowers/specs/2026-08-24-ui-motion-revamp-pilot-design.md`

## Global Constraints

- No new build tooling (no bundler, no npm, no package.json). Plain `<script>`/ES modules only.
- No changes to existing color tokens `--ink`, `--ink-2`, `--ink-3`, `--paper`, `--paper-2`, `--rule`, `--rule-2`, `--teal`, `--amber`, `--red`, `--blue`, `--mono`, `--disp` in `assets/styles.css` — additive tokens only.
- `.rail` (header), hairline dividers, and `.foot` (footer) stay flat — elevation (radius/shadow) never applies to them.
- `prefers-reduced-motion: reduce` must disable all non-essential motion (stagger, slide, lift) via a single guard in `assets/motion.js`, not per call site.
- Only Dashboard (`assets/app.js`'s `renderDashboard`/`buildDashboardShell`/`updateDashboardValues`/`wireDashboard`) and Transactions (`renderTransactions`) get new JS/motion wiring. Other tabs (Add, Budget, Net worth, Data, Billing, Profile) get the CSS elevation for free via shared `.kpi`/`.panel` classes, and must not regress, but get no new JS in this plan.
- Per-row transaction amounts never count up — only aggregate totals (page header income/expense/net, group subtotals) do.
- This project has no test framework, no `package.json`, and no build step (confirmed by inspection). Every task's verification step uses `node --check <file>` for JS syntax validation (confirmed working against this project's real ESM files, e.g. `assets/store.js`, under Node v24) plus a manual browser check: serve `Expense_tracker_New/frontend` with `python3 -m http.server`, bypass the Cognito sign-in gate via `sessionStorage.setItem('ledger.cognitoIdToken', 'fake-preview-token')` then reload (the frontend's `getIdToken()` only checks token presence, not validity — this renders the full authenticated app shell in the honest "disconnected" state), and visually confirm the behavior described in that task's Step "Verify in browser".

---

### Task 1: Foundation — GSAP, design tokens, and the `motion.js` module

**Files:**
- Modify: `Expense_tracker_New/frontend/index.html` (add GSAP script tag)
- Modify: `Expense_tracker_New/frontend/assets/styles.css` (new tokens, reduced-motion query)
- Create: `Expense_tracker_New/frontend/assets/motion.js`

**Interfaces:**
- Produces: `countUp(el, from, to, fmt, duration = 0.6)`, `revealStagger(els, { stagger, duration })`, `cardHoverable(el)`, `exitCollapse(el, duration = 0.25)`, `viewTransition(renderFn)`, all exported from `assets/motion.js`. Every later task imports from here.
- Produces CSS tokens consumed by every later task: `--radius-sm`, `--radius-md`, `--card-bg`, `--shadow-card`, `--shadow-card-hover`, `--shadow-focus`, `--motion-fast`, `--motion-base`, `--motion-slow`, `--motion-ease`, `--cat-color-0` through `--cat-color-7`.
- Produces CSS class `.card-hoverable` (hover lift, respects reduced motion) consumed by Tasks 2 and 6.

- [ ] **Step 1: Add the GSAP script tag**

In `Expense_tracker_New/frontend/index.html`, immediately after the existing Chart.js `<script>` tag (currently the last thing in `<head>` before the SheetJS comment):

```html
    <script
      src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"
      defer
    ></script>
    <script
      src="https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/gsap.min.js"
      defer
    ></script>
```

No CSP change needed — `script-src` in the existing `<meta http-equiv="Content-Security-Policy">` tag already includes `https://cdn.jsdelivr.net`.

- [ ] **Step 2: Add design tokens to `:root` in `assets/styles.css`**

Immediately after the existing `--disp: "Space Grotesk", ...;` line inside the `:root` block (do not remove or reorder any existing token):

```css
  /* ---- elevation & motion (added for the card/motion revamp) ---- */
  --radius-sm: 8px;
  --radius-md: 12px;
  --card-bg: #ffffff;
  --shadow-card: 0 1px 2px rgba(18, 22, 28, 0.04), 0 8px 24px -8px rgba(18, 22, 28, 0.1);
  --shadow-card-hover: 0 2px 4px rgba(18, 22, 28, 0.06), 0 16px 32px -12px rgba(18, 22, 28, 0.16);
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
```

- [ ] **Step 3: Add the `.card-hoverable` class and reduced-motion query**

Append to the end of `assets/styles.css`:

```css

/* ---------- card hover-lift (added for the card/motion revamp) ---------- */
.card-hoverable {
  transition:
    box-shadow var(--motion-fast) var(--motion-ease),
    transform var(--motion-fast) var(--motion-ease);
}
.card-hoverable:hover {
  box-shadow: var(--shadow-card-hover);
  transform: translateY(-2px);
}
@media (prefers-reduced-motion: reduce) {
  .card-hoverable {
    transition: none;
  }
  .card-hoverable:hover {
    transform: none;
  }
}
```

- [ ] **Step 4: Apply `--shadow-focus` to keyboard focus on the new/touched interactive buttons**

`--shadow-focus` (added in Step 2) needs at least one consumer, or it's a dead token. The elements later tasks add or touch that are real focusable `<button>`s inside `#view` are: `.tx-group-header` (Task 6), `.txbtn` edit/delete (unchanged markup, but now sitting inside elevated rows — Task 6), and `#tx-expand-all`/`#tx-collapse-all` (unchanged, same tab). A single scoped rule here covers all of them without any later task needing its own focus-visible step. Append, immediately after the `.card-hoverable` block added in Step 3:

```css
#view button:focus-visible {
  outline: none;
  box-shadow: var(--shadow-focus);
}
```

(This doesn't touch `input`/`select`/`textarea`/`.bcard`-family focus styles, which already exist elsewhere in this file and are out of scope — it only adds a rule for plain `<button>` elements inside the main view, which currently fall back to the browser's default outline.)

- [ ] **Step 5: Create `assets/motion.js`**

```js
/* GSAP-backed motion primitives. app.js and charts.js call these named
   functions rather than raw GSAP, so reduced-motion is one guard here
   instead of a check scattered across every call site, and callers don't
   need to know GSAP's API. */

const reduced = () =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Animates a number from `from` to `to`, formatting each tick through
    `fmt` (money()/pct()/etc.) so the display never shows an unformatted
    raw number mid-count. Falls back to an instant text-set when motion is
    reduced, GSAP hasn't loaded, or from/to are equal or not both finite
    numbers (e.g. a metric currently showing "—"). */
export function countUp(el, from, to, fmt, duration = 0.6) {
  if (
    !el ||
    reduced() ||
    !window.gsap ||
    !Number.isFinite(from) ||
    !Number.isFinite(to) ||
    from === to
  ) {
    if (el) el.textContent = fmt(to);
    return;
  }
  const obj = { v: from };
  gsap.to(obj, {
    v: to,
    duration,
    ease: "power2.out",
    onUpdate: () => (el.textContent = fmt(obj.v)),
  });
}

/** Staggers an array/NodeList of elements in with an 8px rise + fade.
    No-ops (sets opacity 1 immediately) under reduced motion or a missing
    GSAP, and does nothing at all for an empty list. */
export function revealStagger(els, { stagger = 0.04, duration = 0.35 } = {}) {
  const list = Array.from(els || []);
  if (!list.length) return;
  if (reduced() || !window.gsap) {
    list.forEach((el) => (el.style.opacity = 1));
    return;
  }
  gsap.fromTo(
    list,
    { opacity: 0, y: 8 },
    { opacity: 1, y: 0, duration, stagger, ease: "power2.out" },
  );
}

/** Marks an element as hover-liftable (see .card-hoverable in styles.css).
    Exists so call sites don't need to know the CSS class name directly. */
export function cardHoverable(el) {
  if (el) el.classList.add("card-hoverable");
}

/** Fades and height-collapses an element before its caller removes it
    from the DOM/state. Resolves once the animation completes, or
    immediately under reduced motion / missing GSAP (callers must still
    await the returned promise either way). */
export function exitCollapse(el, duration = 0.25) {
  if (!el || reduced() || !window.gsap) return Promise.resolve();
  return new Promise((resolve) => {
    gsap.to(el, {
      opacity: 0,
      height: 0,
      marginTop: 0,
      marginBottom: 0,
      paddingTop: 0,
      paddingBottom: 0,
      duration,
      ease: "power1.in",
      onComplete: resolve,
    });
  });
}

/** Fades/slides #view out, runs renderFn synchronously, then fades/slides
    the new content in. Falls back to calling renderFn directly (no
    animation) under reduced motion or a missing GSAP. */
export function viewTransition(renderFn) {
  const view = document.getElementById("view");
  if (!view || reduced() || !window.gsap) {
    renderFn();
    return;
  }
  gsap.to(view, {
    opacity: 0,
    y: -6,
    duration: 0.12,
    ease: "power1.in",
    onComplete: () => {
      renderFn();
      gsap.fromTo(
        view,
        { opacity: 0, y: 8 },
        { opacity: 1, y: 0, duration: 0.18, ease: "power2.out" },
      );
    },
  });
}
```

- [ ] **Step 6: Verify syntax**

Run: `node --check Expense_tracker_New/frontend/assets/motion.js`
Expected: exits 0, no output.

- [ ] **Step 7: Verify in browser**

From `Expense_tracker_New/frontend`, run `python3 -m http.server 8099`, open `http://localhost:8099/index.html` in a browser, open DevTools console, run `sessionStorage.setItem('ledger.cognitoIdToken','fake-preview-token')`, reload. In the console:
- `typeof window.gsap` → `"object"` (GSAP loaded).
- The page renders exactly as before, with one exception: click into a tab (e.g. Transactions) and Tab-key through its buttons — each focused button now shows the new amber `--shadow-focus` ring instead of the browser default outline. Everything else (KPI/panel appearance, no shadows/radius yet) is unchanged until Task 2.
- No console errors.

Stop the server (`Ctrl-C` or `kill` the process) when done.

- [ ] **Step 8: Commit**

```bash
git add Expense_tracker_New/frontend/index.html Expense_tracker_New/frontend/assets/styles.css Expense_tracker_New/frontend/assets/motion.js
git commit -m "feat(frontend): add GSAP, design tokens, and motion.js foundation"
```

---

### Task 2: Dashboard — card elevation, hover-lift, entrance stagger

**Files:**
- Modify: `Expense_tracker_New/frontend/assets/styles.css` (`.kpis`/`.kpi`/`.panel` elevation)
- Modify: `Expense_tracker_New/frontend/assets/app.js` (`buildDashboardShell`, hover wiring)

**Interfaces:**
- Consumes: `revealStagger`, `cardHoverable` from `assets/motion.js` (Task 1).
- Produces: nothing new consumed by later tasks (this task is presentation-only for Dashboard's static shell).

- [ ] **Step 1: Elevate `.kpis`/`.kpi` in `assets/styles.css`**

The current `.kpis` (lines ~244-294) is a single bordered strip with `.kpi` cells separated by internal `border-right`/`border-bottom` — not individual cards. Replace it with a gap-based grid of individually elevated cards. Replace the existing block:

```css
.kpis {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  border: 1px solid var(--rule-2);
  background: #fff;
}
.kpi {
  padding: 13px 14px;
  border-right: 1px solid var(--rule);
}
.kpi:last-child {
  border-right: 0;
}
```

with:

```css
.kpis {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 12px;
}
.kpi {
  padding: 13px 14px;
  background: var(--card-bg);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-card);
}
```

(`.kpi .k`, `.kpi .v`, `.kpi .m`, `.kpi.neg .v`, `.kpi.pos .v` — the three lines after — are unchanged, leave them exactly as-is.)

In the `@media (max-width: 1100px)` block just below, remove the now-irrelevant per-item divider line — change:

```css
@media (max-width: 1100px) {
  .kpis {
    grid-template-columns: repeat(3, 1fr);
  }
  .kpi {
    border-bottom: 1px solid var(--rule);
  }
}
```

to:

```css
@media (max-width: 1100px) {
  .kpis {
    grid-template-columns: repeat(3, 1fr);
  }
}
```

- [ ] **Step 2: Elevate `.panel` in `assets/styles.css`**

Replace:

```css
.panel {
  border: 1px solid var(--rule-2);
  background: #fff;
  padding: 14px;
}
```

with:

```css
.panel {
  background: var(--card-bg);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-card);
  padding: 14px;
}
```

(`.panel h3` immediately below is unchanged.)

- [ ] **Step 3: Wire hover-lift and entrance stagger into `buildDashboardShell`**

In `assets/app.js`, add the import at the top of the file, alongside the existing imports (find the line importing from `./store.js` and add a new import line after it):

```js
import { cardHoverable, revealStagger } from "./motion.js";
```

At the end of `buildDashboardShell` (after `view.innerHTML = ...` finishes setting the shell — the function currently ends right after the template literal is assigned), add:

```js
  view.querySelectorAll(".kpi, .panel").forEach(cardHoverable);
  revealStagger(view.querySelectorAll(".kpi"));
  revealStagger(view.querySelectorAll(".panel"), { stagger: 0.04 });
```

Order matters: `revealStagger` is called once for `.kpi` elements, then once for `.panel` elements — GSAP queues these as separate tweens, so the panel stagger's tween starts immediately after being scheduled (same tick), not after the KPI stagger visually finishes. To make panels start only once the KPI stagger completes, use GSAP's `delay` computed from the KPI stagger's own duration instead of two independent calls. Replace the two `revealStagger` lines above with:

```js
  const kpiEls = view.querySelectorAll(".kpi");
  const panelEls = view.querySelectorAll(".panel");
  revealStagger(kpiEls);
  const kpiFinish = 0.35 + Math.max(0, kpiEls.length - 1) * 0.04; // duration + stagger tail, matches revealStagger's defaults
  if (window.gsap && panelEls.length) {
    gsap.set(panelEls, { opacity: 0, y: 8 });
    gsap.to(panelEls, {
      opacity: 1,
      y: 0,
      duration: 0.35,
      stagger: 0.04,
      delay: kpiFinish,
      ease: "power2.out",
    });
  } else {
    panelEls.forEach((el) => (el.style.opacity = 1));
  }
```

- [ ] **Step 4: Verify syntax**

Run: `node --check Expense_tracker_New/frontend/assets/app.js`
Expected: exits 0, no output.

- [ ] **Step 5: Verify in browser**

Serve and bypass the gate as in Task 1 Step 6, land on Dashboard (`#dashboard`):
- KPI tiles render as individually shadowed, rounded cards with visible gaps between them (not one bordered strip).
- Chart panels render the same way.
- On page load, KPI tiles fade/rise in first, then chart panels fade/rise in after (not simultaneously).
- Hovering a KPI tile or chart panel shows a deeper shadow and a slight upward shift.
- No console errors.

Stop the server when done.

- [ ] **Step 6: Commit**

```bash
git add Expense_tracker_New/frontend/assets/styles.css Expense_tracker_New/frontend/assets/app.js
git commit -m "feat(frontend): elevate Dashboard KPI tiles and chart panels with hover-lift and entrance stagger"
```

---

### Task 3: Dashboard — chart draw-in animation

**Files:**
- Modify: `Expense_tracker_New/frontend/assets/charts.js`

**Interfaces:**
- Consumes: nothing new (pure Chart.js config change).
- Produces: nothing new consumed by later tasks.

- [ ] **Step 1: Add a shared draw-in animation constant**

In `assets/charts.js`, alongside the existing shared constants `gridY`, `gridX`, `legendTop` (lines ~56-68), add:

```js
const drawIn = { duration: 600, easing: "easeOutQuart" };
```

- [ ] **Step 2: Apply it to every chart-builder function Dashboard uses**

Add `animation: drawIn,` inside the `options: { ... }` block of each of these functions (all currently missing an `animation` key, which leaves Chart.js's default — instant/no animation — in effect): `incomeVsExpense`, `netByMonth`, `trend`, `actualVsBudget`, `topFive`, `paymentSplit`, `personSplit`, `personByMonth`, `dividendsTrend`.

For example, `incomeVsExpense`'s `options` block changes from:

```js
    options: {
      maintainAspectRatio: false,
      responsive: true,
      plugins: legendTop,
      scales: { x: gridX, y: gridY },
    },
```

to:

```js
    options: {
      maintainAspectRatio: false,
      responsive: true,
      animation: drawIn,
      plugins: legendTop,
      scales: { x: gridX, y: gridY },
    },
```

Apply the identical one-line addition (`animation: drawIn,` as the first or second key in each function's `options` object) to the other eight functions listed above. Do **not** add it to `netWorthTrend`, `assetSplit`, or `personVsBudget` — those back the Net Worth tab, which is out of scope for this plan (see Global Constraints).

- [ ] **Step 3: Verify syntax**

Run: `node --check Expense_tracker_New/frontend/assets/charts.js`
Expected: exits 0, no output.

- [ ] **Step 4: Verify in browser**

Serve and bypass the gate, land on Dashboard. Reload the page (hard refresh) and watch the charts: each should visibly draw in (bars/lines animate from baseline) over roughly half a second, rather than appearing instantly. Switch the month/year selector and confirm charts still update correctly (Chart.js's own update animation applies here too). No console errors.

Stop the server when done.

- [ ] **Step 5: Commit**

```bash
git add Expense_tracker_New/frontend/assets/charts.js
git commit -m "feat(frontend): add draw-in animation to Dashboard charts"
```

---

### Task 4: Dashboard — KPI count-up (initial load and month/year patch path)

**Files:**
- Modify: `Expense_tracker_New/frontend/assets/app.js` (`buildDashboardShell`, `updateDashboardValues`)

**Interfaces:**
- Consumes: `countUp` from `assets/motion.js` (Task 1).
- Produces: `state._dashLastAgg` (the last-rendered aggregate object, read by the next `updateDashboardValues` call) — no other task depends on this field.

- [ ] **Step 1: Import `countUp`**

In `assets/app.js`, change the import added in Task 2 Step 3 from:

```js
import { cardHoverable, revealStagger } from "./motion.js";
```

to:

```js
import { cardHoverable, revealStagger, countUp } from "./motion.js";
```

- [ ] **Step 2: Store the last-rendered aggregate**

At the very end of `buildDashboardShell` (after the stagger code added in Task 2 Step 3), add:

```js
  state._dashLastAgg = a;
```

(`a` is the aggregate parameter `buildDashboardShell` already receives — it is the first parameter per the current signature `function buildDashboardShell(a, label, people, pSeries, showCompare)`. Note the call site passes a 6th argument, `shape` — `buildDashboardShell(a, label, people, pSeries, showCompare, shape)` in `renderDashboard` — that the function signature doesn't declare; it's silently dropped, a pre-existing quirk unrelated to this task. Do not add a `shape` parameter to `buildDashboardShell` as part of this task.)

- [ ] **Step 3: Rewrite `updateDashboardValues` to count up instead of instant text-set**

Replace the current body of `updateDashboardValues` (which sets `.v`/`.m` text directly via a local `setKpi(key, v, m)` helper) with a version that counts up from `state._dashLastAgg` to the new aggregate `a`, falling back to an instant set when there's no previous value or the metric is a non-numeric placeholder ("—"):

**Ruling (found during Task 2's review):** the code below already includes a fix for a real, confirmed bug — `#kpi-net`/`#kpi-budgetused` each get a `card-hoverable` class in Task 2 (via `cardHoverable()` in `buildDashboardShell`), but this function's original `netEl.className = ...`/`budEl.className = ...` lines do a bare overwrite that silently strips it, and `boot()`'s background `ensureAllYearsLoaded()` callback re-renders through this exact function on nearly every real session — not an edge case. The two `className` lines below include `card-hoverable` in the template string specifically to preserve it. Do not remove `card-hoverable` from those two lines as "not part of this task's scope" — it is a required fix carried forward from Task 2's review finding, not stray code.

```js
function updateDashboardValues(a, label, people, pSeries, showCompare) {
  const sub = $("#dash-sub");
  if (sub)
    sub.textContent = `${personLabel()} · ${label} · ${a.count} transactions`;

  const prev = state._dashLastAgg;

  const setKpiMeta = (key, m) => {
    const mEl = $(`#kpi-${key}-m`);
    if (mEl) mEl.textContent = m;
  };
  const setKpiNumber = (key, from, to, fmt) => {
    const vEl = $(`#kpi-${key}-v`);
    if (!vEl) return;
    if (from === undefined || from === null) {
      vEl.textContent = fmt(to);
      return;
    }
    countUp(vEl, from, to, fmt);
  };
  const setKpiText = (key, text) => {
    const vEl = $(`#kpi-${key}-v`);
    if (vEl) vEl.textContent = text;
  };

  setKpiNumber("income", prev?.income, a.income, money);
  setKpiMeta("income", a.income === 0 ? "no income recorded" : "");

  setKpiNumber("expense", prev?.expense, a.expense, money);
  setKpiMeta("expense", `${a.count} entries`);

  const netEl = $("#kpi-net");
  if (netEl) netEl.className = `kpi card-hoverable ${a.net < 0 ? "neg" : "pos"}`;
  setKpiNumber("net", prev?.net, a.net, money);
  setKpiMeta("net", a.net < 0 ? "spending exceeds income" : "");

  if (a.income > 0 && prev?.income > 0) {
    setKpiNumber("savings", prev.savingsRate, a.savingsRate, pct);
  } else {
    setKpiText("savings", a.income > 0 ? pct(a.savingsRate) : "—");
  }
  setKpiMeta("savings", a.income > 0 ? "" : "needs income data");

  const budEl = $("#kpi-budgetused");
  if (budEl) budEl.className = `kpi card-hoverable ${a.budgetUsed > 1 ? "neg" : ""}`;
  if (a.expenseBudget > 0 && prev?.expenseBudget > 0) {
    setKpiNumber("budgetused", prev.budgetUsed, a.budgetUsed, pct);
  } else {
    setKpiText("budgetused", a.expenseBudget > 0 ? pct(a.budgetUsed) : "—");
  }
  setKpiMeta(
    "budgetused",
    a.expenseBudget > 0
      ? state.person
        ? `of ${money(a.expenseBudget)} household`
        : `of ${money(a.expenseBudget)}`
      : "no budget set",
  );

  setKpiNumber("avgday", prev?.avgDaily, a.avgDaily, money);
  setKpiMeta(
    "avgday",
    state.month === 0
      ? `over ${state.year % 4 === 0 && (state.year % 100 !== 0 || state.year % 400 === 0) ? 366 : 365} days`
      : `over ${new Date(state.year, state.month, 0).getDate()} days`,
  );

  state._dashLastAgg = a;
```

Leave the rest of `updateDashboardValues` (whatever follows the KPI-setting block — chart/person-comparison wiring, if any, stays as it already is) unchanged; only the KPI-setting portion shown above is replaced.

- [ ] **Step 4: Verify syntax**

Run: `node --check Expense_tracker_New/frontend/assets/app.js`
Expected: exits 0, no output.

- [ ] **Step 5: Verify in browser**

Serve and bypass the gate, land on Dashboard:
- On first load, KPI numbers show their real values immediately, with no animation — `buildDashboardShell` (the first-render path) only stores `state._dashLastAgg`, it never calls `countUp`. **Correction from an earlier draft of this step:** count-up is intentionally scoped to the patch path only (below), not first paint — animating away from $0.00 on a page's very first render would make it look emptier for longer, which is the wrong tradeoff for a finance dashboard's perceived load time.
- Change the month or year selector: KPI numbers visibly count up from their *previous* displayed value to the new one (not an instant swap, and not re-counting from zero).
- A metric that's a placeholder ("—", e.g. Savings rate with no income) sets instantly with no animation, and doesn't error when income later becomes positive (test by switching to a month/year with income if data permits, or just confirm no console error occurs).
- No console errors.

Stop the server when done.

- [ ] **Step 6: Commit**

```bash
git add Expense_tracker_New/frontend/assets/app.js
git commit -m "feat(frontend): animate Dashboard KPI values with count-up on load and month/year switch"
```

---

### Task 5: Global — animated tab switch

**Files:**
- Modify: `Expense_tracker_New/frontend/assets/app.js` (`go`)

**Interfaces:**
- Consumes: `viewTransition` from `assets/motion.js` (Task 1).
- Produces: nothing new consumed by later tasks.

- [ ] **Step 1: Import `viewTransition`**

Change the import from Task 4 Step 1 to also include `viewTransition`:

```js
import { cardHoverable, revealStagger, countUp, viewTransition } from "./motion.js";
```

- [ ] **Step 2: Wrap the render call in `go(tab)`**

Replace the current `go` function:

```js
function go(tab) {
  state.tab = tab;
  charts.destroyAll();
  delete view.dataset.shell;
  document
    .querySelectorAll("#tabs button")
    .forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
  location.hash = tab;
  (VIEWS[tab] || renderDashboard)();
  window.scrollTo(0, 0);
}
```

with:

```js
function go(tab) {
  state.tab = tab;
  charts.destroyAll();
  delete view.dataset.shell;
  document
    .querySelectorAll("#tabs button")
    .forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
  location.hash = tab;
  viewTransition(() => {
    (VIEWS[tab] || renderDashboard)();
    window.scrollTo(0, 0);
  });
}
```

(`window.scrollTo(0, 0)` moves inside the callback so the scroll happens exactly when the new content renders, not while the old content is still fading out.)

- [ ] **Step 3: Verify syntax**

Run: `node --check Expense_tracker_New/frontend/assets/app.js`
Expected: exits 0, no output.

- [ ] **Step 4: Verify in browser**

Serve and bypass the gate. Click between tabs (Dashboard → Transactions → Budget → Dashboard): each switch should show a brief fade+slide transition rather than an instant content swap. Confirm the correct tab's content renders after the transition each time (no stale content, no double-render), and that Dashboard's own month/year selectors — which call `renderDashboard()`/`updateDashboardValues` directly, bypassing `go()` — still update instantly without the fade (only tab *switches* get the transition). No console errors.

Stop the server when done.

- [ ] **Step 5: Commit**

```bash
git add Expense_tracker_New/frontend/assets/app.js
git commit -m "feat(frontend): animate tab switches with a fade+slide transition"
```

---

### Task 6: Transactions — category color chips, row hover shadow, elevated group container

**Files:**
- Modify: `Expense_tracker_New/frontend/assets/store.js` (`categoryColorIndex`)
- Modify: `Expense_tracker_New/frontend/assets/app.js` (`categoryColorClass`, `txRow`)
- Modify: `Expense_tracker_New/frontend/assets/styles.css` (`.category-chip`, `.tx-row:hover`, `.tx-group`)

**Interfaces:**
- Produces: `CATEGORY_PALETTE_SIZE` (const, value `8`) and `categoryColorIndex(name)` exported from `assets/store.js`, mirroring the existing `PERSON_PALETTE_SIZE`/`personColorIndex`. `categoryColorClass(cat)` in `assets/app.js`, mirroring `personColorClass`. Not consumed elsewhere in this plan, but this is the pattern any future tab can reuse for category coloring.

- [ ] **Step 1: Add `categoryColorIndex` to `assets/store.js`**

Immediately after the existing block:

```js
export const PERSON_PALETTE_SIZE = 5;
export function personColorIndex(name) {
  const s = String(name || "");
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % PERSON_PALETTE_SIZE;
}
```

add:

```js

export const CATEGORY_PALETTE_SIZE = 8;
export function categoryColorIndex(name) {
  const s = String(name || "");
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % CATEGORY_PALETTE_SIZE;
}
```

- [ ] **Step 2: Add `categoryColorClass` to `assets/app.js` and use it in `txRow`**

In `assets/app.js`, find the existing import from `./store.js` (the block that includes `personColorIndex`) and add `categoryColorIndex` to it.

Immediately after the existing `personColorClass` definition:

```js
const personColorClass = (p) =>
  p && p !== UNASSIGNED
    ? `person-color-${personColorIndex(p)}`
    : "person-color-none";
```

add:

```js

/** Colour class for a category chip, derived the same way as
    personColorClass — a stable hash of the category name, not a lookup
    table, so a new category just works without a matching edit here. */
const categoryColorClass = (cat) =>
  `category-color-${categoryColorIndex(cat)}`;
```

In `txRow()`'s template, replace:

```js
          <span class="tx-cat">${esc(r.category)}${r.subcategory ? " · " + esc(r.subcategory) : ""}</span>
```

with:

```js
          <span class="tx-cat"><span class="category-chip ${categoryColorClass(r.category)}">${esc(r.category)}</span>${r.subcategory ? " · " + esc(r.subcategory) : ""}</span>
```

- [ ] **Step 3: Add `.category-chip` CSS**

In `assets/styles.css`, immediately after the existing `.person-chip.person-color-4 { ... }` block, add:

```css

/* category chip on transaction rows */
.category-chip {
  font-size: 10px;
  letter-spacing: 0.03em;
  padding: 1px 6px;
  border-radius: var(--radius-sm);
  margin-right: 4px;
  white-space: nowrap;
  color: #fff;
}
.category-chip.category-color-0 { background: var(--cat-color-0); }
.category-chip.category-color-1 { background: var(--cat-color-1); }
.category-chip.category-color-2 { background: var(--cat-color-2); }
.category-chip.category-color-3 { background: var(--cat-color-3); }
.category-chip.category-color-4 { background: var(--cat-color-4); }
.category-chip.category-color-5 { background: var(--cat-color-5); }
.category-chip.category-color-6 { background: var(--cat-color-6); }
.category-chip.category-color-7 { background: var(--cat-color-7); }
```

- [ ] **Step 4: Add hover shadow to `.tx-row` (keep existing background-tint hover)**

In `assets/styles.css`, the existing `.tx-row` block already has `transition: background 0.1s;` and separate hover rules for the default and income cases. Change:

```css
.tx-row {
  display: grid;
  grid-template-columns: 28px 22px 1fr auto auto;
  gap: 0 10px;
  align-items: center;
  padding: 9px 12px;
  border-bottom: 1px solid var(--rule);
  transition: background 0.1s;
}
```

to:

```css
.tx-row {
  display: grid;
  grid-template-columns: 28px 22px 1fr auto auto;
  gap: 0 10px;
  align-items: center;
  padding: 9px 12px;
  border-bottom: 1px solid var(--rule);
  transition: background var(--motion-fast), box-shadow var(--motion-fast);
}
```

and add a `box-shadow` to the existing hover rules (leave their `background` values untouched):

```css
.tx-row:hover {
  background: #fffdf5;
  box-shadow: var(--shadow-card);
}
```

```css
.tx-row.tx-income:hover {
  background: #edfbf3;
  box-shadow: var(--shadow-card);
}
```

(Find each existing rule by its current `background`-only declaration and add the `box-shadow` line inside it — do not duplicate the rule.)

- [ ] **Step 5: Elevate `.tx-group`, preserving the sticky group header**

`.tx-group-header` is `position: sticky` — adding `overflow: hidden` to its ancestor `.tx-group` would change its sticky scroll behavior, so radius is applied to the header and the last row independently instead of clipping the whole container. Replace:

```css
.tx-group {
  border: 1px solid var(--rule-2);
  background: #fff;
  margin-bottom: 10px;
}
```

with:

```css
.tx-group {
  background: var(--card-bg);
  box-shadow: var(--shadow-card);
  border-radius: var(--radius-md);
  margin-bottom: 10px;
}
```

Add top corner radius to the header (it sits flush at the top of `.tx-group`) and reuse the existing `.tx-group.closed .tx-group-header` rule to give it full corner radius when there's no body showing below it. Change:

```css
.tx-group-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  width: 100%;
  padding: 7px 12px;
  background: var(--paper-2);
  border-bottom: 1px solid var(--rule);
  position: sticky;
  top: 52px;
  z-index: 3;
  border-left: 0;
  border-right: 0;
  border-top: 0;
  cursor: pointer;
  font-family: var(--disp);
  text-align: left;
}
```

to:

```css
.tx-group-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  width: 100%;
  padding: 7px 12px;
  background: var(--paper-2);
  border-bottom: 1px solid var(--rule);
  border-radius: var(--radius-md) var(--radius-md) 0 0;
  position: sticky;
  top: 52px;
  z-index: 3;
  cursor: pointer;
  font-family: var(--disp);
  text-align: left;
}
```

(`border-left: 0; border-right: 0; border-top: 0;` are removed — they were overriding a `border` shorthand that no longer exists on this element, so they're dead weight now.)

And change:

```css
.tx-group.closed .tx-group-header {
  border-bottom: 0;
}
```

to:

```css
.tx-group.closed .tx-group-header {
  border-bottom: 0;
  border-radius: var(--radius-md);
}
```

Finally, give the last row in an open group's body bottom corner radius, so the container's bottom edge looks rounded when expanded. Add, after the existing `.tx-row:last-child { border-bottom: 0; }` rule:

```css
.tx-group-body .tx-row:last-child {
  border-bottom-left-radius: var(--radius-md);
  border-bottom-right-radius: var(--radius-md);
}
```

Also update the chevron's hardcoded transition duration to use the new token, for consistency (this is the only line in this rule that changes):

```css
.tx-group-chevron {
  font-size: 10px;
  color: var(--ink-3);
  margin-right: 8px;
  flex-shrink: 0;
  transition: transform var(--motion-fast);
  display: inline-block;
}
```

(The chevron's rotate-on-collapse behavior — `.tx-group.closed .tx-group-chevron { transform: rotate(-90deg); }` — already exists and needs no change.)

- [ ] **Step 6: Verify syntax**

Run: `node --check Expense_tracker_New/frontend/assets/store.js && node --check Expense_tracker_New/frontend/assets/app.js`
Expected: both exit 0, no output.

- [ ] **Step 7: Verify in browser**

Serve and bypass the gate, land on Transactions (add a couple of transactions first via the Add tab if none exist, using at least two different categories):
- Each row shows a colored category chip before the category name.
- The same category always gets the same chip color across different rows.
- Hovering a row shows both the existing background tint and a soft shadow.
- Each month group renders as a single shadowed, rounded card; collapsing a group still shows its chevron rotate and its bottom/full radius adjusts correctly (no square corners poking out).
- Scroll past a group with several rows: its sticky header still sticks to the top of the viewport while scrolling through that group's rows (confirms `overflow: hidden` was correctly avoided).
- No console errors.

Stop the server when done.

- [ ] **Step 8: Commit**

```bash
git add Expense_tracker_New/frontend/assets/store.js Expense_tracker_New/frontend/assets/app.js Expense_tracker_New/frontend/assets/styles.css
git commit -m "feat(frontend): add category color chips and elevate Transactions rows/groups"
```

---

### Task 7: Transactions — row/group entrance stagger and group subtotal count-up

**Files:**
- Modify: `Expense_tracker_New/frontend/assets/app.js` (`renderTransactions`)

**Interfaces:**
- Consumes: `revealStagger`, `countUp` from `assets/motion.js` (Task 1/4's import).
- Produces: module-level `const txRevealed = new Set()` (mirrors the existing `txCollapsed`) — not consumed by any later task in this plan, but any future work touching this render function should know it exists.

- [ ] **Step 1: Add the `txRevealed` tracking set**

In `assets/app.js`, immediately after the existing:

```js
const txCollapsed = new Set();
```

add:

```js
/* Tracks which month groups have already played their entrance
   animation (row stagger + header subtotal count-up), by group key.
   renderTransactions() fully replaces view.innerHTML on every call (no
   patch path here, unlike Dashboard's canPatch), so DOM node identity
   can't tell "already animated" from "newly revealed" — this Set is the
   substitute. Same lifetime as txCollapsed: never explicitly cleared,
   lives for as long as the page does. */
const txRevealed = new Set();
```

- [ ] **Step 2: Give each group's rows a stable, queryable wrapper and header subtotal a stable id**

In the groups-rendering template inside `renderTransactions` (the `groups.map((g) => { ... })` block), the current markup is:

```js
              return `
          <div class="tx-group${closed ? " closed" : ""}" data-month="${g.key}">
            <button class="tx-group-header" data-toggle="${g.key}" aria-expanded="${!closed}">
              <span class="tx-group-chevron">▾</span>
              <span class="tx-group-label">${esc(g.label)}</span>
              <span class="tx-group-count muted">${g.rows.length}</span>
              <span class="tx-group-stats num">
                ${g.income > 0 ? `<span class="tx-income">+${money(g.income)}</span>` : ""}
                ${g.income > 0 && g.expense > 0 ? '<span class="tx-sep">·</span>' : ""}
                ${g.expense > 0 ? `<span>${money(g.expense)}</span>` : ""}
              </span>
            </button>
            <div class="tx-group-body">${g.rows.map(txRow).join("")}</div>
          </div>`;
```

Add stable ids on the two subtotal `<span>`s (needed for `countUp` to target them) by replacing the `tx-group-stats` line with:

```js
              <span class="tx-group-stats num">
                ${g.income > 0 ? `<span class="tx-income" id="tx-g-inc-${g.key}">+${money(g.income)}</span>` : ""}
                ${g.income > 0 && g.expense > 0 ? '<span class="tx-sep">·</span>' : ""}
                ${g.expense > 0 ? `<span id="tx-g-exp-${g.key}">${money(g.expense)}</span>` : ""}
              </span>
```

(`g.key` is a `YYYY-MM` string, safe to use directly in an `id` attribute.)

- [ ] **Step 3: Stagger rows and count up subtotals for newly-revealed groups**

After `view.innerHTML = ...` finishes (find the point in `renderTransactions` right after the template literal is assigned, before the existing `// — month group collapse/expand` wiring block), add:

```js
  groups.forEach((g) => {
    if (txRevealed.has(g.key)) return;
    txRevealed.add(g.key);

    if (g.income > 0) {
      const el = document.getElementById(`tx-g-inc-${g.key}`);
      if (el) countUp(el, 0, g.income, (v) => `+${money(v)}`);
    }
    if (g.expense > 0) {
      const el = document.getElementById(`tx-g-exp-${g.key}`);
      if (el) countUp(el, 0, g.expense, money);
    }

    if (!txCollapsed.has(g.key)) {
      const groupEl = view.querySelector(`.tx-group[data-month="${g.key}"]`);
      if (groupEl) revealStagger(groupEl.querySelectorAll(".tx-row"));
    }
  });
```

- [ ] **Step 4: Verify syntax**

Run: `node --check Expense_tracker_New/frontend/assets/app.js`
Expected: exits 0, no output.

- [ ] **Step 5: Verify in browser**

Serve and bypass the gate, land on Transactions with data spanning at least two months:
- On first load, the newest (expanded) group's rows fade/rise in, and its header subtotal counts up from 0.
- A collapsed group's header subtotal also counts up on first load (it's visible even though its rows aren't), but its rows do not stagger (they're hidden).
- Expand a previously-collapsed group: rows appear without re-playing the header's count-up (it already ran once) — this is expected per the spec's correction; only rows become visible, no numbers re-animate.
- Type in the search box: previously-revealed groups' rows don't re-stagger on every keystroke's debounced re-render (only genuinely new group keys — e.g. a month that only appears once a filter is cleared — would stagger and count up, and only the first time).
- No console errors.

Stop the server when done.

- [ ] **Step 6: Commit**

```bash
git add Expense_tracker_New/frontend/assets/app.js
git commit -m "feat(frontend): stagger Transactions rows and count up group subtotals on first reveal"
```

---

### Task 8: Transactions — filter pill animations and row delete exit animation

**Files:**
- Modify: `Expense_tracker_New/frontend/assets/app.js` (`renderTransactions`'s filter-pill rendering/wiring and delete handler)
- Modify: `Expense_tracker_New/frontend/assets/styles.css` (`.fpill` transition)

**Interfaces:**
- Consumes: `revealStagger`, `exitCollapse` from `assets/motion.js`.
- Produces: nothing new consumed elsewhere.

- [ ] **Step 1: Track the previous filter snapshot**

Immediately after the `txRevealed` declaration added in Task 7 Step 1, add:

```js
/* Snapshot of the filter state as of the last renderTransactions() call,
   used to tell "a filter pill that's newly active" (animate in) from "a
   pill that was already showing" (leave alone) across a full-rebuild
   re-render triggered by typing in the search box. */
let txPrevFilter = { q: "", cat: "", type: "", month: "" };
```

- [ ] **Step 2: Animate newly-added pills in, and animate a cleared pill out before removing its filter**

In `renderTransactions`, find where `f` is read at the top (`const f = state.filter;`) and, immediately after it, capture the previous snapshot before it's overwritten:

```js
  const f = state.filter;
  const prevFilter = txPrevFilter;
  txPrevFilter = { q: f.q, cat: f.cat, type: f.type, month: f.month };
```

After the existing `view.innerHTML = ...` block finishes and after Task 7 Step 3's group-reveal code, add:

```js
  ["q", "cat", "type", "month"].forEach((k) => {
    if (!prevFilter[k] && f[k]) {
      const el = view.querySelector(`.fpill[data-clear="${k}"]`);
      if (el) revealStagger([el], { stagger: 0 });
    }
  });
```

Find the existing filter-pill click wiring:

```js
  // — active filter pills
  view.querySelectorAll("[data-clear]").forEach(
    (el) =>
      (el.onclick = () => {
        state.filter[el.dataset.clear] = "";
        refilter();
      }),
  );
```

and replace it with a version that animates the pill out first:

```js
  // — active filter pills
  view.querySelectorAll("[data-clear]").forEach(
    (el) =>
      (el.onclick = async () => {
        await exitCollapse(el);
        state.filter[el.dataset.clear] = "";
        refilter();
      }),
  );
```

- [ ] **Step 3: Give `.fpill` a transition base for the collapse animation**

In `assets/styles.css`, the existing `.fpill` rule has no `transition`. `exitCollapse` animates inline styles via GSAP directly (it doesn't rely on CSS transitions), so no CSS change is strictly required for the exit to work — but add one for consistency with the rest of the hoverable/animatable elements in this revamp, and so a reduced-motion user still gets a clean (instant, GSAP-bypassed) removal with no lingering half-collapsed state:

```css
.fpill {
  font-size: 11.5px;
  padding: 3px 9px;
  background: var(--ink);
  color: var(--paper);
  cursor: pointer;
  letter-spacing: 0.03em;
  border: 1px solid var(--ink);
  overflow: hidden;
}
```

(Only the added `overflow: hidden;` line is new — it's required so the height-collapse in `exitCollapse` doesn't let the pill's text spill out while its box is shrinking. Everything else in the rule is unchanged.)

- [ ] **Step 4: Wire the delete-row exit animation**

Find the existing delete confirmation handler:

```js
        row.querySelector("#cd-yes").onclick = async () => {
          row.style.opacity = ".4";
          const done = await withBusy("Deleting", async () => {
            await state.store.remove(r.id);
            await refresh();
          });
          if (done) {
            renderTransactions();
            notice("Entry deleted.", "ok");
          } else row.style.opacity = "";
        };
```

Replace it with:

```js
        row.querySelector("#cd-yes").onclick = async () => {
          row.style.opacity = ".4";
          const done = await withBusy("Deleting", async () => {
            await state.store.remove(r.id);
            await refresh();
          });
          if (done) {
            row.style.opacity = "";
            await exitCollapse(row);
            renderTransactions();
            notice("Entry deleted.", "ok");
          } else row.style.opacity = "";
        };
```

(`row.style.opacity = ""` resets the in-flight dim back to full opacity immediately before `exitCollapse` animates it down to 0 — otherwise the fade would start from 0.4 instead of a clean full-opacity row.)

Ensure `exitCollapse` is imported — add it to the existing motion.js import line (from Task 1/2/4/5) so it now reads:

```js
import { cardHoverable, revealStagger, countUp, viewTransition, exitCollapse } from "./motion.js";
```

- [ ] **Step 5: Verify syntax**

Run: `node --check Expense_tracker_New/frontend/assets/app.js`
Expected: exits 0, no output.

- [ ] **Step 6: Verify in browser**

Serve and bypass the gate, land on Transactions:
- Type a search term that matches a category: the resulting filter pill fades/rises in.
- Click a filter pill's ✕: the pill visibly shrinks/fades out before the list re-filters (not an instant disappearance).
- Delete a transaction (via the row's ✕ button, then confirm): the row visibly fades and collapses in height before it's gone, rather than the whole list just re-rendering under it instantly.
- No console errors, and no leftover empty gap where a deleted row was (the collapse should close the space cleanly).

Stop the server when done.

- [ ] **Step 7: Commit**

```bash
git add Expense_tracker_New/frontend/assets/app.js Expense_tracker_New/frontend/assets/styles.css
git commit -m "feat(frontend): animate filter pill add/remove and row delete on Transactions"
```

---

## Final Verification (after all tasks)

- [ ] Serve `Expense_tracker_New/frontend` and bypass the gate as above. Click through all 8 tabs (Dashboard, Add, Transactions, Budget, Net worth, Data, Billing, Profile) — confirm every tab still renders correctly, `.kpi`/`.panel` elements elsewhere (Net Worth's KPI row and panels, Data/Household/Billing panels) show the new elevation with no layout breakage, and no tab throws a console error.
- [ ] In Chrome DevTools, enable "Emulate CSS media feature prefers-reduced-motion: reduce", reload, and repeat the Dashboard and Transactions checks above: all stagger/slide/lift/count-up motion should be instant (final state immediately, no animation), with no console errors.
- [ ] Confirm `txCollapsed`'s existing collapse/expand persistence behavior (session-lifetime, not saved anywhere) is unchanged, and that switching Dashboard's year/month selector still correctly triggers `updateDashboardValues`'s fast patch path (no full-shell rebuild) by checking `view.dataset.shell === "dashboard"` stays set to `"dashboard"` across a month switch (inspect via DevTools or a console log).
