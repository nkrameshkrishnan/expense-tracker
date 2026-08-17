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

    // Which tenant this request acts as. A user can belong to more than one
    // tenant (tenant_users has no uniqueness constraint on user_sub alone),
    // so the active one is either explicit (X-Tenant-Id header, validated
    // against membership by the caller) or the token's own default claim set
    // at signup — see postConfirmation.js. Route modules never accept a
    // tenant id from the request body; only from here.
    const requestedTenantId = event.headers?.["x-tenant-id"];
    const tenantId = requestedTenantId || claims["custom:tenant_id"];
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
