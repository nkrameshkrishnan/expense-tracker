# AI Import Security Hardening — Design

**Status:** Approved by user, ready for implementation planning.

## Problem

The AI transaction import feature (`ExtractFunction`, `routes/extract.js`,
`bedrock.js`) has two real gaps:

1. **No LLM safety layer.** The Bedrock `ConverseCommand` call has no
   content filtering, and — more concretely — the CSV path sends untrusted
   uploaded file text directly into the prompt as inline content, with no
   defense against a prompt-injection payload embedded in that text.
2. **No file-content validation or malware scanning.** `parseExtractRequest`
   trusts the client-supplied `fileType` field and only checks size (4MB)
   and, for PDFs, page count. Nothing verifies the uploaded bytes actually
   _are_ a CSV/PDF, and nothing scans them for embedded malware.

These are two independent mechanisms — Bedrock Guardrails is LLM output/
input content safety; malware scanning is a property of the file bytes
themselves, unrelated to the LLM. They're covered in one spec because both
harden the same feature and touch the same files, but they can ship and be
reasoned about independently.

**Context on actual risk today:** nothing in `ExtractFunction` currently
_executes_ an uploaded file — CSV bytes become inline prompt text, PDF
bytes are parsed by `pdf-lib` (page-count only) then sent to Bedrock's API.
There is no "uploads and runs your executable" path today. The real gaps
are (a) prompt injection via untrusted CSV text reaching the model, and
(b) nothing stopping a disguised/malicious file from being processed at
all, including by `pdf-lib`'s own parsing of untrusted PDF bytes.

## Scope

**In scope:**

- A Bedrock Guardrail applied to every `ExtractFunction` Converse call.
- Routing uploads through S3 with Amazon GuardDuty Malware Protection,
  and a server-side, non-bypassable check that a file passed that scan
  before it's ever read or sent to Bedrock.

**Out of scope:**

- Self-hosted antivirus (ClamAV) — GuardDuty was chosen over it explicitly
  (fully managed, no virus-definition maintenance for a small team).
- Changing what currency, category, or transaction-type data the model is
  allowed to see — unrelated to this hardening.
- Any change to Stripe billing, the AI-import monthly cap's _value_, or
  any other already-shipped feature's behavior beyond what this spec
  describes.
- Real-time/streaming scanning — GuardDuty's S3 Malware Protection scans a
  completed object, not a stream; the upload-then-scan-then-process
  sequence below is not optional given that constraint.

## Architecture

### A. Bedrock Guardrails

A new `AWS::Bedrock::Guardrail` + `AWS::Bedrock::GuardrailVersion` pair in
`template.yaml`, configured with:

- **Content filters** (hate, insults, sexual, violence, misconduct) at
  `MEDIUM` strength, applied to both input and output — standard baseline.
- **Prompt-attack detection enabled on input.** This is the load-bearing
  filter for this feature: the CSV path sends untrusted uploaded text
  straight into the prompt as inline content (`routes/extract.js`'s
  `buildExtractionRequest`), so a malicious CSV could attempt a
  prompt-injection payload. Bedrock's prompt-attack filter is AWS's
  purpose-built defense for exactly this pattern.
- **PII handling:** input stays unfiltered — bank statements are supposed
  to contain account numbers and names, that's the extraction target, and
  blocking PII on input would break the feature. Output gets PII masking
  (not blocking) on card-number/SSN-like patterns, as defense-in-depth in
  case a `description` field the model returns ever echoes something it
  shouldn't.
- Denied-topics and contextual-grounding checks: not configured — not
  applicable to a structured tool-use extraction call.

**Wiring:** `routes/extract.js`'s `buildExtractionRequest` gains a
`guardrailConfig: { guardrailIdentifier, guardrailVersion, trace: "enabled" }`
field on the request, sourced from two new env vars
(`BEDROCK_GUARDRAIL_ID`/`BEDROCK_GUARDRAIL_VERSION`) that `extractTransactions`
reads and passes through — mirrors how `modelId` already flows from
`process.env.BEDROCK_MODEL_ID` through `extract.js` (the handler) into
`extractTransactions`.

`parseExtractionResponse` gains a check for a guardrail-intervened
response (the Converse API sets `stopReason: "guardrail_intervened"` when
a guardrail blocks input or output) and throws a distinct,
clearly-labeled error — `extract.js`'s handler maps this to a clean 400
("This file could not be processed.") rather than the generic 500 an
unrecognized error gets. A guardrail intervention still counts against
the tenant's monthly AI-import cap: Bedrock was genuinely called and
responded, the same reasoning that already applies to "the model found
zero transactions" counting against the cap.

