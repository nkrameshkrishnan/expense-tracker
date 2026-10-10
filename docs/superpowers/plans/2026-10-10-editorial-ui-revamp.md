# Editorial UI Revamp Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every page of the root Ledger app a "calm editorial finance" look (warm paper, serif display numbers, hairline surfaces) with restrained, reduced-motion-safe motion.

**Architecture:** Visual identity is carried by the `:root` / `:root[data-theme="dark"]` tokens in `assets/styles.css`, so pages inherit it; per-page tasks then remove hard-coded values that bypass tokens. Motion lives in one new module, `assets/motion.js`, the only importer of a vendored `framer-motion/dom` ES bundle; pages call its helpers. Chart draw-in is Chart.js's own `animation` option (charts are Chart.js canvases, not DOM).

**Tech Stack:** Vanilla ES modules (no build), CSS custom properties, Chart.js (CDN), Framer Motion 14.1.0 DOM API (`animate`, `stagger`, `inView`) vendored.

**Spec:** `docs/superpowers/specs/2026-10-10-editorial-ui-revamp-design.md`

## Global Constraints

- Zero-build static app; no bundler in the app. Serve with `python3 -m http.server 8080` (ES modules need HTTP).
- Only new runtime dependency: Framer Motion DOM API, vendored as ONE ES module at `assets/vendor/framer-motion-dom.js`. No CDN, no CSP change, no React. `package.json` is NOT changed in this branch (the user's main checkout has an uncommitted `framer-motion` entry; do not copy it).
- Fonts: Fraunces (display/serif) added to the existing Google Fonts `<link>` in `index.html`; Inter stays; Sora removed. CSP already allows `fonts.googleapis.com` / `fonts.gstatic.com`.
- Palette: `--paper` ≈ `#f7f4ee`, teal stays the single accent; red/green semantic (loss/gain) only. Radius `--radius-md` 18px → 12px. Cards: hairline border, no stacked shadows.
- Light AND dark themes (`:root[data-theme="dark"]`) both updated; text contrast ≥ 4.5:1.
- Motion: 150–220ms, `--ease-out`; enter = opacity + 6px translateY; only `transform`/`opacity` animate; every animation honours `prefers-reduced-motion` (instant). Never animate table rows, filters, keyboard-initiated actions, or high-frequency interactions.
- No behaviour, data, storage-adapter, or Supabase schema changes. Visual + motion only. Do not touch `.github/workflows/`, `supabase/`, `migrate.mjs`.
- Money numbers use tabular numerals (`font-variant-numeric: tabular-nums`).
- Verification (no test runner exists): `node --check <file>` on every touched JS file; load the page in the browser (light and dark, and with reduced-motion emulation) and confirm no console errors.
- Commit messages end with: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`

## Review Focus

- Dark theme: a token or hard-coded colour that looks right in light but is unreadable/invisible in dark (check every page in both).
- `prefers-reduced-motion: reduce`: any motion path (count-up, stagger, inView reveal, Chart.js animation) that still moves.
- Empty/zero/negative values: count-up on `0`, on negative money, on `NaN`/missing text must not display wrong final text.
- Re-render safety: `renderDashboard()` patches in place (`view.dataset.shell`) and `go()` re-renders on every nav; motion helpers must be idempotent and must not leave elements stuck at `opacity: 0`.
- Font load failure / offline: serif falls back to `Georgia, serif` with no layout break; numbers stay aligned.
- Vendored module failure: if the dynamic import of the vendored bundle fails, the app must still render fully (motion helpers no-op).

---

### Task 1: Foundation — tokens, fonts, vendored Framer Motion, `motion.js`

**Files:**
- Modify: `assets/styles.css` (`:root` and `:root[data-theme="dark"]` blocks, lines ~9-105; `body`/`.num` rules; any `font-family: var(--disp)` users)
- Modify: `index.html:51-55` (Google Fonts link)
- Create: `assets/vendor/framer-motion-dom.js`, `assets/vendor/FRAMER-MOTION-LICENSE.md`
- Create: `assets/motion.js`
- Modify: `assets/router.js` (call `motion.revealPage()` after the page renders in `go()`)

**Interfaces:**
- Produces (`assets/motion.js`, all no-op when reduced-motion or when the vendored module failed to load, all safe to call repeatedly):
  - `reducedMotion(): boolean`
  - `countUp(el: HTMLElement, to: number, format: (n:number)=>string, opts?: {duration?: number}): void` — animates `el.textContent` from its previous numeric value (or 0) to `to`, always ends exactly on `format(to)`.
  - `revealStagger(els: Iterable<HTMLElement>|string, opts?: {delay?: number}): void` — opacity 0→1 + translateY 6px→0, ~40ms stagger.
  - `revealOnView(els: Iterable<HTMLElement>|string): void` — same enter animation triggered by `inView`.
  - `revealPage(root?: HTMLElement): void` — reveals the top-level cards/sections of `#view`.
  - `chartAnimation(): object` — Chart.js `animation` option: `{duration: 0}` when reduced-motion, else `{duration: 400, easing: "easeOutQuart"}`.
- CSS tokens produced: `--paper`, `--paper-2`, `--rule`, `--rule-2`, `--card-bg`, `--radius-md`, `--disp` (serif stack), `--mono`/UI font stack, unchanged names so other tasks inherit.

- [ ] **Step 1: Vendor Framer Motion DOM**

In a scratch dir (not the repo), build one ESM file from the already-installed package:

```bash
S=/private/tmp/claude-501/-Users-rameshkrishnannarashimankrishnamurthy-Downloads-expense-tracker/1a33384c-2c65-4c20-8757-45994014f20b/scratchpad/fm
mkdir -p "$S" && cd "$S" && npm init -y >/dev/null && npm i framer-motion@14.1.0 esbuild >/dev/null
echo 'export { animate, stagger, inView } from "framer-motion/dom";' > entry.js
npx esbuild entry.js --bundle --format=esm --minify --outfile=out.js
wc -c out.js
```

Expected: `out.js` is produced (roughly 20–60 KB). If `framer-motion/dom` has no `inView` export in 14.1.0, remove it from `entry.js`, and implement `revealOnView` with `IntersectionObserver` instead (record this in the task report).

Copy `out.js` to `<worktree>/assets/vendor/framer-motion-dom.js`, and copy `node_modules/framer-motion/LICENSE.md` to `assets/vendor/FRAMER-MOTION-LICENSE.md`. Add a first-line comment to the bundle: `/* framer-motion 14.1.0 dom bundle (MIT) - see FRAMER-MOTION-LICENSE.md */`.

- [ ] **Step 2: Fonts**

In `index.html`, change the Google Fonts `href` to load Fraunces and Inter, dropping Sora:
`https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600;9..144,700&family=Inter:wght@400;500;600;700&display=swap`

- [ ] **Step 3: Tokens**

In `assets/styles.css`:
- Light: `--paper: #f7f4ee; --paper-2: #efeae0; --rule: #e6e0d4; --rule-2: #d6cfc0; --card-bg: #fffdf9;` `--ink`, `--ink-2`, `--ink-3` shift slightly warm (`#1a1814`, `#4f4a40`, `#5c564a` — all ≥ 4.5:1 on `--paper`), `--border-card: 1px solid rgba(26, 24, 20, 0.09)`, `--shadow-card: none`, `--shadow-card-hover: 0 1px 0 rgba(26, 24, 20, 0.04)`; `--radius-md: 12px; --radius-sm: 8px; --radius-xs: 6px`.
- `--disp` becomes the UI/body stack `"Inter", system-ui, -apple-system, "Segoe UI", sans-serif`; add `--serif: "Fraunces", Georgia, "Times New Roman", serif`; `--mono` keeps Inter + tabular numerals.
- Dark: warm-dark equivalents (`--paper: #17150f`, `--paper-2: #1f1c15`, `--rule: #2e2a20`, `--rule-2: #3d382b`, `--card-bg: #1c1a13`, ink `#efe9dc` / `#bdb5a4` / `#908874`, `--border-card: 1px solid rgba(255,248,230,0.09)`, shadows `none`). Keep `--rail-bg`/`--rail-fg` fixed as they are.
- Apply `font-family: var(--serif)` to page titles (`h1`, `h2.page-title` or the equivalent headings used across pages — grep `font-family: var(--disp)` rules at lines ~121, 188, 213 to find them) and to the hero/KPI value classes (`.kpi .v`, `.div-kpi-val`, net-worth hero figure); keep `.num` tabular numerals.
- Do not rename any token. Update the explanatory comments that mention Sora/cool grey if they become false.

- [ ] **Step 4: `assets/motion.js`**

Implement the interface above. Rules: `import()` the vendored module lazily inside `motion.js` with `.catch(() => null)`; every helper returns immediately if `reducedMotion()` or the module is null; `countUp` must set `el.textContent = format(to)` in a `finally`/completion path and when `to` is not finite; `revealStagger` sets final styles on completion and cancels cleanly if called again on the same element; add a `data-motion` attribute guard so repeated calls on the same element in one render don't stack.

- [ ] **Step 5: Wire into router**

In `assets/router.js` `go()`, after `(VIEWS[tab] || renderDashboard)();` call `revealPage()` imported from `./motion.js` (wrapped so an exception can never break navigation).

- [ ] **Step 6: Verify**

Run `node --check assets/motion.js assets/router.js`. Serve with `python3 -m http.server 8080` from the worktree, open each of Dashboard, Add, Transactions, Budget, Net Worth, Data, Profile in light and dark: warm palette, serif titles/hero numbers, no console errors, pages visible (not stuck at opacity 0). Emulate `prefers-reduced-motion: reduce` and confirm no movement. Block `assets/vendor/framer-motion-dom.js` (rename temporarily) and confirm the app still renders.

- [ ] **Step 7: Commit**

```bash
git add assets/styles.css index.html assets/vendor assets/motion.js assets/router.js
git commit -m "feat(ui): editorial design tokens, Fraunces, vendored framer-motion/dom and motion.js"
```

---

### Task 2: Dashboard + charts

**Files:**
- Modify: `assets/pages/dashboard.js` (KPI render around lines 246-275 and 388-410: `#kpi-${key}-v`, `#kpi-net`, `#kpi-budgetused`, `#dash-div-total`)
- Modify: `assets/pages/dashboard.css`
- Modify: `assets/charts.js` (the Chart.js config in the shared create helper at ~line 68 and the builders `incomeVsExpense`…`dividendsTrend`)

**Interfaces:**
- Consumes: `countUp`, `revealStagger`, `chartAnimation` from `assets/motion.js` (Task 1).

- [ ] **Step 1:** In `dashboard.css`/`dashboard.js`, grep for hard-coded colours/radii/shadows/`font-family` that bypass tokens (`grep -nE '#[0-9a-fA-F]{3,8}|border-radius|box-shadow|font-family' assets/pages/dashboard.css assets/pages/dashboard.js`) and replace with tokens (`var(--rule)`, `var(--radius-md)`, `var(--serif)` for hero numbers). Semantic colours (loss red, gain green) stay.
- [ ] **Step 2:** In `charts.js`, set `options.animation = chartAnimation()` in the single place charts are created (so all nine builders inherit); restyle gridlines to `--rule` and tick/legend text to `--ink-3` using values read from computed CSS variables at chart-creation time so dark mode works. Keep existing category colours.
- [ ] **Step 3:** In `dashboard.js`, call `countUp` for KPI value elements after each render/patch with the existing money formatter (final text must equal what the code previously set directly), and `revealStagger` for the KPI tiles on first shell render only (not on the in-place patch path).
- [ ] **Step 4: Verify** — `node --check` touched JS; Dashboard in light/dark, change year and month selectors (in-place patch path: values update, nothing stuck hidden), reduced-motion emulation.
- [ ] **Step 5: Commit** — `git commit -am "feat(ui): restyle Dashboard and charts, KPI count-up"`

---

### Task 3: Transactions + Add

**Files:**
- Modify: `assets/pages/transactions.js`, `assets/pages/transactions.css`, `assets/pages/add.js`, `assets/pages/add.css`

- [ ] **Step 1:** Grep both pairs for token-bypassing literals (`grep -nE '#[0-9a-fA-F]{3,8}|border-radius|box-shadow|font-family'`) and replace with tokens; category chips keep `--cat-color-*`.
- [ ] **Step 2:** Table: hairline row separators, tabular numerals in amount columns, sticky header on `--paper`. NO animation on rows or filters (frequency gate). Add form: visible labels, focus ring uses `--shadow-focus`, inputs use `--radius-sm`.
- [ ] **Step 3:** One page-level `revealStagger` on the filter bar + table container only (via `revealPage()` from Task 1; no extra code unless a section is missed).
- [ ] **Step 4: Verify** — `node --check`; add and edit a transaction, filter, sort — in light/dark; reduced-motion emulation.
- [ ] **Step 5: Commit** — `git commit -am "feat(ui): restyle Transactions and Add"`

---

### Task 4: Net Worth, Metals, Fixed Deposits

**Files:**
- Modify: `assets/pages/networth.js`, `assets/pages/networth.css`, `assets/pages/metals.js`, `assets/pages/fixed-deposits.js`

- [ ] **Step 1:** Grep for token-bypassing literals in these files and replace with tokens; hero net-worth figure uses `var(--serif)` with tabular numerals; tabs and KPI tiles use hairline surfaces.
- [ ] **Step 2:** `countUp` on the net-worth hero figure and the section totals (metals total value, FD total) using the existing formatters; `revealOnView` for the lower sections (Precious metals, Fixed Deposits tables) so they enter on scroll.
- [ ] **Step 3:** Charts (`netWorthTrend`, `assetSplit`) already inherit Task 2's styling; confirm only.
- [ ] **Step 4: Verify** — `node --check`; every Net Worth tab in light/dark; add/edit a metals lot (form still works, fields hide/show as before); reduced-motion emulation.
- [ ] **Step 5: Commit** — `git commit -am "feat(ui): restyle Net Worth, Metals, Fixed Deposits"`

---

### Task 5: Debts + Budget

**Files:**
- Modify: `assets/pages/debts.js`, `assets/pages/budget.js`, `assets/pages/budget.css`

- [ ] **Step 1:** Grep for token-bypassing literals and replace with tokens. Budget progress bars: track `--paper-2`, fill uses existing semantic colours, over-budget stays red; bar fill animates `transform: scaleX` (not `width`) once on first render only.
- [ ] **Step 2:** `countUp` on Debts KPI tiles and Budget summary figures with existing formatters.
- [ ] **Step 3: Verify** — `node --check`; edit a budget amount and a debt row (no animation on edit; values correct); light/dark; reduced-motion emulation.
- [ ] **Step 4: Commit** — `git commit -am "feat(ui): restyle Debts and Budget"`

---

### Task 6: Data, Profile, Onboarding, landing page

**Files:**
- Modify: `assets/pages/data.js`, `assets/pages/profile.js`, `assets/pages/onboarding.js`, `assets/landing.js`, `assets/landing.css`, `assets/auth.css`, `assets/styles.css` (header rail / popover / footer only, if still off-token)

- [ ] **Step 1:** Grep for token-bypassing literals in these files and replace with tokens. Landing hero headline uses `var(--serif)`; buttons keep `--ink`/`--paper` swap behaviour for dark mode.
- [ ] **Step 2:** Empty states (Data with no rows, Onboarding steps) get the only Jhey-style delight: a single gentle `revealStagger` on first show. Landing sections use `revealOnView`.
- [ ] **Step 3: Verify** — `node --check`; sign-in gate/landing, onboarding, Data tab (import/export dialogs still open), Profile (theme switch toggles light/dark/system and the UI follows) — light/dark; reduced-motion emulation.
- [ ] **Step 4: Commit** — `git commit -am "feat(ui): restyle Data, Profile, Onboarding, landing"`

---

## Self-Review

- **Spec coverage:** palette/type/surfaces → Task 1; Framer Motion vendored + `motion.js` (count-up, stagger, inView, chart draw-in) → Tasks 1–2; rollout order 1–6 matches the spec; reduced-motion, dark theme, out-of-scope items → Global Constraints.
- **Deviation from spec, flagged:** chart draw-in is Chart.js's `animation` option (charts are canvas), not Framer Motion. The spec's "chart draw-in" is still met.
- **Type consistency:** helper names (`countUp`, `revealStagger`, `revealOnView`, `revealPage`, `chartAnimation`, `reducedMotion`) are defined in Task 1 and used unchanged in Tasks 2–6.
