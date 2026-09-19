import {
  PAYMENTS,
  ACCOUNTS,
  currentYear,
  PERSON_KEY,
  getIdToken,
  setIdToken,
  CURRENCIES,
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
  planCopy,
  formatPlanAmount,
  formatPlanPeriod,
  planSeatsLabel,
  planFeatureList,
  ensurePlans,
  markPlanGateSeen,
} from "./tenant.js";
import {
  showGate,
  signOut,
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

/** The household's plan, status and payment actions - its own top-level page
    rather than a section of Data, since it is where an owner actually goes
    to make a billing decision, not incidental to "where your data lives".
    Deliberately does not share markup with renderPlanGate: that overlay is
    a one-time, full-viewport decision shown once at signup, this is a page
    you come back to and sits visually among this app's other panels. */
function renderBilling() {
  const tenant = state.tenant || { plan: "free", status: "active" };
  const myRole = state.role || "member";
  // Billing is owner-only (the backend enforces the same rule on both
  // billing actions) - a narrower rule than canManageInvites, since an
  // admin can invite people but cannot spend the household's money.
  const canManageBilling = myRole === "owner";
  // Checkout can only CREATE a subscription. Once one exists, changing or
  // cancelling it belongs to the Customer Portal - showing "Choose <other
  // plan>" here would start a second, separately-billed subscription
  // (routes/billing.js rejects it server-side too).
  const hasSubscription = tenant.plan !== "free";
  const showDowngradeBanner =
    tenant.plan === "free" && !!tenant.hasStripeCustomer;
  const plans = state.plans || [];
  const planMeta = plans.find((p) => p.id === tenant.plan);
  const currentLabel = planCopy(tenant.plan).label;
  const statusLabel =
    tenant.status === "past_due"
      ? "Payment failed"
      : showDowngradeBanner
        ? "Back on Free"
        : "Active";
  const statusClass =
    tenant.status === "past_due" ? "bad" : showDowngradeBanner ? "warn" : "ok";

  view.innerHTML = `
  <div class="head"><div><h1>Billing</h1><p class="sub">This household's plan, seats and payment details.</p></div></div>

  <div class="eyebrow">Current plan</div>
  <div class="panel billing-current">
    <div class="billing-current-top">
      <div>
        <div class="billing-current-plan">${esc(currentLabel)}</div>
        <div class="muted">${
          planMeta
            ? `${esc(planSeatsLabel(planMeta.seatCap))} &middot; <span class="num">${esc(formatPlanAmount(planMeta))}</span>${esc(formatPlanPeriod(planMeta))}`
            : esc(state.plans ? "Plan details unavailable" : "Loading…")
        }</div>
      </div>
      <span class="status-pill ${statusClass}">${esc(statusLabel)}</span>
    </div>
    ${
      tenant.status === "past_due"
        ? `<p class="note" style="margin-top:12px">Your last payment failed. Update your card in the billing portal before the grace period ends to keep full access.</p>`
        : ""
    }
    ${
      showDowngradeBanner
        ? `<p class="note" style="margin-top:12px">Your subscription was canceled after a failed payment — you're on the Free plan.${canManageBilling ? ' <button class="btn ghost" id="resubscribe">Resubscribe</button>' : ""}</p>`
        : ""
    }
    ${
      canManageBilling
        ? ""
        : '<p class="note" style="margin-top:12px">Only the household owner can change the plan or manage payment details.</p>'
    }
  </div>

  <div class="eyebrow">Plans</div>
  ${
    !state.plans
      ? `<p class="note">Loading plans…</p>`
      : plans.length === 0
        ? `<p class="note">Plans are temporarily unavailable. Try reconnecting from the banner above, then reload.</p>`
        : `<div class="billing-plan-grid">
    ${plans
      .map((p) => {
        const isCurrent = p.id === tenant.plan;
        const copy = planCopy(p.id);
        return `
      <div class="billing-plan-card${isCurrent ? " current" : ""}${copy.recommended && !isCurrent ? " recommended" : ""}">
        ${copy.recommended && !isCurrent ? '<div class="billing-plan-tag">Most households</div>' : ""}
        <div class="billing-plan-name">${esc(copy.label)}</div>
        <div class="billing-plan-price"><span class="num">${esc(formatPlanAmount(p))}</span><span class="muted">${esc(formatPlanPeriod(p))}</span></div>
        <div class="muted" style="margin:2px 0 10px">${esc(planSeatsLabel(p.seatCap))}</div>
        <p class="note" style="margin:0 0 10px">${esc(copy.blurb)}</p>
        <ul class="billing-plan-features">
          ${planFeatureList(p.features)
            .map((f) => `<li>${esc(f)}</li>`)
            .join("")}
        </ul>
        ${
          isCurrent
            ? '<span class="billing-plan-current-tag">Current plan</span>'
            : !canManageBilling || hasSubscription || !p.priceId
              ? ""
              : `<button class="btn ghost" data-upgrade-plan="${esc(p.priceId)}">Choose ${esc(copy.label)}</button>`
        }
      </div>`;
      })
      .join("")}
  </div>`
  }

  ${
    hasSubscription && canManageBilling
      ? `<div class="eyebrow">Manage</div>
  <div class="panel stack">
    <p class="note" style="margin:0">Switching plans, updating your card and cancelling all happen in the Stripe billing portal — starting a second checkout here would bill you twice.</p>
    <div class="actions"><button class="btn ghost" id="manage-billing">Manage billing</button></div>
  </div>`
      : ""
  }`;

  view.querySelectorAll("[data-upgrade-plan]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const base = location.origin + location.pathname;
      const done = await withBusy("Starting checkout", async () => {
        const { url } = await state.store.createCheckoutSession(
          btn.dataset.upgradePlan,
          `${base}#billing`,
          `${base}#billing`,
        );
        location.href = url;
      });
      if (!done) notice("Could not start checkout.", "bad");
    });
  });

  $("#manage-billing")?.addEventListener("click", async () => {
    const returnUrl = location.origin + location.pathname;
    const done = await withBusy("Opening billing portal", async () => {
      const { url } = await state.store.createPortalSession(returnUrl);
      location.href = url;
    });
    if (!done) notice("Could not open billing portal.", "bad");
  });

  $("#resubscribe")?.addEventListener("click", () => {
    // Re-renders this same page's plan cards - resubscribing is just
    // choosing a plan again, no separate flow needed.
    renderBilling();
  });

  // First render shows "Loading plans…" above; once the fetch resolves,
  // silently re-render with the real list - but only if Billing is still
  // the tab on screen (the user may have already navigated away by the
  // time it resolves).
  ensurePlans(() => {
    if (state.tab === "billing") renderBilling();
  });
}

