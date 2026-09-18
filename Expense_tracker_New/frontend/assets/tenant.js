/* Multi-tenant plan metadata and active-tenant/invite-token storage — New-only, no root Ledger equivalent (root is single-household). */

import { state } from "./core.js";

const PLAN_COPY = {
  free: {
    label: "Free",
    blurb: "Track your own spending, no card required.",
  },
  pro: {
    label: "Pro",
    blurb: "Built for two people running one household.",
    recommended: true,
  },
  family: {
    label: "Family",
    blurb: "Room for kids, parents, or a shared place.",
  },
};

/** A plan id's display label/blurb/recommended flag, falling back to
    something generic (rather than refusing to render) for a tier that
    exists server-side but has no entry above yet. */
function planCopy(id) {
  return (
    PLAN_COPY[id] || {
      label: id.charAt(0).toUpperCase() + id.slice(1),
      blurb: "",
      recommended: false,
    }
  );
}

/** Formats a plan's price from state.plans' live Stripe amount (cents) -
    there is no static fallback number any more, since a hardcoded one is
    exactly the kind of duplicate that can silently drift from what Stripe
    actually charges. Free has no Stripe Price at all (nothing to buy), so
    it's always "$0"; a paid plan whose price hasn't resolved (Stripe
    unreachable, a misconfigured id) shows "—" rather than inventing a
    number. */
function formatPlanAmount(p) {
  if (p.id === "free") return "$0";
  if (p.amount == null) return "—";
  const amount = p.amount / 100;
  return `$${Number.isInteger(amount) ? amount : amount.toFixed(2)}`;
}

/** "/mo CAD" - derived from the live Price's currency rather than
    hardcoded per plan, so it can't advertise the wrong currency if a
    deployment is ever priced in something other than CAD. Free has no
    currency (no Stripe Price), so it's just "/mo". */
function formatPlanPeriod(p) {
  return p.currency ? `/mo ${p.currency.toUpperCase()}` : "/mo";
}

/** "2 people" / "Unlimited people" - derived from the enforced seatCap
    rather than hand-authored, so the copy can't say something the backend
    doesn't actually allow. */
function planSeatsLabel(seatCap) {
  if (seatCap === 1) return "1 person";
  if (seatCap === Infinity) return "Unlimited people";
  return `${seatCap} people`;
}

/** Feature bullet list, derived from the enforced FEATURES flags rather
    than hand-authored copy - the bug this closes: hand-authored text
    could keep advertising "Net worth tracking" after a FEATURES flag
    flipped it off server-side, since nothing would ever catch the two
    falling out of sync. */
function planFeatureList(features) {
  const list = [
    features.historyMonths == null
      ? "Full history, every year"
      : `Last ${features.historyMonths} months of history`,
  ];
  if (features.netWorth) list.push("Net worth tracking");
  if (features.aiImport) list.push("AI-powered statement import");
  return list;
}

// Fetched once per session, lazily, the first time either renderPlanGate or
// renderBilling needs it - same "load on first actual use" shape as
// xlsxio.js's lazy SheetJS import, rather than adding a round trip to every
// refresh() when most sessions never look at a plan price at all. A
// rerender callback (rather than returning the data) lets both callers
// pass "render again, now with the plan list" without this function
// needing to know which page is currently showing. DisconnectedStore's
// getPlans() resolves to [] (not a rejection), so a disconnected session
// caches that outcome too instead of retrying on every render - only a
// genuine unexpected error leaves state.plans null to retry next time.
let _plansInFlight = null;
function ensurePlans(onLoaded) {
  if (state.plans) return;
  if (!_plansInFlight) {
    _plansInFlight = state.store
      .getPlans()
      .then((plans) => {
        state.plans = plans;
      })
      .catch(() => {}) // fail open - state.plans stays null, callers show "unavailable"
      .finally(() => {
        _plansInFlight = null;
      });
  }
  _plansInFlight.then(onLoaded);
}

/* Shown once, the first time a brand-new household's owner signs in with no
   plan chosen yet. Keyed by nothing more than "has this browser seen it" -
   this app has exactly one tenant-creation moment per Cognito user (see
   Expense_tracker_New/README.md's "Tenant-switching UI is deferred by
   design"), so there is only ever one owner and one gate to show per
   account; cleared on sign-out so a different person signing in on a
   shared browser still gets asked. */
const PLAN_GATE_SEEN_KEY = "ledger.planGateSeen";
const planGateSeen = () => localStorage.getItem(PLAN_GATE_SEEN_KEY) === "1";
const markPlanGateSeen = () => localStorage.setItem(PLAN_GATE_SEEN_KEY, "1");

/* --------------------------------------------------------- active tenant
   Keyed by email, not a single global key, so switching Google accounts in
   the same browser (a real path: signing out and back in as someone else)
   never resurrects a stale choice made under a different account. */
function activeTenantKey() {
  return `ledger:activeTenant:${state.userEmail || "anon"}`;
}
function getStoredActiveTenant() {
  return localStorage.getItem(activeTenantKey());
}
function setStoredActiveTenant(tenantId) {
  localStorage.setItem(activeTenantKey(), tenantId);
}
function clearStoredActiveTenant() {
  localStorage.removeItem(activeTenantKey());
}

/* An invite token clicked while SIGNED OUT has to survive the round trip
   through Cognito's Hosted UI. cognitoAuthorizeUrl's client_metadata only
   reaches the PostConfirmation trigger, which fires for a brand-new
   Cognito user and nobody else - an existing user simply re-authenticating
   never triggers it - and the redirect back strips the fragment (see
   consumeAuthRedirect) before boot()'s own #invite= check can see it. So
   the token is parked here first and consumed by boot() on the way back.
   sessionStorage, not localStorage: it is scoped to this sign-in attempt
   in this tab, and must not outlive it. */
const PENDING_INVITE_KEY = "ledger.pendingInviteToken";
function getPendingInviteToken() {
  try {
    return sessionStorage.getItem(PENDING_INVITE_KEY) || "";
  } catch {
    return "";
  }
}
function setPendingInviteToken(token) {
  try {
    if (token) sessionStorage.setItem(PENDING_INVITE_KEY, token);
    else sessionStorage.removeItem(PENDING_INVITE_KEY);
  } catch {
    /* a locked-down sessionStorage just means the signed-out invite path
       falls back to doing nothing, exactly as it did before */
  }
}

export {
  planCopy,
  formatPlanAmount,
  formatPlanPeriod,
  planSeatsLabel,
  planFeatureList,
  ensurePlans,
  PLAN_GATE_SEEN_KEY,
  planGateSeen,
  markPlanGateSeen,
  activeTenantKey,
  getStoredActiveTenant,
  setStoredActiveTenant,
  clearStoredActiveTenant,
  getPendingInviteToken,
  setPendingInviteToken,
};
