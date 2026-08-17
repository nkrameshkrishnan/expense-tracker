import { test } from "node:test";
import assert from "node:assert/strict";
import { createAuthChecker, AuthError } from "../src/auth.js";

function fakeVerifier(claims) {
  return {
    verify: async (token) => {
      if (token !== "valid-token") throw new Error("signature verification failed");
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

test("throws AuthError when the token has no tenant claim and no X-Tenant-Id header", async () => {
  const requireUser = createAuthChecker(
    fakeVerifier({ sub: "u1", email: "a@x.com" }),
  );
  await assert.rejects(
    requireUser({ headers: { authorization: "Bearer valid-token" } }),
    AuthError,
  );
});

test("resolves sub/email/tenantId from a valid token's custom:tenant_id claim", async () => {
  const requireUser = createAuthChecker(
    fakeVerifier({ sub: "u1", email: "a@x.com", "custom:tenant_id": "t1" }),
  );
  const user = await requireUser({ headers: { authorization: "Bearer valid-token" } });
  assert.deepEqual(user, { sub: "u1", email: "a@x.com", tenantId: "t1" });
});

test("an X-Tenant-Id header overrides the token's own tenant claim", async () => {
  const requireUser = createAuthChecker(
    fakeVerifier({ sub: "u1", email: "a@x.com", "custom:tenant_id": "t1" }),
  );
  const user = await requireUser({
    headers: { authorization: "Bearer valid-token", "x-tenant-id": "t2" },
  });
  assert.equal(user.tenantId, "t2");
});
