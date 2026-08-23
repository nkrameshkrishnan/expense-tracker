import { test } from "node:test";
import assert from "node:assert/strict";
import { PDFDocument } from "pdf-lib";
import {
  assertAiImportAllowed,
  AiImportGateError,
  countPdfPages,
  parseExtractRequest,
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

// Regression coverage for a bug review found in the task-5 handler: a
// malformed body or an unparseable PDF must come back as a clean 400 from
// parseExtractRequest, never as a thrown/rejected exception that would
// escape handler() with no CORS headers attached.
test("parseExtractRequest returns a clean 400 for malformed JSON, not a thrown exception", async () => {
  const result = await parseExtractRequest("{not valid json");
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
});

test("parseExtractRequest returns a clean 400 for a JSON body that isn't an object", async () => {
  const result = await parseExtractRequest("null");
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
});

test("parseExtractRequest returns a clean 400 for a pdf fileType whose bytes aren't a real PDF", async () => {
  const body = JSON.stringify({
    fileType: "pdf",
    fileBase64: Buffer.from("not a real pdf").toString("base64"),
    categoryNames: ["Groceries"],
  });
  const result = await parseExtractRequest(body);
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
});

test("parseExtractRequest accepts a well-formed csv request", async () => {
  const body = JSON.stringify({
    fileType: "csv",
    fileBase64: Buffer.from("date,amount\n2026-01-01,10").toString("base64"),
    categoryNames: ["Groceries"],
  });
  const result = await parseExtractRequest(body);
  assert.equal(result.ok, true);
  assert.equal(result.fileType, "csv");
  assert.ok(Buffer.isBuffer(result.fileBuffer));
});

test("parseExtractRequest accepts a well-formed pdf request under the page limit", async () => {
  const doc = await PDFDocument.create();
  doc.addPage();
  const bytes = await doc.save();
  const body = JSON.stringify({
    fileType: "pdf",
    fileBase64: Buffer.from(bytes).toString("base64"),
    categoryNames: ["Groceries"],
  });
  const result = await parseExtractRequest(body);
  assert.equal(result.ok, true);
  assert.equal(result.fileType, "pdf");
});
