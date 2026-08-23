# AI Transaction Import (CSV/PDF) — Design Spec

**Status:** Approved by user, ready for implementation planning.

## Goal

Let a user upload a CSV or PDF that isn't in this app's own exact export
format — most realistically, a real bank or credit-card statement — and
have the backend use an LLM to read it, map it into this app's transaction
model (`date/type/category/subcategory/description/amount/payment/
account/person`), and hand back a reviewable list the user can selectively
import, rather than requiring the file to already match a known column
layout the way the existing importer does.

## Background

`frontend/assets/xlsxio.js`'s `importFile()` is the only import path today.
It is a fixed header-alias matcher (`HEADER_ALIASES`): it scores each
sheet's first 8 rows against a hardcoded list of recognized column names
(`date`, `amount`, `debit`, `category`, …) and only proceeds if it finds a
row with both a Date and an Amount column. It cannot read PDFs at all (it
loads a file straight into SheetJS), and it has no concept of inferring
anything — a "Credit"/"Debit" column value is taken as a literal `type`
string, never reinterpreted against this app's actual `TYPES = ["Expense",
"Income", "Transfer", "Dividends"]` taxonomy, and no category is ever
guessed from a description.

That mismatch is the real product gap this spec closes: a genuine bank
export or a statement PDF doesn't speak this app's vocabulary, and no
amount of smarter alias-matching changes that — it needs something that
can read a merchant description and a signed/columned amount and decide
"this is a $12.40 Dining Out expense," the way a person skimming their
own statement would.

## Non-goals

- **Replacing the existing manual-format import.** `importFile()` stays
  exactly as it is, for users whose file already matches a known layout —
  free, instant, no LLM call, no cap. This feature is additive: a second,
  separate upload control on the Data tab.
- **Receipts, invoices, or any single-transaction document.** In scope
  only: a statement-shaped document where one file produces many
  transaction rows. A receipt/invoice ("one PDF → one transaction") needs
  a different extraction shape and a different review UI; explicitly out
  of scope for this spec (see the brainstorming transcript this spec was
  written from).
- **Currency conversion.** The transaction schema
  (`db/schema.sql`'s `transactions` table) has no currency column today,
  and this feature doesn't add one — an extracted amount is taken as-is,
  the same way the existing manual import already behaves for a non-CAD
  file. A household with foreign-currency statements gets the same
  (non-)handling they'd get importing that file manually today.
- **Inline editing of extracted rows.** The review table is select/deselect
  only (see Frontend section). Anything the model got wrong is corrected
  through the existing Transactions tab edit flow after import, not a new
  in-review editing UI.
- **Async/job-queue processing.** Every request in this app today is
  synchronous, request-in/response-out; this feature keeps that shape
  (see Architecture §2) rather than introducing the first background-job
  pattern into the codebase.
- **Tier-scaled caps.** Pro and Family share one `AI_IMPORT_MONTHLY_CAP`
  value. Differentiating the cap by tier is a reasonable future
  refinement, not a v1 requirement.

## Architecture

### 1. New, dedicated Lambda (`ExtractFunction`), not a `DataFunction` action

Every other write/read action in this app is dispatched through
`handler.js`'s `action` switch on the single `DataFunction` Lambda, backed
by the shared `Globals.Function.Timeout: 10` in `template.yaml`. This
feature gets its own function instead, for two concrete reasons:

- **Timeout.** A Bedrock call over a multi-page PDF can reasonably take
  10–20+ seconds. Raising the *global* Lambda timeout to accommodate that
  would apply to every action in the app, including the ones that are
  supposed to fail fast. `ExtractFunction` gets its own `Timeout: 25`
  (see §5 for why 25, not higher).
- **Blast radius / cold start.** The Bedrock SDK and this feature's own
  logic have no business living in `DataFunction`'s bundle, which is the
  hottest, most frequently invoked path in the app. Keeping this isolated
  means a bug or a slow dependency here can't affect the transaction CRUD
  path at all.

New file `backend/src/extract.js`, same shape as `stripeWebhook.js`/
`postConfirmation.js` (a standalone handler, not a `routes/*.js` module
called from `handler.js`). It imports `requireUser`/`AuthError` from
`./auth.js` directly — no duplication of the JWT-verification logic, same
CORS handling (`CORS_HEADERS`, `OPTIONS` short-circuit) copied from
`handler.js`'s own pattern since there's no shared module for that today.

### 2. Synchronous request/response, with a hard page-count cap

API Gateway HTTP API enforces a **29-second integration timeout**
regardless of what the Lambda's own timeout is set to — this is a hard
platform ceiling, not configurable. `ExtractFunction`'s own timeout is set
to 25s (under that ceiling, so a Lambda-side timeout produces a clean
error instead of API Gateway's own opaque 504). To keep real-world
requests comfortably inside that window, the request is rejected
up front — before calling Bedrock — if the PDF has more than **10 pages**
(a typical single-month statement fits well inside that; the error message
tells the user to split multi-month statements). CSV has no equivalent
limit beyond the existing file-size cap below, since text-only prompts are
fast regardless of row count within reason.

No job table, no polling endpoint, no async Lambda invocation — the
frontend makes one request and waits, same as every other action in this
app.

### 3. Bedrock integration

`ExtractFunction` calls Bedrock's Converse API with:

- **System/user prompt** containing the real category list and an explicit
  explanation of the `Expense/Income/Transfer/Dividends` + always-positive-
  amount convention, so the model maps a statement's own Credit/Debit
  language into *this app's* model rather than echoing it back verbatim.
  The category list itself is **supplied by the frontend in the request**
  (`categoryNames`, the same `CAT_NAMES` array `store.js` already exports),
  not a second copy hardcoded on the backend — categories in this app are
  user-owned, inventable vocabulary (`validate.js`'s `validateTransaction`
  deliberately does not allow-list them, unlike the fixed plan tiers), so
  the backend treats the list as request input to validate the model's
  output against, not something it owns a canonical copy of. `type` *is*
  allow-listed against `validate.js`'s existing `TYPES` constant, which
  already is backend-owned structural data.
- **CSV**: the raw file text, inline in the prompt (small enough that a
  `document` content block isn't needed).
- **PDF**: the base64 file bytes as a `document` content block. Bedrock's
  newer Claude models can read PDF pages as images as well as extract
  embedded text, which should cover a scanned/image-only statement too —
  **flagged as an assumption to verify against a real scanned PDF at
  implementation time**, the same way this codebase already flags its two
  MUST-VERIFY Cognito assumptions in `README.md` rather than asserting
  confidently and finding out in production.
- **Structured output**: Bedrock's tool-use / constrained-JSON mode, not
  free-text parsing of the model's response. The tool schema mirrors the
  transaction fields exactly (`date`, `type`, `category`, `subcategory`,
  `description`, `amount`, `payment`, `account`), plus a per-row
  `confidence: "high" | "low"` the frontend uses to flag uncertain rows.
- **Model id** is a new template parameter (`BedrockModelId`), not
  hardcoded — model availability varies by region and changes over time,
  and this keeps that a deploy-time concern like every other Stripe/SES
  value already is.

A response that fails schema validation (missing required fields, an
`amount` that isn't a number, a `category` outside the real list) is
treated as an extraction failure for that row — the row is dropped and
counted in a `skipped` total returned to the frontend, not silently
coerced into something that might be wrong twice over.

The extraction schema does **not** include `person`, `recurring`, or
`notes` — nothing in a bank statement identifies which household member a
transaction belongs to, or marks it as recurring. Every imported row lands
with `person` unset, same as the existing precedent for rows that arrive
with no person info (`CLAUDE.md`: "rows without it are treated as
Unassigned"), and `recurring`/`notes` blank. All three are editable
afterward through the normal Transactions edit flow, same as any other
imported row.

### 4. New route

`POST /extract` on the existing `HttpApi` (adds an `Events` entry to
`ExtractFunction`, same `ApiId: !Ref HttpApi` every other function uses —
this automatically inherits the existing `CorsConfiguration`, no new CORS
setup needed). Request body:

```json
{
  "fileName": "statement.pdf",
  "fileType": "csv" | "pdf",
  "fileBase64": "...",
  "categoryNames": ["Salary", "Rent / Housing", "Groceries", "..."]
}
```

Success response:

```json
{
  "ok": true,
  "transactions": [
    { "date": "2026-08-03", "type": "Expense", "category": "Dining Out",
      "subcategory": "", "description": "STARBUCKS #4521", "amount": 6.75,
      "payment": "Credit Card", "account": "", "confidence": "high" }
  ],
  "skipped": 2
}
```

Failure response (cap exceeded, extraction error, file rejected) uses the
same `{ "ok": false, "error": "..." }` shape every other action already
uses — no new error envelope.

### 5. Monthly cap: a new Postgres table, not the existing rate-limit table

New table `ai_imports`, RLS-scoped exactly like `balances`/`debts` in
`db/schema.sql`:

```sql
create table ai_imports (
  id          bigint generated always as identity primary key,
  tenant_id   uuid not null default nullif(current_setting('app.tenant_id', true), '')::uuid references tenants(id) on delete cascade,
  created_at  timestamptz not null default now()
);
create index ai_imports_tenant_created_idx on ai_imports (tenant_id, created_at);

alter table ai_imports enable row level security;
alter table ai_imports force row level security;
create policy ai_imports_isolation on ai_imports
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
```

One row per extraction *attempt that reached Bedrock and got a response* —
not one row per successfully-imported transaction, and not one row for a
request that failed before calling Bedrock (a throttled/errored Bedrock
call didn't cost the household a usable result, so it shouldn't cost their
cap either). A request that reaches Bedrock and gets back zero
transactions still counts — it was still a real, billed call.

`ExtractFunction` checks the count for the current calendar month
(`created_at >= date_trunc('month', now())`) *before* calling Bedrock, and
rejects with `{ ok: false, error: "You've used your N AI imports this
month." }` once at `AI_IMPORT_MONTHLY_CAP` (a new constant in `plans.js`,
alongside `SEAT_CAPS`). No reset job or cron needed — the rolling
calendar-month window is just a `WHERE` clause.

This is deliberately **not** the `RateLimitTable` DynamoDB table added in
the API-hardening work — that's a 60-second-window per-IP abuse guard, a
different concern from a monthly per-tenant *billing-adjacent feature
cap*. Conflating them would make both harder to reason about, and this
one needs a real per-tenant audit trail (Postgres, queryable, RLS-scoped)
more than it needs DynamoDB's speed.

### 6. Plan gating

`plans.js`'s `FEATURES` gains an `aiImport` boolean (`false` for free,
`true` for pro/family — same shape as the existing `netWorth` flag).
Because `getPlans()` (`backend/src/routes/billing.js`) already returns
`features: FEATURES[id]` verbatim for every tier, **this flag reaches the
frontend with zero changes to `getPlans()` itself** — a direct benefit of
the backend-being-the-source-of-truth refactor already done for the plan
list. The only frontend change needed for the Billing-page plan cards is
one line in `app.js`'s `planFeatureList()` to render an "AI-powered
import" bullet when `features.aiImport` is true, matching how the
`netWorth` bullet already works there.

The existing `GET /data` action's `tenant` object
(`handler.js`'s `handleGet`, currently `{ plan, status,
hasStripeCustomer }`) gains one more field, `aiImportsUsedThisMonth`
(same `ai_imports` count query as §5), computed inside the same tenant
transaction that's already open for that request — no new round trip.
This means the frontend has "used 12 of 20 this month" available on every
page load, not just when the upload control renders.

### 7. Frontend

**Upload control**: a second, visually distinct control on the Data tab's
existing Import section — not the same `<input>` as the current CSV/XLSX
importer, since this triggers a completely different path (slow, metered,
a backend AI call) and a user should be able to tell the difference before
clicking. Gated the same way Net Worth already is in the nav: locked with
an upsell message on Free plan; once `aiImportsUsedThisMonth >=
AI_IMPORT_MONTHLY_CAP`, replaced with a plain "You've used your N AI
imports this month" message instead of the control.

**Loading state**: `withBusy()`'s existing spinner, but with wording that
sets a real expectation ("Reading your statement — this can take up to 20
seconds") rather than the instant-feeling copy every other action uses,
since this is the only action in the app that can meaningfully take that
long.

**Review table**: renders `state.store`'s `extractTransactions()` result
as one row per transaction — date, type, category, description, amount,
a checkbox (default checked), and a visible flag on any `confidence:
"low"` row. An "Import N selected" button collects the checked rows and
calls the *existing* `state.store.bulkAdd()` path unchanged — this is
where the new code stops and the already-built, already-tested import
path takes over. No new row-level editing UI (see Non-goals);
`skipped` (rows the model returned but that failed schema validation) is
shown as a one-line note above the table, same tone as the existing
importer's "N rows skipped" copy.

**`store.js`**: new `ApiStore.extractTransactions(fileName, fileType,
fileBase64)` → `this._post` against the new endpoint (note: this one
targets `/extract`, not `/data` — `_post`'s base URL will need a way to
target the second route; simplest is a second private method,
`_postTo(path, payload)`, that `_post` itself becomes a thin wrapper
around for `/data`, so existing behavior is unchanged). `DisconnectedStore`
gets a matching stub that throws `notConnected()` — same as every other
write-shaped action, since without a live connection there's nothing to
send a file to.

## Error handling & edge cases

- **Cap exceeded** → checked before any Bedrock call, `{ ok: false, error:
  "You've used your N AI imports this month." }`, does not touch
  `ai_imports`.
- **File too large / too many PDF pages** → checked client-side (page
  count requires reading the PDF first — a lightweight client-side PDF
  page-count check, not a full parse) *and* server-side (the source of
  truth), rejected before the Bedrock call, does not touch `ai_imports`.
- **Bedrock call fails** (throttled, service error, malformed response
  before any usable JSON) → `{ ok: false, error: "..." }`, does **not**
  count against the cap (see §5).
- **Bedrock responds, but zero transactions extracted** → counts against
  the cap (a real call happened); frontend shows an empty review state
  with a clear "no transactions found in this file" message rather than
  an error.
- **A row fails schema validation** → dropped, counted in `skipped`, not
  included in the reviewable list, not silently coerced.
- **No currency conversion** → see Non-goals; amount is taken as-is.

## Testing

**Backend**: Bedrock is mocked in every test — `mock.method(bedrockClient,
"send", ...)` or equivalent, same pattern as the existing `mock.method
(stripe.prices, "retrieve", ...)` used throughout `test/billing-route.
test.js`. No test makes a real, billable Bedrock call. Real coverage:

- Cap enforcement at exactly the limit, one over, and confirming a
  failed-before-Bedrock-response call does *not* increment it.
- Prompt construction — the real `CAT_NAMES` list and type-taxonomy
  explanation actually appear in what gets sent.
- Response validation — a malformed/partial model response is rejected
  per-row (dropped + counted in `skipped`), not allowed to crash the
  request or produce a half-valid transaction.
- The plan-gating check itself (free-plan request rejected before any of
  the above even runs).

**Frontend**: no test runner exists for the frontend anywhere in this
codebase today (matches CLAUDE.md), so this feature follows the same
pattern as everything else here — manual verification via the local
`python3 -m http.server` + browser workflow, not new test infrastructure.

## Open questions / assumptions to verify at implementation time

1. **Scanned/image-only PDF support** via Bedrock's document content
   blocks — assumed to work, not yet confirmed against a real scanned
   statement (§3).
2. **Exact Bedrock model id** — left as a deploy-time parameter
   (`BedrockModelId`) rather than fixed in this spec, since model
   availability is region- and time-dependent.
3. **`AI_IMPORT_MONTHLY_CAP` value** — 20/month used as a working number
   throughout this spec; the real number is a product/cost decision to
   confirm before shipping, not a technical constraint.
