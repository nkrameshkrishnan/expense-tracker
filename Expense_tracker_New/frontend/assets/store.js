/* Storage layer for the SaaS build. ApiStore is the only real store: it
   talks to the server-mediated API (API Gateway + Lambda + Aurora, see
   ../../backend) instead of a Google Sheet or Supabase directly — the
   browser never holds a database credential of any kind, only a
   short-lived Cognito ID token. There is deliberately no local/offline
   fallback (this is multi-tenant SaaS, not a personal tool with no server
   of its own) — see DisconnectedStore below for what openStore() returns
   when a real connection isn't currently working. app.js calls the same
   interface regardless of which one is active. */

export * from "./constants.js";
export * from "./auth-config.js";
export * from "./store-helpers.js";
export { ApiStore } from "./stores/api-store.js";
export { DisconnectedStore } from "./stores/disconnected-store.js";

import { getApiEndpoint, getIdToken } from "./auth-config.js";
import { ApiStore } from "./stores/api-store.js";
import { DisconnectedStore } from "./stores/disconnected-store.js";

/** Requires a real, working connection to the account — there is no local
    or offline fallback. If the endpoint or token is missing, or the API
    can't be reached, this returns a DisconnectedStore: the app still boots
    and renders (see boot() in app.js), but every read comes back empty and
    every write fails loudly instead of quietly keeping changes that were
    never actually saved anywhere. */
export async function openStore(onNotice) {
  const endpoint = getApiEndpoint();
  const idToken = getIdToken();
  if (endpoint && idToken) {
    try {
      const s = new ApiStore(endpoint, idToken);
      await s.ping();
      return s;
    } catch (e) {
      // e.message is already user-appropriate (see _get/_post above), but
      // stitching it onto a lead-in phrase here reads redundant ("Could not
      // connect...: Couldn't reach..."). Log the detail, show one message.
      console.error(`[store] openStore failed: ${e.message}`);
      onNotice?.("Could not connect to your Ledger account.", "bad");
      return new DisconnectedStore();
    }
  }
  onNotice?.("Not connected to a Ledger account.", "bad");
  return new DisconnectedStore();
}
