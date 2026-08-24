/* Presigned-upload and scan-status reading for the AI-import feature's
   S3 + GuardDuty Malware Protection flow (see this feature's spec,
   Section B). No tenantId-scoped RLS here - these functions talk to S3,
   not Postgres, so tenant isolation is enforced by prefixing the object
   key itself (see presignUploadUrl), not by a database session GUC. */

import { randomUUID } from "node:crypto";
import {
  PutObjectCommand,
  GetObjectTaggingCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const UPLOAD_URL_EXPIRY_SECONDS = 300; // 5 minutes

/** Signs a short-lived PUT URL for a new object under this tenant's key
    prefix. The key is never client-chosen - always a fresh UUID - so a
    tenant can't guess or overwrite another tenant's object. */
export async function presignUploadUrl(s3Client, bucket, tenantId, fileType) {
  const key = `${tenantId}/${randomUUID()}.${fileType}`;
  const url = await getSignedUrl(
    s3Client,
    new PutObjectCommand({ Bucket: bucket, Key: key }),
    { expiresIn: UPLOAD_URL_EXPIRY_SECONDS },
  );
  return { url, key };
}

/** Reads GuardDuty's own scan-result tag directly from S3 - the single
    source of truth for whether an object is safe to process. Never
    trusts a client-supplied claim; every caller (the status-poll action
    AND ExtractFunction's own pre-processing check) calls this same
    function against the real object. Fails closed: anything that isn't
    a confirmed NO_THREATS_FOUND tag - absent, THREATS_FOUND, any of
    GuardDuty's other terminal statuses, or a read error - is never
    treated as clean. */
export async function getScanStatus(s3Client, bucket, key) {
  let tagSet;
  try {
    const result = await s3Client.send(
      new GetObjectTaggingCommand({ Bucket: bucket, Key: key }),
    );
    tagSet = result.TagSet || [];
  } catch {
    return { status: "error" };
  }
  const tag = tagSet.find((t) => t.Key === "GuardDutyMalwareScanStatus");
  if (!tag) return { status: "pending" };
  if (tag.Value === "NO_THREATS_FOUND") return { status: "clean" };
  if (tag.Value === "THREATS_FOUND") return { status: "infected" };
  return { status: "error" };
}

/** The uploaded object's size in bytes, via a HEAD request (no body
    transfer) - used to enforce the same MAX_FILE_BYTES limit the feature
    already had, now that the file arrives via S3 instead of the request
    body. */
export async function headObjectSize(s3Client, bucket, key) {
  const result = await s3Client.send(
    new HeadObjectCommand({ Bucket: bucket, Key: key }),
  );
  return result.ContentLength;
}
