import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createAuthChecker, AuthError } from "../src/auth.js";

function fakeVerifier(claims) {
  return {
    verify: async (token) => {
      if (token !== "valid-token")
        throw new Error("signature verification failed");
      return claims;
    },
  };
}

test("throws AuthError with no Authorization header", async () => {
  const requireUser = createAuthChecker(fakeVerifier({}));
  await assert.rejects(requireUser({ headers: {} }), AuthError);
});

test("throws AuthError on an invalid token", async () => {
  const requireUser = createAuthChecker(fakeVerifier({}));
  await assert.rejects(
    requireUser({ headers: { authorization: "Bearer garbage" } }),
    AuthError,
  );
});

test("throws AuthError when the token has no tenant claim", async () => {
  const requireUser = createAuthChecker(
    fakeVerifier({ sub: "u1", email: "a@x.com" }),
  );
  await assert.rejects(
    requireUser({ headers: { authorization: "Bearer valid-token" } }),
    AuthError,
  );
});

/* Finding C3. requireUser() used to accept an X-Tenant-Id header and use it
   as the caller's tenant context, with a comment claiming it was "validated
   against membership by the caller" - no caller ever did. Since every
   downstream control (RLS scoping, invite roles, the whole isolation model)
   keys off that one value, any authenticated user could read and write any
   other tenant's data by setting one header. The header is gone; these two
   tests exist so it cannot come back unnoticed. */
test("an X-Tenant-Id header is IGNORED, not honoured as a tenant override", async () => {
  const requireUser = createAuthChecker(
    fakeVerifier({ sub: "u1", email: "a@x.com", "custom:tenant_id": "t1" }),
  );
  const user = await requireUser({
    headers: {
      authorization: "Bearer valid-token",
      "x-tenant-id": "someone-elses-tenant",
    },
  });
  assert.equal(user.tenantId, "t1");
});

test("an X-Tenant-Id header cannot stand in for a missing tenant claim", async () => {
  const requireUser = createAuthChecker(
    fakeVerifier({ sub: "u1", email: "a@x.com" }),
  );
  await assert.rejects(
    requireUser({
      headers: { authorization: "Bearer valid-token", "x-tenant-id": "t2" },
    }),
    AuthError,
  );
});

test("resolves sub/email/tenantId from a valid token's custom:tenant_id claim", async () => {
  const requireUser = createAuthChecker(
    fakeVerifier({ sub: "u1", email: "a@x.com", "custom:tenant_id": "t1" }),
  );
  const user = await requireUser({
    headers: { authorization: "Bearer valid-token" },
  });
  assert.deepEqual(user, { sub: "u1", email: "a@x.com", tenantId: "t1" });
});

test("the CORS allow-list does not advertise x-tenant-id", async () => {
  // handler.js's CORS_HEADERS and template.yaml's CorsConfiguration are the
  // two places a browser would learn the header is acceptable; both must
  // stay in sync with auth.js ignoring it.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const handlerSrc = readFileSync(
    path.join(here, "..", "src", "handler.js"),
    "utf8",
  );
  const template = readFileSync(path.join(here, "..", "template.yaml"), "utf8");
  assert.ok(
    !/Allow-Headers"?:\s*"[^"]*x-tenant-id/.test(handlerSrc),
    "handler.js's Access-Control-Allow-Headers must not list x-tenant-id",
  );
  assert.ok(
    !/AllowHeaders:.*x-tenant-id/.test(template),
    "template.yaml's AllowHeaders must not list x-tenant-id",
  );
});
