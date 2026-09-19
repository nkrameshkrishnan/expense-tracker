/* Tab navigation: the VIEWS map and go(tab), plus the #tabs button wiring.

   router.js <-> core.js is circular (core.js's renderPeopleSwitch() click
   handler calls go() from here; core.js's switchActiveTenant() reads VIEWS
   from here) and router.js <-> auth.js is circular too (auth.js's boot()
   calls go() and reads VIEWS to restore the last-viewed tab on sign-in) -
   safe in ES modules since every one of these is only ever read from
   inside a function body (a click handler, or boot()'s async flow), never
   at module top-level. Unlike root's go() (assets/router.js), New's wraps
   the view swap in viewTransition() rather than calling renderPeopleSwitch()
   itself - the person switch here is core.js's own concern. */
import { view, state } from "./core.js";
import { viewTransition } from "./motion.js";
import * as charts from "./charts.js";
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

export const VIEWS = {
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

export function go(tab) {
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
