/* Cognito Hosted UI sign-in flow (federates to Google) and the boot-sequence
   UI helpers (loading messages, revealing the app once ready). isRemoteStore
   distinguishes the real API backend from the offline DisconnectedStore.
   boot() itself lives here too, added by a follow-up commit. */
import { getCognitoConfig, getIdToken, setIdToken } from "./store.js";
import { $, esc } from "./core.js";
import { setPendingInviteToken, PLAN_GATE_SEEN_KEY } from "./tenant.js";

/* ------------------------------------------------------------ Google sign-in
   The ID token lives in sessionStorage, so closing the tab signs you out.
   It is only ever a claim - Apps Script decides whether it is honoured. */
/* A true full-viewport overlay rather than a sibling whose visibility has to
   stay manually in sync with #view. That sync WAS the bug: only the initial
   page-load path and a successful sign-in ever touched it, so any auth
   failure that happened mid-session (a token expiring after ~an hour, then
   the user clicking Reload, Add, or anything else that hits the sheet) left
   the previous page's content fully rendered underneath a banner that
   explained nothing and offered no way back in. Wrapping this in a fixed,
   opaque, high-z-index layer means showing it can never result in stale
   content bleeding through, no matter which code path triggered it. */
/** Cognito's Hosted UI federates to Google itself - the frontend no longer
    loads Google Identity Services or handles a raw Google id_token at all.
    response_type=token is the implicit grant: safe for a public client (no
    client secret, nothing to keep out of the browser), and it hands back a
    usable Cognito id_token directly in the redirect's URL fragment, with no
    server-side code exchange step needed. */
export function cognitoAuthorizeUrl(inviteToken) {
  const { domain, clientId } = getCognitoConfig();
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "token",
    scope: "openid email profile",
    redirect_uri: location.origin + location.pathname,
    identity_provider: "Google",
  });
  if (inviteToken)
    params.set("client_metadata", JSON.stringify({ inviteToken }));
  return `https://${domain}/oauth2/authorize?${params}`;
}

export function showGate(message) {
  // Named bootOverlay, not boot - a local `const boot` here would shadow the
  // outer async function boot() inside this function's own nested sign-in
  // callback below, which calls the REAL boot(). That exact collision
  // happened once already: "boot is not a function", caught by testing the
  // actual sign-in flow rather than just reading the diff.
  const bootOverlay = $("#boot-loading");
  if (bootOverlay) bootOverlay.hidden = true; // was z-index above the gate - would otherwise hide it entirely
  const gate = $("#gate");
  gate.hidden = false;
  gate.innerHTML = `
    <div class="gate-card">
      <div class="gate-mark">&#8214;</div>
      <h1 class="gate-title">Ledger</h1>
      <p class="gate-sub">${esc(message || "Sign in with Google to continue.")}</p>
      <div id="gsi-button"></div>
      <p class="gate-note">Every request is checked on our servers, and your
        household's data is always kept separate from every other household's.
        Signing in here does not grant access on its own.</p>
    </div>`;

  const { domain, clientId } = getCognitoConfig();
  if (!domain || !clientId) {
    // The exact fix (COGNITO_DOMAIN/COGNITO_CLIENT_ID in config.js) is
    // real, but meaningless to whoever is actually looking at the sign-in
    // screen — keep it in the console for whoever's debugging the
    // deployment, and keep the on-screen copy in plain language.
    console.error(
      "Cognito not configured: set COGNITO_DOMAIN and COGNITO_CLIENT_ID in assets/config.js (see backend/template.yaml's outputs).",
    );
    $("#gsi-button").innerHTML =
      `<p class="gate-error">Sign-in isn't set up for this site yet. Please check back later.</p>`;
    return;
  }
  $("#gsi-button").innerHTML =
    `<button class="btn" id="cognito-signin">Sign in with Google</button>`;
  $("#cognito-signin").onclick = () => {
    const inviteMatch = location.hash.match(/invite=([\w-]+)/);
    const inviteToken = inviteMatch?.[1];
    // client_metadata (below) only ever reaches the PostConfirmation
    // trigger, i.e. only for a first-ever signup. An EXISTING user
    // clicking an invite link - the common case, since invites go to
    // people who often already have an account - would otherwise sign in
    // and silently never join anything. Stash it so boot() can redeem it
    // after the redirect lands.
    if (inviteToken) setPendingInviteToken(inviteToken);
    location.href = cognitoAuthorizeUrl(inviteToken);
  };
}

export function signOut() {
  setIdToken("");
  localStorage.removeItem(PLAN_GATE_SEEN_KEY);
  const { domain, clientId } = getCognitoConfig();
  if (domain && clientId) {
    const params = new URLSearchParams({
      client_id: clientId,
      logout_uri: location.origin + location.pathname,
    });
    location.href = `https://${domain}/logout?${params}`;
    return;
  }
  location.reload();
}

/** Cognito's Hosted UI redirects back here with the id_token in the URL
    FRAGMENT (never sent to any server as part of a request), matching the
    response_type=token request above. Runs once at startup, before boot()
    decides whether the gate needs showing - a fragment left sitting in the
    URL bar after a successful sign-in would also leak the token into
    browser history, so this is cleared unconditionally either way. */
export function consumeAuthRedirect() {
  if (!location.hash.includes("id_token=")) return false;
  const idToken = new URLSearchParams(location.hash.slice(1)).get("id_token");
  history.replaceState(null, "", location.pathname + location.search);
  if (!idToken) return false;
  setIdToken(idToken);
  return true;
}

/* Staged, time-based messages for the boot-loading overlay - independent of
   store.js's actual retry count, so this needs no wiring through several
   layers to know "which attempt" is in flight. A cold sign-in can
   legitimately take several seconds (retries against a cold Lambda/Aurora
   start, worst case), and a silent unlabeled spinner for that whole window
   is indistinguishable from a frozen page to a real person watching it - a
   direct report confirmed exactly that impression. */
let _bootMsgTimers = [];
export function startBootMessages() {
  stopBootMessages();
  const el = $("#boot-msg");
  if (!el) return;
  const stages = [
    [0, ""],
    [1800, "Connecting…"],
    [4500, "Still connecting — first sign-in can take a little longer"],
    [8000, "Almost there — waking up your account"],
  ];
  _bootMsgTimers = stages.map(([delay, text]) =>
    setTimeout(() => {
      if (el) el.textContent = text;
    }, delay),
  );
}
export function stopBootMessages() {
  _bootMsgTimers.forEach(clearTimeout);
  _bootMsgTimers = [];
}

/** Reveal the real app - hide the boot overlay, show the header/nav that was
    deliberately kept invisible (not un-rendered, just visibility:hidden) so
    there is zero layout shift the instant it appears. */
export function revealApp() {
  stopBootMessages();
  const bootOverlay = $("#boot-loading");
  if (bootOverlay) bootOverlay.hidden = true;
  const header = $("#app-header");
  if (header) header.style.visibility = "";
}

// True only when actually talking to the API. False for DisconnectedStore
// (see store.js) - there is no other kind of store in this build.
export const isRemoteStore = (s) => s.kind === "api";
