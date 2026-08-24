# UI Elevation & Motion Revamp — Pilot (Dashboard + Transactions)

## Context

The current frontend (`Expense_tracker_New/frontend`) uses a deliberate flat
"paper ledger" aesthetic — hairline rules, zero border-radius, tabular mono
numerals, instant state changes, no JS animation dependency. The user asked
for a UI/animation revamp inspired by Pocketsmith, Sure, and Monarch — all
card-based, soft-shadowed, animated personal-finance dashboards.

Decided in brainstorming (see chat log, 2026-08-24):

- **Direction:** modernize, don't replace — keep the amber/teal/paper/mono
  identity, add elevation and motion on top of it (not a full repaint).
- **Scope:** pilot on two tabs first — **Dashboard** and **Transactions** —
  the two most-visited, most chart/data-dense tabs. The remaining six tabs
  (Add, Budget, Net worth, Data, Billing, Profile) are explicitly out of
  scope for this spec; see "Future work" below.
- **Elevation level:** "Ledger, Elevated" — cards with soft shadows and
  rounded corners sit on the existing paper canvas; the canvas itself
  (header rail, hairline dividers, footer) stays flat.
- **Animation approach:** add GSAP (~70KB, from `cdn.jsdelivr.net`, which
  `index.html`'s CSP `script-src` already allows for Chart.js) rather than
  hand-rolling every timing/easing case in vanilla JS.

There is no build step, no bundler, no package.json, and no frontend test
suite for this app (confirmed by inspection) — `index.html` loads
`assets/app.js` directly as an ES module, and CSS is one file,
`assets/styles.css`. This spec assumes that continues to be true: no new
tooling, no new script tags beyond the one GSAP `<script defer>`.

## Goals

1. Dashboard and Transactions read as "elevated" — cards with real shadow
   and rounded corners, not flat hairline-bordered blocks — while every
   other tab (which shares `.kpi`/`.panel` CSS classes with Dashboard)
   picks up the same visual treatment for free, even without new motion.
2. Real, purposeful motion: count-up numbers, staggered entrance, chart
   draw-in, hover-lift, animated tab transitions — scoped to Dashboard and
   Transactions' own render/patch functions. (Skeleton loading was
   considered and dropped — see the note under "Motion System" below.)
3. `prefers-reduced-motion: reduce` disables all non-essential motion
   (stagger, slide, lift) in one place, not per call site.
4. No regression to the existing fast-path DOM-patching behavior
   (`buildDashboardShell` vs `updateDashboardValues`, `txCollapsed` state,
   filter/search reactivity) — motion wraps existing render logic, it does
   not replace it.

## Non-Goals

- The other six tabs are not touched beyond whatever they inherit for
  free via shared `.kpi`/`.panel` CSS classes. No JS/motion changes to
  Add, Budget, Net worth, Data, Billing, or Profile in this pass.
- No new build tooling (bundler, npm scripts, CSS preprocessor). Plain
  CSS custom properties and one new vanilla ES module (`assets/motion.js`).
- No backend/API changes. This is presentation-layer only.
- No changes to `styles.css`'s existing color tokens (`--ink`, `--paper`,
  `--amber`, `--teal`, `--red`, `--blue`, `--mono`, `--disp`) — only
  additive tokens (below).

## Design Tokens

Added to `:root` in `assets/styles.css`, alongside the existing tokens
(nothing existing is removed or renamed):

```css
--radius-sm: 8px;   /* inputs, chips, buttons */
--radius-md: 12px;  /* cards, panels, modals */
--card-bg: #ffffff; /* one shade lighter than --paper-2, so cards visibly
                        sit ON the paper rather than blending into it */
--shadow-card: 0 1px 2px rgba(18,22,28,.04), 0 8px 24px -8px rgba(18,22,28,.10);
--shadow-card-hover: 0 2px 4px rgba(18,22,28,.06), 0 16px 32px -12px rgba(18,22,28,.16);
--shadow-focus: 0 0 0 3px rgba(180,83,9,.25); /* amber ring, keyboard focus */
--motion-fast: 150ms;
--motion-base: 250ms;
--motion-slow: 600ms;
--motion-ease: cubic-bezier(0.22, 1, 0.36, 1); /* power2.out-equivalent, used in CSS transitions */
```

**Category color palette** — 8 desaturated hues, compatible with the
paper/amber base, used only for category chips (Transactions, and
anywhere else `.category-chip` is used later):

```css
--cat-color-0: #7c9885; /* sage */
--cat-color-1: #7a92a8; /* dusty blue */
--cat-color-2: #b98a6b; /* clay */
--cat-color-3: #9b7ba8; /* plum */
--cat-color-4: #c2a04a; /* ochre */
--cat-color-5: #6b7684; /* slate (reuses --ink-3's hue family) */
--cat-color-6: #7f9270; /* moss */
--cat-color-7: #ab6f5c; /* rust */
```

