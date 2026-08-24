import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PutObjectCommand,
  GetObjectTaggingCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import {
  presignUploadUrl,
  getScanStatus,
  headObjectSize,
} from "../src/routes/uploads.js";

test("presignUploadUrl returns a tenant-prefixed key and a URL", async () => {
  // presignUploadUrl signs against a real S3Client instance (getSignedUrl
  // reads the client's config, not a mocked .send), so this test uses a
  // real (but never-network-calling) client with dummy credentials -
  // getSignedUrl computes the signature locally, it never makes a request.
  const { S3Client } = await import("@aws-sdk/client-s3");
  const client = new S3Client({
    region: "us-east-1",
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
  });
  const { url, key } = await presignUploadUrl(
    client,
    "test-bucket",
    "tenant-abc",
    "pdf",
  );
  assert.match(key, /^tenant-abc\/[0-9a-f-]{36}\.pdf$/);
  assert.match(url, /^https:\/\/test-bucket\.s3\./);
});

test("getScanStatus maps NO_THREATS_FOUND to clean", async () => {
  const calls = [];
  const s3Client = {
    send: async (command) => {
      calls.push(command);
      return {
        TagSet: [
          { Key: "GuardDutyMalwareScanStatus", Value: "NO_THREATS_FOUND" },
        ],
      };
    },
  };
  const result = await getScanStatus(
    s3Client,
    "test-bucket",
    "tenant-abc/x.pdf",
  );
  assert.deepEqual(result, { status: "clean" });
  assert.ok(calls[0] instanceof GetObjectTaggingCommand);
});

test("getScanStatus maps THREATS_FOUND to infected", async () => {
  const s3Client = {
    send: async () => ({
      TagSet: [{ Key: "GuardDutyMalwareScanStatus", Value: "THREATS_FOUND" }],
    }),
  };
  const result = await getScanStatus(
    s3Client,
    "test-bucket",
    "tenant-abc/x.pdf",
  );
  assert.deepEqual(result, { status: "infected" });
});

test("getScanStatus maps an absent tag to pending", async () => {
  const s3Client = { send: async () => ({ TagSet: [] }) };
  const result = await getScanStatus(
    s3Client,
    "test-bucket",
    "tenant-abc/x.pdf",
  );
  assert.deepEqual(result, { status: "pending" });
});

test("getScanStatus maps UNSUPPORTED/ACCESS_DENIED/FAILED to error", async () => {
  for (const value of ["UNSUPPORTED", "ACCESS_DENIED", "FAILED"]) {
    const s3Client = {
      send: async () => ({
        TagSet: [{ Key: "GuardDutyMalwareScanStatus", Value: value }],
      }),
    };
    const result = await getScanStatus(
      s3Client,
      "test-bucket",
      "tenant-abc/x.pdf",
    );
    assert.deepEqual(
      result,
      { status: "error" },
      `expected ${value} to map to error`,
    );
  }
});

test("getScanStatus maps a tag-read failure to error, not a thrown exception", async () => {
  const s3Client = {
    send: async () => {
      throw new Error("NoSuchKey");
    },
  };
  const result = await getScanStatus(
    s3Client,
    "test-bucket",
    "tenant-abc/x.pdf",
  );
  assert.deepEqual(result, { status: "error" });
});

test("headObjectSize returns the object's ContentLength", async () => {
  const calls = [];
  const s3Client = {
    send: async (command) => {
      calls.push(command);
      return { ContentLength: 12345 };
    },
  };
  const size = await headObjectSize(
    s3Client,
    "test-bucket",
    "tenant-abc/x.pdf",
  );
  assert.equal(size, 12345);
  assert.ok(calls[0] instanceof HeadObjectCommand);
});
