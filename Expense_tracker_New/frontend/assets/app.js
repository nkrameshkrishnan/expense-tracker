import {
  PAYMENTS,
  ACCOUNTS,
  currentYear,
  PERSON_KEY,
  getIdToken,
  setIdToken,
} from "./store.js";
import {
  $,
  view,
  esc,
  YEAR_KEY,
  state,
  withBusy,
  notice,
  refresh,
  periodSelect,
} from "./core.js";
import { viewTransition } from "./motion.js";
import { aggregate } from "./xlsxio.js";
import { removeCustom } from "./categories.js";
import * as charts from "./charts.js";
import {
  showGate,
  consumeAuthRedirect,
  revealApp,
  boot,
} from "./auth.js";
import { renderDashboard } from "./pages/dashboard.js";
import { renderCashFlow } from "./pages/cashflow.js";
import { renderSpending } from "./pages/spending.js";
import { renderAdd } from "./pages/add.js";
import { renderTransactions } from "./pages/transactions.js";
import { renderBudget } from "./pages/budget.js";
import { renderNetWorth } from "./pages/networth.js";
import { renderData } from "./pages/data.js";
import { renderBilling } from "./pages/billing.js";
import { renderProfile } from "./pages/profile.js";

/* ------------------------------------------------------------------ plans
   Pure display copy, keyed by plan id - label and blurb are the only
   per-plan facts that can't come from the backend, since they're
   marketing text, not business logic. Everything that determines what a
   plan actually DOES or COSTS (seat cap, features, price) comes from
   state.plans (getPlans(), see ensurePlans below) - this app keeps no
   independent list of which tiers exist, so a tier added or removed on
   the server just works here without a matching edit. Personal-finance
   app, not a team tool - Family is deliberately the top tier; there is no
   unlimited-seat "Business" plan. A plan id with no entry here (a new
   tier added server-side before its copy is written) still renders, with
   a generic fallback label/blurb - see planCopy() below. The signup gate
   (renderPlanGate) and the Billing tab (renderBilling) deliberately do
   not share markup/CSS: the gate is a one-time, full-viewport decision
   (bigger cards, its own visual weight), while Billing is a page you
   return to, sitting alongside this app's other panels - collapsing them
   into one component would make whichever one changes next drag the
   other along with it. They DO share the small data helpers below
   (planCopy/planFeatureList/planSeatsLabel/formatPlanAmount/
   formatPlanPeriod) - those are pure derivation, not markup, so sharing
   them carries none of that risk. */

/* ==================================================================== router */
const VIEWS = {
  dashboard: renderDashboard,
  cashflow: renderCashFlow,
  spending: renderSpending,
  add: renderAdd,
  transactions: renderTransactions,
  budget: renderBudget,
  networth: renderNetWorth,
  data: renderData,
  billing: renderBilling,
  profile: renderProfile,
};

function go(tab) {
  state.tab = tab;
  charts.destroyAll();
  // dataset.shell lives on the #view ELEMENT, not its children - reassigning
  // innerHTML for a DIFFERENT page never clears it on its own. Without this,
  // Dashboard -> Transactions -> Dashboard could find the stale flag still
  // set, wrongly take the fast patch path against Transactions' leftover
  // markup, and silently show nothing new at all. Only renderDashboard()'s
  // OWN direct calls (from its year/month selectors, which bypass go()
  // entirely) should ever see this flag intact.
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

document.querySelectorAll("#tabs button").forEach(
  (b) =>
    (b.onclick = () => {
      if (b.dataset.tab !== "add") state.editing = null;
      go(b.dataset.tab);
    }),
);

// A tenant that downgraded to Free still HAS its older transactions on the
// server - the Free plan's 12-month window only hides them from what the
// API returns (see backend/src/plans.js's FEATURES.historyMonths). The
// destructive flows below, though, clear the table server-side with no date
// filter at all, so they delete those hidden rows too, and neither the
// "Delete all N transactions" count nor the import's "Replace everything
// first" wording would otherwise account for them. Only a tenant that has
// been through checkout (hasStripeCustomer) can have rows outside the
// window, so the warning is scoped to exactly that case rather than shown
// to every Free user.
const hiddenHistoryWarning = () =>
  state.tenant?.plan === "free" && state.tenant?.hasStripeCustomer
    ? "\n\nWARNING: your account is on the Free plan, which only shows the last 12 months. Older transactions that are currently hidden from you will ALSO be permanently deleted, and they are not in the counts above or in an export taken now."
    : "";

(async function main() {
  // XLSX is deliberately excluded - it's loaded on demand by xlsxio.js when
  // Export/Import is actually clicked, not before. Waiting for it here would
  // reintroduce the exact 930KB blocking cost this change removes.
  const ready = () => typeof Chart !== "undefined";
  if (!ready())
    await new Promise((r) =>
      window.addEventListener("load", r, { once: true }),
    );

  // A redirect back from Cognito's Hosted UI carries the id_token in the URL
  // fragment - consume it before deciding whether the gate needs showing, so
  // a just-completed sign-in doesn't get shown the gate again.
  consumeAuthRedirect();

  // Sign-in is always required — this is multi-tenant SaaS with no
  // local/offline mode to fall back to (see store.js), so an unauthenticated
  // session has nothing to show. If Cognito itself isn't configured for this
  // deployment, showGate() renders that as its own clear error rather than a
  // broken sign-in button.
  if (!getIdToken()) {
    showGate();
    return;
  }

  try {
    await boot();
  } catch (e) {
    if (e?.auth || /sign in|not permitted/i.test(e?.message || "")) {
      setIdToken("");
      showGate(e.message);
    } else {
      revealApp();
      throw e;
    }
  }
})();
