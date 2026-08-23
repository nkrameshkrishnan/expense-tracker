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