**IAM:** `ExtractFunction` gains `bedrock:ApplyGuardrail`, scoped to the
new guardrail's ARN, alongside its existing `bedrock:InvokeModel` grant.

### B. File upload flow (S3 + GuardDuty Malware Protection)

The upload flow changes from "base64 bytes in the `/extract` POST body"
to a 3-step flow, because GuardDuty Malware Protection only scans S3
objects — there is no way to scan arbitrary bytes in a request body
without landing them in S3 first.

**New resources (`template.yaml`):**

- `AiUploadsBucket` (`AWS::S3::Bucket`): private (`PublicAccessBlockConfiguration`
  blocking all public access), default SSE-S3 encryption, a `CorsConfiguration`
  allowing `PUT` from `AllowedOrigin` (the existing parameter already used
  for the HTTP API's CORS config), and a `LifecycleConfiguration` rule
  expiring objects after 1 day — a backstop in case explicit cleanup
  (below) ever fails to run. These are real bank/credit-card statements;
  they should not persist in S3 longer than a single request needs them.
- `AiUploadsMalwareProtectionPlan` (`AWS::GuardDuty::MalwareProtectionPlan`):
  points at `AiUploadsBucket`, with tagging enabled so scan results land
  as an object tag GuardDuty writes automatically
  (`GuardDutyMalwareScanStatus`, one of `NO_THREATS_FOUND` /
  `THREATS_FOUND` / `UNSUPPORTED` / `ACCESS_DENIED` / `FAILED`).
  Requires GuardDuty itself to be enabled for the account/region — a
  one-time manual/console enablement step if not already on, documented
  in `DEPLOYMENT.md` the same way Bedrock model access already is (a real
  thing to verify at deploy time, not a CloudFormation-expressible step).

**New backend module — `backend/src/s3.js`:** a lazy `S3Client` singleton,
same shape as `bedrock.js`/`stripe.js`.

**New backend module — `backend/src/routes/uploads.js`:**

- `presignUploadUrl(s3Client, bucket, tenantId, fileType)` — generates a
  short-lived (5 minute) presigned `PUT` URL via `getSignedUrl` +
  `PutObjectCommand`, with key `${tenantId}/${randomUUID()}.${fileType}`
  (tenant-prefixed, so one tenant can never guess or collide with
  another's object key). Returns `{ url, key }`.
- `getScanStatus(s3Client, bucket, key)` — reads the object's
  `GuardDutyMalwareScanStatus` tag via `GetObjectTaggingCommand` and maps
  it to `{ status: "pending" | "clean" | "infected" | "error" }`: tag
  absent → `pending` (scan hasn't completed yet); `NO_THREATS_FOUND` →
  `clean`; `THREATS_FOUND` → `infected`; anything else
  (`UNSUPPORTED`/`ACCESS_DENIED`/`FAILED`, or a tagging read failure) →
  `error` — fail-closed, never silently treated as clean.

**`handler.js` (`DataFunction`) gains two new `POST` actions**, in the
existing `handlePost` action switch (alongside `setBudget`/`setCurrency`
etc.) — both are fast (URL signing, one S3 tag read), so they belong in
`DataFunction`, not `ExtractFunction`, matching this codebase's
established "dedicated Lambda only for genuinely slow work" pattern:

- `getUploadUrl` — calls `uploads.presignUploadUrl`, returns `{ ok: true, url, key }`.
- `getScanStatus` — calls `uploads.getScanStatus`, returns `{ ok: true, status }`.

**`extract.js` (`ExtractFunction`)'s request contract changes**:
`parseExtractRequest` now expects `{ fileType, s3Key, categoryNames }`
(replacing `fileBase64`). New logic, before any Bedrock call:

1. Call `uploads.getScanStatus` on the given key — **server-side, always**,
   regardless of what the client believes the status is. This is the
   non-bypassable check: a client cannot skip scanning by simply calling
   `/extract` with a key it never waited on, because the handler
   independently re-reads the authoritative S3 tag itself.
2. `status !== "clean"` → reject (400), with a message distinguishing
   `pending` ("still being scanned, try again shortly") from `infected`/
   `error` ("this file could not be processed") — never proceed on
   anything but a confirmed clean tag.
3. On clean, `GetObjectCommand` fetches the bytes, and the existing
   `countPdfPages`/size-derived-from-object/Bedrock flow continues
   unchanged from that point.
4. The S3 object is deleted (`DeleteObjectCommand`) after processing —
   success, cap-exceeded, or any other failure — so it never outlives a
   single request's actual need for it, independent of the 1-day
   lifecycle backstop.

**IAM:** `DataFunction` gains `s3:PutObject` (to sign a presigned PUT on
`AiUploadsBucket`'s behalf) and `s3:GetObjectTagging` (for `getScanStatus`,
since the picker screen may poll before extraction). `ExtractFunction`
gains `s3:GetObject`, `s3:GetObjectTagging`, and `s3:DeleteObject`, all
scoped to `AiUploadsBucket`.

### C. Frontend flow

`store.js`'s `ApiStore` gains `getUploadUrl(fileType)` and
`getScanStatus(key)` (both thin `_post()` wrappers, matching every other
action method's shape), plus a new `uploadToS3(url, file)` helper that
does a raw `fetch(url, { method: "PUT", body: file })` directly against
the presigned URL — this goes straight to S3, not through `_post()`/this
app's own API, since it's a different origin entirely.

`extractTransactions` (the existing `ApiStore` method the AI-import UI
already calls) is rewritten to orchestrate the full sequence instead of
just posting bytes: request an upload URL → `PUT` the file to S3 → poll
`getScanStatus` (every 2 seconds, up to a 60-second timeout) until
`clean`/`infected`/`error` → on `clean`, call the existing `/extract`
action with `{ fileType, s3Key, categoryNames }` in place of
`fileBase64`. A timeout or `infected`/`error` status short-circuits with
a clear error before ever calling `/extract`.

`app.js`'s `#ai-file` change handler's status message becomes multi-phase
to match: "Uploading your statement…" → "Scanning for threats…" →
"Reading your statement — this can take up to 20 seconds…" (the existing
message, now scoped to just the Bedrock-call phase) → the review table.

## Error handling & edge cases

- **Infected file** → never reaches Bedrock, S3 object deleted
  immediately, clean user-facing message, does **not** count against the
  monthly AI-import cap (matches the existing rule: nothing that fails
  before a Bedrock call counts).
- **Inconclusive scan status** (`UNSUPPORTED`/`ACCESS_DENIED`/`FAILED`) →
  treated identically to `infected` for gating purposes (fail-closed),
  though the user-facing message may differ ("couldn't be scanned" vs.
  "flagged by a security scan").
- **Scan never completes within the frontend's poll timeout** → the
  object is left for the 1-day lifecycle backstop to clean up; the
  frontend shows a timeout error and the user can retry with a fresh
  upload.
- **A client calls `/extract` with a key it never actually waited on** →
  `ExtractFunction`'s own server-side `getScanStatus` re-check catches
  this; the client-side polling is a UX convenience, not the security
  boundary.
- **Guardrail intervention** (blocked input or output) → mapped to a
  clean 400, counts against the monthly cap (a real, billed Bedrock call
  happened).

## Testing

- **Backend:** `routes/uploads.js`'s `presignUploadUrl`/`getScanStatus`
  get direct tests against a **mocked S3 client** (`@aws-sdk/client-s3`) —
  never a real S3 call in tests, the same "always mocked" rule this
  codebase already applies to Bedrock (`extract-route.test.js`'s
  hand-rolled `bedrockClient.send` stub is the precedent to mirror).
- **The server-side scan re-verification is the one security-critical
  path requiring its own dedicated test**: mock S3's tag response to
  return `infected`/`error`/absent, and confirm `extract.js` rejects
  before ever calling Bedrock in each case.
- **Guardrail-intervened response handling** gets a test case in the
  existing mocked-Bedrock test file: a `stopReason: "guardrail_intervened"`
  response maps to the distinct error `extract.js` turns into a clean 400.
- `handler.js`'s two new actions get no direct test, matching this
  codebase's established precedent (its Lambda entrypoint has zero direct
  tests; only the pure functions it composes do).
- **Frontend:** no automated test runner exists in this codebase
  (confirmed during two earlier features' work) — verified manually,
  including an end-to-end pass using the industry-standard **EICAR test
  file** (a harmless string every AV/malware engine recognizes as "this
  would be malware") to confirm the infected-file path actually works
  once deployed, without needing real malware.
