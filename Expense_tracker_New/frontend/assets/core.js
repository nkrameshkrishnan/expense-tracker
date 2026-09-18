/* Shared app-wide infrastructure: DOM helpers, the single `state` object,
   the busy/notice banner, refresh() (reloads state.rows/budget/etc from the
   store), and switchActiveTenant() (multi-tenant household switch).

   core.js <-> tenant.js, core.js <-> router.js, and core.js <-> auth.js are
   all genuinely circular (renderPeopleSwitch()'s click handler calls go(),
   switchActiveTenant() reads VIEWS and calls tenant.js's
   getStoredActiveTenant()/setStoredActiveTenant()/clearStoredActiveTenant(),
   withBusy()'s catch calls showGate(), refresh() wires up signOut() and
   reads isRemoteStore() and clearStoredActiveTenant()/
   getStoredActiveTenant()) - plus switchActiveTenant()'s renderDashboard()
   fallback, which forward-references pages/dashboard.js the same way. ES
   modules support this correctly as long as the imported binding is only
   used INSIDE a function body (deferred until call time), never read at
   module top-level, which is the case for every one of these. This mirrors
   root's own core.js <-> router.js / core.js <-> auth.js pattern (see
   assets/core.js:1-12) with tenant.js and pages/dashboard.js added for
   New's multi-tenant switcher; actual import resolution can only be
   confirmed once tenant.js (Task 4), auth.js (Task 6), pages/dashboard.js
   (Task 8), and router.js (Task 19) all land. */
import {
  emptyBudget,
  UNASSIGNED,
  PERSON_KEY,
  currentYear,
  getIdToken,
  setIdToken,
  setCurrency as setCurrentCurrency,
} from "./store.js";
import {
  getStoredActiveTenant,
  setStoredActiveTenant,
  clearStoredActiveTenant,
} from "./tenant.js";
import { go, VIEWS } from "./router.js";
import { showGate, signOut, isRemoteStore } from "./auth.js";
import { renderDashboard } from "./pages/dashboard.js";

export const $ = (s) => document.querySelector(s);
export const view = $("#view");
export const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

export const YEAR_KEY = "ledger.year";
export const state = {
  store: null,
  rows: [],
  budget: emptyBudget(),
  month: 0,
  tab: "dashboard",
  editing: null,
  person: localStorage.getItem(PERSON_KEY) || "", // '' = whole family
  // Which year's Dashboard/Budget you're viewing - independent of what
  // calendar year it actually is right now, so past years stay browsable.
  // Defaults to the real current year, not a value fixed at build time.
  year: Number(localStorage.getItem(YEAR_KEY)) || currentYear(),
  balances: [],
  debts: [],
  filter: { q: "", cat: "", month: "", type: "" },
  // The full plan list, fetched lazily once (see ensurePlans) - null until
  // then. backend/src/routes/billing.js's getPlans is the only place this
  // app learns which tiers exist, what they cost, and what they enforce;
  // see PLAN_COPY below for the one thing that still lives client-side.
  // Never invalidated: tiers essentially never change mid-session, and a
  // reload naturally clears this.
  plans: null,
};

/** Segmented control in the header rail. Present on every tab, so the choice
    follows you between Dashboard, Transactions, Add and Budget. */
export function renderPeopleSwitch() {
  const el = $("#people");
  if (!el) return;
  const present = new Set(state.rows.map((r) => r.person || UNASSIGNED));
  const known = [...present]
    .filter((p) => p !== UNASSIGNED)
    .sort((a, b) => a.localeCompare(b));
  const opts = ["", ...known];
  if (present.has(UNASSIGNED)) opts.push(UNASSIGNED);
  el.innerHTML = opts
    .map((p) => {
      const label = p === "" ? "Family" : p === UNASSIGNED ? "Unassigned" : p;
      return `<button class="person-btn${state.person === p ? " on" : ""}" data-person="${esc(p)}">${esc(label)}</button>`;
    })
    .join("");
  el.querySelectorAll(".person-btn").forEach(
    (b) =>
      (b.onclick = () => {
        state.person = b.dataset.person;
        localStorage.setItem(PERSON_KEY, state.person);
        go(state.tab);
      }),
  );
}

