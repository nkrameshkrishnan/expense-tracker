/* Cognito Hosted UI sign-in flow (federates to Google) and the boot-sequence
   UI helpers (loading messages, revealing the app once ready). isRemoteStore
   distinguishes the real API backend from the offline DisconnectedStore.
   boot() itself lives here too, added by a follow-up commit. */
import {
  getCognitoConfig,
  getIdToken,
  setIdToken,
  openStore,
} from "./store.js";
import { $, esc, state, notice, withBusy, refresh } from "./core.js";
import {
  setPendingInviteToken,
  PLAN_GATE_SEEN_KEY,
  getPendingInviteToken,
  planGateSeen,
} from "./tenant.js";
import { go, VIEWS } from "./router.js";
import { renderPlanGate } from "./pages/plan-gate.js";
import { renderDashboard } from "./pages/dashboard.js";

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

export async function boot() {
  startBootMessages();
  state.store = await openStore(notice);
  await refresh();
  // An already-signed-in user clicking an invite link: showGate()'s own
  // inviteMatch handles the NOT-signed-in case (it feeds the token through
  // Cognito's client_metadata so postConfirmation.js can redeem it on
  // signup) - this covers the other case, where boot() runs directly and
  // that gate is never shown at all. Same hash-based #invite=<token> link
  // createInvite's "Copy link" button already produces (see the
  // data-copy-invite handler below) - reusing that format rather than
  // introducing a second, differently-shaped invite param.
  //
  // The sessionStorage fallback covers the signed-OUT case: showGate()
  // parks the token there before handing off to Cognito, because the
  // redirect back consumes and clears the whole fragment (including
  // #invite=) before this ever runs, and client_metadata only reaches
  // PostConfirmation, which does not fire for an existing user signing in
  // again. Redeeming a token that user's own signup already burned is not
  // an error: redeemInvite treats a spent token whose tenant you are
  // already a member of as a no-op success.
  const inviteMatch = location.hash.match(/invite=([\w-]+)/);
  const inviteToken = inviteMatch?.[1] || getPendingInviteToken();
  if (inviteToken && isRemoteStore(state.store)) {
    const joined = await withBusy("Joining household", async () => {
      await state.store.joinTenant(inviteToken);
    });
    // Consumed either way - a failed token must not be retried on every
    // subsequent load of this tab.
    setPendingInviteToken("");
    if (joined) {
      state.tenants = (await state.store.getMyTenants?.()) || [];
      notice(
        "You've joined the household. Switch to it from the Household panel whenever you're ready.",
        "ok",
      );
    }
    // No else: withBusy has already shown the REAL failure ("Joining
    // household failed: <server message>"). Overwriting it with a fixed
    // "invalid or has expired" hid genuinely different causes - a seat-cap
    // rejection, or a lost membership - behind a wrong explanation.
    //
    // Strip the hash so a reload/refresh doesn't try to re-join. Only when
    // the token actually came from the hash: otherwise this would throw
    // away a perfectly good #transactions-style deep link.
    if (inviteMatch)
      history.replaceState(null, "", location.pathname + location.search);
  }
  // A brand-new household's owner, who has never chosen a plan: gated the
  // same way showDowngradeBanner tells "new" apart from "downgraded" - plan
  // is free AND no Stripe customer has ever been created for this tenant.
  // An owner who cancelled after a failed payment (hasStripeCustomer: true)
  // is back on Free too, but must never see the "new signup" gate again.
  const showPlanGate =
    state.role === "owner" &&
    state.tenant?.plan === "free" &&
    !state.tenant?.hasStripeCustomer &&
    !planGateSeen();
  // Deferred until the plan gate has had its chance to decide: revealing the
  // header now would let a bare, unstyled Dashboard flash behind the gate
  // for a moment before it renders (see renderPlanGate's own comment).
  if (!showPlanGate) revealApp();
  if (state.tenant?.status === "past_due") {
    notice(
      "Your payment failed — update your card to keep full access.",
      "bad",
      {
        label: "Manage billing →",
        // Same withBusy + notice shape as the #manage-billing handler in
        // renderBilling(). Without it, a failed createPortalSession (expired
        // token, API down, a non-owner reaching the banner) rejected into
        // nothing: the click looked like it did nothing at all.
        onClick: async () => {
          const returnUrl = location.origin + location.pathname;
          const done = await withBusy("Opening billing portal", async () => {
            const { url } = await state.store.createPortalSession(returnUrl);
            location.href = url;
          });
          if (!done) notice("Could not open billing portal.", "bad");
        },
      },
    );
  }
  // There is no local/offline fallback in this build (see store.js) - a
  // DisconnectedStore here means every read comes back empty and every
  // write will throw until this is resolved, whether that's because no API
  // endpoint is configured at all or a configured one just failed to
  // answer. Either way it's the one state worth a persistent, actionable
  // banner rather than letting the empty dashboard speak for itself. The
  // retry window in store.js now covers several seconds of genuine cold
  // starts, but no window is infinite, and this is also the manual recovery
  // path once it exhausts.
  if (!isRemoteStore(state.store)) {
    notice(
      "Not connected to your Ledger account — nothing will load or save until you reconnect.",
      "bad",
      {
        label: "Retry connecting",
        onClick: async () => {
          const done = await withBusy("Reconnecting", async () => {
            state.store = await openStore(notice);
            if (!isRemoteStore(state.store))
              throw new Error("still could not reach your Ledger account");
            await refresh();
            await state.store.ensureAllYearsLoaded?.(); // same reasoning as Connect & test: a rare, manual action, worth the accurate total
            state.rows = await state.store.list();
          });
          if (done) {
            notice(`Connected — ${state.rows.length} rows loaded.`, "ok");
            (VIEWS[state.tab] || renderDashboard)();
          }
        },
      },
    );
  }
  // Was: `(location.hash || '#dashboard').slice(1) in VIEWS ? location.hash.slice(1) : 'dashboard'`
  // - the '#dashboard' fallback was only used for the membership CHECK, then
  // the true branch re-read the original (still-empty) location.hash a
  // second time, producing startTab = '' whenever there was no hash at all.
  // The dashboard still rendered (VIEWS[''] falls back to renderDashboard
  // elsewhere), so this was invisible by luck - but the URL bar itself never
  // actually got '#dashboard' written into it. Compute the effective tab
  // once and reuse it, rather than deriving it twice from two different
  // values.
  const hashTab = (location.hash || "#dashboard").slice(1);
  const startTab = hashTab in VIEWS ? hashTab : "dashboard";
  if (showPlanGate) {
    renderPlanGate(() => {
      revealApp();
      go(startTab);
    });
  } else {
    go(startTab);
  }

  // Fire-and-forget: brings in every other year's transactions silently in
  // the background, so by the time anyone actually reaches for a different
  // year or searches Transactions, it is usually already there - without
  // making the FIRST paint wait on however much history has accumulated.
  // Only re-renders on Dashboard/Transactions, where more data arriving
  // actually changes what is on screen; skipped entirely on Add (would wipe
  // in-progress form input) and elsewhere it would just be pointless churn.
  state.store
    .ensureAllYearsLoaded?.()
    .then(async () => {
      state.rows = await state.store.list();
      if (state.tab === "dashboard" || state.tab === "transactions")
        (VIEWS[state.tab] || renderDashboard)();
    })
    .catch(() => {}); // best-effort - a failure here just means years stay lazy-loaded on demand
}
