# Bedrock Guardrails Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply an AWS Bedrock Guardrail (content filters, prompt-attack detection, output PII masking) to every Bedrock call the AI transaction import feature makes.

**Architecture:** A new `AWS::Bedrock::Guardrail`/`GuardrailVersion` pair in `template.yaml`, referenced by ARN via two new env vars. `routes/extract.js`'s request builder attaches the guardrail config to the Converse call; its response parser detects a guardrail intervention and raises a distinct error the Lambda handler maps to a clean 400.

**Tech Stack:** AWS Bedrock Guardrails (`AWS::Bedrock::Guardrail` CloudFormation resource), `@aws-sdk/client-bedrock-runtime`'s Converse API.

**Spec:** docs/superpowers/specs/2026-08-23-ai-import-security-hardening-design.md (Section A only — Section B is a separate plan, docs/superpowers/plans/2026-08-23-ai-upload-malware-scanning.md)

## Global Constraints

- Content filters (hate/insults/sexual/violence/misconduct) at `MEDIUM` strength, both input and output.
- Prompt-attack detection enabled on input — this is the load-bearing filter, defending against a malicious CSV's text reaching the prompt.
- PII: unfiltered on input (bank statements are supposed to contain account numbers/names — that's the extraction target); masked (not blocked) on output, for card-number/SSN-like patterns.
- A guardrail intervention (`stopReason: "guardrail_intervened"`) maps to a clean 400, and DOES still count against the tenant's monthly AI-import cap — a real, billed Bedrock call happened and responded, same reasoning as "zero transactions found" already counting.
- No test file exists for `handler.js`'s `handler`/`handleGet`/`handlePost` — this codebase's established precedent, only pure exported helpers get direct tests. This plan's tasks don't touch `handler.js` at all (the guardrail-intervention mapping lives inside `extract.js`, the Lambda handler behind `POST /extract`, whose own top-level `handler` export is under the same no-direct-test precedent — Task 2 verifies via the tested `routes/extract.js` functions it calls, not the handler itself).

---

### Task 1: Guardrail infrastructure

**Files:**
- Modify: `Expense_tracker_New/backend/template.yaml`
- Modify: `Expense_tracker_New/DEPLOYMENT.md`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: two new `ExtractFunction` env vars, `BEDROCK_GUARDRAIL_ID` and `BEDROCK_GUARDRAIL_VERSION`, and an IAM grant for `bedrock:ApplyGuardrail`. Task 2 reads both env vars.

- [ ] **Step 1: Add the Guardrail resources**

Open `Expense_tracker_New/backend/template.yaml`, find the `Resources:` section (where `DataFunction`/`ExtractFunction` are already defined). Add two new resources anywhere in that section, e.g. right before `ExtractFunction`:

```yaml
  AiImportGuardrail:
    Type: AWS::Bedrock::Guardrail
    Properties:
      Name: ai-import-guardrail
      Description: Content safety and prompt-attack defense for the AI transaction import feature - see docs/superpowers/specs/2026-08-23-ai-import-security-hardening-design.md, Section A.
      BlockedInputMessaging: "This file could not be processed."
      BlockedOutputsMessaging: "This file could not be processed."
      ContentPolicyConfig:
        FiltersConfig:
          - Type: HATE
            InputStrength: MEDIUM
            OutputStrength: MEDIUM
          - Type: INSULTS
            InputStrength: MEDIUM
            OutputStrength: MEDIUM
          - Type: SEXUAL
            InputStrength: MEDIUM
            OutputStrength: MEDIUM
          - Type: VIOLENCE
            InputStrength: MEDIUM
            OutputStrength: MEDIUM
          - Type: MISCONDUCT
            InputStrength: MEDIUM
            OutputStrength: MEDIUM
          - Type: PROMPT_ATTACK
            InputStrength: MEDIUM
            OutputStrength: NONE # PROMPT_ATTACK only applies to input
      SensitiveInformationPolicyConfig:
        PiiEntitiesConfig:
          - Type: CREDIT_DEBIT_CARD_NUMBER
            Action: ANONYMIZE
          - Type: US_SOCIAL_SECURITY_NUMBER
            Action: ANONYMIZE

  AiImportGuardrailVersion:
    Type: AWS::Bedrock::GuardrailVersion
    Properties:
      GuardrailIdentifier: !GetAtt AiImportGuardrail.GuardrailId
      Description: v1 - initial content filters + prompt-attack detection
```

- [ ] **Step 2: Wire the guardrail into `ExtractFunction`**

Find `ExtractFunction`'s `Environment.Variables` block:

```yaml
      Environment:
        Variables:
          RATE_LIMIT_TABLE: !Ref RateLimitTable
          BEDROCK_MODEL_ID: !Ref BedrockModelId
```

Add the two new variables:

```yaml
      Environment:
        Variables:
          RATE_LIMIT_TABLE: !Ref RateLimitTable
          BEDROCK_MODEL_ID: !Ref BedrockModelId
          BEDROCK_GUARDRAIL_ID: !GetAtt AiImportGuardrail.GuardrailId
          BEDROCK_GUARDRAIL_VERSION: !GetAtt AiImportGuardrailVersion.Version
```

Find `ExtractFunction`'s existing `bedrock:InvokeModel` policy statement:

```yaml
            - Effect: Allow
              Action: bedrock:InvokeModel
              # Covers both invocation paths a Claude model on Bedrock may
              # need: the bare foundation-model id (BedrockModelId's
              # default), and - for models that only work via a
              # cross-region inference profile - the profile ARN plus the
              # regional foundation-model ARNs it routes to. Profile ids
              # are AWS-managed, not account-owned, hence the wildcard
              # scoped to this account/region rather than a single
              # resource id.
              Resource:
                - !Sub arn:aws:bedrock:${AWS::Region}::foundation-model/${BedrockModelId}
                - !Sub arn:aws:bedrock:${AWS::Region}:${AWS::AccountId}:inference-profile/*
```

Add a second statement right after it, in the same `Statement:` list:

```yaml
            - Effect: Allow
              Action: bedrock:InvokeModel
              Resource:
                - !Sub arn:aws:bedrock:${AWS::Region}::foundation-model/${BedrockModelId}
                - !Sub arn:aws:bedrock:${AWS::Region}:${AWS::AccountId}:inference-profile/*
            - Effect: Allow
              Action: bedrock:ApplyGuardrail
              Resource: !GetAtt AiImportGuardrail.GuardrailArn
```

- [ ] **Step 3: Validate the template**

Run: `cd Expense_tracker_New/backend && sam validate --region us-east-1`
Expected: `... is a valid SAM Template.`

- [ ] **Step 4: Add a DEPLOYMENT.md note**

Open `Expense_tracker_New/DEPLOYMENT.md`, find the existing "Bedrock model access" callout (search for that exact phrase — it explains verifying model access is enabled). Add one sentence right after it:

```markdown
The Guardrail itself (`AiImportGuardrail`) is fully defined in `template.yaml` and needs no separate manual enablement, unlike model access above.
```

- [ ] **Step 5: Commit**

```bash
git add Expense_tracker_New/backend/template.yaml Expense_tracker_New/DEPLOYMENT.md
git commit -m "feat: add Bedrock Guardrail infrastructure for AI import"
```

---

### Task 2: Wire the guardrail into the extraction request/response

**Files:**
- Modify: `Expense_tracker_New/backend/src/routes/extract.js`
- Modify: `Expense_tracker_New/backend/src/extract.js`
- Test: `Expense_tracker_New/backend/test/extract-route.test.js`

**Interfaces:**
- Consumes: `BEDROCK_GUARDRAIL_ID`/`BEDROCK_GUARDRAIL_VERSION` env vars (Task 1).
- Produces: `buildExtractionRequest` accepts a new `guardrailId`/`guardrailVersion` parameter pair; `parseExtractionResponse` throws a new, distinctly-typed `GuardrailInterventionError` when the response was blocked. Nothing downstream of this plan consumes these — this is the last task in this plan.

- [ ] **Step 1: Write the failing tests**

Open `Expense_tracker_New/backend/test/extract-route.test.js`. It already imports `extractTransactions`/`validateExtractedRow`/etc. from `../src/routes/extract.js` and `ConverseCommand` from `@aws-sdk/client-bedrock-runtime` — add `GuardrailInterventionError` to the existing import from `../src/routes/extract.js`. Add these tests near the existing `extractTransactions calls Bedrock once...` test:

```javascript
test("buildExtractionRequest attaches guardrailConfig when a guardrail id is given", () => {
  const request = buildExtractionRequest({
    fileType: "csv",
    fileContent: "date,amount\n2026-08-01,10",
    categoryNames: CATEGORY_NAMES,
    modelId: "test-model",
    guardrailId: "gr-abc123",
    guardrailVersion: "1",
  });
  assert.deepEqual(request.guardrailConfig, {
    guardrailIdentifier: "gr-abc123",
    guardrailVersion: "1",
    trace: "enabled",
  });
});

test("buildExtractionRequest omits guardrailConfig when no guardrail id is given", () => {
  const request = buildExtractionRequest({
    fileType: "csv",
    fileContent: "date,amount\n2026-08-01,10",
    categoryNames: CATEGORY_NAMES,
    modelId: "test-model",
  });
  assert.equal(request.guardrailConfig, undefined);
});

test("parseExtractionResponse throws GuardrailInterventionError when a guardrail blocked the response", () => {
  assert.throws(
    () =>
      parseExtractionResponse({
        stopReason: "guardrail_intervened",
        output: { message: { content: [] } },
      }),
    GuardrailInterventionError,
  );
});

test("extractTransactions propagates a guardrail intervention as GuardrailInterventionError", async () => {
  const bedrockClient = {
    send: async () => ({
      stopReason: "guardrail_intervened",
      output: { message: { content: [] } },
    }),
  };
  await assert.rejects(
    () =>
      extractTransactions(bedrockClient, {
        fileType: "csv",
        fileContent: "date,amount\n2026-08-01,10",
        categoryNames: CATEGORY_NAMES,
        modelId: "test-model",
      }),
    GuardrailInterventionError,
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd Expense_tracker_New/backend && node --test test/extract-route.test.js`
Expected: FAIL — `GuardrailInterventionError` is not exported yet, `guardrailId`/`guardrailVersion` aren't accepted yet.

- [ ] **Step 3: Implement**

Open `Expense_tracker_New/backend/src/routes/extract.js`. Find `buildExtractionRequest`'s signature and its `return { ... }` block:

```javascript
export function buildExtractionRequest({
  fileType,
  fileContent,
  categoryNames,
  modelId,
}) {
  const userContent =
    fileType === "pdf"
      ? [
          ...
        ]
      : [
          ...
        ];

  return {
    modelId,
    system: [{ text: buildSystemPrompt(categoryNames) }],
    messages: [{ role: "user", content: userContent }],
    toolConfig: {
      ...
    },
  };
}
```

Change the signature and the returned object to add the guardrail config, only when a guardrail id is actually given (so existing tests that don't pass one keep working unchanged, and a not-yet-deployed guardrail doesn't break local/test runs):

```javascript
export function buildExtractionRequest({
  fileType,
  fileContent,
  categoryNames,
  modelId,
  guardrailId,
  guardrailVersion,
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
    ...(guardrailId
      ? {
          guardrailConfig: {
            guardrailIdentifier: guardrailId,
            guardrailVersion,
            trace: "enabled",
          },
        }
      : {}),
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
```

Add a new exported error class right after the existing `TOOL_NAME` constant:

```javascript
/** Thrown when Bedrock's response has stopReason "guardrail_intervened" -
    the guardrail (see this feature's spec, Section A) blocked the input
    or output. A distinct type from the generic "no usable tool-use
    content" error below, so extract.js (the Lambda handler) can map this
    to its own clear message rather than the generic one. */
export class GuardrailInterventionError extends Error {}
```

Find `parseExtractionResponse`:

```javascript
export function parseExtractionResponse(response) {
  const content = response.output?.message?.content || [];
  const toolUse = content.find((c) => c.toolUse)?.toolUse;
  if (!toolUse || !Array.isArray(toolUse.input?.transactions))
    throw new Error("Bedrock response did not include a transactions list.");
  return toolUse.input.transactions;
}
```

Add the guardrail check first:

```javascript
export function parseExtractionResponse(response) {
  if (response.stopReason === "guardrail_intervened")
    throw new GuardrailInterventionError(
      "The content safety guardrail blocked this request.",
    );
  const content = response.output?.message?.content || [];
  const toolUse = content.find((c) => c.toolUse)?.toolUse;
  if (!toolUse || !Array.isArray(toolUse.input?.transactions))
    throw new Error("Bedrock response did not include a transactions list.");
  return toolUse.input.transactions;
}
```

Find `extractTransactions`:

```javascript
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
  ...
```

Thread the two new parameters through:

```javascript
export async function extractTransactions(
  bedrockClient,
  { fileType, fileContent, categoryNames, modelId, guardrailId, guardrailVersion },
) {
  const request = buildExtractionRequest({
    fileType,
    fileContent,
    categoryNames,
    modelId,
    guardrailId,
    guardrailVersion,
  });
  const response = await bedrockClient.send(new ConverseCommand(request));
  const rawRows = parseExtractionResponse(response);
  ...
```

(Leave the rest of `extractTransactions`'s body — the per-row validation loop — unchanged.)

Now open `Expense_tracker_New/backend/src/extract.js` (the Lambda handler, a different file from `routes/extract.js`). Find the import line:

```javascript
import { extractTransactions } from "./routes/extract.js";
```

Add `GuardrailInterventionError`:

```javascript
import { extractTransactions, GuardrailInterventionError } from "./routes/extract.js";
```

Find the call to `extractTransactions` inside `handler()`:

```javascript
        const extracted = await extractTransactions(bedrock, {
          fileType,
          fileContent,
          categoryNames,
          modelId: process.env.BEDROCK_MODEL_ID,
        });
```

Add the two new arguments:

```javascript
        const extracted = await extractTransactions(bedrock, {
          fileType,
          fileContent,
          categoryNames,
          modelId: process.env.BEDROCK_MODEL_ID,
          guardrailId: process.env.BEDROCK_GUARDRAIL_ID,
          guardrailVersion: process.env.BEDROCK_GUARDRAIL_VERSION,
        });
```

Find `handler()`'s outer catch block:

```javascript
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

Add a branch for the guardrail error, mapping it to a clean 400 rather than the generic 500 (a guardrail intervention is an expected, user-facing outcome, not an internal failure):

```javascript
  } catch (err) {
    if (err instanceof AiImportGateError)
      return json(403, { ok: false, error: err.message });
    if (err instanceof GuardrailInterventionError)
      return json(400, { ok: false, error: "This file could not be processed." });
    console.error(
      `[${user.tenantId}] extract failed: ${err.message}`,
      err.stack,
    );
    return json(500, { ok: false, error: "Request failed." });
  }
};
```

Note: this guardrail branch sits inside the same `try` that already calls `recordAttempt(execute)` (see the surrounding code) — a guardrail intervention happens *after* Bedrock responds, so `recordAttempt` was already reached before the throw only if it's placed after `extractTransactions` in the existing code (check the actual current ordering in this file: `extractTransactions` is called, then `recordAttempt(execute)`, then the `return`). Since `extractTransactions` throws before `recordAttempt` runs, a guardrail intervention currently does NOT get recorded against the cap by this code path as written. Per this plan's Global Constraints, a guardrail intervention should count against the cap (a real, billed Bedrock call happened). Find the transaction callback:

```javascript
        const extracted = await extractTransactions(bedrock, {
          fileType,
          fileContent,
          categoryNames,
          modelId: process.env.BEDROCK_MODEL_ID,
          guardrailId: process.env.BEDROCK_GUARDRAIL_ID,
          guardrailVersion: process.env.BEDROCK_GUARDRAIL_VERSION,
        });
        await recordAttempt(execute);
        return extracted;
