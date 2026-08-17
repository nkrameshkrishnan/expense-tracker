/* Server-side validation for every client-supplied write payload.

   Why this exists (finding I5): routes/*.js passed the raw request body
   straight into SQL bind params. A browser is not a trust boundary — the
   frontend's normalise() in assets/store.js runs on the client and anyone
   can POST past it with curl and a valid token. Everything that reaches a
   bind param is validated here first.

   The reference for the rules below is the ORIGINAL project's
   `normalise()` (assets/store.js): amount coerced with
   `Math.abs(Number(x) || 0)` then rounded to cents, `type` forced into a
   known allow-list, `date` truncated to `YYYY-MM-DD`, `category`
   defaulting to "Miscellaneous". This module keeps those semantics so the
   server and the client agree on what a stored row looks like.

   THE POLICY, stated once so it stays consistent across all four route
   modules: coerce where the caller's intent is unambiguous, reject where
   it is not.

     - Coerce: a value that is recoverable to exactly one sensible result.
       A negative amount becomes positive (the domain rule is "amount is a
       magnitude; type/kind/direction carries the sign" — see CLAUDE.md and
       db/schema.sql's comment on transactions.amount). An unknown `type`
       becomes "Expense". A blank category becomes "Miscellaneous". A
       missing optional string becomes "".

     - Reject: a value that could mean several different things, where
       guessing would silently misfile data. A missing or malformed
       required date is the main one — there is no defensible default
       (today? epoch? null?), and every wrong guess files the row into the
       wrong month's budget where nobody will look for it. Likewise a
       non-numeric amount ("abc"), which the client-side reference would
       have silently turned into 0.

   That last point is a deliberate divergence from the reference: `Number(x)
   || 0` is fine in a UI where the user sees the result immediately, but as
   a server-side rule it converts a typo into a permanently stored zero. An
   empty/absent amount still means 0, because "unset" genuinely is
   unambiguous; a garbage amount is an error.

   Validation errors are thrown as ValidationError, which handler.js maps
   to a 400 with the message intact. Every message here is written to be
   shown to a user, so none of them leak internals. */

/** Thrown for bad client input. handler.js turns this into a 400 with the
    message passed through, unlike a generic Error which becomes an opaque
    500 — the distinction matters because these messages are actionable
    ("date is required...") while internal failures must stay silent. */
export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
  }
}

/** Matches the original store.js TYPES. These are structural to the app
    (they drive Income-vs-Expense maths everywhere), not per-household
    vocabulary, so allow-listing them server-side is safe for every tenant. */
export const TYPES = ["Expense", "Income", "Transfer", "Dividends"];

// numeric(12,2) in db/schema.sql: 10 digits before the decimal point.
// Checked here so an oversized amount produces a readable message instead
// of Postgres's opaque "numeric field overflow".
const MAX_AMOUNT = 9999999999.99;

// Generous cap on free-text fields. `text` columns are unbounded in
// Postgres, so nothing here would fail at the database — the cap exists so
// a single request cannot park megabytes in a row. Real descriptions and
// notes are orders of magnitude below this.
const MAX_TEXT = 10000;

/** Money: absolute value, rounded to cents.

    Absolute because amount is a magnitude in this schema — transactions'
    sign comes from `type`, balances' from `kind` (Asset/Liability),
    debts' from `direction` (Owed/Lent). A negative amount stored directly
    would be counted twice-negated by the net-worth maths in app.js. */
export function money(value, field = "amount") {
  if (value === null || value === undefined || value === "") return 0;
  if (typeof value !== "number" && typeof value !== "string")
    throw new ValidationError(`${field} must be a number.`);
  const n = Number(value);
  if (!Number.isFinite(n))
    throw new ValidationError(`${field} must be a number, got "${value}".`);
  const rounded = Math.round(Math.abs(n) * 100) / 100;
  if (rounded > MAX_AMOUNT)
    throw new ValidationError(`${field} is too large.`);
  return rounded;
}

/** `YYYY-MM-DD`, truncated from anything longer (the reference does
    `.slice(0, 10)`, which is what lets a full ISO timestamp through).
    Rejects rather than defaults when required and absent.

    The round-trip check catches dates that match the shape but are not
    real days — "2026-02-31" would otherwise reach Postgres and fail there
    as an opaque 500. */
