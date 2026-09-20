/* Google sign-in gate, sign-out, and the boot sequence that loads real data
   after auth succeeds (or immediately, if no auth is configured).

   auth.js <-> core.js is circular (core.js's withBusy()/refresh() need
   showGate()/signOut()/isRemoteStore() from here; this file needs
   notice()/withBusy()/state()/refresh() from core.js) - safe in ES modules
   since every one of these is only ever called from inside a function body,
   never read at module top-level. Verified via a real import() resolution,
   not just reasoned about. */
import {
  openStore,
  getSupabaseUrl,
  getSupabaseAnonKey,
  getClientId,
  setIdToken,
  setNonce,
} from "./store.js";
import { $, esc, state, notice, withBusy, refresh } from "./core.js";
import { go, VIEWS } from "./router.js";
import { renderDashboard } from "./pages/dashboard.js";

/** Hex-encoded SHA-256 of a string - used only for the Google sign-in nonce
    below. Google's initialize() takes the HASHED nonce and embeds it in the
    id token's own nonce claim; Supabase's signInWithIdToken needs the RAW
    value to hash and compare itself, which is why both a raw and a hashed
    version have to exist side by side rather than just using one value. */
async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Google Identity Services keeps its own internal state once initialize()
// runs (session tickets, an in-flight FedCM prompt, etc.) - calling it a
// second time doesn't reset that state, it just warns "initialize() is
// called multiple times" and can abort whatever prompt was already pending
// (visible in devtools as an AbortError on the FedCM get() call). showGate()
// legitimately runs more than once in a session on purpose (a token
// expiring mid-session, roughly hourly), so init must be idempotent across
// those calls even though rendering the button and attempting the prompt
// should still happen every time - the #gsi-button element itself is a
// fresh DOM node on each call (gate.innerHTML is rebuilt), so the button
// needs re-rendering into it regardless.
let gsiInitialized = false;
let gsiPrompted = false;

export function showGate(message) {
  // Named bootOverlay, not boot - a local `const boot` here would shadow the
  // outer async function boot() below, called from this function's own
  // nested sign-in callback. That exact collision happened once already:
  // "boot is not a function", caught by testing the actual sign-in flow
  // rather than just reading the diff.
  const bootOverlay = $("#boot-loading");
  if (bootOverlay) bootOverlay.hidden = true; // was z-index above the gate - would otherwise hide it entirely
  const gate = $("#gate");
  gate.hidden = false;
  gate.innerHTML = `
    <div class="gate-card">
      <div class="gate-mark">&#8214;</div>
      <h1 class="gate-title">Ledger</h1>
      <p class="gate-sub">${esc(message || "Sign in with the Google account linked to this tracker.")}</p>
      <div id="gsi-button"></div>
      <p class="gate-note">Access is verified by Supabase Row Level Security against an allow-list.
        Signing in here does not grant access on its own.</p>
      <p class="gate-note"><a href="terms.html" target="_blank" rel="noopener">Terms &amp; Privacy</a>
        &mdash; what Google profile information this app collects and why.</p>
    </div>`;

  const cid = getClientId();
  if (!cid) {
    $("#gsi-button").innerHTML =
      `<p class="gate-error">No Google client ID configured. Set GOOGLE_CLIENT_ID in
       assets/config.js, then reload.</p>`;
    return;
  }
  const start = async () => {
    if (!gsiInitialized) {
      gsiInitialized = true;
      // Generated fresh for this one sign-in attempt: Google's initialize()
      // gets the HASHED nonce (embedded in the resulting id token's own
      // nonce claim), while the RAW value is stashed via setNonce() in the
      // callback below for signInWithGoogleIdToken() to hand to Supabase
      // later - see the comment on signInWithGoogleIdToken in store.js for
      // why both matter. Only generated here, inside the init-once guard,
      // since initialize() (and therefore this nonce) is never re-issued on
      // a later showGate() call - see the gsiInitialized comment above.
      const rawNonce = crypto.randomUUID();
      const hashedNonce = await sha256Hex(rawNonce);
      google.accounts.id.initialize({
        client_id: cid,
        nonce: hashedNonce,
        // Chrome is phasing out the legacy One Tap prompt path in favour of
        // its native FedCM API; without this flag the library silently falls
        // back to a shim that logs deprecation warnings (including an inner
        // one about the nonce request shape) instead of using FedCM directly.
        // The isNotDisplayed()/isSkippedMoment() checks in prompt() below
        // still work under FedCM - Google's guide flags them only because
        // their semantics narrow slightly, not because they stop working.
        use_fedcm_for_prompt: true,
        callback: async (res) => {
          setIdToken(res.credential);
          setNonce(rawNonce);
          gate.hidden = true;
          // boot() below makes a real network fetch that can take several
          // seconds on a cold start. Hiding the gate here without showing
          // anything else left a genuinely blank #view for that whole window -
          // the boot-loading overlay only ever covered the FIRST page load,
          // never this second wait after a successful sign-in.
          const bootOverlay = $("#boot-loading");
          if (bootOverlay) bootOverlay.hidden = false;
          startBootMessages();
          // Unlike the top-level main() IIFE, this callback had no try/catch of
          // its own - if boot() threw here for ANY reason, the failure became
          // an unhandled rejection and the page was left exactly in the state
          // being reported: gate hidden, boot-loading uncertain, #view empty,
          // nothing to click, nothing explaining why. Whatever the underlying
          // cause turns out to be, the page must never be able to end up with
          // no visible UI at all - so on any failure here, fall back to
          // showing the gate again with the real error message, the same
          // recovery path used everywhere else auth-related failures surface.
          try {
            await boot();
          } catch (e) {
            setIdToken("");
            setNonce("");
            showGate(
              e?.message ||
                "Something went wrong loading your data. Please sign in again.",
            );
          }
        },
        // auto_select removed on purpose. Google's own docs: on ITP browsers
        // (Safari, Firefox) the automatic One Tap prompt opens a pop-up, and
        // Safari blocks pop-ups that were not triggered by a direct click. That
        // failure is silent from here - no error, no callback, nothing - so a
        // user on Safari could sign in with Google's own UI and still see
        // exactly this same gate afterward with no clue why. The rendered
        // button below is click-triggered, which satisfies the user-gesture
        // requirement on every browser, so it is the primary path now.
      });
    }
    google.accounts.id.renderButton($("#gsi-button"), {
      theme: "filled_black",
      size: "large",
      text: "signin_with",
      shape: "rectangular",
    });

    // Still attempt the automatic prompt as a nice-to-have on browsers where
    // it works cleanly - but only on the FIRST call. Re-prompting on a later
    // showGate() (e.g. after a mid-session token expiry) would either be a
    // silent no-op or race the still-settling first prompt into an
    // AbortError - and the user has already seen one attempt at that point,
    // so the rendered button is the reliable path from here on regardless.
    if (!gsiPrompted) {
      gsiPrompted = true;
      google.accounts.id.prompt((notification) => {
        if (
          notification.isNotDisplayed?.() ||
          notification.isSkippedMoment?.()
        ) {
          const hint = $(".gate-sub");
          if (hint)
            hint.textContent =
              "The automatic prompt did not open in this browser (common in Safari) \u2014 use the button below instead.";
        }
      });
    }
  };
  if (window.google?.accounts?.id) start();
  else
    window.addEventListener(
      "load",
      () => window.google?.accounts?.id && start(),
      { once: true },
    );
}

