/* Display preferences: the signed-in person's home/primary currency (used
   to show every CAD total in a currency they chose - see xlsxio.js's
   money()) and their light/dark/system theme. Deliberately a tiny,
   dependency-free module - xlsxio.js's money() needs to read the current
   home currency, and xlsxio.js is imported from all over the app, so this
   file must never import anything that could create a cycle back to it.

   State here is just a cache: the real source of truth is the Supabase
   user_settings table (one row per signed-in email - see
   supabase/schema.sql) for a remote store, or these same localStorage keys
   for local/memory stores, which have no concept of a signed-in account.
   auth.js's boot() populates this cache once at sign-in; Profile's
   Preferences panel updates it immediately after a successful save so the
   whole app reflects a change without a reload. */

const LS_CURRENCY = "ledger.homeCurrency";
const LS_THEME = "ledger.theme";
const LS_ONBOARDED = "ledger.onboarded";

const state = {
  homeCurrency: localStorage.getItem(LS_CURRENCY) || "CAD",
  theme: localStorage.getItem(LS_THEME) || "system",
  // CAD-per-unit, latest known rate for each non-CAD currency - see
  // setDisplayRate()/auth.js boot(). Empty until a remote store actually
  // looks one up; money() falls back to plain CAD when a rate is missing
  // rather than converting by a guess.
  rates: {},
};

export const CURRENCY_LABEL = {
  CAD: "Canadian Dollar",
  INR: "Indian Rupee",
  AED: "UAE Dirham",
};
export const CURRENCY_SYMBOL = { CAD: "$", INR: "₹", AED: "AED " };

export const getHomeCurrency = () => state.homeCurrency;
export const getTheme = () => state.theme;
export const getDisplayRate = (code) => state.rates[code];

export function setHomeCurrency(code) {
  state.homeCurrency = code;
  try {
    localStorage.setItem(LS_CURRENCY, code);
  } catch {}
}

export function setDisplayRate(code, rateToCad) {
  if (code && rateToCad) state.rates[code] = rateToCad;
}

/** Whether this browser/account has ever finished the first-run currency +
    appearance step - see renderOnboarding() in pages/onboarding.js and
    boot() in auth.js, which both use this (for local/memory stores only;
    a Supabase store asks user_settings instead, since onboarding is tied
    to the ACCOUNT there, not the browser). */
export const hasOnboarded = () => localStorage.getItem(LS_ONBOARDED) === "1";
export function markOnboarded() {
  try {
    localStorage.setItem(LS_ONBOARDED, "1");
  } catch {}
}

let mql = null;
/** Resolves the current theme preference to a concrete "light"/"dark" and
    writes it onto <html data-theme="...">, which is all the CSS in
    styles.css actually looks at (see the :root[data-theme="dark"] block) -
    "system" is resolved here, once, rather than ever reaching CSS as a
    prefers-color-scheme query, so a manual Light/Dark choice always wins
    over whatever the OS is set to. */
export function applyTheme() {
  const resolved =
    state.theme === "system"
      ? (mql ||= matchMedia("(prefers-color-scheme: dark)")).matches
        ? "dark"
        : "light"
      : state.theme;
  document.documentElement.setAttribute("data-theme", resolved);
}

export function setTheme(theme) {
  state.theme = theme;
  try {
    localStorage.setItem(LS_THEME, theme);
  } catch {}
  applyTheme();
}

// Applied immediately on module load (before any sign-in), so a returning
// visitor's last choice - or the OS's current light/dark setting, for
// "system" - is in effect from the very first paint, landing page included.
applyTheme();
if (typeof matchMedia === "function") {
  (mql ||= matchMedia("(prefers-color-scheme: dark)")).addEventListener?.(
    "change",
    () => {
      if (state.theme === "system") applyTheme();
    },
  );
}