**Where elevation applies:** `.kpi` tiles, `.panel` chart containers, the
Transactions row-group container, modals/drawers. **Where it does not
apply:** `.rail` (header), hairline `<hr>`/border-bottom dividers between
sections, `.foot` (footer) — these stay flat, preserving the ledger canvas
underneath the new elevation.

## Motion System

### Loading

`index.html` gets one new line, alongside the existing Chart.js tag:

```html
<script src="https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/gsap.min.js" defer></script>
```

No CSP change needed — `script-src` already includes `https://cdn.jsdelivr.net`.

### `assets/motion.js` (new file)

A small wrapper module so `app.js` and `charts.js` call named intent
functions, not raw GSAP — keeps render functions readable, and makes
reduced-motion a single guard rather than a check scattered across every
call site.

```js
// assets/motion.js
const reduced = () =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Animates a number from `from` to `to` over the element's text content,
    formatting each tick through `fmt` (money()/pct()/etc.) so the display
    never shows an unformatted raw number mid-count. */
export function countUp(el, from, to, fmt, duration = 0.6) {
  if (reduced() || !window.gsap || from === to) {
    el.textContent = fmt(to);
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

/** Staggers a NodeList/array of elements in with an 8px rise + fade. */
export function revealStagger(els, { stagger = 0.04, duration = 0.35 } = {}) {
  if (!els.length) return;
  if (reduced() || !window.gsap) {
    els.forEach((el) => (el.style.opacity = 1));
    return;
  }
  gsap.fromTo(
    els,
    { opacity: 0, y: 8 },
    { opacity: 1, y: 0, duration, stagger, ease: "power2.out" },
  );
}

/** Wires hover-lift on an element via the CSS shadow token swap — this is
    a CSS transition (see .card-hoverable in styles.css), not GSAP; this
    helper only exists so call sites don't need to know that detail. */
export function cardHoverable(el) {
  el.classList.add("card-hoverable");
}

/** Fade+collapse an element's height before removing it from the DOM.
    Resolves once the animation completes (or immediately, if reduced). */
export function exitCollapse(el, duration = 0.25) {
  if (reduced() || !window.gsap) return Promise.resolve();
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

/** 180ms fade+slide swap of #view's content — called by go()/tab switch. */
export function viewTransition(renderFn) {
  const view = document.getElementById("view");
  if (reduced() || !window.gsap) {
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

### Catalog (durations final, tuned against the reference apps)

| Element | Motion | Duration | Notes |
|---|---|---|---|
| KPI tile value | count-up | 500–700ms, `power2.out` | Fires on `buildDashboardShell` AND `updateDashboardValues` (the month/year patch path) — both, or switching months only animates once per session. |
| KPI tiles entrance | stagger fade+rise | 350ms, 40ms stagger | Grid order (left-to-right, top-to-bottom). |
| Chart panels entrance | stagger fade+rise | 350ms, 40ms stagger | Starts after KPI stagger completes, not simultaneously. |
| Chart draw-in | Chart.js `animation.duration` | 600ms, `easeOutQuart` | Per-chart, via existing `charts.js` functions — a filter-triggered re-render of one chart must not replay its panel's entrance stagger. |
| Card/row hover-lift | shadow token swap + translate-y (cards only) | 150ms | Transactions rows use background-tint + shadow only, no translate-y (dense list, individual lift reads as noisy). |
| Tab switch | fade+slide on `#view` | 180ms | Via `viewTransition()`. |
| ~~Skeleton loading~~ | — | — | **Dropped, see note below.** |
| Transactions group expand | chevron rotate | 150ms | Purely visual toggle, independent of the subtotal count-up below. |
| Transactions group header subtotal | count-up | 500–700ms | Once per group key (via `txRevealed`, same gate as row entrance) — fires when the group is first rendered, not on expand/collapse, since the header is visible in both states. |
| Transactions row entrance | stagger fade+rise | 350ms, 40ms stagger | Only for rows newly revealed (group expand, or initial newest-group load) — not replayed on unrelated re-renders (e.g. typing in the search filter). |
| Filter pill (`.fpill`) add/remove | scale+fade | 150ms | |
| Transactions row delete | fade + height-collapse | 250ms | Via `exitCollapse()`, awaited before the row leaves the DOM/state. |
| Per-row transaction amounts | **none** | — | Explicitly no count-up — animating 20+ individual values at once is the "wall of motion" this spec avoids. Only aggregate totals (page header, group subtotals) count up. |

