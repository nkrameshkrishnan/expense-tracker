/* Entry point. Everything else lives in core.js, auth.js, categories.js,
   router.js, and pages/*.js - this file just boots the app: wait for
   Chart.js to be ready, gate behind Google sign-in if configured, then
   boot() the real UI. */
import { getClientId, getIdToken, setIdToken, setNonce } from "./store.js";
import { showGate, boot, revealApp } from "./auth.js";

(async function main() {
  // XLSX is deliberately excluded - it's loaded on demand by xlsxio.js when
  // Export/Import is actually clicked, not before. Waiting for it here would
  // reintroduce the exact 930KB blocking cost this change removes.
  const ready = () => typeof Chart !== "undefined";
  if (!ready())
    await new Promise((r) =>
      window.addEventListener("load", r, { once: true }),
    );

  // Sign-in is required whenever this deployment has Google auth configured
  // AT ALL - a site-wide setting - regardless of whether THIS particular
  // browser happens to already have a sheet endpoint saved. It used to also
  // require an endpoint on this device, which meant a brand new browser
  // skipped authentication entirely and landed straight on an empty,
  // unexplained Dashboard instead of ever being asked to sign in.
  const needsAuth = !!getClientId();
  if (needsAuth && !getIdToken()) {
    showGate();
    return;
  }
  // No Google auth configured at all: nothing to protect, go straight in -
  // but still clear the loading overlay once real content is ready, same as
  // the authenticated path.

  try {
    await boot();
  } catch (e) {
    if (e?.auth || /sign in|not permitted/i.test(e?.message || "")) {
      setIdToken("");
      setNonce("");
      showGate(e.message);
    } else {
      revealApp();
      throw e;
    }
  }
})();