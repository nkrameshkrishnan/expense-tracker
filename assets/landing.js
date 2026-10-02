/* Pre-sign-in landing page: a Monarch-style marketing shell (sticky nav,
   hero, alternating feature sections, a "why we built this" strip, sign-in,
   footer) wrapped around the real Google sign-in gate. Only shown on a
   fresh, first sign-in - showGate() in auth.js skips straight to the plain
   compact gate-card for a mid-session re-auth, so a token expiring an hour
   into real use doesn't force a scroll through marketing copy again.

   The feature "screenshots" below are small hand-built mockups using the
   app's own design tokens and icon set (icons.js) rather than stock photos,
   cartoon illustrations, or fabricated product screenshots - per the
   anti-slop rule, and because they are honest about being illustrative
   rather than live data. */
import { iconBadge } from "./icons.js";

const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

/** Sticky top nav + hero. None of the buttons below render Google's button
    by default - that would mean every visitor's browser starts talking to
    Google before they've expressed any intent to continue, which is not how
    a modern marketing page behaves (Monarch, Linear, Notion all keep auth
    behind a click). All of them are plain, JS-driven triggers
    (data-action="open-signin", data-mode="signin"|"signup") that open the
    SAME sign-in modal - see renderSigninModal() below and
    wireLandingSignin() in auth.js, which relabels the modal and the real
    Google button per mode on open. There is no separate account-creation
    form: Google sign-in is the
    identical mechanism either way (and access is still gated by the
    Supabase allow-list afterward), so "Sign up" only changes the wording of
    the invitation, never what actually happens when it's clicked. */
function renderHero() {
  return `
    <nav class="l-nav">
      <div class="l-nav-in">
        <div class="brand">
          <span class="brand-mark">&#8214;</span>
          <span class="brand-name">LEDGER</span>
          <span class="brand-Currency"> &middot; CAD</span>
        </div>
        <div class="l-nav-actions">
          <button type="button" class="l-btn l-btn-ghost l-nav-btn" data-action="open-signin" data-mode="signin">Sign in</button>
          <button type="button" class="l-btn l-nav-btn" data-action="open-signin" data-mode="signup">Sign up</button>
        </div>
      </div>
    </nav>
    <header class="l-hero">
      <p class="l-eyebrow">A private household ledger</p>
      <h1 class="l-h1">Every dollar, every account,<br />one shared view.</h1>
      <p class="l-sub">Track spending, keep a household budget, and watch your
        net worth grow &mdash; built for the two of you, not a company
        trying to sell you a subscription.</p>
      <div class="l-hero-ctas">
        <button type="button" class="l-btn l-hero-cta" data-action="open-signin" data-mode="signup">Get started</button>
        <button type="button" class="l-link" data-action="open-signin" data-mode="signin">Already have access? Sign in</button>
      </div>
      <p class="l-trust">Google sign-in &middot; access checked against an
        allow-list &middot; your data lives in your own Supabase project</p>
    </header>`;
}

/** Hidden by default (see .l-modal[hidden] in landing.css) - opened only
    when a "Sign in" or "Sign up" button is clicked. Holds the same card
    content the old always-visible gate-card had; the real Google button is
    re-rendered into #gsi-button on every open (not just the first) because
    wireLandingSignin() in auth.js needs to swap its label ("Sign up with
    Google" vs "Sign in with Google") to match whichever button opened the
    modal. The title/subtitle text below are placeholders - the same code
    rewrites them the instant the modal opens; see the COPY table in
    wireLandingSignin(). */
function renderSigninModal() {
  return `
    <div class="l-modal" id="signin-modal" hidden>
      <div class="l-modal-scrim" data-action="close-signin"></div>
      <div class="l-modal-card gate-card" role="dialog" aria-modal="true" aria-labelledby="signin-modal-title">
        <button type="button" class="l-modal-close" data-action="close-signin" aria-label="Close">&times;</button>
        <div class="gate-mark">&#8214;</div>
        <h1 class="gate-title" id="signin-modal-title">Ledger</h1>
        <p class="gate-sub" id="signin-modal-sub">Sign in or sign up with the Google account linked to this tracker.</p>
        <div id="gsi-button"></div>
        <p class="gate-note">Access is verified by Supabase Row Level Security against an allow-list.
          Signing in here does not grant access on its own.</p>
        <p class="gate-note"><a href="terms.html" target="_blank" rel="noopener">Terms &amp; Privacy</a>
          &mdash; what Google profile information this app collects and why.</p>
      </div>
    </div>`;
}

