/* Turns a CSV/PDF into a reviewable list of transactions via Bedrock.
   No Lambda event, no DB, no auth here - extract.js (the Lambda handler)
   is the only caller, and it owns all of that. This file's only job is
   "given file bytes and the app's real vocabulary, call the model and
   come back with something safe to show a user," which is why it's
   testable with nothing but a mocked bedrockClient.send. */

import { ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { money, isoDate, text, TYPES } from "../validate.js";

const TOOL_NAME = "record_transactions";

/** Thrown when Bedrock's response has stopReason "guardrail_intervened" -
    the guardrail (see this feature's spec, Section A) blocked the input
    or output. A distinct type from the generic "no usable tool-use
    content" error below, so extract.js (the Lambda handler) can map this
    to its own clear message rather than the generic one. */
export class GuardrailInterventionError extends Error {}

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

/** Pulls the tool-use input out of a Converse API response. Throws (does
    not return an empty array) when the response has no usable tool-use
    content at all - that's a genuinely different, worse failure than "the
    model found zero transactions," and extract.js needs to tell those
    two apart (the latter still counts against the monthly cap; treating
    a malformed response the same way would be a fair charge). */
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
  {
    fileType,
    fileContent,
    categoryNames,
    modelId,
    guardrailId,
    guardrailVersion,
  },
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

  const transactions = [];
  let skipped = 0;
  for (const row of rawRows) {
    const clean = validateExtractedRow(row, categoryNames);
    if (clean) transactions.push(clean);
    else skipped++;
  }
  return { transactions, skipped };
}
