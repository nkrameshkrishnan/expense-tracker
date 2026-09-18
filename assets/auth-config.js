/* Auth/config values persisted in localStorage/sessionStorage: the Google ID
   token, sign-in nonce, and the runtime-overridable Supabase URL/anon key
   (what you type under Data -> Supabase wins over the build-time values
   injected from GitHub secrets - see getSupabaseUrl/getSupabaseAnonKey). */
import { GOOGLE_CLIENT_ID, SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

// A stored Google ID token from a session over ~1hr old is already expired
// by the time a later page load (e.g. a hard refresh) tries to reuse it -
// signInWithIdToken() in supabase-store.js already recovers correctly from
// that (the resulting error is tagged .auth = true, which routes to the
// re-sign-in screen), but only after actually making the doomed request
// first: a real POST to Supabase's /auth/v1/token that Google's own
// verification was always going to reject with 400. Decoding the token's
// own `exp` claim locally catches this before spending that round trip -
// same recovery path, minus the guaranteed-failing network call and the
// console entry that comes with any non-2xx response regardless of whether
// the app's own try/catch already handles it.
export function isJwtExpired(token) {
  try {
    const payload = JSON.parse(
      atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")),
    );
    // 30s grace period, not exact-second precision - a token that expires
    // between "this check" and "the request Supabase makes with it" a
    // moment later should still be treated as expired now rather than
    // trusting a razor-thin margin.
    return !payload.exp || payload.exp * 1000 < Date.now() + 30_000;
  } catch {
    // Anything unparseable (truncated, corrupted, not actually a JWT) is
    // not a token this app minted itself - safest to treat it as expired
    // and let the normal re-sign-in path handle it, rather than risk
    // throwing here on a malformed token which is likely stale localStorage
    // data anyway.
    return true;
  }
}

export const ID_TOKEN_KEY = "ledger.googleIdToken";
export const NONCE_KEY = "ledger.googleNonce";

export const getClientId = () =>
  (localStorage.getItem("ledger.clientId") || GOOGLE_CLIENT_ID || "").trim();
// sessionStorage can throw in locked-down browser contexts (strict privacy
// modes, some sandboxed embeds). Falls back to an in-memory value for the
// lifetime of the tab rather than crashing the whole app on that one call.
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
// The RAW nonce given to signInWithIdToken() - Google's initialize() only
// ever sees its SHA-256 hash (see showGate() in auth.js), so the raw value
// has to be kept somewhere to hand to Supabase later. Persisted alongside
// the id token itself (not just held in a variable) because Supabase sign-in
// can happen well after the Google callback fires - e.g. on a later page
// load that reuses a still-valid sessionStorage id token - not only in the
// same tick as the callback.
let _nonceMem = "";
export const getNonce = () => {
  try {
    return sessionStorage.getItem(NONCE_KEY) || "";
  } catch {
    return _nonceMem;
  }
};
export const setNonce = (n) => {
  try {
    if (n) sessionStorage.setItem(NONCE_KEY, n);
    else sessionStorage.removeItem(NONCE_KEY);
  } catch {
    /* fall through to memory */
  }
  _nonceMem = n || "";
};

export const SUPABASE_URL_KEY = "ledger.supabaseUrl";
export const SUPABASE_KEY_KEY = "ledger.supabaseAnonKey";
export const getSupabaseUrl = () =>
  (localStorage.getItem(SUPABASE_URL_KEY) || SUPABASE_URL || "").trim();
export const getSupabaseAnonKey = () =>
  (localStorage.getItem(SUPABASE_KEY_KEY) || SUPABASE_ANON_KEY || "").trim();
export const supabaseConfigSource = () =>
  localStorage.getItem(SUPABASE_URL_KEY)
    ? "runtime"
    : SUPABASE_URL
      ? "build"
      : "none";
