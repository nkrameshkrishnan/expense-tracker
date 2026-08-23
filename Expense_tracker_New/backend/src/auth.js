/* Verifies the Cognito ID token the frontend sends as `Authorization:
   Bearer <token>`, and resolves which tenant the caller is acting as.

   This is the server-mediated backend's equivalent of Code.gs's
   requireUser() — called unconditionally at the top of every request in
   handler.js, the same "always-on gate" shape the root README's "Read
   this before you deploy" section describes for the Sheets/Supabase
   backends. */

import { CognitoJwtVerifier } from "aws-jwt-verify";
import { runProvisioningTransaction } from "./db.js";
import { getMembershipInTenant } from "./routes/tenants.js";

export class AuthError extends Error {}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Factory so tests can inject a fake verifier instead of hitting Cognito's
    real JWKS endpoint over the network - see backend/test/auth.test.js.
    Production wiring (the exported `requireUser` below) is the only
    caller that passes the real CognitoJwtVerifier and the real
    runProvisioningTransaction. */
export function createAuthChecker(
  verifier,
  runProvisioning = runProvisioningTransaction,
) {
  return async function requireUser(event) {
    const header =
      event.headers?.authorization || event.headers?.Authorization || "";
    const token = header.replace(/^Bearer\s+/i, "").trim();
    if (!token) throw new AuthError("Missing Authorization header.");

    let claims;
    try {
      claims = await verifier.verify(token);
    } catch (err) {
      throw new AuthError(`Invalid token: ${err.message}`);
    }

    // The default tenant this request acts as, from the VERIFIED token and
    // nothing else — `custom:tenant_id` is set on the user at signup by
    // postConfirmation.js and is covered by the JWT signature checked
    // above. Route modules never accept a tenant id from the request body
    // either; only from here (or the validated override below).
    const defaultTenantId = claims["custom:tenant_id"];
    if (!defaultTenantId)
      throw new AuthError("No tenant associated with this user.");

    // X-Active-Tenant: lets a user who belongs to more than one tenant act
    // as one other than their token's default — this is the feature
    // documented in docs/superpowers/specs/2026-08-18-tenant-switching-design.md.
    //
    // This is NOT a resurrection of the old X-Tenant-Id header. That header
    // was removed (see git history and the "X-Tenant-Id header is IGNORED"
    // tests in test/auth.test.js) because nothing ever validated it against
    // tenant_users — any authenticated user could read and write any other
    // tenant's data by setting one header, since every downstream control
    // (RLS, invite roles, the whole isolation model) keys off this value.
    // X-Active-Tenant is different in the one way that matters: every value
    // reaching the return below has first been confirmed, inside a DB
    // transaction, against a real tenant_users row for this user. An
    // unvalidated header must never be trusted here again.
    const requested =
      event.headers?.["x-active-tenant"] || event.headers?.["X-Active-Tenant"];

    if (!requested || requested === defaultTenantId) {
      return {
        sub: claims.sub,
        email: claims.email,
        tenantId: defaultTenantId,
      };
    }

    // A client-supplied value reaching a `cast(... as uuid)` query as
    // garbage would surface as a raw Postgres error rather than a clean
    // 401/403 — reject the shape here, before any DB round trip, same as
    // rejecting a malformed token above.
    if (!UUID_RE.test(requested))
      throw new AuthError("Malformed X-Active-Tenant header.");

    const membership = await runProvisioning(claims.sub, (execute) =>
      getMembershipInTenant(execute, claims.sub, requested),
    );
    if (!membership)
      throw new AuthError("Not a member of the requested tenant.");

    return { sub: claims.sub, email: claims.email, tenantId: requested };
  };
}

const verifier = CognitoJwtVerifier.create({
  userPoolId: process.env.COGNITO_USER_POOL_ID,
  tokenUse: "id",
  clientId: process.env.COGNITO_CLIENT_ID,
});

export const requireUser = createAuthChecker(verifier);
