/* Static lists, formatting helpers, and color-index helpers shared across every page. */

export function currentYear() {
  return new Date().getFullYear();
}

export const CATEGORIES = [
  ["Salary", "Income"],
  ["Dividends", "Income"],
  ["Other Income", "Income"],
  ["Rent / Housing", "Expense"],
  ["Groceries", "Expense"],
  ["Utilities", "Expense"],
  ["Internet & Phone", "Expense"],
  ["Transport", "Expense"],
  ["Gas", "Expense"],
  ["Dining Out", "Expense"],
  ["Health & Fitness", "Expense"],
  ["Insurance", "Expense"],
  ["Shopping", "Expense"],
  ["Entertainment", "Expense"],
  ["Subscriptions", "Expense"],
  ["Travel", "Expense"],
  ["Education", "Expense"],
  ["Gifts & Donations", "Expense"],
  ["Personal Care", "Expense"],
  ["Savings & Investments", "Expense"],
  ["Miscellaneous", "Expense"],
];
export const CAT_NAMES = CATEGORIES.map((c) => c[0]);
export const EXPENSE_CATS = CATEGORIES.filter((c) => c[1] === "Expense").map(
  (c) => c[0],
);
export const CAT_TYPE = Object.fromEntries(CATEGORIES);

export const TYPES = ["Expense", "Income", "Transfer", "Dividends"];
// Must match backend/src/routes/tenants.js's CURRENCIES exactly - the
// backend is the source of truth for what it accepts; this list is what
// the Profile picker offers. Keep both in sync by hand if this ever grows.
export const CURRENCIES = ["CAD", "USD", "EUR", "GBP", "INR", "AUD"];
export const PAYMENTS = [
  "Credit Card",
  "Debit Card",
  "Cash",
  "e-Transfer",
  "Pre-authorized Debit",
  "Other",
];
// Generic account-type labels, not any real bank/brokerage's names - this
// app is multi-tenant (see NET_WORTH_ACCOUNTS/BUILTIN.person above), so a
// built-in default list is every new tenant's starting point, not one
// household's actual accounts. Real, specific accounts come from what a
// tenant adds via "+ New" (see app.js's addCustom/listFor).
export const ACCOUNTS = ["Checking", "Savings", "Credit Card", "Cash"];
export const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

export const UNASSIGNED = "Unassigned";
export const PERSON_KEY = "ledger.person";

// No fixed PEOPLE list, unlike the original single-household project this
// was adapted from: this backend is multi-tenant (see validate.js's own
// "person: text(...)" comment, which already treats it as free text
// server-side), so hardcoding a household's real member names here would
// mean every OTHER tenant's household sees someone else's names as their
// only options - and normalise() below would silently discard any person
// name that isn't in the list, which is exactly what happened before this
// was fixed. person is now a listFor()-managed field like category/payment/
// account (see app.js's BUILTIN), seeded with nothing built-in.

// No hardcoded starter accounts either, for the same reason - a brand-new
// tenant starts with zero net-worth accounts and adds their own (the "+
// New" flow already exists for this); showing every signup someone else's
// real-looking bank/brokerage accounts was never correct for a SaaS
// product, even as a demo.
export const NET_WORTH_ACCOUNTS = [];

export const CUSTOM_KEY = "ledger.customLists";

// The tenant's chosen display currency, set once per refresh() (see
// app.js) and read by formatMoney below - not React/observable state,
// just a module-level value every formatter call reads fresh, the same
// "shared singleton other modules import" shape as CAT_NAMES/ACCOUNTS
// above. No currency conversion anywhere (see this feature's spec) - this
// only changes how already-stored numbers are formatted.
let _currency = "CAD";
export function setCurrency(code) {
  _currency = code;
}
export function currentCurrency() {
  return _currency;
}

/** Formats `n` as money in the tenant's current currency - symbol,
    decimal places, and placement all come from Intl.NumberFormat's own
    knowledge of the currency code, not a hand-maintained per-currency
    table. */
export function formatMoney(n) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: _currency,
    currencyDisplay: "narrowSymbol",
  }).format(n);
}

// Deterministic person -> palette-index mapping, so the same name always
// gets the same colour across swatches/chips/charts without this app
// needing to know a tenant's household member names in advance. Kept here
// (not in app.js/charts.js) so both modules derive the same colour for the
// same name from one definition. "Unassigned" is handled by each caller as
// an explicit, separate case - it is a state, not a person, and must not
// collide with a real name's colour.
export const PERSON_PALETTE_SIZE = 5;
export function personColorIndex(name) {
  const s = String(name || "");
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % PERSON_PALETTE_SIZE;
}

export const CATEGORY_PALETTE_SIZE = 12;
export function categoryColorIndex(name) {
  const s = String(name || "");
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % CATEGORY_PALETTE_SIZE;
}
