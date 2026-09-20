/* Tab navigation: the VIEWS map and go(tab), plus the #tabs button wiring.

   router.js <-> core.js is circular (core.js's renderPeopleSwitch() calls
   go() from here; go() here calls renderPeopleSwitch() from core.js) - safe
   in ES modules since both are only ever called from inside a function body
   (a click handler), never read at module top-level. Verified via a real
   import() resolution, not just reasoned about. */
import * as charts from "./charts.js";
import { view, state, renderPeopleSwitch } from "./core.js";
import { renderDashboard } from "./pages/dashboard.js";
import { renderAdd } from "./pages/add.js";
import { renderTransactions } from "./pages/transactions.js";
import { renderBudget } from "./pages/budget.js";
import { renderNetWorth } from "./pages/networth.js";
import { renderData } from "./pages/data.js";
import { renderProfile } from "./pages/profile.js";

export const VIEWS = {
  dashboard: renderDashboard,
  add: renderAdd,
  transactions: renderTransactions,
  budget: renderBudget,
  networth: renderNetWorth,
  data: renderData,
  // No .tabs button carries data-tab="profile" on purpose - this page is
  // reached from the profile popover (core.js's renderProfileMenu()), not
  // the main nav. go()'s #tabs-highlighting loop only touches buttons that
  // exist in the DOM, so landing here just leaves every nav button
  // unhighlighted rather than erroring.
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
  // The person switch (#people) reflects state.person, which can change
  // independently of the tab (clicking Ramesh/Surya/Family calls go() to
  // reload the current tab's data, but doesn't itself touch #tabs). It was
  // only ever rendered once at boot, so its highlighted button silently
  // froze on whatever was selected at load - re-render it every navigation
  // so it always matches state.person, not just the tab buttons.
  renderPeopleSwitch();
  location.hash = tab;
  (VIEWS[tab] || renderDashboard)();
  window.scrollTo(0, 0);
}

document.querySelectorAll("#tabs button").forEach(
  (b) =>
    (b.onclick = () => {
      if (b.dataset.tab !== "add") state.editing = null;
      go(b.dataset.tab);
    }),
);