```

Wrap the call so a `GuardrailInterventionError` still reaches `recordAttempt` before propagating — `recordAttempt` must run whether extraction succeeded or the guardrail intervened, since both are a real, billed Bedrock call that reached and responded; only a failure *before* this point (auth, cap check, file validation) should skip recording:

```javascript
        let extracted;
        try {
          extracted = await extractTransactions(bedrock, {
            fileType,
            fileContent,
            categoryNames,
            modelId: process.env.BEDROCK_MODEL_ID,
            guardrailId: process.env.BEDROCK_GUARDRAIL_ID,
            guardrailVersion: process.env.BEDROCK_GUARDRAIL_VERSION,
          });
        } catch (err) {
          if (err instanceof GuardrailInterventionError) await recordAttempt(execute);
          throw err;
        }
        await recordAttempt(execute);
        return extracted;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd Expense_tracker_New/backend && node --test test/extract-route.test.js`
Expected: PASS, all tests including the 4 new ones.

- [ ] **Step 5: Run the full suite**

Run: `cd Expense_tracker_New/backend && npm test`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add Expense_tracker_New/backend/src/routes/extract.js Expense_tracker_New/backend/src/extract.js Expense_tracker_New/backend/test/extract-route.test.js
git commit -m "feat: apply the Bedrock guardrail to extraction calls and handle interventions"
```