/** The signed-in individual's own account: identity, role, and sign-out.
    Distinct from Data's Household panel (which manages OTHER members and
    invites) and from Billing (tenant-wide money) - this is the one page
    that's about you specifically, not the household. Only shows real
    fields the backend actually returns (email, role) - no display name or
    avatar exists anywhere in this app's auth (see auth.js/handler.js). */
function renderProfile() {
  const signedIn = !!getIdToken();
  const email = state.userEmail || state.store.user?.email || "";
  const myRole = state.role || "member";
  const roleInfo =
    {
      owner:
        "Full access — can manage billing, invite or remove members, and use every feature.",
      admin: "Can invite members. Billing stays with the owner.",
      member:
        "Can add and edit transactions, budget and net worth. Inviting and billing stay with the owner or admins.",
    }[myRole] || "";
  const members = state.members || [];
  const tenants = state.tenants || [];

  view.innerHTML = `
  <div class="head"><div><h1>Profile</h1><p class="sub">Your account in this ledger.</p></div></div>

  <div class="eyebrow">Account</div>
  <div class="panel stack">
    ${
      signedIn
        ? `
    <p class="note" style="margin:0">Signed in as <b>${esc(email || "unknown")}</b>.</p>
    <p class="note" style="margin:0">Your role: <b>${esc(myRole)}</b>. ${esc(roleInfo)}</p>
    <p class="note" style="margin:0">Sign-in is Google-only — there's no separate Ledger password to set or reset.</p>`
        : `<p class="note" style="margin:0">Not signed in to a Ledger account.</p>`
    }
  </div>

  ${
    signedIn
      ? `
  <div class="eyebrow">Currency</div>
  <div class="panel stack">
    <label>Display currency
      <select id="profile-currency">
        ${CURRENCIES.map(
          (c) =>
            `<option value="${esc(c)}"${c === (state.tenant?.currency || "CAD") ? " selected" : ""}>${esc(c)}</option>`,
        ).join("")}
      </select>
    </label>
    <p class="note" style="margin:0">Changes how amounts are formatted everywhere in this household's ledger. Every amount already entered keeps its original number — only the currency label changes, nothing is converted.</p>
  </div>`
      : ""
  }

  ${
    signedIn
      ? `
  <div class="eyebrow">Household</div>
  <div class="panel stack">
    <p class="note" style="margin:0">${members.length} member${members.length === 1 ? "" : "s"} in this household.${tenants.length > 1 ? ` You belong to ${tenants.length} households.` : ""}</p>
    <p class="note" style="margin:0">Manage members, invites${tenants.length > 1 ? " and switch households" : ""} from Data &rarr; Household.</p>
  </div>

  <div class="eyebrow">Session</div>
  <div class="panel"><div class="actions">
    <button class="btn ghost" id="profile-signout">Sign out</button>
  </div></div>`
      : ""
  }`;

  $("#profile-currency")?.addEventListener("change", async (e) => {
    const currency = e.target.value;
    await withBusy(`Switching to ${currency}`, async () => {
      await state.store.setCurrency(currency);
      await refresh();
    });
    renderProfile();
  });
  $("#profile-signout")?.addEventListener("click", signOut);
}

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
