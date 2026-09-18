/* Shared plumbing used by all three store backends (Supabase/Local/Memory):
   row normalisation, budget shaping, the lazy Supabase SDK loader, and a
   small sleep/retry/error-tagging toolkit. */
import { CAT_NAMES, PEOPLE, TYPES } from "./constants.js";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The actual current calendar year, not a value baked in at build time.
    Was `export const YEAR = 2026;` - fine for exactly one year, silently
    wrong for every year after. Anything needing "the current year" as a
    UI default should call this; anything needing "the year the person is
    currently viewing" should use state.year in core.js instead, since those
    are genuinely different things (today's date vs. a chosen Dashboard year). */

export function currentYear() {
  return new Date().getFullYear();
}

export function emptyBudget() {
  const b = {};
  for (const c of CAT_NAMES) {
    b[c] = {};
    for (let m = 1; m <= 12; m++) b[c][m] = 0;
  }
  return b;
}

export function normalise(r) {
  const amount = Math.abs(Number(r.amount) || 0);
  let type = r.type || r.typ || "Expense";
  if (!TYPES.includes(type)) type = "Expense";
  const raw = r.category || r.cat;
  return {
    // Postgres bigint columns (used for Supabase's identity primary keys)
    // serialize as STRINGS over JSON - both pg and PostgREST do this
    // deliberately, since a full 64-bit integer isn't always safely
    // representable as a JS number. LocalStore/MemoryStore ids are always
    // real JS numbers already, so this coercion is a no-op for them and
    // matters only for Supabase - but doing it unconditionally here means
    // every id comparison anywhere in the app (strict equality included)
    // behaves consistently regardless of which backend produced the record.
    // This was found by a real bug: a strict `!==` comparison in remove()
    // silently never matched a Postgres-sourced id against a coerced
    // Number(id), because the cached id was still a string.
    id: Number(r.id) || 0,
    date: String(r.date || "").slice(0, 10),
    type,
    // Any non-empty string is allowed: users can create their own categories,
    // and forcing unknown names to Miscellaneous would silently discard them.
    category: String(raw || "").trim() || "Miscellaneous",
    subcategory: r.subcategory || r.sub || "",
    description: r.description || r.desc || "",
    amount: Math.round(amount * 100) / 100,
    payment: r.payment || "",
    account: r.account || "",
    recurring: r.recurring === "Yes" || r.recur === "Yes" ? "Yes" : "No",
    notes: r.notes || r.note || "",
    person: PEOPLE.includes(r.person) ? r.person : "",
  };
}

/* ------------------------------------------------------------------- Supabase
   helpers - loading the SDK lazily, paginating past PostgREST's 1000-row
   cap, and tagging auth-expiry errors so callers can route to re-sign-in.
   No build step means no npm import for the SDK - it is loaded from a CDN
   on first actual use, same lazy pattern as xlsxio.js's loadXLSX(): most
   sessions won't have Supabase configured at all, so there is no reason to
   fetch the SDK for them. */
let supabaseSdkReady = null;

export function loadSupabaseSdk() {
  if (typeof window !== "undefined" && window.supabase?.createClient)
    return Promise.resolve();
  if (supabaseSdkReady) return supabaseSdkReady;
  supabaseSdkReady = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src =
      "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js";
    s.onload = resolve;
    s.onerror = () => {
      supabaseSdkReady = null;
      reject(
        new Error(
          "Could not load the Supabase client library. Check your connection and try again.",
        ),
      );
    };
    document.head.appendChild(s);
  });
  return supabaseSdkReady;
}

// Cached at module scope, not per-instance: openStore() runs more than once
// a session (boot, then again on "Test connection"/"Disconnect"), and each
// call constructs a fresh SupabaseStore. Without this, every one of those
// called createClient() again for the same project, and supabase-js warns
// "Multiple GoTrueClient instances detected... same storage key" because
// they all read/write the same localStorage auth-token entry. An object
// wrapper, not two loose `let`s, because SupabaseStore (in a different
// module) needs to update this too - ES modules allow mutating PROPERTIES
// of an imported object, just not reassigning the imported binding itself.
export const supabaseClientCache = { client: null, key: "" };

// PostgREST (what supabase-js talks to) caps any single response at 1000
// rows by default - a project-level setting, not something this code
// controls, and it fails silently: no error, just a truncated result. A
// real transaction history WILL cross 1000 rows eventually, and every read
// below used to be a plain .select() with no .range(), so rows past the
// cap simply vanished from the app with nothing indicating why. buildQuery
// must return a FRESH query object each call - a supabase-js query builder
// is not safely re-usable across repeated awaits.

export const SUPABASE_PAGE_SIZE = 1000;

// Every Supabase write/read throws a plain Error(error.message) on failure -
// except a session that expired mid-use (roughly hourly - see the comment
// above sha256Hex in auth.js) surfaces here as a JWT/permission/RLS error
// from PostgREST, and THAT specific case needs to route to the re-sign-in
// screen (see withBusy()'s catch in core.js, which checks e.auth) rather than
// just showing a red "X failed: JWT expired" banner and leaving the page
// half-authenticated with no way forward. One shared helper instead of
// repeating the same tagging at each of the dozen-plus call sites below,
// which is how _loadYear() originally had it but getBudget()'s separate
// fetch path did not - the exact kind of drift a shared helper prevents.

export function dbError(error) {
  const e = new Error(error.message);
  // Real Postgres RLS violations read "...violates row-level security
  // policy..." - the spelled-out phrase, never the bare acronym "RLS" - so
  // matching only /RLS/i (as this originally did) silently never caught an
  // actual RLS denial, only a JWT error or a generic "permission denied".
  if (/JWT|permission|row-level security/i.test(error.message)) e.auth = true;
  return e;
}

export async function selectAllRows(buildQuery) {
  const rows = [];
  let from = 0;
  for (;;) {
    const { data, error } = await buildQuery(
      from,
      from + SUPABASE_PAGE_SIZE - 1,
    );
    if (error) return { data: null, error };
    rows.push(...data);
    if (data.length < SUPABASE_PAGE_SIZE) break;
    from += SUPABASE_PAGE_SIZE;
  }
  return { data: rows, error: null };
}

export function budgetRowsToShape(rows) {
  const full = emptyBudget();
  for (const row of rows || [])
    if (full[row.category]) full[row.category][row.month] = Number(row.amount);
  return full;
}