/** Cosmetic only - the server already returns an empty balances array for
    Free-tier tenants (getBalances, Task 6) regardless of what this does, so
    a stale label here after a plan change (before the next refresh()) is
    harmless. Locks the nav button rather than removing it outright, so a
    Free-tier user sees WHY the tab is unavailable instead of it just
    vanishing. */
export function updateNetWorthGate() {
  const btn = document.querySelector('#tabs button[data-tab="networth"]');
  if (!btn) return;
  const locked = state.tenant?.plan === "free";
  btn.disabled = locked;
  btn.textContent = locked ? "\u{1F512} Net worth" : "Net worth";
  btn.title = locked ? "Upgrade to unlock Net worth" : "";
  btn.style.opacity = locked ? "0.5" : "";
  btn.style.cursor = locked ? "not-allowed" : "";
}

let busy = false;
/** Wraps a write so the UI cannot fire two overlapping sheet writes. */
export async function withBusy(label, fn) {
  if (busy) {
    notice("Another change is still saving — one at a time.", "bad");
    return false;
  }
  busy = true;
  document.body.style.cursor = "progress";
  notice(label + "…");
  try {
    await fn();
    return true;
  } catch (e) {
    // A Google sign-in can expire mid-session (roughly hourly). Previously
    // every action here just showed a red banner and left the page sitting
    // in a half-authenticated state with no way forward. Route auth failures
    // to the same re-sign-in screen the app uses on first load, instead.
    if (e?.auth) {
      setIdToken("");
      showGate(e.message);
      return false;
    }
    notice(`${label} failed: ${e.message}`, "bad");
    return false;
  } finally {
    busy = false;
    document.body.style.cursor = "";
  }
}

/** action, when given, is {label, onClick} - rendered as a real button after
    the (still escaped, still safe) message text. Not exposed to raw HTML
    injection from msg itself; the button only ever comes from a caller
    passing a hardcoded label/callback, never from untrusted data. */
export function notice(msg, kind = "", action = null) {
  const b = $("#banner");
  b.className = "banner " + kind;
  b.innerHTML =
    esc(msg) +
    (action
      ? ` <button class="banner-action" id="banner-action-btn">${esc(action.label)}</button>`
      : "");
  b.hidden = false;
  if (action) $("#banner-action-btn").onclick = action.onClick;
  if (kind === "ok" && !action)
    setTimeout(() => {
      b.hidden = true;
    }, 4000);
}

/** `reentered` is set only by refresh's own re-entrant call below - every
    other caller invokes refresh() with no arguments. */