**Why skeleton loading was dropped:** the original assumption — that Dashboard/Transactions can render with `state.rows` still unresolved, producing a blank/zero flash — doesn't hold once `boot()` (in `assets/app.js`) is actually read. `state.rows` is fetched and awaited *before* the first `go(startTab)` call that produces the first Dashboard/Transactions render; the actual network wait is already covered by the pre-existing full-screen `#boot-loading` overlay shown by inline HTML before `app.js` even starts running. The only later data refetch (Dashboard's month/year selectors, and the background `ensureAllYearsLoaded()` call) replaces already-rendered real numbers with newer real numbers — never a blank state — so there is no blank/zero flash for this pilot's two tabs to replace. A skeleton system remains a reasonable future addition for Billing's genuine "Loading plans…" text state, but that tab is out of scope here (see Non-Goals).

### Reduced motion

`prefers-reduced-motion: reduce` is checked once, inside `motion.js`'s
`reduced()` helper. When true: `countUp`/`revealStagger`/`exitCollapse`
all resolve instantly to their end state (final formatted value, opacity
1, removed from DOM) with no animation. `cardHoverable`'s CSS transition
respects the same media query directly in `styles.css`:

```css
@media (prefers-reduced-motion: reduce) {
  .card-hoverable { transition: none; }
}
```

## Dashboard Tab Changes (`assets/app.js`)

- `.kpi` tiles (in `.kpis`, built by the `kpi()` helper at ~line 1175) and
  `.panel` chart containers (built inline in `buildDashboardShell`, ~line
  966 onward) get `--radius-md` + `--shadow-card` in `styles.css`, and
  `cardHoverable()` wired onto each after render.
