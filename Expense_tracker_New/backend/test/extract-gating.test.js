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

test("parseExtractRequest rejects a request with no s3Key", async () => {
  const s3Client = { send: async () => ({ TagSet: [] }) };
  const result = await parseExtractRequest(
    JSON.stringify({ fileType: "csv", categoryNames: ["Groceries"] }),
    s3Client,
    "test-bucket",
  );
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
});

test("parseExtractRequest rejects when the scan status is not clean", async () => {
  const s3Client = {
    send: async () => ({
      TagSet: [{ Key: "GuardDutyMalwareScanStatus", Value: "THREATS_FOUND" }],
    }),
  };
  const result = await parseExtractRequest(
    JSON.stringify({
      fileType: "csv",
      s3Key: "tenant-abc/x.csv",
      categoryNames: ["Groceries"],
    }),
    s3Client,
    "test-bucket",
  );
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.match(result.error, /could not be processed/i);
});

test("parseExtractRequest rejects a pending (not-yet-scanned) file", async () => {
  const s3Client = { send: async () => ({ TagSet: [] }) };
  const result = await parseExtractRequest(
    JSON.stringify({
      fileType: "csv",
      s3Key: "tenant-abc/x.csv",
      categoryNames: ["Groceries"],
    }),
    s3Client,
    "test-bucket",
  );
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.match(result.error, /scan/i);
});

test("parseExtractRequest rejects an oversized clean file before fetching its bytes", async () => {
  const calls = [];
  const s3Client = {
    send: async (command) => {
      calls.push(command.constructor.name);
      if (command.constructor.name === "GetObjectTaggingCommand")
        return {
          TagSet: [{ Key: "GuardDutyMalwareScanStatus", Value: "NO_THREATS_FOUND" }],
        };
      if (command.constructor.name === "HeadObjectCommand")
        return { ContentLength: 5 * 1024 * 1024 };
      throw new Error(`unexpected command in this test: ${command.constructor.name}`);
    },
  };
  const result = await parseExtractRequest(
    JSON.stringify({
      fileType: "pdf",
      s3Key: "tenant-abc/x.pdf",
      categoryNames: ["Groceries"],
    }),
    s3Client,
    "test-bucket",
  );
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.match(result.error, /too large/i);
  assert.ok(!calls.includes("GetObjectCommand"), "must not fetch bytes for an oversized file");
});

test("parseExtractRequest accepts a clean, correctly-sized file and returns its bytes", async () => {
  const doc = await PDFDocument.create();
  doc.addPage();
  const pdfBytes = await doc.save();
  const s3Client = {
    send: async (command) => {
      if (command.constructor.name === "GetObjectTaggingCommand")
        return {
          TagSet: [{ Key: "GuardDutyMalwareScanStatus", Value: "NO_THREATS_FOUND" }],
        };
      if (command.constructor.name === "HeadObjectCommand")
        return { ContentLength: pdfBytes.length };
      if (command.constructor.name === "GetObjectCommand")
        return { Body: { transformToByteArray: async () => pdfBytes } };
      throw new Error(`unexpected command: ${command.constructor.name}`);
    },
  };
  const result = await parseExtractRequest(
    JSON.stringify({
      fileType: "pdf",
      s3Key: "tenant-abc/x.pdf",
      categoryNames: ["Groceries"],
    }),
    s3Client,
    "test-bucket",
  );
  assert.equal(result.ok, true);
  assert.equal(result.fileType, "pdf");
  assert.ok(Buffer.isBuffer(result.fileBuffer));
  assert.equal(result.fileBuffer.length, pdfBytes.length);
});

test("parseExtractRequest returns a clean 500 instead of throwing when HeadObjectCommand fails", async () => {
  const s3Client = {
    send: async (command) => {
      if (command.constructor.name === "GetObjectTaggingCommand")
        return {
          TagSet: [{ Key: "GuardDutyMalwareScanStatus", Value: "NO_THREATS_FOUND" }],
        };
      if (command.constructor.name === "HeadObjectCommand")
        throw new Error("S3 unavailable");
      throw new Error(`unexpected command: ${command.constructor.name}`);
    },
  };
  const result = await parseExtractRequest(
    JSON.stringify({
      fileType: "csv",
      s3Key: "tenant-abc/x.csv",
      categoryNames: ["Groceries"],
    }),
    s3Client,
    "test-bucket",
  );
  assert.equal(result.ok, false);
  assert.equal(result.status, 500);
});

test("parseExtractRequest returns a clean 500 instead of throwing when GetObjectCommand fails", async () => {
  const s3Client = {
    send: async (command) => {
      if (command.constructor.name === "GetObjectTaggingCommand")
        return {
          TagSet: [{ Key: "GuardDutyMalwareScanStatus", Value: "NO_THREATS_FOUND" }],
        };
      if (command.constructor.name === "HeadObjectCommand")
        return { ContentLength: 100 };
      if (command.constructor.name === "GetObjectCommand")
        throw new Error("S3 unavailable");
      throw new Error(`unexpected command: ${command.constructor.name}`);
    },
  };
  const result = await parseExtractRequest(
    JSON.stringify({
      fileType: "csv",
      s3Key: "tenant-abc/x.csv",
      categoryNames: ["Groceries"],
    }),
    s3Client,
    "test-bucket",
  );
  assert.equal(result.ok, false);
  assert.equal(result.status, 500);
});

test("parseExtractRequest returns a clean 500 instead of throwing when reading the object body fails", async () => {
  const s3Client = {
    send: async (command) => {
      if (command.constructor.name === "GetObjectTaggingCommand")
        return {
          TagSet: [{ Key: "GuardDutyMalwareScanStatus", Value: "NO_THREATS_FOUND" }],
        };
      if (command.constructor.name === "HeadObjectCommand")
        return { ContentLength: 100 };
      if (command.constructor.name === "GetObjectCommand")
        return {
          Body: {
            transformToByteArray: async () => {
              throw new Error("stream interrupted");
            },
          },
        };
      throw new Error(`unexpected command: ${command.constructor.name}`);
    },
  };
  const result = await parseExtractRequest(
    JSON.stringify({
      fileType: "csv",
      s3Key: "tenant-abc/x.csv",
      categoryNames: ["Groceries"],
    }),
    s3Client,
    "test-bucket",
  );
  assert.equal(result.ok, false);
  assert.equal(result.status, 500);
});

test("parseExtractRequest returns a clean 400 for a pdf fileType whose bytes aren't a real PDF", async () => {
  const garbageBytes = Buffer.from("not a real pdf");
  const s3Client = {
    send: async (command) => {
      if (command.constructor.name === "GetObjectTaggingCommand")
        return {
          TagSet: [{ Key: "GuardDutyMalwareScanStatus", Value: "NO_THREATS_FOUND" }],
        };
      if (command.constructor.name === "HeadObjectCommand")
        return { ContentLength: garbageBytes.length };
      if (command.constructor.name === "GetObjectCommand")
        return { Body: { transformToByteArray: async () => garbageBytes } };
      throw new Error(`unexpected command: ${command.constructor.name}`);
    },
  };
  const result = await parseExtractRequest(
    JSON.stringify({
      fileType: "pdf",
      s3Key: "tenant-abc/x.pdf",
      categoryNames: ["Groceries"],
    }),
    s3Client,
    "test-bucket",
  );
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
});
