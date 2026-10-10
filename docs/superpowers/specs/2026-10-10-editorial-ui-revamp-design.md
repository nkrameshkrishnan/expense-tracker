# Editorial UI revamp (root Ledger app) — design

## Intent

Give the whole Ledger app a distinctive "calm editorial finance" identity
instead of the generic SaaS-card default, with restrained, purposeful motion.
Used daily by a household (Ramesh, Surya); success = every page shares one
visual system, numbers read clearly, nothing feels animated for its own sake.

Assumptions (not yet confirmed by the user): direction 1 of the three offered;
Emil primary / Jakub secondary / Jhey for empty states and count-ups only.

## Constraints

- Zero-build static app: ES modules, no bundler. The one allowed new runtime
  dependency is Framer Motion's framework-agnostic DOM API
  (`framer-motion/dom`: `animate`, `stagger`, `inView`), vendored as a single
  ES module under `assets/vendor/` (no CDN, no CSP change). React components
  are not used. GSAP is not added.
- CSP in `index.html` already allows Google Fonts (`fonts.googleapis.com`,
  `fonts.gstatic.com`); no CSP change needed for a new face.
- No behaviour, data, or storage-adapter changes. Visual + motion only.
- Light and dark themes (`:root[data-theme="dark"]`) both updated.
- Every animation honours `prefers-reduced-motion`; only transform/opacity
  animate.

## Design

### 1. Foundation (tokens in `assets/styles.css`)

- Palette: warm paper (`--paper` ≈ #f7f4ee, `--paper-2` slightly deeper, warm
  hairlines) replaces cool grey. Teal remains the single accent. Red/green are
  semantic (loss/gain) only. Dark theme gets the matching warm-dark swap.
- Type: serif display face (Fraunces, via the existing Google Fonts link) for
  page titles and hero numbers; Inter for UI; tabular numerals wherever money
  appears. Sora removed.
- Surfaces: flat cards, hairline rules instead of stacked shadows, radius
  18px → 12px (`--radius-md`).
- Pages inherit via tokens; per-page edits only where a page hard-codes values.

### 2. Motion (`assets/motion.js` on vendored `framer-motion/dom`, plus CSS)

- `motion.js` is the only importer of the vendored module; pages call its
  helpers. Vendoring: `npm install framer-motion` in a scratch dir, bundle
  `framer-motion/dom` to one ESM file, commit it to `assets/vendor/` with its
  version and licence noted. `package.json` is not changed (it exists only for
  `migrate.mjs`).
- Count-up on KPI numbers, ~40ms-stagger list reveal (`stagger`), chart
  draw-in, scroll-in reveal (`inView`); springs/interruptible where it helps.
- 150–220ms, existing `--ease-out`; enter = opacity + 6px translateY; exit
  shorter than enter. Hover/press states stay in CSS.
- Not animated: table rows, filters, keyboard-initiated actions, anything
  used hundreds of times a day.
- Reduced-motion: all of the above collapse to instant.

### 3. Rollout (one subagent task each, reviewed per task)

1. Tokens, fonts, type scale, shell/nav, vendored Framer Motion + `motion.js`.
2. Dashboard + `charts.js`.
3. Transactions + Add.
4. Net Worth, Metals, Fixed Deposits.
5. Debts + Budget.
6. Data, Profile, Onboarding, landing page (`landing.js`, `landing.css`).

## Verification

Per task: `node --check` on touched JS; serve with `python3 -m http.server 8080`
and inspect each affected page in light and dark; contrast ≥ 4.5:1 for text;
reduced-motion emulation shows no movement.

## Out of scope

Data model, Supabase schema, deploy workflow, the `expense-tracker-new` repo.
