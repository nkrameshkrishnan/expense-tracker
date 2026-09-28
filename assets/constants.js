/* Static enums and lookup constants: categories, payment methods, accounts,
   months, people, net-worth account list, and the localStorage keys for
   user-defined dropdown options. Pure data, zero dependencies. */

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

export const TYPES = ["Expense", "Income", "Transfer", "Dividends", "Refund"];

/* Currencies a transaction or balance can be recorded in. CAD is the home
   currency - every dashboard, budget and net-worth total is expressed in it.
   INR/AED rows keep their own native amount (never converted in place) plus
   an fx_rate - see amountCad() below, and assets/dedupe.js's compatible()
   check, which must never match a CAD row against an INR/AED row of the same
   numeric amount. Extending this list is a schema change too - see
   supabase/schema.sql's currency check constraints on transactions/balances,
   and exchange_rates' own currency check (which excludes CAD - see there). */
export const CURRENCIES = ["CAD", "INR", "AED"];
// The subset that actually needs a looked-up rate. CAD's rate is always
// exactly 1, so it's never fetched or stored in exchange_rates.
export const FX_CURRENCIES = CURRENCIES.filter((c) => c !== "CAD");

/** The CAD value of a native amount, given the row's own fx_rate (1 for a
    CAD row - a no-op multiply). `amount`/`balance` themselves are NEVER
    converted in place; this is the one place that conversion happens, and
    every total in the app (spendOf below, Dashboard, Budget, Net Worth,
    xlsxio's report aggregation) is built by summing this, never the raw
    field, so a rupee and a dollar are never added together as if they were
    the same unit. Rounded to cents, same precision the fields themselves are
    stored at. */
export const toCad = (nativeAmount, fxRate) =>
  Math.round((Number(nativeAmount) || 0) * (Number(fxRate) || 1) * 100) / 100;

/** The CAD-equivalent of a transaction row's own amount/fx_rate. */
export const amountCad = (r) => toCad(r.amount, r.fx_rate);

/** The CAD-equivalent of a net-worth balance row's own balance/fx_rate. */
export const balanceCad = (b) => toCad(b.balance, b.fx_rate);

/** How much a row adds to spending, in CAD. A Refund is money back on an
    earlier purchase: it keeps that purchase's category (a returned item
    under Shopping, points applied to a flight under Travel) and is
    subtracted from it, so category and total spend show what was actually
    paid. Amounts are always stored positive - the type carries the sign.
    Every other type (Income, Transfer, Dividends) is not spending and
    contributes 0. A booking cancelled in full is NOT a Refund: the charge
    and the refund are both recorded as Transfers so neither month is
    inflated or driven negative. Goes through amountCad, not raw r.amount,
    so a Refund on an INR purchase nets against that purchase's CAD value,
    not its rupee face value. */
export const spendOf = (r) =>
  r.type === "Expense" ? amountCad(r) : r.type === "Refund" ? -amountCad(r) : 0;
export const PAYMENTS = [
  "Credit Card",
  "Debit Card",
  "Cash",
  "e-Transfer",
  "Pre-authorized Debit",
  "Other",
];
export const ACCOUNTS = [
  "CIBC Chequing",
  "WealthSimple Chequing",
  "Savings",
  "Visa",
  "Mastercard",
  "Amex",
  "WealthSimple TFSA",
  "WealthSimple RRSP",
  "WealthSimple Non-registered",
  "Cash Wallet",
];
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

/* Who the money belongs to. 'Family' is a real third bucket, not a sum of the
   other two — a shared grocery run is Family, it is not half Ramesh and half
   Surya. Rows imported before this feature existed have no person and read
   as Unassigned. */
export const PEOPLE = ["Family", "Ramesh", "Surya"];
export const UNASSIGNED = "Unassigned";
export const PERSON_KEY = "ledger.person";

/* Accounts tracked for net worth. Some exist only as balances and never appear
   in transactions (a GIC, a savings account that sat at zero all year), so this
   is deliberately a superset of ACCOUNTS rather than derived from it. */
export const NET_WORTH_ACCOUNTS = [
  { account: "CIBC Chequing", owner: "Ramesh", kind: "Asset" },
  { account: "CIBC TFSA (Investment)", owner: "Ramesh", kind: "Asset" },
  { account: "WealthSimple Chequing", owner: "Ramesh", kind: "Asset" },
  { account: "WealthSimple TFSA", owner: "Ramesh", kind: "Asset" },
  { account: "WealthSimple RRSP", owner: "Ramesh", kind: "Asset" },
  { account: "WealthSimple Non-registered", owner: "Ramesh", kind: "Asset" },
  { account: "CIBC Visa", owner: "Ramesh", kind: "Liability" },
  { account: "CIBC Mastercard", owner: "Ramesh", kind: "Liability" },
  { account: "Amex (Ramesh)", owner: "Ramesh", kind: "Liability" },
  { account: "CIBC Chequing (Surya)", owner: "Surya", kind: "Asset" },
  { account: "CIBC Savings (Surya)", owner: "Surya", kind: "Asset" },
  { account: "CIBC TFSA (Surya)", owner: "Surya", kind: "Asset" },
  { account: "CIBC TFSA GIC (Surya)", owner: "Surya", kind: "Asset" },
  { account: "WealthSimple Chequing (Surya)", owner: "Surya", kind: "Asset" },
  { account: "WealthSimple TFSA (Surya)", owner: "Surya", kind: "Asset" },
  { account: "WealthSimple RRSP (Surya)", owner: "Surya", kind: "Asset" },
  {
    account: "WealthSimple Non-registered (Surya)",
    owner: "Surya",
    kind: "Asset",
  },
  { account: "Amex (Surya)", owner: "Surya", kind: "Liability" },
];

export const CUSTOM_KEY = "ledger.customLists";