- `buildDashboardShell`: after `view.innerHTML` is set, call
  `revealStagger()` on `.kpi` elements, then on `.panel` elements (chained
  after the KPI stagger's `onComplete`, per the catalog above).
- `updateDashboardValues(a, label, people, pSeries, showCompare)` currently
  calls a local `setKpi(key, v, m)` helper with `v` already formatted
  (`money(a.income)`, `pct(a.savingsRate)`, or the literal `"—"` when the
  underlying metric has no meaningful value yet). `countUp()` needs a raw
  number and a formatter, not a pre-formatted string, and there is
  currently nowhere the *previous* aggregate is kept — `state._dashShape`
  stores only the KPI grid's shape (for the `canPatch` comparison), not
  its values. Concretely:
  - Add `state._dashLastAgg = a;` at the end of both
    `buildDashboardShell` and `updateDashboardValues`, so the next patch
    has a `from` value to animate away from.
  - Change `setKpi` to take a raw number/formatter pair instead of a
    pre-formatted string: `setKpi(key, mEl_text, { from, to, fmt })`. When
    `state._dashLastAgg` is `undefined` (first render) or the metric is a
    placeholder state (e.g. `a.income > 0` was false and is still false,
    so the display value is `"—"` on both sides), skip `countUp()` and set
    `textContent` directly — animating into/out of `"—"` has no sensible
    numeric path.
  - Each of the six `setKpi` call sites in `updateDashboardValues` passes
    its own `from`/`to`/`fmt`, e.g. for income:
    `setKpi("income", { from: state._dashLastAgg?.income, to: a.income, fmt: money }, a.income === 0 ? "no income recorded" : "")`.
- Chart draw-in: each `charts.js` chart-builder function (`incomeVsExpense`,
  `netByMonth`, `trend`, `paymentSplit`, `actualVsBudget`, `topFive`,
  `personSplit`, `personByMonth`, `dividendsTrend`) gets
  `animation: { duration: 600, easing: "easeOutQuart" }` added to its
  Chart.js config (currently unset, i.e. instant).
- Dividends panel (conditional, `a.dividends > 0`) and person-compare
  panels (conditional, `showCompare`) need no special-case — they use the
  same `.panel` markup and are included in the same `revealStagger()` call
  since they're already in the DOM by the time it runs.

## Transactions Tab Changes (`assets/app.js`)

- New `categoryColorClass(category)` function, mirroring the existing
  `personColorClass(person)` (hash category string mod 8, return
  `category-color-{n}`). New `.category-chip` element added next to
  `.tx-cat` in the `txRow()` template, styled via the 8 `--cat-color-*`
  tokens (mirroring `.person-chip.person-color-{n}` in `styles.css`).
- Row entrance: `revealStagger()` on the rows of a month group when it's
  first rendered expanded — either the newest group on initial load, or
  any group the user clicks open. `renderTransactions()` fully replaces
  `view.innerHTML` on every call (confirmed — there is no patch path here
  the way Dashboard has `canPatch`), so DOM node identity can't be used to
  tell "already animated" from "newly revealed". Instead, add a new
  module-level `const txRevealed = new Set()` next to the existing
  `txCollapsed` Set: after staggering a group's rows in, add that group's
  key to `txRevealed`; on every render, only call `revealStagger()` for an
  expanded group whose key is not yet in `txRevealed`. A re-render
  triggered by typing in the search box re-creates the DOM but skips the
  stagger for any group already in `txRevealed`, so rows just appear
  (opacity 1, no animation) instead of re-playing entrance every keystroke.
  `txRevealed` is never explicitly cleared — same lifetime as `txCollapsed`
  (which also has no explicit reset point in the current code): both live
  for as long as the page does, and a full reload naturally clears them.
- Row hover: `.tx-row` gets `--shadow-card` + background-tint on hover,
  no translate-y (see catalog).
- Month group header: chevron icon rotates 90° over 150ms on
  expand/collapse (CSS transition on a `transform` class toggle). **Correction
  from an earlier draft of this spec:** the header's income/expense subtotal
  (`.tx-group-stats`) is markup-adjacent to the chevron and label, not inside
  `.tx-group-body` — it is already visible whether the group is expanded or
  collapsed (only the row list toggles). So its count-up cannot be gated on
  "expand"; instead it uses the same `txRevealed` gate as row entrance (see
  above): the first time a group is rendered with a key not yet in
  `txRevealed`, its header subtotal counts up. Whether the group also
  stagger-reveals rows at that moment depends on whether it starts expanded.
- Filter pills (`.fpill`): scale+fade in when added (a filter is set),
  scale+fade out before removal when cleared.
- Row delete (the `data-del` button handler): call `await
  exitCollapse(rowEl)` before removing the row from `state.rows`/DOM and
  re-rendering, so the row visibly collapses rather than vanishing
  instantly.
- Per-row amounts: no count-up (see catalog's explicit non-goal).

## File / Component Map

| File | Change |
|---|---|
| `Expense_tracker_New/frontend/index.html` | Add GSAP `<script defer>` tag next to the Chart.js tag. |
| `Expense_tracker_New/frontend/assets/motion.js` | New file — `countUp`, `revealStagger`, `cardHoverable`, `exitCollapse`, `viewTransition`, `reduced()`. |
| `Expense_tracker_New/frontend/assets/styles.css` | New tokens (radius/shadow/motion/category-color), `.card-hoverable`, `.category-chip`+`.category-color-{0..7}`, elevation applied to `.kpi`/`.panel`, reduced-motion media query. |
| `Expense_tracker_New/frontend/assets/app.js` | `buildDashboardShell`, `updateDashboardValues`, `wireDashboard`, `renderTransactions`, `txRow()`, new `categoryColorClass()`, tab-switch call site (`go()` or equivalent) wired through `viewTransition()`. |
| `Expense_tracker_New/frontend/assets/charts.js` | Add `animation` config to each chart-builder function used by Dashboard. |

## Testing & Verification

This app has no frontend test suite or build step (confirmed by
inspection — no `package.json`, no `*.test.js` files in
`Expense_tracker_New/frontend`). Verification is manual/visual, via a
locally-served static instance of the frontend (as already used earlier
this session for artifact screenshots — `python3 -m http.server` from the
`frontend` directory, with the Cognito gate bypassed via
`sessionStorage.setItem('ledger.cognitoIdToken', 'fake-preview-token')`
to reach the disconnected-but-real app shell) plus browser automation to:

1. Confirm Dashboard KPI tiles and chart panels render as elevated cards
   (radius + shadow visible), with hover-lift on mouse-over.
2. Confirm KPI values count up on first load AND on switching
   month/year (the patch path) — not just once per session.
3. Confirm chart panels stagger in after KPI tiles, not simultaneously.
4. Confirm Transactions rows carry category chips in the new palette,
   stagger in on group expand, and collapse-fade on delete.
5. Confirm `prefers-reduced-motion: reduce` (via Chrome DevTools
   emulation) disables stagger/slide/lift and shows final states
   immediately, with no console errors.
6. Confirm no regression to existing behavior: search/filter reactivity,
   month-group collapse/expand state persistence (`txCollapsed`), and the
   Dashboard fast-path (`canPatch`) still triggering correctly.
7. Confirm the other six tabs (Add, Budget, Net worth, Data, Billing,
   Profile) still render correctly with the new `.kpi`/`.panel` elevation
   tokens applied (expected and desired) but no motion regressions or
   layout breakage, since those classes are shared.

## Future Work (explicitly out of scope here)

- Extending the motion system (stagger, count-up, card elevation) to the
  remaining six tabs: Add, Budget, Net worth, Data, Billing, Profile.
- A skeleton-loading treatment for Billing's genuine "Loading plans…" wait
  (the only tab with a real blank-state window today).
- Re-evaluating whether `--card-bg`/shadow tokens need dark-mode
  equivalents (this app currently has no dark mode).