/* ---------- mini "product preview" mockups ---------- */
/* Static, illustrative, built from the same tokens/icons as the real app -
   never a claim that this is live data. */

function mockDashboard() {
  return `
    <div class="l-mock l-mock-dash">
      <div class="l-mock-kpis">
        <div class="l-mock-kpi"><span class="l-mock-kpi-k">Income</span><span class="l-mock-kpi-v" style="color:var(--green)">$3,200</span></div>
        <div class="l-mock-kpi"><span class="l-mock-kpi-k">Expense</span><span class="l-mock-kpi-v" style="color:var(--red)">$1,940</span></div>
        <div class="l-mock-kpi"><span class="l-mock-kpi-k">Net</span><span class="l-mock-kpi-v">+$1,260</span></div>
      </div>
      <svg class="l-mock-spark" viewBox="0 0 220 60" preserveAspectRatio="none" aria-hidden="true">
        <polyline points="0,46 30,40 60,44 90,24 120,30 150,14 180,20 220,6" fill="none" stroke="var(--amber)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </div>`;
}

function mockAdd() {
  return `
    <div class="l-mock l-mock-add">
      <div class="l-mock-type-row">
        <span class="l-mock-type on">Expense</span>
        <span class="l-mock-type">Income</span>
        <span class="l-mock-type">Transfer</span>
      </div>
      <div class="l-mock-amount-wrap">
        <span class="l-mock-currency">$</span>
        <span class="l-mock-amount">42.10</span>
        <span class="l-mock-ccy">CAD</span>
      </div>
      <div class="l-mock-field-row">
        <span class="l-mock-field">${iconBadge("Dining Out", "category", "sm")}Dining Out</span>
        <span class="l-mock-field">${iconBadge("Visa", "account", "sm")}Visa</span>
      </div>
    </div>`;
}

function mockTransactions() {
  const row = (cat, acct, person, amt, cls) => `
      <div class="l-mock-tx">
        ${iconBadge(cat, "category", "sm")}
        <span class="l-mock-tx-desc">${esc(cat)}</span>
        ${iconBadge(acct, "account", "sm")}
        <span class="l-mock-tx-amt ${cls}">${amt}</span>
      </div>`;
  return `
    <div class="l-mock l-mock-tx-list">
      ${row("Groceries", "Amex", "Ramesh", "$85.40", "")}
      ${row("Salary", "Chequing", "Surya", "+$3,200.00", "pos")}
      ${row("Dividends", "TFSA", "Ramesh", "+$120.00", "div")}
    </div>`;
}

function mockBudget() {
  return `
    <div class="l-mock l-mock-budget">
      <div class="l-mock-bcard">
        <div class="l-mock-bcard-head">${iconBadge("Groceries", "category", "sm")}<span>Groceries</span><span class="l-mock-bcard-total">$600<small>/mo</small></span></div>
        <div class="l-mock-bar-track"><div class="l-mock-bar-fill" style="width:71%"></div></div>
        <div class="l-mock-bar-label">$427 spent &middot; 71%</div>
      </div>
      <div class="l-mock-bcard">
        <div class="l-mock-bcard-head">${iconBadge("Dining Out", "category", "sm")}<span>Dining Out</span><span class="l-mock-bcard-total">$250<small>/mo</small></span></div>
        <div class="l-mock-bar-track"><div class="l-mock-bar-fill over" style="width:100%"></div></div>
        <div class="l-mock-bar-label over">$289 spent &middot; over</div>
      </div>
    </div>`;
}

function mockNetworth() {
  return `
    <div class="l-mock l-mock-nw">
      <div class="l-mock-nw-split">
        <div class="l-mock-nw-seg" style="width:78%;background:var(--teal)"></div>
        <div class="l-mock-nw-seg" style="width:22%;background:var(--red)"></div>
      </div>
      <div class="l-mock-nw-rows">
        <div><span class="dot" style="background:var(--teal)"></span>Assets <b>$184,200</b></div>
        <div><span class="dot" style="background:var(--red)"></span>Liabilities <b>$51,800</b></div>
        <div class="total">Net worth <b>$132,400</b></div>
      </div>
    </div>`;
}

