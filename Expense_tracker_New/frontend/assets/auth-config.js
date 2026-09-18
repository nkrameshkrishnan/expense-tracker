/* Cognito config accessors and API-endpoint/token storage — read by auth.js and store.js. */

import {
  API_ENDPOINT,
  COGNITO_USER_POOL_ID,
  COGNITO_CLIENT_ID,
  COGNITO_DOMAIN,
  COGNITO_REGION,
} from "./config.js";

/* ----------------------------------------------------------- Cognito auth
   Config precedence matches the original project: what's typed under a
   runtime settings screen (localStorage) wins over build-time config.js
   values, so this can be pointed at a different deployment without a
   rebuild. */
export const API_ENDPOINT_KEY = "ledger.apiEndpoint";
export const getApiEndpoint = () =>
  (localStorage.getItem(API_ENDPOINT_KEY) || API_ENDPOINT || "").trim();
export const apiEndpointSource = () =>
  localStorage.getItem(API_ENDPOINT_KEY)
    ? "runtime"
    : API_ENDPOINT
      ? "build"
      : "none";

export const getCognitoConfig = () => ({
  userPoolId: COGNITO_USER_POOL_ID,
  clientId: COGNITO_CLIENT_ID,
  domain: COGNITO_DOMAIN,
  region: COGNITO_REGION,
});

const ID_TOKEN_KEY = "ledger.cognitoIdToken";

// sessionStorage can throw in locked-down browser contexts; falls back to
// an in-memory value for the lifetime of the tab rather than crashing the
// whole app on that one call — same pattern the original store.js uses for
// the Google ID token.
let _idTokenMem = "";
export const getIdToken = () => {
  try {
    return sessionStorage.getItem(ID_TOKEN_KEY) || "";
  } catch {
    return _idTokenMem;
  }
};
export const setIdToken = (t) => {
  try {
    if (t) sessionStorage.setItem(ID_TOKEN_KEY, t);
    else sessionStorage.removeItem(ID_TOKEN_KEY);
  } catch {
    /* fall through to memory */
  }
  _idTokenMem = t || "";
};
