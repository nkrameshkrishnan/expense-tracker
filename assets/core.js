/* Shared app-wide infrastructure: DOM helpers, the single `state` object,
   the busy/notice banner, and refresh() (reloads state.rows/budget/etc from
   the store). Every page module and auth.js imports from here.

   core.js <-> router.js and core.js <-> auth.js are both genuinely circular
   (renderPeopleSwitch()'s click handler calls go(), withBusy()'s catch calls
   showGate(), refresh() wires up signOut() and reads isRemoteStore()) - ES
   modules support this correctly as long as the imported binding is only
   used INSIDE a function body (deferred until call time), never read at
   module top-level, which is the case for every one of these. Verified this
   actually initializes cleanly via a real import() resolution, not just
   reasoned about. */
import {
  emptyBudget,
  currentYear,
  PERSON_KEY,
  PEOPLE,
  UNASSIGNED,
  getIdToken,
  setIdToken,
  setNonce,
} from "./store.js";
import { byPersonFilter } from "./xlsxio.js";
import { go } from "./router.js";
import { showGate, signOut, isRemoteStore } from "./auth.js";

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
  // The "Category spend by month" panel has its own year/month-filter
  // controls, independent of the Dashboard's year/period selector above it -
  // so switching that to review, say, 2024 doesn't yank this chart off the
  // current year too. Defaults to the real current year/month, not whatever
  // state.year/state.month happen to be set to.
  catMonthYear: currentYear(),
  // Defaults to "All months" (0), not the current calendar month - a full
  // year's shape is the more useful first thing to see; filtering down to
  // one month is something you opt into from the dropdown.
  catMonthHighlight: 0,
  catMonthOrientation: "horizontal",
};

export const scoped = () => byPersonFilter(state.rows, state.person);
export const personLabel = () => state.person || "Family";

/** Segmented control in the header rail. Present on every tab, so the choice
    follows you between Dashboard, Transactions, Add and Budget. */
export function renderPeopleSwitch() {
  const el = $("#people");
  if (!el) return;
  const present = new Set(state.rows.map((r) => r.person || UNASSIGNED));
  const opts = ["", ...PEOPLE.filter((p) => present.has(p))];
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

let busy = false;
/** Wraps a write so the UI cannot fire two overlapping store writes. */
export async function withBusy(label, fn) {
  if (busy) {
    notice("Another change is still saving — one at a time.", "bad");
    return false;
  }
  busy = true;
  document.body.style.cursor = "progress";
  notice(label + "\u2026");
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
      setNonce("");
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

export async function refresh() {
  state.rows = await state.store.list();
  state.budget = await state.store.getBudget(state.year);
  state.balances = (await state.store.getBalances?.()) || [];
  state.debts = (await state.store.getDebts?.()) || [];
  $("#foot-count").textContent = `${state.rows.length} transactions stored`;
  renderPeopleSwitch();
  const c = $("#conn");
  const label = {
    supabase: "\u25cf supabase",
    local: "\u25cf browser only",
    memory: "\u25cf session only",
  };
  const who = state.store.user?.email
    ? ` \u00b7 ${state.store.user.email.split("@")[0]}`
    : "";
  c.innerHTML =
    (label[state.store.kind] || "\u25cf ?") +
    esc(who) +
    (getIdToken()
      ? ' <button class="signout-btn" id="signout">sign out</button>'
      : "");
  $("#signout")?.addEventListener("click", signOut);
  c.title =
    state.store.kind === "supabase"
      ? "Reading and writing your Supabase project live"
      : "Not connected to Supabase — changes stay in this browser";
  c.className = "conn" + (isRemoteStore(state.store) ? " remote" : "");
}

/** Shared KPI-card markup. Used by both Dashboard and Net worth. */
export const kpi = (k, v, m = "", cls = "", key = "") =>
  `<div class="kpi ${cls}"${key ? ` id="kpi-${key}"` : ""}><div class="k">${k}</div><div class="v"${key ? ` id="kpi-${key}-v"` : ""}>${v}</div><div class="m"${key ? ` id="kpi-${key}-m"` : ""}>${esc(m)}</div></div>`;