export function isoDate(value, field = "date", { required = true } = {}) {
  if (value === null || value === undefined || value === "") {
    if (required) throw new ValidationError(`${field} is required.`);
    return null;
  }
  if (typeof value !== "string" && !(value instanceof Date))
    throw new ValidationError(`${field} must be a YYYY-MM-DD string.`);
  const text = (value instanceof Date ? value.toISOString() : value).slice(
    0,
    10,
  );
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text))
    throw new ValidationError(
      `${field} must be a YYYY-MM-DD date, got "${value}".`,
    );
  const [y, m, d] = text.split("-").map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (
    probe.getUTCFullYear() !== y ||
    probe.getUTCMonth() !== m - 1 ||
    probe.getUTCDate() !== d
  )
    throw new ValidationError(`${field} is not a real date: "${text}".`);
  return text;
}

/** Free text. Objects and arrays are rejected rather than stringified —
    `String({})` is "[object Object]", which would store silently. */
export function text(value, field, { fallback = "" } = {}) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "object")
    throw new ValidationError(`${field} must be text.`);
  const s = String(value);
  if (s.length > MAX_TEXT)
    throw new ValidationError(`${field} is too long (max ${MAX_TEXT}).`);
  return s;
}

/** Picks `value` if it is in `allowed`, else falls back — the reference's
    treatment of `type`. Coercion, not rejection: an unrecognised type is
    recoverable (it is an expense until told otherwise) and rejecting would
    break importing a spreadsheet with one stray value in it. */
function oneOf(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

/** Validates a transaction record — handler.js's `payload.record` for the
    `create`, `update` and `bulk` actions. Returns a NEW object containing
    only the columns transactions has, so an attacker-supplied extra key
    (`tenant_id`, `id`) cannot ride along into a bind param. */
export function validateTransaction(record) {
  if (!record || typeof record !== "object" || Array.isArray(record))
    throw new ValidationError("A transaction record is required.");
  return {
    date: isoDate(record.date, "date"),
    type: oneOf(record.type, TYPES, "Expense"),
    // Deliberately NOT allow-listed: users invent their own categories,
    // and forcing an unknown name to Miscellaneous would silently discard
    // it (same reasoning as the reference normalise()).
    category: text(record.category, "category").trim() || "Miscellaneous",
    subcategory: text(record.subcategory, "subcategory"),
    description: text(record.description, "description"),
    amount: money(record.amount, "amount"),
    payment: text(record.payment, "payment"),
    account: text(record.account, "account"),
    recurring: record.recurring === "Yes" ? "Yes" : "No",
    // Free text, NOT allow-listed against the original PEOPLE constant
    // (["Ramesh", "Surya", "Joint"]). That list is one household's
    // vocabulary; this backend is multi-tenant, so hardcoding it
    // server-side would reject every other tenant's real member names.
    person: text(record.person, "person"),
  };
}

/** Validates one balances entry. `account` is `not null` in the schema and
    is half the primary key, so a blank one is rejected rather than
    defaulted — an unnamed balance row cannot be edited or deleted from the
    UI afterwards. */
export function validateBalanceEntry(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry))
    throw new ValidationError("A balance entry is required.");
  const account = text(entry.account, "account").trim();
  if (!account) throw new ValidationError("Each balance needs an account.");
  return {
    account,
    amount: money(entry.amount, "amount"),
    owner: text(entry.owner, "owner"),
    kind: oneOf(entry.kind, ["Asset", "Liability"], "Asset"),
  };
}

/** Validates a debt/payment record. `date` is nullable in db/schema.sql,
    so unlike transactions it is optional here. */
export function validateDebt(record) {
  if (!record || typeof record !== "object" || Array.isArray(record))
    throw new ValidationError("A debt record is required.");
  return {
    kind: oneOf(record.kind, ["Debt", "Payment"], "Debt"),
    name: text(record.name, "name"),
    amount: money(record.amount, "amount"),
    date: isoDate(record.date, "date", { required: false }),
    notes: text(record.notes, "notes"),
  };
}

/** Year for the budget and for GET's ?year=. Bounded because it is written
    into an `int` column and reaches an index; a nonsense year is far more
    likely a bug or a probe than a real intent. */
export function validateYear(value, field = "year") {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1900 || n > 2200)
    throw new ValidationError(`${field} must be a year, got "${value}".`);
  return n;
}
