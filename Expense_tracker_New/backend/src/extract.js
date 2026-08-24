/* Lambda behind POST /extract - lets a Pro/Family tenant upload a CSV/PDF
   statement and get back a reviewable list of extracted transactions.
   Deliberately its own Lambda, not a DataFunction action - see this
   feature's spec (docs/superpowers/specs/2026-08-23-ai-transaction-
   import-design.md), Architecture §1, for why (timeout, blast radius).

   No dedicated test for the `handler` export itself, matching handler.js's
   own precedent: its Lambda entrypoint has zero direct tests either, only
   the small pure gate functions it exports (assertManagesInvites,
   assertKnownPriceId). Everything handler() composes here - the auth gate,
   the body parsing/validation, the plan gate, the cap check, the
   extraction call, the cap-recording insert - is independently tested
   already (auth.js's own tests, extract-gating.test.js below,
   extract-route.test.js, ai-import-cap.test.js). handler() itself is thin
   wiring over already-proven pieces, the same category of code
   handler.js's action switch already is. */

import { PDFDocument } from "pdf-lib";
import { requireUser, AuthError } from "./auth.js";
import { checkRateLimit, RateLimitError } from "./rateLimit.js";
import { runInTenantTransaction } from "./db.js";
import { FEATURES, AI_IMPORT_MONTHLY_CAP } from "./plans.js";
import { bedrock } from "./bedrock.js";
import {
  extractTransactions,
  GuardrailInterventionError,
} from "./routes/extract.js";
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

// 4MB raw. Lambda's synchronous invocation payload ceiling is ~6MB, and
// this file travels base64-encoded (~33% bigger) inside a JSON request
// body - a raw file much above 4-4.5MB would be rejected by the platform
// itself before this check ever runs, surfacing as an opaque platform
// error instead of the message below. See spec Architecture §1's rejected
// S3-direct-upload alternative.
const MAX_FILE_BYTES = 4 * 1024 * 1024;
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

/** Parses and validates the raw Lambda event body for POST /extract.
    Never throws - a malformed body (unparseable JSON, or valid JSON that
    isn't an object, e.g. a literal `null`) and a PDF pdf-lib can't parse
    (mislabeled fileType, a corrupted upload) are both client-input
    problems, exactly like a missing fileBase64, and get the same
    { ok: false, status, error } shape as those existing checks rather
    than escaping as a thrown exception. Kept as its own pure(-ish, one
    pdf-lib call) function, not inlined in handler(), so this parsing path
    has direct test coverage the same way countPdfPages/
    assertAiImportAllowed do, instead of only handler()'s own untested
    body. */
export async function parseExtractRequest(body) {
  let payload;
  try {
    payload = JSON.parse(body || "{}");
  } catch {
    return {
      ok: false,
      status: 400,
      error: "Request body is not valid JSON.",
    };
  }
  const { fileType, fileBase64, categoryNames } = payload || {};

  if (fileType !== "csv" && fileType !== "pdf")
    return {
      ok: false,
      status: 400,
      error: 'fileType must be "csv" or "pdf".',
    };
  if (typeof fileBase64 !== "string" || !fileBase64)
    return { ok: false, status: 400, error: "fileBase64 is required." };
  if (!Array.isArray(categoryNames) || categoryNames.length === 0)
    return { ok: false, status: 400, error: "categoryNames is required." };

  const fileBuffer = Buffer.from(fileBase64, "base64");
  if (fileBuffer.length > MAX_FILE_BYTES)
    return {
      ok: false,
      status: 400,
      error: `File is too large (max ${MAX_FILE_BYTES / 1024 / 1024}MB).`,
    };

  if (fileType === "pdf") {
    let pageCount;
    try {
      pageCount = await countPdfPages(fileBuffer);
    } catch {
      return {
        ok: false,
        status: 400,
        error: "Could not read this PDF. Please try a different file.",
      };
    }
    if (pageCount > MAX_PDF_PAGES)
      return {
        ok: false,
        status: 400,
        error: `This PDF has ${pageCount} pages — the limit is ${MAX_PDF_PAGES}. Try uploading a single month's statement.`,
      };
  }

  return { ok: true, fileType, fileBase64, categoryNames, fileBuffer };
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

  // parseExtractRequest never throws - see its own comment - so an
  // uncaught rejection here can no longer escape handler() with no
  // CORS_HEADERS attached, the failure mode handler.js's own comment above
  // requireUser() warns about.
  const parsed = await parseExtractRequest(event.body);
  if (!parsed.ok)
    return json(parsed.status, { ok: false, error: parsed.error });
  const { fileType, categoryNames, fileBuffer } = parsed;

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
        // A GuardrailInterventionError is deliberately NOT rethrown here -
        // db.js's withDataApiTransaction rolls back and rethrows on ANY
        // callback exception (see stripeWebhook.js's notifyBestEffort
        // comment for the same precedent), so throwing after
        // recordAttempt() would undo the very cap-count write this is
        // trying to commit. A guardrail intervention is a real, billed
        // Bedrock call that reached and responded - same reasoning as
        // "the model found zero transactions" already counting against
        // the cap - so this returns a sentinel instead, letting the
        // transaction commit normally, and handler() below branches on
        // it after the transaction has already committed.
        try {
          const extracted = await extractTransactions(bedrock, {
            fileType,
            fileContent,
            categoryNames,
            modelId: process.env.BEDROCK_MODEL_ID,
            guardrailId: process.env.BEDROCK_GUARDRAIL_ID,
            guardrailVersion: process.env.BEDROCK_GUARDRAIL_VERSION,
          });
          await recordAttempt(execute);
          return { extracted };
        } catch (err) {
          if (!(err instanceof GuardrailInterventionError)) throw err;
          await recordAttempt(execute);
          return { guardrailBlocked: true };
        }
      },
    );
    if (result.guardrailBlocked)
      return json(400, {
        ok: false,
        error: "This file could not be processed.",
      });
    return json(200, { ok: true, ...result.extracted });
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
