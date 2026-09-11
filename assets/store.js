/* Storage layer entry point.

   The actual implementation now lives in separate files - constants.js
   (categories/payments/accounts/months/people), auth-config.js (Google
   token + Supabase URL/key persistence), store-helpers.js (shared
   normalise/dbError/etc plumbing), and stores/{supabase,local,memory}-store.js
   (the three backend implementations). This file re-exports all of it, so
   every existing `import {...} from "./store.js"` across the app keeps
   working unchanged - only openStore() itself (which decides which backend
   to actually use) lives here now.

   Config precedence: what you type under Data → Supabase (localStorage) wins over
   the build-time values injected from GitHub secrets. */

export * from "./constants.js";
export * from "./auth-config.js";
export * from "./store-helpers.js";
export { SupabaseStore } from "./stores/supabase-store.js";
export { LocalStore } from "./stores/local-store.js";
export { MemoryStore } from "./stores/memory-store.js";

import { SupabaseStore } from "./stores/supabase-store.js";
import { LocalStore } from "./stores/local-store.js";
import { MemoryStore } from "./stores/memory-store.js";
import { isJwtExpired, getSupabaseUrl, getSupabaseAnonKey, getIdToken } from "./auth-config.js";

export async function openStore(onNotice) {
  // Supabase is the only real backend now. Falls through to Local/Memory on
  // any failure - the same graceful degradation the app always had, just
  // with one fewer intermediate backend to fall through first.
  const supabaseUrl = getSupabaseUrl(),
    supabaseKey = getSupabaseAnonKey();
  if (supabaseUrl && supabaseKey) {
    try {
      const s = new SupabaseStore(supabaseUrl, supabaseKey);
      const idToken = getIdToken();
      if (idToken) {
        if (isJwtExpired(idToken)) {
          // Same recovery this would eventually reach anyway via the 400
          // from Supabase - see the comment on isJwtExpired() in
          // auth-config.js for why it's worth catching here instead.
          const e = new Error("Your session expired. Please sign in again.");
          e.auth = true;
          throw e;
        }
        await s.signInWithGoogleIdToken(idToken);
      }
      await s.ping();
      return s;
    } catch (e) {
      // An auth failure (expired/invalid session) is NOT the same situation
      // as Supabase being unreachable, and must not be handled the same
      // way. Falling through to LocalStore below - the ordinary behaviour
      // for a real connectivity problem - would silently strand the person
      // in local-only mode with nothing but an easy-to-miss banner, when
      // what actually happened is their sign-in expired and boot()/main()
      // needs to route them back to the sign-in gate instead (main()'s own
      // catch already does exactly that, but only ever sees this error if
      // it's allowed to propagate that far). Re-throwing here instead of
      // notice()-and-fall-through is what makes that happen.
      if (e?.auth) throw e;
      onNotice?.(
        `Supabase unreachable: ${e.message} Falling back to this browser's storage — changes will NOT reach Supabase.`,
        "bad",
      );
    }
  } else {
    onNotice?.(
      "No Supabase project connected. Using browser storage — connect it under Data.",
    );
  }
  try {
    return await LocalStore.open();
  } catch {
    onNotice?.(
      "IndexedDB unavailable, so nothing will persist. Export before closing the tab.",
      "bad",
    );
    return new MemoryStore();
  }
}