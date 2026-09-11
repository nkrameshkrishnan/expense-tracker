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

export const TYPES = ["Expense", "Income", "Transfer", "Dividends"];
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

/* Who the money belongs to. 'Joint' is a real third bucket, not a sum of the other
   two — a shared grocery run is Joint, it is not half Ramesh and half Surya.
   Rows imported before this feature existed have no person and read as Unassigned. */
export const PEOPLE = ["Ramesh", "Surya", "Joint"];
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