export function signOut() {
  setIdToken("");
  setNonce("");
  try {
    google.accounts.id.disableAutoSelect();
  } catch {}
  location.reload();
}

/* Staged, time-based messages for the boot-loading overlay. A cold sign-in
   plus the first Supabase query can take a few seconds, and a silent
   unlabeled spinner for that whole window is indistinguishable from a
   frozen page to a real person watching it - a direct report confirmed
   exactly that impression. */
let _bootMsgTimers = [];
function startBootMessages() {
  stopBootMessages();
  const el = $("#boot-msg");
  if (!el) return;
  const stages = [
    [0, ""],
    [1800, "Connecting\u2026"],
    [4500, "Still connecting \u2014 first sign-in can take a little longer"],
    [8000, "Still working \u2014 almost there"],
  ];
  _bootMsgTimers = stages.map(([delay, text]) =>
    setTimeout(() => {
      if (el) el.textContent = text;
    }, delay),
  );
}
function stopBootMessages() {
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

// "Connected to a real backend" - true only for Supabase now (the earlier
// Sheets backend has been removed). LocalStore/MemoryStore mean openStore()
// actually fell back; a resolved Supabase connection is a success, not a
// degraded state.
export const isRemoteStore = (s) => s.kind === "supabase";

// Shared across every "where is this actually being saved" message (Net
// worth import/save, transactions import, the wipe confirmation) - naming
// the backend explicitly (rather than a generic "connected"/"not connected")
// matters most for a destructive action: the wipe confirmation needs to say
// "your Supabase project" when it is about to delete from a live database,
// not something vague enough to read as "browser storage" either way.
export const backendLabel = (s) =>
  s.kind === "supabase"
    ? "your Supabase project"
    : s.kind === "memory"
      ? "this session only (nothing will be saved after reload)"
      : "this browser only";

export async function boot() {
  startBootMessages();
  state.store = await openStore(notice);
  await refresh();
  revealApp();
  // A configured Supabase project that still failed to connect (as opposed
  // to nothing being configured at all, which is a normal, expected state)
  // is the one case worth a real recovery action, not just informational
  // text - the only previous recovery path was "go to Data, click Connect &
  // test", which nothing on screen actually pointed you toward.
  if (getSupabaseUrl() && getSupabaseAnonKey() && !isRemoteStore(state.store)) {
    notice(
      "Could not reach Supabase just now \u2014 working from this browser\u2019s storage instead.",
      "bad",
      {
        label: "Retry connecting",
        onClick: async () => {
          const done = await withBusy("Reconnecting", async () => {
            state.store = await openStore(notice);
            if (!isRemoteStore(state.store))
              throw new Error("still could not reach Supabase");
            await refresh();
            await state.store.ensureAllYearsLoaded?.(); // same reasoning as Connect & test: a rare, manual action, worth the accurate total
            state.rows = await state.store.list();
          });
          if (done) {
            notice(
              `Connected to Supabase \u2014 ${state.rows.length} rows loaded.`,
              "ok",
            );
            (VIEWS[state.tab] || renderDashboard)();
          }
        },
      },
    );
  }
  // Tied to the ACTUAL current state - no Supabase connection AND no local
  // data either - not to a one-time "have you ever visited" flag. That flag
  // lived in localStorage, which never expires: the very first page load
  // after this feature shipped set it permanently, so it correctly fired
  // once and then silently never fired again for that browser - including
  // for someone who still has nothing connected and nothing recorded, which
  // is exactly the case this was supposed to keep helping with. Checking
  // real state instead means it naturally stops nagging the moment there is
  // either a real Supabase connection OR real local data worth not
  // disrupting with a redirect - and keeps helping for as long as neither
  // exists yet.
  const firstRun =
    !(getSupabaseUrl() && getSupabaseAnonKey()) &&
    !isRemoteStore(state.store) &&
    state.rows.length === 0;
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
  const startTab = firstRun ? "data" : hashTab in VIEWS ? hashTab : "dashboard";
  go(startTab);

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