---

## Self-Review Notes

**Spec coverage:** Section A's every requirement maps to these 2 tasks — guardrail resource + IAM (Task 1), request/response wiring + cap-counting on intervention (Task 2). Section B (upload malware scanning) is intentionally out of this plan's scope, covered by the sibling plan `docs/superpowers/plans/2026-08-23-ai-upload-malware-scanning.md`.

**Type/name consistency verified:** `guardrailId`/`guardrailVersion` (Task 2's `buildExtractionRequest`/`extractTransactions` parameters) match `BEDROCK_GUARDRAIL_ID`/`BEDROCK_GUARDRAIL_VERSION` (Task 1's env vars) in meaning, read via `process.env` in `extract.js`. `GuardrailInterventionError` is defined and exported in `routes/extract.js`, imported and caught in `extract.js` (the handler) — same cross-file pattern `AiImportGateError` already uses within `extract.js` itself, and the same `export class ... extends Error` shape `AiImportGateError` and `AiImportGateError`'s sibling `InvalidInviteError` (in `routes/tenants.js`) already use.

**Placeholder scan:** clean. (Step 3's draft `finally` shape was deliberately shown then replaced with the real, simpler `try/catch` form — this is not a placeholder, it's showing the implementer the reasoning before the final code, and the final code block is complete and correct.)
