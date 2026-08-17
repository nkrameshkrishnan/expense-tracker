/* Verifies the Cognito ID token the frontend sends as `Authorization:
   Bearer <token>`, and resolves which tenant the caller is acting as.

   This is the server-mediated backend's equivalent of Code.gs's
   requireUser() — called unconditionally at the top of every request in
   handler.js, exactly the same "always-on gate" shape the security review
   in Security_Analysis.md validated for the Sheets/Supabase backends. */

import { CognitoJwtVerifier } from "aws-jwt-verify";

export class AuthError extends Error {}

/** Factory so tests can inject a fake verifier instead of hitting Cognito's
    real JWKS endpoint over the network - see backend/test/auth.test.js.
    Production wiring (the exported `requireUser` below) is the only
    caller that passes the real CognitoJwtVerifier. */
export function createAuthChecker(verifier) {
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

    // Which tenant this request acts as. This comes from the VERIFIED token
    // and nothing else — `custom:tenant_id` is set on the user at signup by
    // postConfirmation.js and is covered by the JWT signature checked above.
    // Route modules never accept a tenant id from the request body either;
    // only from here.
    //
    // This used to also honour an `X-Tenant-Id` request header, on the
    // theory that a user belonging to more than one tenant needs a way to
    // say which one they are acting as. Nothing ever validated that header
    // against tenant_users, so any authenticated user could read and write
    // any other tenant's data by setting one header — every downstream
    // control (RLS, the invite roles, the whole isolation model) keys off
    // this value. Removed rather than patched, because nothing sends it:
    // the frontend never set it, and multi-tenant switching is out of scope.
    //
    // FUTURE WORK, do not build now: re-introducing tenant switching means
    // a real membership check BEFORE this value is trusted — inside a
    // transaction, query tenant_users for (user_sub = claims.sub, tenant_id
    // = requested) and reject with AuthError when there is no row. That
    // lookup needs a DB round trip, so it belongs in a provisioning-style
    // transaction here (or in handler.js before runInTenantTransaction),
    // not in a header read. Until that exists, a client-supplied tenant id
    // must never reach this function's return value.
    const tenantId = claims["custom:tenant_id"];
    if (!tenantId) throw new AuthError("No tenant associated with this user.");

    return {
      sub: claims.sub,
      email: claims.email,
      tenantId,
    };
  };
}

const verifier = CognitoJwtVerifier.create({
  userPoolId: process.env.COGNITO_USER_POOL_ID,
  tokenUse: "id",
  clientId: process.env.COGNITO_CLIENT_ID,
});

export const requireUser = createAuthChecker(verifier);
