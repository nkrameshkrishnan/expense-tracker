# AI Transaction Import (CSV/PDF) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user upload a bank/credit-card statement (CSV or PDF) on the Data tab and have an LLM (AWS Bedrock) extract its transactions, mapped into this app's own model, for review before import.

**Architecture:** A new, dedicated Lambda (`ExtractFunction`) behind a new `POST /extract` route calls Bedrock's Converse API with the app's real category/type vocabulary and gets back structured JSON. Every extracted row is validated server-side before it ever reaches the frontend; the frontend shows a read-only, checkbox-driven review table and rejoins the existing `bulkAdd` write path for anything the user keeps checked. A new Postgres table tracks a monthly per-tenant cap; a new `FEATURES.aiImport` flag gates the whole feature to Pro/Family.

**Tech Stack:** AWS Bedrock (`@aws-sdk/client-bedrock-runtime`), `pdf-lib` (PDF page counting), existing stack otherwise (SAM/Lambda/API Gateway/Aurora Postgres RLS/Cognito).

**Spec:** `docs/superpowers/specs/2026-08-23-ai-transaction-import-design.md`

## Global Constraints

- No currency conversion — amount is taken as-is (spec Non-goals).
- No inline editing of extracted rows — select/deselect only, corrections happen after import via the existing Transactions edit flow (spec Non-goals, Architecture §7).
- Synchronous request/response only — no job queue/polling (spec Non-goals, Architecture §2). `ExtractFunction` timeout is 25s, under API Gateway's hard 29s integration ceiling.
- PDF hard cap: 10 pages, checked before calling Bedrock (spec Architecture §2).
- A request that fails before Bedrock returns a response does NOT count against the monthly cap; a request that reaches Bedrock and gets a response (even zero transactions) DOES count (spec Architecture §5, Error handling).
- `categoryNames` is supplied by the frontend in every request, not a second backend-owned copy — categories are user-owned vocabulary in this app (spec Architecture §3, as patched 2026-08-23).
- `type` IS backend-owned structural data — validate against `backend/src/validate.js`'s existing `TYPES` constant, not a value from the request.
- `AI_IMPORT_MONTHLY_CAP` = 20/month, shared by Pro and Family (spec Non-goals, Open Questions #3) — a working number, not a hard technical constraint.
- Bedrock is always mocked in tests — no test may make a real, billable Bedrock call (spec Testing).

---

## File Structure

**Backend — new files:**

- `backend/src/bedrock.js` — Bedrock Runtime client singleton (mirrors `backend/src/stripe.js`'s shape exactly).
- `backend/src/routes/extract.js` — pure-ish extraction logic: builds the Converse API request, parses its response, validates each row. No Lambda event, no DB, no auth — testable standalone.
- `backend/src/routes/aiImportCap.js` — the two DB queries for the monthly cap (`countThisMonth`, `recordAttempt`). Separate from `routes/extract.js` because it's a different responsibility (billing/cap bookkeeping, not AI extraction).
- `backend/src/extract.js` — the actual Lambda handler (standalone, top-level file — same shape as `stripeWebhook.js`/`postConfirmation.js`, not a `routes/*.js` module called from `handler.js`). Also exports the two small pure functions (`assertAiImportAllowed`, `countPdfPages`) that make its gating logic independently testable, same pattern `handler.js` already uses for `assertManagesInvites`/`assertKnownPriceId`.

**Backend — modified files:**

- `db/schema.sql` — new `ai_imports` table.
- `backend/src/plans.js` — new `FEATURES.aiImport` flag, new `AI_IMPORT_MONTHLY_CAP` constant.
- `backend/template.yaml` — new `ExtractFunction` resource, new `BedrockModelId` parameter, new IAM policy statement.
- `backend/package.json` — new dependencies.
- `Expense_tracker_New/DEPLOYMENT.md` — new deploy parameter in Phase 2's table.

**Backend — new test files:**

- `backend/test/extract-route.test.js` — `routes/extract.js`'s prompt-building/response-parsing/row-validation, Bedrock mocked.
- `backend/test/ai-import-cap.test.js` — `routes/aiImportCap.js` against real Postgres (pg-harness), including cross-tenant RLS isolation.
- `backend/test/extract-gating.test.js` — `extract.js`'s `assertAiImportAllowed` and `countPdfPages`, mirroring `handler-gating.test.js`'s style exactly.
- `backend/test/plans.test.js` — extended, not new.

**Frontend — modified files:**

- `frontend/assets/store.js` — `_postTo` refactor (so `/extract` and `/data` can both be POSTed to), new `ApiStore.extractTransactions()` / `DisconnectedStore.extractTransactions()`.
- `frontend/assets/app.js` — new upload control + review table on the Data tab, plan-gating UI, one new bullet in `planFeatureList()`.

No new frontend test files — this codebase has no frontend test runner (Global Constraints notwithstanding; verification is manual, per each frontend task's Testing step).

---

### Task 1: `ai_imports` table

**Files:**

- Modify: `Expense_tracker_New/db/schema.sql`
- Test: none new (schema is exercised by every later task's tests via `pg-harness.js`'s `freshDb()`, which applies this file fresh on every test run)

**Interfaces:**

- Produces: an `ai_imports` table with columns `id` (bigint identity), `tenant_id` (uuid, RLS-scoped, same default expression as `debts`/`balances`), `created_at` (timestamptz, default `now()`). Every column has a default, so `insert into ai_imports default values` is a complete, valid insert — later tasks rely on this.

- [ ] **Step 1: Add the table**

Open `Expense_tracker_New/db/schema.sql`. Find the `-- -------------------------------------------------------------------- debts`
section (the last table in the file) and add this immediately after its closing RLS policy (after the `debts_isolation` policy's closing `;`):

```sql
-- --------------------------------------------------------------- ai_imports
-- One row per extraction attempt that reached Bedrock and got a response
-- back (see backend/src/extract.js) - this is a cost-control record, not
-- a log of successful imports. A request that fails before Bedrock
-- responds (throttled, service error) never reaches the insert that
-- creates one of these rows.
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

- [ ] **Step 2: Verify the schema still applies cleanly**

Run: `cd Expense_tracker_New/backend && npm test`
Expected: all 92 existing tests still pass (each test file's `freshDb()` call applies the whole schema fresh, so a syntax error here fails every single test, immediately and loudly).

- [ ] **Step 3: Commit**

```bash
git add Expense_tracker_New/db/schema.sql
git commit -m "feat: add ai_imports table for AI-import monthly cap tracking"
```

---

### Task 2: Plan gating constants

**Files:**

- Modify: `Expense_tracker_New/backend/src/plans.js`
- Test: Modify `Expense_tracker_New/backend/test/plans.test.js`

**Interfaces:**

- Produces: `FEATURES[planId].aiImport` (boolean, `false` for free, `true` for pro/family) and `AI_IMPORT_MONTHLY_CAP` (number, `20`), both exported from `plans.js`. `routes/aiImportCap.js` (Task 4) and `extract.js` (Task 5) both import `AI_IMPORT_MONTHLY_CAP`; `extract.js` imports `FEATURES`.

- [ ] **Step 1: Write the failing test**

Open `Expense_tracker_New/backend/test/plans.test.js`. Add these two tests after the existing `"FEATURES: only free restricts net worth and history"` test:

```javascript
test("FEATURES: aiImport is only true for pro and family", () => {
  assert.equal(FEATURES.free.aiImport, false);
  assert.equal(FEATURES.pro.aiImport, true);
  assert.equal(FEATURES.family.aiImport, true);
});

test("AI_IMPORT_MONTHLY_CAP is a positive number", () => {
  assert.equal(typeof AI_IMPORT_MONTHLY_CAP, "number");
  assert.ok(AI_IMPORT_MONTHLY_CAP > 0);
});
```

Update the import at the top of the file:

```javascript
const { SEAT_CAPS, FEATURES, planFromPriceId, AI_IMPORT_MONTHLY_CAP } =
  await import("../src/plans.js");
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd Expense_tracker_New/backend && node --test test/plans.test.js`
Expected: FAIL — `AI_IMPORT_MONTHLY_CAP` is `undefined`, `FEATURES.free.aiImport` is `undefined` (not `false`).

- [ ] **Step 3: Implement**

In `Expense_tracker_New/backend/src/plans.js`, replace the `FEATURES` export and add the new constant:

```javascript
export const FEATURES = {
  free: { netWorth: false, historyMonths: 12, aiImport: false },
  pro: { netWorth: true, historyMonths: null, aiImport: true },
  family: { netWorth: true, historyMonths: null, aiImport: true },
};

// A working number, not a hard technical constraint - see this feature's
// spec (docs/superpowers/specs/2026-08-23-ai-transaction-import-design.md),
// Open Questions #3. Shared by Pro and Family; not tier-scaled (v1 scope).
export const AI_IMPORT_MONTHLY_CAP = 20;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd Expense_tracker_New/backend && node --test test/plans.test.js`
Expected: PASS, all tests including the two new ones.

- [ ] **Step 5: Run the full suite and commit**

Run: `cd Expense_tracker_New/backend && npm test`
Expected: all tests pass (94 now).

```bash
git add Expense_tracker_New/backend/src/plans.js Expense_tracker_New/backend/test/plans.test.js
git commit -m "feat: add aiImport feature flag and monthly cap constant"
```

---

### Task 3: Bedrock client + extraction logic

**Files:**

- Create: `Expense_tracker_New/backend/src/bedrock.js`
- Create: `Expense_tracker_New/backend/src/routes/extract.js`
- Test: Create `Expense_tracker_New/backend/test/extract-route.test.js`
- Modify: `Expense_tracker_New/backend/package.json`

**Interfaces:**

- Consumes: `backend/src/validate.js`'s `money`, `isoDate`, `text`, `TYPES` (all already exist).
- Produces: `bedrock.js` exports `bedrock` (a `BedrockRuntimeClient` instance). `routes/extract.js` exports `buildExtractionRequest({ fileType, fileContent, categoryNames, modelId })` → a Converse API request object; `parseExtractionResponse(response)` → an array of raw row objects (throws if the response has no usable tool-use content); `validateExtractedRow(row, categoryNames)` → a clean row object or `null`; `extractTransactions(bedrockClient, { fileType, fileContent, categoryNames, modelId })` → `Promise<{ transactions: [...], skipped: number }>`. Task 5 calls only `extractTransactions`.

- [ ] **Step 1: Add dependencies**

In `Expense_tracker_New/backend/package.json`, add to `"dependencies"`:

```json
    "@aws-sdk/client-bedrock-runtime": "^3.600.0",
    "pdf-lib": "^1.17.1",
```

Run: `cd Expense_tracker_New/backend && npm install`

- [ ] **Step 2: Create the Bedrock client singleton**

Create `Expense_tracker_New/backend/src/bedrock.js`:

```javascript
/* Lazy Bedrock Runtime client singleton - same shape as stripe.js/db.js's
   module-scope clients. No API key to read at module load (Bedrock auth
   is IAM, via the Lambda's execution role - see template.yaml's
   ExtractFunction Policies), unlike stripe.js's STRIPE_SECRET_KEY. */
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";

export const bedrock = new BedrockRuntimeClient({});
```

- [ ] **Step 3: Write the failing test for prompt construction**

Create `Expense_tracker_New/backend/test/extract-route.test.js`:

```javascript
import { test, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import { ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import {
  buildExtractionRequest,
  parseExtractionResponse,
  validateExtractedRow,
  extractTransactions,
} from "../src/routes/extract.js";

afterEach(() => mock.restoreAll());

const CATEGORY_NAMES = ["Groceries", "Dining Out", "Salary", "Miscellaneous"];

test("buildExtractionRequest includes the real category list and type taxonomy", () => {
  const req = buildExtractionRequest({
    fileType: "csv",
    fileContent: "date,amount\n2026-08-01,12.50",
    categoryNames: CATEGORY_NAMES,
    modelId: "test-model",
  });
  assert.equal(req.modelId, "test-model");
  const systemText = req.system[0].text;
  for (const cat of CATEGORY_NAMES) assert.ok(systemText.includes(cat));
  assert.ok(systemText.includes("Expense"));
  assert.ok(systemText.includes("Income"));
  assert.ok(systemText.includes("Transfer"));
  assert.ok(systemText.includes("Dividends"));
  // category is enum-constrained in the tool schema, not just described
  // in prose - this is what actually keeps the model from hallucinating
  // a category outside the given list.
  const props =
    req.toolConfig.tools[0].toolSpec.inputSchema.json.properties.transactions
      .items.properties;
  assert.deepEqual(props.category.enum, CATEGORY_NAMES);
  assert.deepEqual(props.type.enum, [
    "Expense",
    "Income",
    "Transfer",
    "Dividends",
  ]);
});

test("buildExtractionRequest sends CSV as inline text, not a document block", () => {
  const req = buildExtractionRequest({
    fileType: "csv",
    fileContent: "date,amount\n2026-08-01,12.50",
    categoryNames: CATEGORY_NAMES,
    modelId: "test-model",
  });
  const content = req.messages[0].content;
  assert.ok(content.some((c) => c.text?.includes("2026-08-01,12.50")));
  assert.ok(!content.some((c) => c.document));
});

test("buildExtractionRequest sends PDF as a document content block", () => {
  const bytes = Buffer.from("fake-pdf-bytes");
  const req = buildExtractionRequest({
    fileType: "pdf",
    fileContent: bytes,
    categoryNames: CATEGORY_NAMES,
    modelId: "test-model",
  });
  const content = req.messages[0].content;
  const doc = content.find((c) => c.document);
  assert.ok(doc);
  assert.equal(doc.document.format, "pdf");
  assert.equal(doc.document.source.bytes, bytes);
});

test("parseExtractionResponse reads the tool-use input", () => {
  const response = {
    output: {
      message: {
        content: [
          {
            toolUse: {
              input: {
                transactions: [{ date: "2026-08-01", amount: 12.5 }],
              },
            },
          },
        ],
      },
    },
  };
  const rows = parseExtractionResponse(response);
  assert.deepEqual(rows, [{ date: "2026-08-01", amount: 12.5 }]);
});

test("parseExtractionResponse throws on a response with no tool-use content", () => {
  const response = {
    output: { message: { content: [{ text: "no tool call" }] } },
  };
  assert.throws(
    () => parseExtractionResponse(response),
    /did not include a transactions list/,
  );
});

test("validateExtractedRow accepts a well-formed row", () => {
  const row = validateExtractedRow(
    {
      date: "2026-08-01",
      type: "Expense",
      category: "Groceries",
      subcategory: "",
      description: "SAFEWAY #123",
      amount: 42.5,
      payment: "Credit Card",
      account: "",
      confidence: "high",
    },
    CATEGORY_NAMES,
  );
  assert.deepEqual(row, {
    date: "2026-08-01",
    type: "Expense",
    category: "Groceries",
    subcategory: "",
    description: "SAFEWAY #123",
    amount: 42.5,
    payment: "Credit Card",
    account: "",
    confidence: "high",
  });
});

test("validateExtractedRow drops a row with a category outside the given list", () => {
  const row = validateExtractedRow(
    {
      date: "2026-08-01",
      type: "Expense",
      category: "Not A Real Category",
      amount: 10,
    },
    CATEGORY_NAMES,
  );
  assert.equal(row, null);
});

test("validateExtractedRow drops a row with a bad date", () => {
  const row = validateExtractedRow(
    { date: "not-a-date", type: "Expense", category: "Groceries", amount: 10 },
    CATEGORY_NAMES,
  );
  assert.equal(row, null);
});

test("validateExtractedRow drops a row with a non-numeric amount", () => {
  const row = validateExtractedRow(
    {
      date: "2026-08-01",
      type: "Expense",
      category: "Groceries",
      amount: "abc",
    },
    CATEGORY_NAMES,
  );
  assert.equal(row, null);
});

test("validateExtractedRow drops a zero-amount row", () => {
  const row = validateExtractedRow(
    { date: "2026-08-01", type: "Expense", category: "Groceries", amount: 0 },
    CATEGORY_NAMES,
  );
  assert.equal(row, null);
});

test("validateExtractedRow drops a row with an unrecognized type", () => {
  const row = validateExtractedRow(
    {
      date: "2026-08-01",
      type: "Something Else",
      category: "Groceries",
      amount: 10,
    },
    CATEGORY_NAMES,
  );
  assert.equal(row, null);
});

test("validateExtractedRow defaults confidence to high when absent", () => {
  const row = validateExtractedRow(
    { date: "2026-08-01", type: "Expense", category: "Groceries", amount: 10 },
    CATEGORY_NAMES,
  );
  assert.equal(row.confidence, "high");
});

test("extractTransactions calls Bedrock once and returns validated rows plus a skipped count", async () => {
  const calls = [];
  const bedrockClient = {
    send: async (command) => {
      calls.push(command);
      return {
        output: {
          message: {
            content: [
              {
                toolUse: {
                  input: {
                    transactions: [
                      {
                        date: "2026-08-01",
                        type: "Expense",
                        category: "Groceries",
                        amount: 42.5,
                      },
                      {
                        // dropped: category not in the given list
                        date: "2026-08-02",
                        type: "Expense",
                        category: "Nonsense",
                        amount: 5,
                      },
                    ],
                  },
                },
              },
            ],
          },
        },
      };
    },
  };

  const result = await extractTransactions(bedrockClient, {
    fileType: "csv",
    fileContent: "date,amount\n2026-08-01,42.50",
    categoryNames: CATEGORY_NAMES,
    modelId: "test-model",
  });

  assert.equal(calls.length, 1);
  assert.ok(calls[0] instanceof ConverseCommand);
  assert.equal(result.transactions.length, 1);
  assert.equal(result.transactions[0].category, "Groceries");
  assert.equal(result.skipped, 1);
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `cd Expense_tracker_New/backend && node --test test/extract-route.test.js`
Expected: FAIL — `routes/extract.js` doesn't exist yet, import error.

- [ ] **Step 5: Implement**

Create `Expense_tracker_New/backend/src/routes/extract.js`:

```javascript
/* Turns a CSV/PDF into a reviewable list of transactions via Bedrock.
   No Lambda event, no DB, no auth here - extract.js (the Lambda handler)
   is the only caller, and it owns all of that. This file's only job is
   "given file bytes and the app's real vocabulary, call the model and
   come back with something safe to show a user," which is why it's
   testable with nothing but a mocked bedrockClient.send. */

import { ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { money, isoDate, text, TYPES } from "../validate.js";

const TOOL_NAME = "record_transactions";

function buildSystemPrompt(categoryNames) {
  return [
    "You are extracting transactions from a bank or credit-card statement",
    "for a personal finance app. Extract every transaction line you can",
    "find - do not summarize or skip any.",
    "",
    "Rules:",
    `- "type" must be exactly one of: ${TYPES.join(", ")}.`,
    '- "amount" is always a positive number. The "type" field carries the',
    "  sign/direction - never send a negative amount.",
    '- A statement\'s own "Debit"/withdrawal typically maps to "Expense";',
    '  a "Credit"/deposit typically maps to "Income" - but read the actual',
    "  description. A refund credited back is still an Expense reversal,",
    "  not Income; a transfer between the customer's own accounts is",
    '  "Transfer", not Income or Expense.',
    `- "category" must be exactly one of: ${categoryNames.join(", ")}.`,
    '  If nothing fits well, use "Miscellaneous" if it is in that list,',
    "  otherwise pick the closest match - never invent a category name.",
    '- "date" must be YYYY-MM-DD.',
    '- Set "confidence" to "low" for any row you are not confident about',
    "  (an ambiguous amount, an unclear category, illegible text),",
    '  "high" otherwise.',
  ].join("\n");
}

/** Builds the Bedrock Converse API request. CSV content is sent as inline
    text (small enough that a document block adds nothing); PDF content is
    sent as a `document` content block - Bedrock's newer Claude models can
    read PDF pages as images as well as extract embedded text, which
    should also cover a scanned/image-only statement (flagged as an
    assumption to verify against a real scanned PDF - see this feature's
    spec, Architecture §3). category/type are enum-constrained in the tool
    schema itself, not just described in prose - this is what actually
    keeps the model from hallucinating outside the given vocabulary,
    rather than relying on it merely reading the instructions. */
export function buildExtractionRequest({
  fileType,
  fileContent,
  categoryNames,
  modelId,
}) {
  const userContent =
    fileType === "pdf"
      ? [
          {
            document: {
              format: "pdf",
              name: "statement",
              source: { bytes: fileContent },
            },
          },
          { text: "Extract every transaction from this statement." },
        ]
      : [
          {
            text: `Extract every transaction from this CSV:\n\n${fileContent}`,
          },
        ];

  return {
    modelId,
    system: [{ text: buildSystemPrompt(categoryNames) }],
    messages: [{ role: "user", content: userContent }],
    toolConfig: {
      toolChoice: { tool: { name: TOOL_NAME } },
      tools: [
        {
          toolSpec: {
            name: TOOL_NAME,
            description:
              "Records every transaction extracted from the document.",
            inputSchema: {
              json: {
                type: "object",
                properties: {
                  transactions: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        date: { type: "string" },
                        type: { type: "string", enum: TYPES },
                        category: { type: "string", enum: categoryNames },
                        subcategory: { type: "string" },
                        description: { type: "string" },
                        amount: { type: "number" },
                        payment: { type: "string" },
                        account: { type: "string" },
                        confidence: {
                          type: "string",
                          enum: ["high", "low"],
                        },
                      },
                      required: ["date", "type", "category", "amount"],
                    },
                  },
                },
                required: ["transactions"],
              },
            },
          },
        },
      ],
    },
  };
}

/** Pulls the tool-use input out of a Converse API response. Throws (does
    not return an empty array) when the response has no usable tool-use
    content at all - that's a genuinely different, worse failure than "the
    model found zero transactions," and extract.js needs to tell those
    two apart (the latter still counts against the monthly cap; treating
    a malformed response the same way would be a fair charge). */
export function parseExtractionResponse(response) {
  const content = response.output?.message?.content || [];
  const toolUse = content.find((c) => c.toolUse)?.toolUse;
  if (!toolUse || !Array.isArray(toolUse.input?.transactions))
    throw new Error("Bedrock response did not include a transactions list.");
  return toolUse.input.transactions;
}

/** Validates one extracted row, reusing validate.js's existing field
    validators (money/isoDate/text) rather than duplicating their rules.
    Returns null (drop this row) instead of throwing on ANY problem - a
    single bad row from the model must not fail the whole request, unlike
    validateTransaction()'s throw-on-bad-input contract for a single
    user-authored write. category is checked against the caller-supplied
    list (not a backend-owned constant - see this feature's spec,
    Architecture §3); type is checked against validate.js's own TYPES,
    which genuinely is backend-owned structural data. */
export function validateExtractedRow(row, categoryNames) {
  try {
    if (!row || typeof row !== "object") return null;
    const date = isoDate(row.date, "date");
    const amount = money(row.amount, "amount");
    if (amount === 0) return null;
    if (!TYPES.includes(row.type)) return null;
    if (!categoryNames.includes(row.category)) return null;
    return {
      date,
      type: row.type,
      category: row.category,
      subcategory: text(row.subcategory, "subcategory"),
      description: text(row.description, "description"),
      amount,
      payment: text(row.payment, "payment"),
      account: text(row.account, "account"),
      confidence: row.confidence === "low" ? "low" : "high",
    };
  } catch {
    return null;
  }
}

/** The one function extract.js (the Lambda handler) actually calls. Makes
    exactly one Bedrock call; every row in the response is independently
    validated, so one malformed row never fails the whole extraction. */
export async function extractTransactions(
  bedrockClient,
  { fileType, fileContent, categoryNames, modelId },
) {
  const request = buildExtractionRequest({
    fileType,
    fileContent,
    categoryNames,
    modelId,
  });
  const response = await bedrockClient.send(new ConverseCommand(request));
  const rawRows = parseExtractionResponse(response);

  const transactions = [];
  let skipped = 0;
  for (const row of rawRows) {
    const clean = validateExtractedRow(row, categoryNames);
    if (clean) transactions.push(clean);
    else skipped++;
  }
  return { transactions, skipped };
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd Expense_tracker_New/backend && node --test test/extract-route.test.js`
Expected: PASS, all tests.

- [ ] **Step 7: Run the full suite and commit**

Run: `cd Expense_tracker_New/backend && npm test`
Expected: all tests pass.

```bash
git add Expense_tracker_New/backend/src/bedrock.js Expense_tracker_New/backend/src/routes/extract.js Expense_tracker_New/backend/test/extract-route.test.js Expense_tracker_New/backend/package.json Expense_tracker_New/backend/package-lock.json
git commit -m "feat: add Bedrock-based transaction extraction logic"
```

---

### Task 4: Monthly cap tracking

**Files:**

- Create: `Expense_tracker_New/backend/src/routes/aiImportCap.js`
- Test: Create `Expense_tracker_New/backend/test/ai-import-cap.test.js`

**Interfaces:**

- Consumes: `db.js`'s `runInTenantTransaction` (via `pg-harness.js`'s `withTenant` in tests), `plans.js`'s `AI_IMPORT_MONTHLY_CAP`.
- Produces: `countThisMonth(execute)` → `Promise<number>`; `recordAttempt(execute)` → `Promise<void>`. Both take only `execute` — no `tenantId` parameter, since RLS (via the session's `app.tenant_id` GUC, already set by whichever `runInTenantTransaction` call is open) scopes every query automatically, the same way `routes/debts.js`'s `listDebts(execute)` does. Task 5 calls both.

- [ ] **Step 1: Write the failing test**

Create `Expense_tracker_New/backend/test/ai-import-cap.test.js`:

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  freshDb,
  withProvisioning,
  withTenant,
  makeExecute,
} from "./pg-harness.js";
import { countThisMonth, recordAttempt } from "../src/routes/aiImportCap.js";

async function seedTenant(client, name) {
  return withProvisioning(client, "seed-user", async (c) => {
    const { rows } = await c.query(
      `insert into tenants (name) values ($1) returning id`,
      [name],
    );
    return rows[0].id;
  });
}

test("countThisMonth is 0 for a tenant with no attempts", async () => {
  const client = await freshDb();
  try {
    const tenantId = await seedTenant(client, "Household");
    const count = await withTenant(client, tenantId, "owner-sub", (c) =>
      countThisMonth(makeExecute(c)),
    );
    assert.equal(count, 0);
  } finally {
    await client.end();
  }
});

test("recordAttempt increments the count", async () => {
  const client = await freshDb();
  try {
    const tenantId = await seedTenant(client, "Household");
    await withTenant(client, tenantId, "owner-sub", (c) =>
      recordAttempt(makeExecute(c)),
    );
    await withTenant(client, tenantId, "owner-sub", (c) =>
      recordAttempt(makeExecute(c)),
    );
    const count = await withTenant(client, tenantId, "owner-sub", (c) =>
      countThisMonth(makeExecute(c)),
    );
    assert.equal(count, 2);
  } finally {
    await client.end();
  }
});

test("countThisMonth excludes attempts from a previous month", async () => {
  const client = await freshDb();
  try {
    const tenantId = await seedTenant(client, "Household");
    // Insert a backdated row directly - recordAttempt always uses now(),
    // so this is the only way to put a "last month" row in place.
    await withTenant(client, tenantId, "owner-sub", (c) =>
      c.query(
        `insert into ai_imports (tenant_id, created_at) values ($1, now() - interval '40 days')`,
        [tenantId],
      ),
    );
    const count = await withTenant(client, tenantId, "owner-sub", (c) =>
      countThisMonth(makeExecute(c)),
    );
    assert.equal(count, 0);
  } finally {
    await client.end();
  }
});

test("counts are isolated per tenant (RLS)", async () => {
  const client = await freshDb();
  try {
    const tenantA = await seedTenant(client, "Household A");
    const tenantB = await seedTenant(client, "Household B");
    await withTenant(client, tenantA, "owner-a", (c) =>
      recordAttempt(makeExecute(c)),
    );
    await withTenant(client, tenantA, "owner-a", (c) =>
      recordAttempt(makeExecute(c)),
    );
    await withTenant(client, tenantB, "owner-b", (c) =>
      recordAttempt(makeExecute(c)),
    );

    const countA = await withTenant(client, tenantA, "owner-a", (c) =>
      countThisMonth(makeExecute(c)),
    );
    const countB = await withTenant(client, tenantB, "owner-b", (c) =>
      countThisMonth(makeExecute(c)),
    );
    assert.equal(countA, 2);
    assert.equal(countB, 1);
  } finally {
    await client.end();
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd Expense_tracker_New/backend && node --test test/ai-import-cap.test.js`
Expected: FAIL — `routes/aiImportCap.js` doesn't exist yet, import error.

- [ ] **Step 3: Implement**

Create `Expense_tracker_New/backend/src/routes/aiImportCap.js`:

```javascript
/* The two queries behind the monthly AI-import cap (extract.js, Task 5
   of this feature's plan). Neither takes a tenantId - every column on
   ai_imports has a default (see db/schema.sql), and RLS already scopes
   both queries to whichever tenant the caller's open
   runInTenantTransaction is for, the same way routes/debts.js's
   listDebts(execute) needs no explicit tenant filter either. */

/** Attempts recorded so far in the current calendar month. No reset job
    needed - "this month" is just a WHERE clause against now(). */
export async function countThisMonth(execute) {
  const rows = await execute.rows(
    `select count(*)::int as count from ai_imports where created_at >= date_trunc('month', now())`,
  );
  return rows[0].count;
}

/** Records one extraction attempt. Only called after Bedrock has actually
    returned a response (see extract.js) - a call that fails before that
    point must not reach here, per this feature's spec (Error handling:
    a failed-before-response call doesn't count against the cap). */
export async function recordAttempt(execute) {
  await execute(`insert into ai_imports default values`);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd Expense_tracker_New/backend && node --test test/ai-import-cap.test.js`
Expected: PASS, all 4 tests.

- [ ] **Step 5: Run the full suite and commit**

Run: `cd Expense_tracker_New/backend && npm test`
Expected: all tests pass.

```bash
git add Expense_tracker_New/backend/src/routes/aiImportCap.js Expense_tracker_New/backend/test/ai-import-cap.test.js
git commit -m "feat: add monthly AI-import cap tracking"
```

---

### Task 5: The `ExtractFunction` Lambda handler

**Files:**

- Create: `Expense_tracker_New/backend/src/extract.js`
- Test: Create `Expense_tracker_New/backend/test/extract-gating.test.js`

**Interfaces:**

- Consumes: `auth.js`'s `requireUser`/`AuthError`; `rateLimit.js`'s `checkRateLimit`/`RateLimitError`; `db.js`'s `runInTenantTransaction`; `plans.js`'s `FEATURES`/`AI_IMPORT_MONTHLY_CAP`; `bedrock.js`'s `bedrock`; `routes/extract.js`'s `extractTransactions`; `routes/aiImportCap.js`'s `countThisMonth`/`recordAttempt`.
- Produces: `handler` (the Lambda export, wired in Task 6's `template.yaml`), plus two exported pure functions used only by this task's own tests: `assertAiImportAllowed(tenantRow)` (throws `AiImportGateError` if the plan doesn't include `aiImport`) and `countPdfPages(bytes)` (returns a `Promise<number>` via `pdf-lib`).

- [ ] **Step 1: Write the failing tests for the two pure gate functions**

Create `Expense_tracker_New/backend/test/extract-gating.test.js`:

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { PDFDocument } from "pdf-lib";
import {
  assertAiImportAllowed,
  AiImportGateError,
  countPdfPages,
} from "../src/extract.js";

test("throws for a free-plan tenant", () => {
  assert.throws(
    () => assertAiImportAllowed({ plan: "free" }),
    AiImportGateError,
  );
});
test("does not throw for pro", () => {
  assert.doesNotThrow(() => assertAiImportAllowed({ plan: "pro" }));
});
test("does not throw for family", () => {
  assert.doesNotThrow(() => assertAiImportAllowed({ plan: "family" }));
});
test("treats a missing/unrecognized plan as locked", () => {
  assert.throws(() => assertAiImportAllowed({}), AiImportGateError);
  assert.throws(
    () => assertAiImportAllowed({ plan: "not-a-real-plan" }),
    AiImportGateError,
  );
});

test("countPdfPages counts pages in a real PDF", async () => {
  const doc = await PDFDocument.create();
  doc.addPage();
  doc.addPage();
  doc.addPage();
  const bytes = await doc.save();
  const count = await countPdfPages(bytes);
  assert.equal(count, 3);
});

test("countPdfPages counts a single-page PDF correctly", async () => {
  const doc = await PDFDocument.create();
  doc.addPage();
  const bytes = await doc.save();
  const count = await countPdfPages(bytes);
  assert.equal(count, 1);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd Expense_tracker_New/backend && node --test test/extract-gating.test.js`
Expected: FAIL — `src/extract.js` doesn't exist yet, import error.

- [ ] **Step 3: Implement**

Create `Expense_tracker_New/backend/src/extract.js`:

```javascript
/* Lambda behind POST /extract - lets a Pro/Family tenant upload a CSV/PDF
   statement and get back a reviewable list of extracted transactions.
   Deliberately its own Lambda, not a DataFunction action - see this
   feature's spec (docs/superpowers/specs/2026-08-23-ai-transaction-
   import-design.md), Architecture §1, for why (timeout, blast radius).

   No dedicated test for the `handler` export itself, matching handler.js's
   own precedent: its Lambda entrypoint has zero direct tests either, only
   the small pure gate functions it exports (assertManagesInvites,
   assertKnownPriceId). Everything handler() composes here - the auth gate,
   the plan gate, the cap check, the extraction call, the cap-recording
   insert - is independently tested already (auth.js's own tests,
   extract-gating.test.js below, extract-route.test.js, ai-import-
   cap.test.js). handler() itself is thin wiring over already-proven
   pieces, the same category of code handler.js's action switch already
   is. */

import { PDFDocument } from "pdf-lib";
import { requireUser, AuthError } from "./auth.js";
import { checkRateLimit, RateLimitError } from "./rateLimit.js";
import { runInTenantTransaction } from "./db.js";
import { FEATURES, AI_IMPORT_MONTHLY_CAP } from "./plans.js";
import { bedrock } from "./bedrock.js";
import { extractTransactions } from "./routes/extract.js";
import { countThisMonth, recordAttempt } from "./routes/aiImportCap.js";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": process.env.ALLOWED_ORIGIN || "*",
  "Access-Control-Allow-Headers": "authorization,content-type,x-active-tenant",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
};

function json(status, body) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    body: JSON.stringify(body),
  };
}

const MAX_FILE_BYTES = 8 * 1024 * 1024; // 8MB - see spec Architecture §1's rejected S3-direct-upload alternative
const MAX_PDF_PAGES = 10; // see Global Constraints in this feature's plan

export class AiImportGateError extends Error {}

/** Throws AiImportGateError if this tenant's plan doesn't include
    aiImport. A missing or unrecognized plan is treated as locked
    (fail closed), not as an error - `tenantRow` always has a real `plan`
    string in production (see handler() below), so this only matters for
    a malformed row, which should never grant access by accident. */
export function assertAiImportAllowed(tenantRow) {
  const plan = tenantRow?.plan;
  if (!FEATURES[plan]?.aiImport)
    throw new AiImportGateError(
      "AI import is available on the Pro and Family plans. Upgrade from the Billing tab.",
    );
}

/** Page count via pdf-lib, without a full parse of the document content -
    checked before spending a Bedrock call on a file that's too big. */
export async function countPdfPages(bytes) {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  return doc.getPageCount();
}

export const handler = async (event) => {
  const method = event.requestContext?.http?.method || event.httpMethod;
  if (method === "OPTIONS") return { statusCode: 204, headers: CORS_HEADERS };

  try {
    await checkRateLimit(event);
  } catch (err) {
    if (err instanceof RateLimitError)
      return json(429, { ok: false, error: err.message });
    throw err;
  }

  let user;
  try {
    user = await requireUser(event);
  } catch (err) {
    if (err instanceof AuthError)
      return json(401, { ok: false, error: err.message });
    console.error(`[extract auth] ${err.message}`, err.stack);
    return json(500, { ok: false, error: "Request failed." });
  }

  const payload = JSON.parse(event.body || "{}");
  const { fileType, fileBase64, categoryNames } = payload;

  if (fileType !== "csv" && fileType !== "pdf")
    return json(400, { ok: false, error: 'fileType must be "csv" or "pdf".' });
  if (typeof fileBase64 !== "string" || !fileBase64)
    return json(400, { ok: false, error: "fileBase64 is required." });
  if (!Array.isArray(categoryNames) || categoryNames.length === 0)
    return json(400, { ok: false, error: "categoryNames is required." });

  const fileBuffer = Buffer.from(fileBase64, "base64");
  if (fileBuffer.length > MAX_FILE_BYTES)
    return json(400, {
      ok: false,
      error: `File is too large (max ${MAX_FILE_BYTES / 1024 / 1024}MB).`,
    });

  if (fileType === "pdf") {
    const pageCount = await countPdfPages(fileBuffer);
    if (pageCount > MAX_PDF_PAGES)
      return json(400, {
        ok: false,
        error: `This PDF has ${pageCount} pages — the limit is ${MAX_PDF_PAGES}. Try uploading a single month's statement.`,
      });
  }

  try {
    const result = await runInTenantTransaction(
      user.tenantId,
      user.sub,
      async (execute) => {
        const [tenantRow] = await execute.rows(
          `select plan from tenants where id = cast(current_setting('app.tenant_id', true) as uuid)`,
        );
        assertAiImportAllowed(tenantRow);

        const used = await countThisMonth(execute);
        if (used >= AI_IMPORT_MONTHLY_CAP)
          throw new AiImportGateError(
            `You've used your ${AI_IMPORT_MONTHLY_CAP} AI imports this month.`,
          );

        const fileContent =
          fileType === "csv" ? fileBuffer.toString("utf8") : fileBuffer;
        const extracted = await extractTransactions(bedrock, {
          fileType,
          fileContent,
          categoryNames,
          modelId: process.env.BEDROCK_MODEL_ID,
        });
        await recordAttempt(execute);
        return extracted;
      },
    );
    return json(200, { ok: true, ...result });
  } catch (err) {
    if (err instanceof AiImportGateError)
      return json(403, { ok: false, error: err.message });
    console.error(
      `[${user.tenantId}] extract failed: ${err.message}`,
      err.stack,
    );
    return json(500, { ok: false, error: "Request failed." });
  }
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd Expense_tracker_New/backend && node --test test/extract-gating.test.js`
Expected: PASS, all 6 tests.

- [ ] **Step 5: Run the full suite and commit**

Run: `cd Expense_tracker_New/backend && npm test`
Expected: all tests pass.

```bash
git add Expense_tracker_New/backend/src/extract.js Expense_tracker_New/backend/test/extract-gating.test.js
git commit -m "feat: add the ExtractFunction Lambda handler"
```

---

### Task 6: Infrastructure — `template.yaml`, deploy docs

**Files:**

- Modify: `Expense_tracker_New/backend/template.yaml`
- Modify: `Expense_tracker_New/DEPLOYMENT.md`

**Interfaces:**

- Consumes: `extract.handler` (Task 5), `RateLimitTable`/`DbCluster`/`DbSecret` (already exist in `template.yaml`).
- Produces: a deployable `POST /extract` route. Nothing later in this plan depends on template.yaml directly (the frontend calls the route by URL, not by CloudFormation reference), but this task must land before the feature can ever run against a real deployment.

- [ ] **Step 1: Add the `BedrockModelId` parameter**

In `Expense_tracker_New/backend/template.yaml`, find the `Parameters:` section's `StripePriceIdFamily:` entry and add immediately after it:

```yaml
BedrockModelId:
  Type: String
  Default: anthropic.claude-3-5-sonnet-20241022-v2:0
  Description: >-
    Bedrock model id for AI transaction extraction (extract.js). Model
    availability varies by region and requires enabling model access in
    the AWS account first - verify both before deploying to a new
    region (see this feature's spec, Open Questions #1-2).
```

- [ ] **Step 2: Add the `ExtractFunction` resource**

In the same file, find the `DataFunction:` resource block and add a new sibling resource immediately after its closing (right before the `PostConfirmationFunction:` resource):

```yaml
ExtractFunction:
  Type: AWS::Serverless::Function
  Properties:
    CodeUri: src/
    Handler: extract.handler
    Timeout: 25 # under API Gateway's hard 29s integration ceiling - see this feature's spec, Architecture §2
    Environment:
      Variables:
        RATE_LIMIT_TABLE: !Ref RateLimitTable
        BEDROCK_MODEL_ID: !Ref BedrockModelId
    Policies:
      - Statement:
          - Effect: Allow
            Action:
              - rds-data:ExecuteStatement
              - rds-data:BeginTransaction
              - rds-data:CommitTransaction
              - rds-data:RollbackTransaction
            Resource: !GetAtt DbCluster.DBClusterArn
          - Effect: Allow
            Action: secretsmanager:GetSecretValue
            Resource: !Ref DbSecret
          - Effect: Allow
            Action: dynamodb:UpdateItem
            Resource: !GetAtt RateLimitTable.Arn
          - Effect: Allow
            Action: bedrock:InvokeModel
            Resource: !Sub arn:aws:bedrock:${AWS::Region}::foundation-model/${BedrockModelId}
    Events:
      Post:
        Type: HttpApi
        Properties:
          ApiId: !Ref HttpApi
          Path: /extract
          Method: POST
      Options:
        Type: HttpApi
        Properties:
          ApiId: !Ref HttpApi
          Path: /extract
          Method: OPTIONS
```

- [ ] **Step 3: Validate the template**

Run: `cd Expense_tracker_New/backend && AWS_DEFAULT_REGION=us-east-1 sam validate`
Expected: `... is a valid SAM Template.`

Run: `cd Expense_tracker_New/backend && sam build`
Expected: `Build Succeeded.`

- [ ] **Step 4: Update the deploy guide's parameter table**

In `Expense_tracker_New/DEPLOYMENT.md`, find Phase 2's parameter table (the row for `StripePriceIdFamily`) and add immediately after it:

```markdown
| Parameter `BedrockModelId` | leave the default unless you need a different region/model |
```

Also add a note directly below that table (after the existing `FrontendUrl` callout), since Bedrock model access is a real MUST-VERIFY-AGAINST-REAL-AWS gotcha the same way Cognito's two assumptions already are:

```markdown
**Bedrock model access**: unlike the other parameters above, `BedrockModelId`
needs the model itself _enabled_ for your account in this region before
`ExtractFunction` can call it — AWS Console → Bedrock → Model access,
request access to the Anthropic models if you haven't already. This is
a real thing to verify, not a formality: a request against a model your
account hasn't been granted access to fails at call time, not at deploy
time, so nothing here catches it early.
```

- [ ] **Step 5: Commit**

```bash
git add Expense_tracker_New/backend/template.yaml Expense_tracker_New/DEPLOYMENT.md
git commit -m "feat: wire ExtractFunction into the SAM template and deploy guide"
```

---

### Task 7: `store.js` — `extractTransactions()`

**Files:**

- Modify: `Expense_tracker_New/frontend/assets/store.js`

**Interfaces:**

- Consumes: nothing new from earlier tasks (this is the frontend's own contract with the `/extract` route Task 5/6 built).
- Produces: `ApiStore.extractTransactions(fileName, fileType, fileBase64, categoryNames)` → `Promise<{ transactions: [...], skipped: number }>` (throws on any error, same convention as every other `ApiStore` method). `DisconnectedStore.extractTransactions()` → throws `notConnected()`. Task 8 calls `state.store.extractTransactions(...)`.

- [ ] **Step 1: Add `_postTo`, refactor `_post` to use it**

Open `Expense_tracker_New/frontend/assets/store.js`. Find the `_post(payload, ...)` method on `ApiStore` (the one that does `fetch(\`${this.endpoint}/data\`, ...)`). Its current signature hardcodes the `/data`path;`/extract`needs the same retry/401/network-error handling against a different path. Change the`fetch`line inside`_post` from:

```javascript
      res = await fetch(`${this.endpoint}/data`, {
```

to:

```javascript
      res = await fetch(`${this.endpoint}${path}`, {
```

and change the method signature from `async _post(payload, attempt = 1, retriedWithoutTenant = false) {` to:

```javascript
  async _post(payload, attempt = 1, retriedWithoutTenant = false, path = "/data") {
```

and update every recursive call inside `_post` (the retry-on-network-blip call and the retry-on-tenant-rejection call) to pass `path` through, e.g. `return this._post(payload, attempt + 1, retriedWithoutTenant, path);` and `return this._post(payload, 1, true, path);` — match the exact parameter list each existing recursive call already uses, just appending `, path`.

- [ ] **Step 2: Add `extractTransactions` to `ApiStore`**

In the same file, find `getPlans()` on `ApiStore` and add a new method immediately after it:

```javascript
  /** Uploads a CSV/PDF for AI extraction - see backend/src/extract.js.
      Unlike every other ApiStore method, this can legitimately take up to
      ~20 seconds (a Bedrock call over a multi-page PDF), so callers
      should show a loading message that says so rather than the instant-
      feeling wording used everywhere else in this app. */
  async extractTransactions(fileName, fileType, fileBase64, categoryNames) {
    const r = await this._post(
      { fileName, fileType, fileBase64, categoryNames },
      1,
      false,
      "/extract",
    );
    return { transactions: r.transactions || [], skipped: r.skipped || 0 };
  }
```

- [ ] **Step 3: Add the `DisconnectedStore` stub**

Find `DisconnectedStore`'s `getPlanPricing`/`getPlans` stub (whichever is currently there per this codebase's history) and add immediately after it:

```javascript
  async extractTransactions() {
    notConnected();
  }
```

- [ ] **Step 4: Verify and commit**

Run: `cd Expense_tracker_New/frontend/assets && node --check store.js`
Expected: no output (syntax OK).

Manual verification (no frontend test runner exists in this codebase):

1. Start the local server: `cd Expense_tracker_New/frontend && python3 -m http.server 8080`.
2. Open `http://localhost:8080` in a browser, open devtools console.
3. Confirm the page loads with no new console errors (the `_post` signature change must not have broken the existing CSV/XLSX import, budget save, or any other write action — click through Add, Budget, Data → Download .xlsx to confirm those still work).

```bash
git add Expense_tracker_New/frontend/assets/store.js
git commit -m "feat: add ApiStore.extractTransactions, refactor _post for multiple routes"
```

---

### Task 8: `app.js` — upload control, review table, plan gating

**Files:**

- Modify: `Expense_tracker_New/frontend/assets/app.js`

**Interfaces:**

- Consumes: `state.store.extractTransactions()` (Task 7); `state.plans` / `planCopy()` / `planFeatureList()` (already exist from the earlier plan-list refactor); `state.tenant.plan` (already exists).
- Produces: nothing further downstream — this is the last task in this plan.

- [ ] **Step 1: Add the "AI-powered import" feature bullet**

Open `Expense_tracker_New/frontend/assets/app.js`. Find `planFeatureList(features)`:

```javascript
function planFeatureList(features) {
  const list = [
    features.historyMonths == null
      ? "Full history, every year"
      : `Last ${features.historyMonths} months of history`,
  ];
  if (features.netWorth) list.push("Net worth tracking");
  return list;
}
```

Add one line so it also renders the new flag:

```javascript
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
```

- [ ] **Step 2: Add the upload control and review-table renderer to the Data tab**

Find `renderData()`'s `<div class="eyebrow">Import</div>` section (the existing CSV/XLSX file input). Add a new sibling section immediately after that whole `<div class="panel stack">...</div>` block, before the next `<div class="eyebrow">People</div>`:

```javascript
  <div class="eyebrow">AI Import</div>
  <div class="panel stack">
    ${
      !state.tenant?.aiImportAllowed
        ? `<p class="note" style="margin:0">Upload a bank or credit-card statement (CSV or PDF) and let AI read it for you — <b>available on the Pro and Family plans.</b> <a href="#billing" data-goto-billing>Upgrade from Billing</a>.</p>`
        : state.tenant?.aiImportsRemaining <= 0
          ? `<p class="note" style="margin:0">You've used all your AI imports for this month. It resets at the start of next month.</p>`
          : `
    <input type="file" id="ai-file" accept=".csv,.pdf">
    <p class="note" style="margin:0">Upload a real bank or credit-card statement — AI reads it and maps it into your categories. You review everything before anything is saved. ${esc(String(state.tenant?.aiImportsRemaining ?? ""))} import${state.tenant?.aiImportsRemaining === 1 ? "" : "s"} left this month.</p>
    <div id="ai-review"></div>`
    }
  </div>
```

Add the click-through-to-Billing wiring and the file-input handler right after the existing `$("#file").onchange = ...` block in `renderData()`:

```javascript
view.querySelector("[data-goto-billing]")?.addEventListener("click", (e) => {
  e.preventDefault();
  go("billing");
});

$("#ai-file")?.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reviewEl = $("#ai-review");
  const fileType = file.name.toLowerCase().endsWith(".pdf") ? "pdf" : "csv";
  reviewEl.innerHTML = `<p class="note">Reading your statement — this can take up to 20 seconds…</p>`;

  try {
    const buf = await file.arrayBuffer();
    const fileBase64 = btoa(
      new Uint8Array(buf).reduce((s, b) => s + String.fromCharCode(b), ""),
    );
    const { transactions, skipped } = await state.store.extractTransactions(
      file.name,
      fileType,
      fileBase64,
      CAT_NAMES,
    );
    renderAiReviewTable(reviewEl, transactions, skipped);
  } catch (err) {
    reviewEl.innerHTML = `<b class="over">${esc(err.message)}</b>`;
  }
});
```

Add the review-table renderer as a new top-level function, right after `renderData()`'s closing brace:

```javascript
/** Renders the read-only, checkbox-driven review table for AI-extracted
    transactions - see this feature's spec, Architecture §7. No inline
    editing (Non-goals): anything wrong here gets fixed after import via
    the normal Transactions edit flow, same as any other imported row. */
function renderAiReviewTable(reviewEl, transactions, skipped) {
  if (transactions.length === 0) {
    reviewEl.innerHTML = `<p class="note">No transactions found in this file.${skipped ? ` (${skipped} row${skipped === 1 ? "" : "s"} couldn't be read reliably.)` : ""}</p>`;
    return;
  }

  reviewEl.innerHTML = `
    ${skipped ? `<p class="note" style="margin:0 0 8px">${skipped} row${skipped === 1 ? "" : "s"} couldn't be read reliably and ${skipped === 1 ? "isn't" : "aren't"} shown below.</p>` : ""}
    <table class="ai-review-table">
      <thead><tr><th></th><th>Date</th><th>Type</th><th>Category</th><th>Description</th><th>Amount</th></tr></thead>
      <tbody>
        ${transactions
          .map(
            (t, i) => `
        <tr class="${t.confidence === "low" ? "ai-low-confidence" : ""}">
          <td><input type="checkbox" class="ai-row-check" data-idx="${i}" checked></td>
          <td>${esc(t.date)}</td>
          <td>${esc(t.type)}</td>
          <td>${esc(t.category)}${t.confidence === "low" ? ' <span class="ai-flag" title="Low confidence — double-check this row">⚠</span>' : ""}</td>
          <td>${esc(t.description)}</td>
          <td class="num">${esc(money(t.amount))}</td>
        </tr>`,
          )
          .join("")}
      </tbody>
    </table>
    <div class="actions" style="margin-top:10px">
      <button class="btn" id="ai-import-selected">Import selected</button>
    </div>`;

  reviewEl.querySelector("#ai-import-selected").onclick = async () => {
    const checked = [...reviewEl.querySelectorAll(".ai-row-check:checked")].map(
      (cb) => transactions[Number(cb.dataset.idx)],
    );
    if (!checked.length) return notice("Select at least one row.", "bad");
    const done = await withBusy(
      `Importing ${checked.length} transactions`,
      async () => {
        await state.store.bulkAdd(checked);
        await refresh();
      },
    );
    if (done) {
      notice(`Imported ${checked.length} transactions.`, "ok");
      reviewEl.innerHTML = "";
      renderData();
    }
  };
}
```

- [ ] **Step 3: Surface `aiImportAllowed`/`aiImportsRemaining` on `state.tenant`**

The template above reads `state.tenant.aiImportAllowed` and `state.tenant.aiImportsRemaining`, which don't exist yet. Find `refresh()`'s existing `state.tenant = (await state.store.getTenant?.()) || {...}` line and add these two derived fields right after it:

```javascript
state.tenant.aiImportAllowed = !!state.plans?.find(
  (p) => p.id === state.tenant.plan,
)?.features?.aiImport;
state.tenant.aiImportsRemaining =
  state.tenant.aiImportsUsedThisMonth != null
    ? Math.max(0, 20 - state.tenant.aiImportsUsedThisMonth)
    : null;
```

Note: this reads `state.plans`, which is only populated once `ensurePlans()` has resolved (it's fetched lazily — see the earlier plan-list refactor). On a page load before that resolves, `aiImportAllowed` is `false` and the upgrade-upsell message shows first; once `ensurePlans()`'s callback re-renders whichever page is showing (already wired for Billing/the plan gate), it does NOT currently re-render the Data tab. Add that: find `ensurePlans`'s existing callers in `renderBilling`/`renderPlanGate` for the pattern, and add a third call at the end of `renderData()`:

```javascript
ensurePlans(() => {
  if (state.tab === "data") renderData();
});
```

Also note `aiImportsRemaining`'s hardcoded `20` should read the real cap rather than repeat it — but this plan's backend tasks did not expose `AI_IMPORT_MONTHLY_CAP` through any API response (`GET /data`'s `tenant` object only gains `aiImportsUsedThisMonth`, per the spec — the cap value itself isn't sent). For this task, hardcode `20` with a comment referencing the constant it must match:

```javascript
// Must match AI_IMPORT_MONTHLY_CAP in backend/src/plans.js - not sent
// over the wire today, so this is a second, manually-synced copy.
// Low-risk (display only, the real enforcement is server-side), but
// worth revisiting if backend/src/plans.js's value ever changes.
```

- [ ] **Step 4: Verify and commit**

Run: `cd Expense_tracker_New/frontend/assets && node --check app.js`
Expected: no output (syntax OK).

Manual verification:

1. `cd Expense_tracker_New/frontend && python3 -m http.server 8080`, open `http://localhost:8080`.
2. Without a real backend connected, confirm the Data tab still renders (the AI Import panel should show the Free-plan upsell message, since a disconnected/default tenant has no `aiImportAllowed`).
3. Confirm no new console errors on any tab (Dashboard, Add, Transactions, Budget, Net Worth, Data, Billing, Profile).
4. If a real deployed backend is available: sign in as a Pro/Family tenant, upload a small real or sample bank CSV, confirm the review table renders, confirm unchecking a row and clicking "Import selected" only imports the checked rows, confirm the imported rows appear correctly in Transactions.

```bash
git add Expense_tracker_New/frontend/assets/app.js
git commit -m "feat: add AI import upload control and review table to the Data tab"
```

---

## Self-Review Notes

**Spec coverage**: every numbered Architecture section in the spec maps to a task — §1/§2 → Task 5/6, §3 → Task 3, §4 → Task 6 (route)/Task 7 (client), §5 → Task 1/4, §6 → Task 2/8, §7 → Task 7/8. Error handling cases are all implemented in Task 5's `handler` (cap check before Bedrock, page-count check before Bedrock, schema-validation drop-not-crash in Task 3). Testing section's "Bedrock always mocked" is followed in every test file that touches extraction.

**Type/name consistency verified**: `extractTransactions` (Task 3's business logic, Task 7's `ApiStore` method — same name, different modules, deliberate mirror of the pattern `getPlans` already uses on both sides), `AI_IMPORT_MONTHLY_CAP` (Task 2 defines, Task 4/5/8 all reference the same name), `categoryNames` (consistent parameter name from Task 3 through Task 8), `aiImport` (the `FEATURES` flag name, consistent Task 2/5/8).

**One known follow-up, not a gap**: Task 8, Step 3 hardcodes `20` client-side as a synced-by-hand copy of `AI_IMPORT_MONTHLY_CAP`, since the spec's `GET /data` response shape only adds `aiImportsUsedThisMonth`, not the cap value itself. Flagged in-line in the task; low-risk since it's display-only and the real enforcement is entirely server-side (Task 5). A future task could add the cap value to that response if this proves annoying to keep in sync.

---

## Execution

Plan complete and saved to `docs/superpowers/plans/2026-08-23-ai-transaction-import.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
