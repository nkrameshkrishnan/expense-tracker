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