function mockData() {
  return `
    <div class="l-mock l-mock-data">
      <div class="l-mock-data-row"><span class="l-mock-data-btn">Download .xlsx</span><span class="l-mock-data-btn ghost">Download .json backup</span></div>
      <ul class="l-mock-data-list">
        <li>Lives in your own Supabase project &mdash; not ours</li>
        <li>Export anytime as a spreadsheet or a plain JSON backup</li>
        <li>No ads, no data sold, nothing tracked for marketing</li>
      </ul>
    </div>`;
}

const FEATURES = [
  {
    eyebrow: "Dashboard",
    title: "See the whole picture at a glance",
    body: "Income, expenses, savings rate and trend charts for the month, the year, or whoever you pick in the household switch &mdash; updated the moment a transaction is logged.",
    mock: mockDashboard,
  },
  {
    eyebrow: "Add",
    title: "Log a transaction in seconds",
    body: "One big amount field, a type picker, and smart defaults pulled from your recent entries. Built for the 10-second habit, not a form you dread opening.",
    mock: mockAdd,
  },
  {
    eyebrow: "Transactions",
    title: "Every entry, searchable and tagged",
    body: "Search by description, category or payment method, filter by type or month, and see category and account icons at a glance &mdash; grouped by month with running totals.",
    mock: mockTransactions,
  },
  {
    eyebrow: "Budget",
    title: "Set ceilings, not guesswork",
    body: "One shared household ceiling per category, with actual-vs-budget bars that go red the moment you're over &mdash; whether you budget flat or month by month.",
    mock: mockBudget,
  },
  {
    eyebrow: "Net worth",
    title: "Know what you're actually worth",
    body: "Record account balances, track debts and loans, and see assets vs. liabilities roll up into one number &mdash; separate from day-to-day spending.",
    mock: mockNetworth,
  },
  {
    eyebrow: "Data",
    title: "Your data stays yours",
    body: "Everything lives in a Supabase project you control. Export the full ledger to Excel or JSON whenever you want &mdash; no lock-in, no subscription.",
    mock: mockData,
  },
];

function renderFeatures() {
  return `
    <section class="l-features">
      ${FEATURES.map(
        (f, i) => `
        <div class="l-feature${i % 2 ? " rev" : ""}">
          <div class="l-feature-copy">
            <p class="l-feature-eyebrow">${esc(f.eyebrow)}</p>
            <h2 class="l-feature-title">${f.title}</h2>
            <p class="l-feature-body">${f.body}</p>
          </div>
          <div class="l-feature-visual">${f.mock()}</div>
        </div>`,
      ).join("")}
    </section>`;
}

/** Replaces the testimonials/press-logo strip Monarch uses - real quotes and
    outlets would have to be fabricated for a two-person private tool, so
    this is a plain, honest list of the actual reasons the app exists
    instead, per the anti-slop rule against invented social proof. */
function renderValues() {
  const items = [
    ["Private by default", "Your own Supabase project. No ads, no third-party trackers, nothing sold."],
    ["Two people, one ledger", "Switch between a household view and each person's own, any time."],
    ["Open format", "Export to .xlsx or a plain JSON backup whenever you want &mdash; nothing is locked in."],
    ["No subscription", "It's a deployment you own, not a plan you pay for every month."],
  ];
  return `
    <section class="l-values">
      <p class="l-eyebrow l-eyebrow-center">Built for two, not a company</p>
      <div class="l-values-grid">
        ${items
          .map(
            ([t, d]) => `
          <div class="l-value-card">
            <h3>${t}</h3>
            <p>${d}</p>
          </div>`,
          )
          .join("")}
      </div>
    </section>`;
}

function renderFooter() {
  return `
    <footer class="l-footer">
      <div class="brand"><span class="brand-mark">&#8214;</span><span class="brand-name">LEDGER</span></div>
      <a href="terms.html" target="_blank" rel="noopener">Terms &amp; Privacy</a>
      <span class="l-footer-note">A private household ledger &mdash; not a commercial product.</span>
    </footer>`;
}

export function renderLandingIntro() {
  return renderHero() + renderFeatures() + renderValues();
}

export function renderLandingFooter() {
  return renderFooter();
}

export function renderLandingModal() {
  return renderSigninModal();
}