export async function refresh(reentered = false) {
  // Which tenant the fetches below are actually scoped to, captured BEFORE
  // any request goes out. On a fresh page load this is null (no header, so
  // the server uses the JWT's default tenant) - which is precisely why the
  // stored preference has to be compared against it once the data is back,
  // rather than merely applied to future requests.
  const fetchedAs = state.store.getActiveTenant?.() ?? null;
  // Let store.js tell us when the server rejects the active tenant because
  // the membership is gone, so the persisted choice goes with it instead
  // of being re-applied on the next load. Assigning on every refresh keeps
  // it attached across the store being replaced (Connect & test, Retry).
  if (state.store.kind === "api")
    state.store.onActiveTenantRejected = clearStoredActiveTenant;
  state.rows = await state.store.list();
  state.budget = await state.store.getBudget(state.year);
  state.balances = (await state.store.getBalances?.()) || [];
  state.debts = (await state.store.getDebts?.()) || [];
  state.members = (await state.store.getMembers?.()) || [];
  state.invites = (await state.store.getInvites?.()) || [];
  state.role = (await state.store.getRole?.()) || "member";
  state.tenant = (await state.store.getTenant?.()) || {
    plan: "free",
    status: "active",
  };
  setCurrentCurrency(state.tenant.currency || "CAD");
  const headerCurrency = $("#header-currency");
  if (headerCurrency)
    headerCurrency.textContent = `· ${state.tenant.currency || "CAD"}`;
  state.userEmail = (await state.store.getUserEmail?.()) || null;
  state.tenants = (await state.store.getMyTenants?.()) || [];
  // Resolve which tenant this session is actively scoped to. "Never set"
  // or a stored id for a tenant this account no longer belongs to both
  // fall through to null - no X-Active-Tenant header at all, so auth.js
  // falls back to the JWT's own default tenant, exactly as it already does
  // for every existing single-tenant user today. The stored id can only be
  // validated here, after getMyTenants() has answered, which is why this
  // resolution cannot happen before the fetch above.
  const storedTenant = getStoredActiveTenant();
  const validStoredTenant = state.tenants.some(
    (t) => t.tenant_id === storedTenant,
  );
  const desiredTenant = validStoredTenant ? storedTenant : null;
  // Everything above was fetched as `fetchedAs`. If that is not the tenant
  // this session is supposed to be showing, the data on hand belongs to
  // the wrong household: point the store at the right one, throw the cache
  // away, and do the whole pass again. Applying the choice without
  // re-fetching (what this used to do) left the UI rendering tenant A
  // while the switcher said B and every later request went out as B -
  // whose rows then merged into A's cached ones inside _fill().
  //
  // Terminates: the second pass starts with fetchedAs === desiredTenant
  // (nothing else writes the store's active tenant or the stored key in
  // between), so the branch is not taken again. `reentered` is a hard stop
  // regardless - one extra pass, never a loop.
  if (desiredTenant !== fetchedAs) {
    state.store.setActiveTenant?.(desiredTenant);
    state.store.resetCache?.();
    if (!reentered) return refresh(true);
  }
  $("#foot-count").textContent = `${state.rows.length} transactions stored`;
  renderPeopleSwitch();
  updateNetWorthGate();
  const c = $("#conn");
  const label = {
    api: "● ledger api",
    disconnected: "● not connected",
  };
  const who = state.store.user?.email
    ? ` · ${state.store.user.email.split("@")[0]}`
    : "";
  c.innerHTML =
    (label[state.store.kind] || "● ?") +
    esc(who) +
    (getIdToken()
      ? ' <button class="signout-btn" id="signout">sign out</button>'
      : "");
  $("#signout")?.addEventListener("click", signOut);
  c.title =
    state.store.kind === "api"
      ? "Reading and writing your Ledger account live"
      : "Not connected to your Ledger account — reconnect to load or save data";
  c.className = "conn" + (isRemoteStore(state.store) ? " remote" : "");
}

/** Household panel's switcher (Data tab) calls this. Persists the choice,
    points the store at the new tenant, and only THEN clears its cache and
    reloads - resetCache() before refresh() means the very next request goes
    out already scoped to the new tenant, so nothing in between can render a
    frame of the previous tenant's stale data. */
export async function switchActiveTenant(tenantId) {
  // Both writes below are optimistic - they happen before the refresh that
  // can fail. Capture what they replace so a failure can put it back: a
  // rejected id left sitting in localStorage is now applied to the very
  // FIRST request of the next page load (refresh() resolves it up front),
  // so leaving it there would carry a failed switch into every future
  // session rather than being washed away by the next reload.
  const prevStored = getStoredActiveTenant();
  const prevActive = state.store.getActiveTenant?.() ?? null;
  setStoredActiveTenant(tenantId);
  state.store.setActiveTenant?.(tenantId);
  const done = await withBusy("Switching household", async () => {
    state.store.resetCache?.();
    await refresh();
    state.rows = await state.store.list();
  });
  if (done) {
    (VIEWS[state.tab] || renderDashboard)();
    return;
  }
  if (prevStored) setStoredActiveTenant(prevStored);
  else clearStoredActiveTenant();
  state.store.setActiveTenant?.(prevActive);
  // Whatever the failed attempt did or did not manage to load is not the
  // tenant being rolled back to - make the next request fetch afresh.
  state.store.resetCache?.();
}
