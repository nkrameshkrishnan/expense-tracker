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
