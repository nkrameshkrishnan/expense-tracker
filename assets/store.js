/* Storage layer.

   SheetsStore is the real one: your Google Sheet is the database, reached through an
   Apps Script web app. LocalStore (IndexedDB) remains as the no-configuration fallback
   so the app is usable before you wire up the sheet, and MemoryStore covers browsers
   where IndexedDB is blocked.

   Config precedence: what you type under Data → Google Sheet (localStorage) wins over
   the build-time values injected from GitHub secrets. */

import {
  SHEETS_ENDPOINT,
  SHEETS_TOKEN,
  GOOGLE_CLIENT_ID,
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
} from "./config.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The actual current calendar year, not a value baked in at build time.
    Was `export const YEAR = 2026;` - fine for exactly one year, silently
    wrong for every year after. Anything needing "the current year" as a
    UI default should call this; anything needing "the year the person is
    currently viewing" should use state.year in app.js instead, since those
    are genuinely different things (today's date vs. a chosen Dashboard year). */
export function currentYear() {
  return new Date().getFullYear();
}

export const CATEGORIES = [
  ["Salary", "Income"],
  ["Dividends", "Income"],
  ["Other Income", "Income"],
  ["Rent / Housing", "Expense"],
  ["Groceries", "Expense"],
  ["Utilities", "Expense"],
  ["Internet & Phone", "Expense"],
  ["Transport", "Expense"],
  ["Gas", "Expense"],
  ["Dining Out", "Expense"],
  ["Health & Fitness", "Expense"],
  ["Insurance", "Expense"],
  ["Shopping", "Expense"],
  ["Entertainment", "Expense"],
  ["Subscriptions", "Expense"],
  ["Travel", "Expense"],
  ["Education", "Expense"],
  ["Gifts & Donations", "Expense"],
  ["Personal Care", "Expense"],
  ["Savings & Investments", "Expense"],
  ["Miscellaneous", "Expense"],
];
export const CAT_NAMES = CATEGORIES.map((c) => c[0]);
export const EXPENSE_CATS = CATEGORIES.filter((c) => c[1] === "Expense").map(
  (c) => c[0],
);
export const CAT_TYPE = Object.fromEntries(CATEGORIES);

export const TYPES = ["Expense", "Income", "Transfer", "Dividends"];
export const PAYMENTS = [
  "Credit Card",
  "Debit Card",
  "Cash",
  "e-Transfer",
  "Pre-authorized Debit",
  "Other",
];
export const ACCOUNTS = [
  "CIBC Chequing",
  "WealthSimple Chequing",
  "Savings",
  "Visa",
  "Mastercard",
  "Amex",
  "WealthSimple TFSA",
  "WealthSimple RRSP",
  "WealthSimple Non-registered",
  "Cash Wallet",
];
export const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/* Who the money belongs to. 'Joint' is a real third bucket, not a sum of the other
   two — a shared grocery run is Joint, it is not half Ramesh and half Surya.
   Rows imported before this feature existed have no person and read as Unassigned. */
export const PEOPLE = ["Ramesh", "Surya", "Joint"];
export const UNASSIGNED = "Unassigned";
export const PERSON_KEY = "ledger.person";

/* Accounts tracked for net worth. Some exist only as balances and never appear
   in transactions (a GIC, a savings account that sat at zero all year), so this
   is deliberately a superset of ACCOUNTS rather than derived from it. */
export const NET_WORTH_ACCOUNTS = [
  { account: "CIBC Chequing", owner: "Ramesh", kind: "Asset" },
  { account: "CIBC TFSA (Investment)", owner: "Ramesh", kind: "Asset" },
  { account: "WealthSimple Chequing", owner: "Ramesh", kind: "Asset" },
  { account: "WealthSimple TFSA", owner: "Ramesh", kind: "Asset" },
  { account: "WealthSimple RRSP", owner: "Ramesh", kind: "Asset" },
  { account: "WealthSimple Non-registered", owner: "Ramesh", kind: "Asset" },
  { account: "CIBC Visa", owner: "Ramesh", kind: "Liability" },
  { account: "CIBC Mastercard", owner: "Ramesh", kind: "Liability" },
  { account: "Amex (Ramesh)", owner: "Ramesh", kind: "Liability" },
  { account: "CIBC Chequing (Surya)", owner: "Surya", kind: "Asset" },
  { account: "CIBC Savings (Surya)", owner: "Surya", kind: "Asset" },
  { account: "CIBC TFSA (Surya)", owner: "Surya", kind: "Asset" },
  { account: "CIBC TFSA GIC (Surya)", owner: "Surya", kind: "Asset" },
  { account: "WealthSimple Chequing (Surya)", owner: "Surya", kind: "Asset" },
  { account: "WealthSimple TFSA (Surya)", owner: "Surya", kind: "Asset" },
  { account: "WealthSimple RRSP (Surya)", owner: "Surya", kind: "Asset" },
  {
    account: "WealthSimple Non-registered (Surya)",
    owner: "Surya",
    kind: "Asset",
  },
  { account: "Amex (Surya)", owner: "Surya", kind: "Liability" },
];

export const CUSTOM_KEY = "ledger.customLists";
export const ENDPOINT_KEY = "ledger.sheetsEndpoint";
export const TOKEN_KEY = "ledger.sheetsToken";
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
// ever sees its SHA-256 hash (see showGate() in app.js), so the raw value
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

export const getEndpoint = () =>
  (localStorage.getItem(ENDPOINT_KEY) || SHEETS_ENDPOINT || "").trim();
export const getToken = () =>
  (localStorage.getItem(TOKEN_KEY) || SHEETS_TOKEN || "").trim();
export const endpointSource = () =>
  localStorage.getItem(ENDPOINT_KEY)
    ? "runtime"
    : SHEETS_ENDPOINT
      ? "build"
      : "none";

export const SUPABASE_URL_KEY = "ledger.supabaseUrl";
export const SUPABASE_KEY_KEY = "ledger.supabaseAnonKey";
export const getSupabaseUrl = () =>
  (localStorage.getItem(SUPABASE_URL_KEY) || SUPABASE_URL || "").trim();
export const getSupabaseAnonKey = () =>
  (localStorage.getItem(SUPABASE_KEY_KEY) || SUPABASE_ANON_KEY || "").trim();

const DB_NAME = "ledger-expense-tracker";
const DB_VERSION = 1;

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
    // Sheets (via Code.gs) always returns a real JS number here already.
    // Postgres bigint columns (used for Supabase's identity primary keys)
    // serialize as STRINGS over JSON instead - both pg and PostgREST do
    // this deliberately, since a full 64-bit integer isn't always safely
    // representable as a JS number. Coercing here means every id
    // comparison anywhere in the app (strict equality included) behaves
    // consistently regardless of which backend produced the record - this
    // was found by a real bug: a strict `!==` comparison in remove()
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

/* ------------------------------------------------------------- Google Sheets */
class SheetsStore {
  constructor(endpoint, token) {
    this.endpoint = endpoint.replace(/\/+$/, "");
    this.token = token;
    this.kind = "sheets";
    this.cache = null;
    this.sheetName = "";
  }

  async _get(opts = {}, attempt = 1) {
    const { year, txYear } = opts;
    const yq = year ? `&year=${encodeURIComponent(year)}` : "";
    // txYear is independent of Budget's `year` - omitting it means "return
    // every year's transactions", exactly like before this existed. -1 is
    // used deliberately by the metadata-only refresh below: no real
    // transaction can ever be dated year -1, so it is a cheap way to ask for
    // "everything except transactions" without needing a second server-side
    // flag.
    const tq =
      txYear !== undefined && txYear !== null
        ? `&txYear=${encodeURIComponent(txYear)}`
        : "";
    const url = `${this.endpoint}?idToken=${encodeURIComponent(getIdToken())}${yq}${tq}&t=${Date.now()}`;
    let res;
    try {
      // cache:'no-store' matters specifically for redirect-following requests
      // like this one: Apps Script /exec URLs 302-redirect to a
      // script.googleusercontent.com/macros/echo?...&lib=... target, and
      // after a Code.gs redeploy that target changes. Without an explicit
      // no-store, the browser can keep resolving to the OLD cached redirect
      // target, which now 404s - and since every retry hits the SAME stale
      // cache entry, retrying alone never recovers. That is exactly the
      // "several retries, then gives up, but manually re-testing the
      // connection works" pattern: the manual retry happened long enough
      // after, or through a different code path, to escape the same cache
      // hit. The query-string cache-buster on the /exec URL itself does not
      // help here - it only affects that first URL, not the redirect target.
      res = await fetch(url, {
        method: "GET",
        redirect: "follow",
        cache: "no-store",
      });
    } catch (networkErr) {
      // A dropped connection is exactly the kind of transient blip retrying
      // absorbs - fetch() throws for this rather than returning a status.
      if (attempt < 6) {
        await sleep(500 * attempt);
        return this._get(opts, attempt + 1);
      }
      throw new Error(
        `Could not reach the sheet (${networkErr.message}). Check your connection.`,
      );
    }
    if (!res.ok) {
      // Apps Script /exec endpoints are known to intermittently 404 for
      // several seconds right after a redeploy, and after any real idle
      // period a "cold" deployment can take a few seconds to spin back up -
      // neither means the deployment is actually misconfigured. The FIRST
      // ping right after a fresh sign-in is the worst case specifically: it
      // can stack a cold Apps Script start together with the extra latency
      // of Code.gs's own requireUser() making an OUTBOUND call to Google's
      // tokeninfo endpoint to verify the just-issued JWT, on top of the
      // normal cold-start delay. Was 5 attempts over ~6s, and a direct
      // report confirmed that still was not always enough; 7 attempts over
      // ~12.6s of sleep (plus each attempt's own round trip) gives real
      // headroom for that compounded case without hanging a truly broken
      // deployment forever.
      if (res.status === 404 && attempt < 7) {
        await sleep(600 * attempt);
        return this._get(opts, attempt + 1);
      }
      throw new Error(
        `Sheet responded ${res.status}${attempt > 1 ? ` (after ${attempt} attempts)` : ""}. Check the deployment is set to "Anyone".`,
      );
    }
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      // Almost always Google's sign-in page: the web app is not public.
      throw new Error(
        'Got HTML instead of JSON — redeploy the Apps Script with Access set to "Anyone".',
      );
    }
    if (!data.ok) {
      const err = new Error(data.error || "Sheet refused the request.");
      if (/sign in|sign-in|not permitted|rejected that sign/i.test(err.message))
        err.auth = true;
      throw err;
    }
    return data;
  }

  /* text/plain dodges the CORS preflight that Apps Script cannot answer. */
  async _post(payload, attempt = 1) {
    // Retrying a write is only safe when re-applying it produces the same
    // end state either way. 'update'/'delete'/'setBudget'/'setBalances' all
    // overwrite by design, so replaying one changes nothing if it actually
    // landed the first time. 'create'/'bulk'/'addDebt'/'importDebts' APPEND
    // rows - retrying one of those after an ambiguous failure could leave a
    // duplicate row behind, so those are never auto-retried here.
    const idempotent = [
      "update",
      "delete",
      "clear",
      "setBudget",
      "setBalances",
      "deleteBalanceDate",
      "deleteDebt",
      "updateDebt",
    ].includes(payload.action);
    let res;
    try {
      res = await fetch(this.endpoint, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ ...payload, idToken: getIdToken() }),
        redirect: "follow",
        cache: "no-store",
      });
    } catch (networkErr) {
      // fetch() throwing (not a bad status, a genuinely failed request) means
      // it is unclear whether the server ever saw it. Retrying is not risk-free
      // even for idempotent actions - but leaving the person stuck on a dropped
      // connection is worse, so retry once for those specifically.
      if (idempotent && attempt < 2) {
        await sleep(600);
        return this._post(payload, attempt + 1);
      }
      throw new Error(
        `Could not reach the sheet (${networkErr.message}). Check your connection and try again.`,
      );
    }
    if (!res.ok) {
      if (idempotent && res.status === 404 && attempt < 2) {
        await sleep(600);
        return this._post(payload, attempt + 1);
      }
      throw new Error(`Sheet responded ${res.status}.`);
    }
    const data = JSON.parse(await res.text());
    if (!data.ok) {
      const err = new Error(data.error || "Write rejected by the sheet.");
      if (/sign in|sign-in|not permitted|rejected that sign/i.test(err.message))
        err.auth = true;
      throw err;
    }
    // No blanket cache invalidation here anymore. That used to mean EVERY
    // write - adding one transaction, editing one, changing the budget -
    // wiped the entire cache and forced a full re-download of the whole
    // transaction history on the next read, regardless of how large that
    // history had grown. Each caller (add/update/remove/setBudget/etc) now
    // patches exactly the slice it changed, using the record the server just
    // handed back - which it already has, for free, in this response.
    return data;
  }

  _fill(d) {
    const rows = d.transactions.map(normalise);
    // Safety is the DEFAULT, not something a caller has to remember to ask
    // for. The signal that matters is simply whether this.cache already
    // exists - if it does, there is potentially real, locally-known data
    // (a write patched in directly, ahead of any server round trip) that a
    // wholesale replace could silently erase. A caller explicitly passing
    // `merge: false` used to be required to get this right; getting it wrong
    // by omission was the actual failure mode a deterministic test caught -
    // calling _fill() with a stale, pre-write snapshot and no merge flag
    // erased a real transaction. Basing the decision on cache presence
    // instead of a flag means there is no unsafe default left to forget.
    if (this.cache) {
      const seen = new Set(this.cache.transactions.map((r) => r.id));
      this.cache.transactions.push(...rows.filter((r) => !seen.has(r.id)));
    } else {
      this.cache = { transactions: rows };
    }
    this.cache.budget = d.budget;
    this.cache.budgetYear = d.budgetYear || currentYear();
    this.cache.balances = d.balances || [];
    this.cache.debts = d.debts || [];
    this.cache.allTxYears = d.transactionYearsAvailable || [];
    this.cache.loadedTxYears = this.cache.loadedTxYears || new Set();
    this.sheetName = d.sheetName || "";
    this.user = d.user || null; // verified by Apps Script, not by the browser
    return this.cache;
  }
  // Was an UNSCOPED fetch - ping() runs first, inside openStore(), before
  // _ensure() ever gets called. Since _ensure() only does the fast scoped
  // fetch when the cache is still empty, an unscoped ping() here silently
  // defeated the entire point of year-scoping: by the time _ensure() ran,
  // the cache was already fully populated, so its "first call this session"
  // branch never actually fired on the real boot path. Caught by tracing
  // the real call sequence end to end, not from reading either function in
  // isolation - each looked correct on its own.
  async ping() {
    return this._ensure();
  }

  /** First call this session: fetch only the CURRENT year, so the very
      first paint does not wait on however many years of history exist -
      that download only grows over time otherwise. Every later call just
      returns what is already cached; use ensureYearLoaded/ensureAllYearsLoaded
      to bring in more. */
  async _ensure() {
    if (this.cache) return this.cache;
    const y = currentYear();
    const d = await this._get({ txYear: y });
    this._fill(d);
    this.cache.loadedTxYears = new Set([y]);
    this.cache.allYearsLoaded = this.cache.allTxYears.length <= 1;
    return this.cache;
  }

  /** Bring in one specific year not yet loaded (e.g. the Dashboard's year
      selector jumping to a year outside the fast initial fetch). A no-op if
      that year - or everything - is already cached. */
  async ensureYearLoaded(year) {
    await this._ensure();
    if (this.cache.allYearsLoaded || this.cache.loadedTxYears.has(year)) return;
    const d = await this._get({ txYear: year });
    this._fill(d); // merge is now automatic whenever this.cache already exists
    this.cache.loadedTxYears.add(year);
  }

  /** Silently bring in every remaining year in the background. Meant to be
      called right after the fast initial paint, not awaited by anything
      that blocks the UI - by the time a person actually reaches for a
      different year or searches Transactions, this has usually already
      finished, so cross-year features still feel instant in practice. */
  async ensureAllYearsLoaded() {
    await this._ensure();
    if (this.cache.allYearsLoaded) return;
    const d = await this._get({}); // no txYear = every year, in one call
    // _fill() merges automatically whenever this.cache already exists - this
    // fetch can take a real network round trip, and a transaction added
    // WHILE it was in flight is already sitting in the cache by the time
    // this response lands. Verified directly: a deterministic test forces a
    // stale, pre-write snapshot to land via _fill() and confirms the write
    // survives rather than getting silently erased.
    this._fill(d);
    this.cache.loadedTxYears = new Set(this.cache.allTxYears);
    this.cache.allYearsLoaded = true;
  }

  async list() {
    return (await this._ensure()).transactions;
  }
  async getBalances() {
    return (await this._ensure()).balances || [];
  }
  async getDebts() {
    return (await this._ensure()).debts || [];
  }
  async addDebt(record) {
    const r = await this._post({ action: "addDebt", record });
    await this._refreshMeta();
    return r.id;
  }
  async updateDebt(id, record) {
    await this._post({ action: "updateDebt", id, record });
    await this._refreshMeta();
  }
  async deleteDebt(id) {
    await this._post({ action: "deleteDebt", id });
    await this._refreshMeta();
  }
  async importDebts(records) {
    const r = await this._post({ action: "importDebts", records });
    await this._refreshMeta();
    return r;
  }
  async setBalances(date, entries) {
    await this._post({ action: "setBalances", date, entries });
    await this._refreshMeta();
  }
  async deleteBalanceDate(date) {
    await this._post({ action: "deleteBalanceDate", date });
    await this._refreshMeta();
  }
  async getBudget(year) {
    const cached = await this._ensure();
    const wantsCachedYear = !year || year === cached.budgetYear;
    const b = wantsCachedYear
      ? cached.budget
      : (await this._get({ year })).budget;
    const full = emptyBudget();
    if (b)
      for (const c of Object.keys(b))
        if (full[c])
          for (let m = 1; m <= 12; m++) full[c][m] = Number(b[c][m]) || 0;
    return full;
  }
  async setBudget(budget, year) {
    await this._post({ action: "setBudget", budget, year });
    await this._refreshMeta();
    return budget;
  }

  /** Refreshes budget/balances/debts without touching the transactions
      cache at all. txYear:-1 can never match a real row (no transaction is
      ever dated year -1), so the server returns an empty transactions array
      - this is a cheap way to pick up changes to the OTHER three tabs after
      a write to one of them, without re-downloading transaction history or
      disturbing whatever years are already accumulated client-side. */
  async _refreshMeta() {
    if (!this.cache) return;
    const d = await this._get({ txYear: -1 });
    this.cache.budget = d.budget;
    this.cache.budgetYear = d.budgetYear || currentYear();
    this.cache.balances = d.balances || [];
    this.cache.debts = d.debts || [];
  }

  async add(rec) {
    const r = normalise(rec);
    delete r.id;
    const result = normalise(
      (await this._post({ action: "create", record: r })).record,
    );
    // The server just told us exactly what was written - use that directly
    // instead of re-downloading the whole history to learn what we already
    // know. If this row's year has not been individually fetched yet, it is
    // still correctly present; ensureYearLoaded/ensureAllYearsLoaded simply
    // has one less row to bring in later for that year.
    if (this.cache) this.cache.transactions.push(result);
    return result;
  }
  async bulkAdd(list, onProgress) {
    const records = list.map((r) => {
      const n = normalise(r);
      delete n.id;
      return n;
    });
    // Apps Script now writes a chunk with a handful of batched range calls, so
    // larger chunks mean fewer HTTP round trips without risking the 6-min limit.
    const CHUNK = 1000;
    let inserted = 0;
    for (let i = 0; i < records.length; i += CHUNK) {
      inserted += (
        await this._post({
          action: "bulk",
          records: records.slice(i, i + CHUNK),
        })
      ).inserted;
      onProgress?.(Math.min(i + CHUNK, records.length), records.length);
    }
    // A bulk import can span arbitrary years and arbitrary volume - simplest
    // and safest to just bring the client back in sync with a real fetch
    // afterward, rather than trying to patch potentially thousands of rows
    // in place.
    if (this.cache) {
      this.cache = null;
      await this._ensure();
      await this.ensureAllYearsLoaded();
    }
    return inserted;
  }
  async update(id, rec) {
    const r = normalise({ ...rec, id });
    const result = normalise(
      (await this._post({ action: "update", id, record: r })).record,
    );
    if (this.cache) {
      const i = this.cache.transactions.findIndex((x) => x.id === result.id);
      if (i !== -1) this.cache.transactions[i] = result;
      else this.cache.transactions.push(result); // edited row from a not-yet-loaded year
    }
    return result;
  }
  async remove(id) {
    await this._post({ action: "delete", id });
    if (this.cache)
      this.cache.transactions = this.cache.transactions.filter(
        (x) => x.id !== Number(id),
      );
  }
  async clear() {
    await this._post({ action: "clear" });
    this.cache = null;
  }
  async isEmpty() {
    return (await this.list()).length === 0;
  }
}

/* ------------------------------------------------------------------- Supabase
   Fourth implementation of the same storage interface SheetsStore/LocalStore/
   MemoryStore already share. openStore() picks this over SheetsStore once
   both a Supabase URL and anon key are actually configured. Nothing in
   app.js changes to support this - it only ever calls state.store.list()/
   .add()/.getBudget()/etc, never anything backend-specific.

   No build step means no npm import for the SDK - it is loaded from a CDN on
   first actual use, same lazy pattern as xlsxio.js's loadXLSX(): most
   sessions won't have Supabase configured at all, so there is no reason to
   fetch the SDK for them. */
let supabaseSdkReady = null;
function loadSupabaseSdk() {
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
// they all read/write the same localStorage auth-token entry.
let cachedSupabaseClient = null;
let cachedSupabaseClientKey = "";

class SupabaseStore {
  constructor(url, anonKey) {
    this.kind = "supabase";
    this.url = url;
    this.anonKey = anonKey;
    this.sb = null; // created lazily once the SDK has loaded
    this.cache = null; // same accumulating, year-aware cache shape as SheetsStore
    this.sheetName = "Supabase";
    this.user = null;
  }

  async _client() {
    if (this.sb) return this.sb;
    await loadSupabaseSdk();
    const key = `${this.url}|${this.anonKey}`;
    if (!cachedSupabaseClient || cachedSupabaseClientKey !== key) {
      cachedSupabaseClient = window.supabase.createClient(
        this.url,
        this.anonKey,
      );
      cachedSupabaseClientKey = key;
    }
    this.sb = cachedSupabaseClient;
    return this.sb;
  }

  /** Exchanges the SAME Google ID token the app already obtains via Google
      Identity Services (see showGate() in app.js) for a Supabase session -
      the sign-in UI itself does not change, only what happens with the
      resulting token. After this, every query below carries that session
      automatically; Row Level Security enforces the household allow-list on
      the database side, the same job Code.gs's ALLOWED_EMAILS did. */
  async signInWithGoogleIdToken(idToken) {
    const sb = await this._client();
    // Must be present/absent on BOTH sides together, or GoTrue rejects the
    // token outright ("Passed nonce and nonce in id_token should either
    // both exist or not"): Google's initialize() in showGate() only ever
    // sees the HASHED nonce (embedded in the token's own nonce claim),
    // while signInWithIdToken needs the RAW value to hash and compare
    // against that claim itself.
    const nonce = getNonce();
    const { error } = await sb.auth.signInWithIdToken({
      provider: "google",
      token: idToken,
      ...(nonce ? { nonce } : {}),
    });
    if (error) {
      const e = new Error(error.message);
      e.auth = true;
      throw e;
    }
  }

  async ping() {
    return this._ensure();
  }

  async _ensure() {
    if (this.cache) return this.cache;
    return this._loadYear(currentYear());
  }

  async _loadYear(year) {
    const sb = await this._client();
    const [
      { data: tx, error: e1 },
      { data: bg, error: e2 },
      { data: bal, error: e3 },
      { data: debts, error: e4 },
    ] = await Promise.all([
      sb
        .from("transactions")
        .select("*")
        .gte("date", `${year}-01-01`)
        .lte("date", `${year}-12-31`)
        .order("date", { ascending: false }),
      sb.from("budget").select("*").eq("year", year),
      sb.from("balances").select("*").order("date", { ascending: false }),
      sb.from("debts").select("*"),
    ]);
    const err = e1 || e2 || e3 || e4;
    if (err) {
      const e = new Error(err.message);
      if (/JWT|permission|RLS/i.test(err.message)) e.auth = true;
      throw e;
    }
    this.cache = {
      transactions: tx.map(normalise),
      loadedYears: new Set([year]),
      allYearsLoaded: false,
      budget: budgetRowsToShape(bg),
      budgetYear: year,
      balances: bal || [],
      debts: debts || [],
    };
    return this.cache;
  }

  async ensureYearLoaded(year) {
    await this._ensure();
    if (this.cache.allYearsLoaded || this.cache.loadedYears.has(year)) return;
    const sb = await this._client();
    const { data, error } = await sb
      .from("transactions")
      .select("*")
      .gte("date", `${year}-01-01`)
      .lte("date", `${year}-12-31`);
    if (error) throw new Error(error.message);
    const seen = new Set(this.cache.transactions.map((r) => r.id));
    this.cache.transactions.push(
      ...data.map(normalise).filter((r) => !seen.has(r.id)),
    );
    this.cache.loadedYears.add(year);
  }

  async ensureAllYearsLoaded() {
    await this._ensure();
    if (this.cache.allYearsLoaded) return;
    const sb = await this._client();
    const { data, error } = await sb
      .from("transactions")
      .select("*")
      .order("date", { ascending: false });
    if (error) throw new Error(error.message);
    const seen = new Set(this.cache.transactions.map((r) => r.id));
    this.cache.transactions.push(
      ...data.map(normalise).filter((r) => !seen.has(r.id)),
    );
    this.cache.allYearsLoaded = true;
  }

  async list() {
    return (await this._ensure()).transactions;
  }
  async getBalances() {
    return (await this._ensure()).balances;
  }
  async getDebts() {
    return (await this._ensure()).debts;
  }

  async add(rec) {
    const r = normalise(rec);
    delete r.id;
    const sb = await this._client();
    const { data, error } = await sb
      .from("transactions")
      .insert(r)
      .select()
      .single();
    if (error) throw new Error(error.message);
    const result = normalise(data);
    if (this.cache) this.cache.transactions.push(result);
    return result;
  }
  async bulkAdd(list, onProgress) {
    const records = list.map((r) => {
      const n = normalise(r);
      delete n.id;
      return n;
    });
    const sb = await this._client();
    const CHUNK = 1000;
    let inserted = 0;
    for (let i = 0; i < records.length; i += CHUNK) {
      const { data, error } = await sb
        .from("transactions")
        .insert(records.slice(i, i + CHUNK))
        .select();
      if (error) throw new Error(error.message);
      inserted += data.length;
      onProgress?.(Math.min(i + CHUNK, records.length), records.length);
    }
    this.cache = null;
    await this._ensure();
    await this.ensureAllYearsLoaded();
    return inserted;
  }
  async update(id, rec) {
    // id must NOT be in the update payload - it's a `generated always as
    // identity` column, and Postgres rejects any attempt to set it directly
    // ("column id can only be updated to DEFAULT"), even to its own current
    // value. .eq('id', id) targets the row; the body must not mention id at all.
    const r = normalise({ ...rec, id });
    delete r.id;
    const sb = await this._client();
    const { data, error } = await sb
      .from("transactions")
      .update(r)
      .eq("id", id)
      .select()
      .single();
    if (error) throw new Error(error.message);
    const result = normalise(data);
    if (this.cache) {
      const i = this.cache.transactions.findIndex((x) => x.id === result.id);
      if (i !== -1) this.cache.transactions[i] = result;
      else this.cache.transactions.push(result);
    }
    return result;
  }
  async remove(id) {
    const sb = await this._client();
    const { error } = await sb.from("transactions").delete().eq("id", id);
    if (error) throw new Error(error.message);
    if (this.cache)
      this.cache.transactions = this.cache.transactions.filter(
        (x) => x.id !== Number(id),
      );
  }
  async clear() {
    const sb = await this._client();
    await sb.from("transactions").delete().neq("id", 0);
    this.cache = null;
  }
  async isEmpty() {
    return (await this.list()).length === 0;
  }

  async getBudget(year) {
    const cached = await this._ensure();
    if (!year || year === cached.budgetYear) return cached.budget;
    const sb = await this._client();
    const { data, error } = await sb
      .from("budget")
      .select("*")
      .eq("year", year);
    if (error) throw new Error(error.message);
    return budgetRowsToShape(data);
  }
  async setBudget(budget, year) {
    const sb = await this._client();
    const rows = [];
    for (const category of Object.keys(budget))
      for (let month = 1; month <= 12; month++)
        if (budget[category][month])
          rows.push({ year, category, month, amount: budget[category][month] });
    const { error } = await sb
      .from("budget")
      .upsert(rows, { onConflict: "year,category,month" });
    if (error) throw new Error(error.message);
    if (this.cache && year === this.cache.budgetYear)
      this.cache.budget = budget;
    return budget;
  }

  async setBalances(date, entries) {
    const sb = await this._client();
    const { error } = await sb.from("balances").upsert(
      entries.map((e) => ({ date, ...e })),
      { onConflict: "date,account" },
    );
    if (error) throw new Error(error.message);
    if (this.cache) await this._refreshBalances();
  }
  async deleteBalanceDate(date) {
    const sb = await this._client();
    const { error } = await sb.from("balances").delete().eq("date", date);
    if (error) throw new Error(error.message);
    if (this.cache) await this._refreshBalances();
  }
  async _refreshBalances() {
    const sb = await this._client();
    const { data, error } = await sb
      .from("balances")
      .select("*")
      .order("date", { ascending: false });
    if (!error) this.cache.balances = data;
  }

  /** Postgres bigint columns (id, parent_id) serialize as strings over
      JSON, unlike Sheets which always returns real numbers - same class of
      issue fixed in normalise() for transactions. Debts don't go through
      normalise() at all, so each method here coerces explicitly instead. */
  _normDebt(d) {
    return {
      ...d,
      id: Number(d.id) || 0,
      parent_id: d.parent_id != null ? Number(d.parent_id) : null,
    };
  }

  async addDebt(record) {
    const sb = await this._client();
    const { data, error } = await sb
      .from("debts")
      .insert(record)
      .select()
      .single();
    if (error) throw new Error(error.message);
    const result = this._normDebt(data);
    if (this.cache) this.cache.debts.push(result);
    return result.id;
  }
  async updateDebt(id, record) {
    const r = { ...record };
    delete r.id; // same identity-column constraint as transactions.update()
    const sb = await this._client();
    const { data, error } = await sb
      .from("debts")
      .update(r)
      .eq("id", id)
      .select()
      .single();
    if (error) throw new Error(error.message);
    const result = this._normDebt(data);
    if (this.cache) {
      const i = this.cache.debts.findIndex((d) => d.id === result.id);
      if (i !== -1) this.cache.debts[i] = result;
    }
  }
  async deleteDebt(id) {
    // The debts.parent_id foreign key is ON DELETE CASCADE - deleting a debt
    // correctly removes its payments too, with no separate cleanup query.
    const numId = Number(id);
    const sb = await this._client();
    const { error } = await sb.from("debts").delete().eq("id", id);
    if (error) throw new Error(error.message);
    if (this.cache)
      this.cache.debts = this.cache.debts.filter(
        (d) => d.id !== numId && d.parent_id !== numId,
      );
  }
  async importDebts(records) {
    const sb = await this._client();
    const { data, error } = await sb.from("debts").insert(records).select();
    if (error) throw new Error(error.message);
    const results = data.map((d) => this._normDebt(d));
    if (this.cache) this.cache.debts.push(...results);
    return { inserted: results.length };
  }
}

/** Postgres rows (one per year/category/month) -> the same {category: {month:
    amount}} shape SheetsStore/LocalStore/MemoryStore all use, so app.js never
    needs to know which backend produced a budget. */
function budgetRowsToShape(rows) {
  const full = emptyBudget();
  for (const row of rows || [])
    if (full[row.category]) full[row.category][row.month] = Number(row.amount);
  return full;
}

/* ------------------------------------------------------------------ IndexedDB */
class LocalStore {
  constructor(db) {
    this.db = db;
    this.kind = "local";
  }
  // No-ops: unlike SheetsStore, IndexedDB always holds the full history
  // already - there is no partial year-scoping to catch up on. These exist
  // so app.js can call them unconditionally regardless of which adapter is
  // active, without an `if (store.kind === 'sheets')` check at every call site.
  async ensureYearLoaded() {}
  async ensureAllYearsLoaded() {}
  static open() {
    return new Promise((resolve, reject) => {
      if (!("indexedDB" in globalThis))
        return reject(new Error("no indexedDB"));
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("transactions")) {
          db.createObjectStore("transactions", {
            keyPath: "id",
            autoIncrement: true,
          }).createIndex("date", "date");
        }
        if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta");
      };
      req.onsuccess = () => resolve(new LocalStore(req.result));
      req.onerror = () => reject(req.error || new Error("indexedDB blocked"));
      req.onblocked = () => reject(new Error("indexedDB blocked"));
    });
  }
  _tx(s, m) {
    return this.db.transaction(s, m).objectStore(s);
  }
  _wrap(req) {
    return new Promise((res, rej) => {
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
  }
  async list() {
    const rows = await this._wrap(
      this._tx("transactions", "readonly").getAll(),
    );
    return rows.sort((a, b) =>
      a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id,
    );
  }
  async add(rec) {
    const r = normalise(rec);
    delete r.id;
    const id = await this._wrap(this._tx("transactions", "readwrite").add(r));
    return { ...r, id };
  }
  async bulkAdd(list) {
    const os = this.db
      .transaction("transactions", "readwrite")
      .objectStore("transactions");
    for (const rec of list) {
      const r = normalise(rec);
      delete r.id;
      os.add(r);
    }
    await new Promise((res, rej) => {
      os.transaction.oncomplete = res;
      os.transaction.onerror = () => rej(os.transaction.error);
    });
    return list.length;
  }
  async update(id, rec) {
    const r = normalise({ ...rec, id });
    await this._wrap(this._tx("transactions", "readwrite").put(r));
    return r;
  }
  async remove(id) {
    await this._wrap(this._tx("transactions", "readwrite").delete(Number(id)));
  }
  async clear() {
    await this._wrap(this._tx("transactions", "readwrite").clear());
    await this._wrap(this._tx("meta", "readwrite").delete("budget"));
  }
  async getBudget(year) {
    const y = year || currentYear();
    const all =
      (await this._wrap(this._tx("meta", "readonly").get("budgetsByYear"))) ||
      {};
    return all[y] || emptyBudget();
  }
  async getBalances() {
    return (
      (await this._wrap(this._tx("meta", "readonly").get("balances"))) || []
    );
  }
  async getDebts() {
    return (await this._wrap(this._tx("meta", "readonly").get("debts"))) || [];
  }
  async addDebt(record) {
    const all = await this.getDebts();
    const id = Math.max(0, ...all.map((d) => Number(d.id) || 0)) + 1;
    await this._wrap(
      this._tx("meta", "readwrite").put([...all, { ...record, id }], "debts"),
    );
    return id;
  }
  async updateDebt(id, record) {
    const all = await this.getDebts();
    await this._wrap(
      this._tx("meta", "readwrite").put(
        all.map((d) =>
          Number(d.id) === Number(id) ? { ...record, id: Number(id) } : d,
        ),
        "debts",
      ),
    );
  }
  async deleteDebt(id) {
    const all = await this.getDebts();
    await this._wrap(
      this._tx("meta", "readwrite").put(
        all.filter(
          (d) =>
            Number(d.id) !== Number(id) && Number(d.parentId) !== Number(id),
        ),
        "debts",
      ),
    );
  }
  async importDebts(records) {
    const all = await this.getDebts();
    let id = Math.max(0, ...all.map((d) => Number(d.id) || 0)) + 1;
    const fileToReal = {};
    for (const r of records)
      if (r.kind !== "Payment") {
        fileToReal[String(r.fileRef)] = id++;
      }
    const rows = [];
    let nD = 0,
      nP = 0,
      skipped = 0;
    id = Math.max(0, ...all.map((d) => Number(d.id) || 0)) + 1;
    for (const r of records) {
      if (r.kind !== "Payment") {
        rows.push({ ...r, id, parentId: null });
        id++;
        nD++;
        continue;
      }
      const parentReal = fileToReal[String(r.parentFileRef)];
      if (!parentReal) {
        skipped++;
        continue;
      }
      rows.push({ ...r, id, parentId: parentReal });
      id++;
      nP++;
    }
    await this._wrap(
      this._tx("meta", "readwrite").put([...all, ...rows], "debts"),
    );
    return { debts: nD, payments: nP, skipped };
  }
  async setBalances(date, entries) {
    const all = (await this.getBalances()).filter((b) => b.date !== date);
    await this._wrap(
      this._tx("meta", "readwrite").put(
        [...all, ...entries.map((e) => ({ ...e, date }))],
        "balances",
      ),
    );
  }
  async deleteBalanceDate(date) {
    const all = (await this.getBalances()).filter((b) => b.date !== date);
    await this._wrap(this._tx("meta", "readwrite").put(all, "balances"));
  }
  async setBudget(b, year) {
    const y = year || currentYear();
    const all =
      (await this._wrap(this._tx("meta", "readonly").get("budgetsByYear"))) ||
      {};
    all[y] = b;
    await this._wrap(this._tx("meta", "readwrite").put(all, "budgetsByYear"));
    return b;
  }
  async isEmpty() {
    return (
      (await this._wrap(this._tx("transactions", "readonly").count())) === 0
    );
  }
}

/* ------------------------------------------------------------------ memory */
class MemoryStore {
  constructor() {
    this.rows = [];
    this.seq = 1;
    this.budget = emptyBudget();
    this.kind = "memory";
  }
  async ensureYearLoaded() {}
  async ensureAllYearsLoaded() {}
  async list() {
    return [...this.rows].sort((a, b) =>
      a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id,
    );
  }
  async add(rec) {
    const r = normalise(rec);
    r.id = this.seq++;
    this.rows.push(r);
    return r;
  }
  async bulkAdd(l) {
    for (const x of l) await this.add(x);
    return l.length;
  }
  async update(id, rec) {
    const r = normalise({ ...rec, id: Number(id) });
    this.rows = this.rows.map((x) => (x.id === r.id ? r : x));
    return r;
  }
  async remove(id) {
    this.rows = this.rows.filter((x) => x.id !== Number(id));
  }
  async clear() {
    this.rows = [];
    this.budget = emptyBudget();
  }
  async getBudget(year) {
    const y = year || currentYear();
    this.budgetsByYear = this.budgetsByYear || {};
    return this.budgetsByYear[y] || this.budget || emptyBudget();
  }
  async setBudget(b, year) {
    const y = year || currentYear();
    this.budgetsByYear = this.budgetsByYear || {};
    this.budgetsByYear[y] = b;
    return b;
  }
  async getBalances() {
    return this.balances || (this.balances = []);
  }
  async getDebts() {
    return this.debts || (this.debts = []);
  }
  async addDebt(record) {
    this.debts = this.debts || [];
    const id = Math.max(0, ...this.debts.map((d) => Number(d.id) || 0)) + 1;
    this.debts.push({ ...record, id });
    return id;
  }
  async updateDebt(id, record) {
    this.debts = (this.debts || []).map((d) =>
      Number(d.id) === Number(id) ? { ...record, id: Number(id) } : d,
    );
  }
  async deleteDebt(id) {
    this.debts = (this.debts || []).filter(
      (d) => Number(d.id) !== Number(id) && Number(d.parentId) !== Number(id),
    );
  }
  async importDebts(records) {
    this.debts = this.debts || [];
    let id = Math.max(0, ...this.debts.map((d) => Number(d.id) || 0)) + 1;
    const fileToReal = {};
    for (const r of records)
      if (r.kind !== "Payment") {
        fileToReal[String(r.fileRef)] = id++;
      }
    const rows = [];
    let nD = 0,
      nP = 0,
      skipped = 0;
    id = Math.max(0, ...this.debts.map((d) => Number(d.id) || 0)) + 1;
    for (const r of records) {
      if (r.kind !== "Payment") {
        rows.push({ ...r, id, parentId: null });
        id++;
        nD++;
        continue;
      }
      const parentReal = fileToReal[String(r.parentFileRef)];
      if (!parentReal) {
        skipped++;
        continue;
      }
      rows.push({ ...r, id, parentId: parentReal });
      id++;
      nP++;
    }
    this.debts.push(...rows);
    return { debts: nD, payments: nP, skipped };
  }
  async setBalances(date, entries) {
    this.balances = [
      ...(this.balances || []).filter((b) => b.date !== date),
      ...entries.map((e) => ({ ...e, date })),
    ];
  }
  async deleteBalanceDate(date) {
    this.balances = (this.balances || []).filter((b) => b.date !== date);
  }
  async isEmpty() {
    return this.rows.length === 0;
  }
}

export async function openStore(onNotice) {
  // Supabase is preferred once BOTH pieces are configured - during a
  // transition period this lets the app be pointed at either backend
  // without disturbing whichever one is not yet set up. Falls through to
  // Sheets, then Local/Memory, on any failure - exactly the same graceful
  // degradation the app already had for Sheets alone.
  const supabaseUrl = getSupabaseUrl(),
    supabaseKey = getSupabaseAnonKey();
  if (supabaseUrl && supabaseKey) {
    try {
      const s = new SupabaseStore(supabaseUrl, supabaseKey);
      const idToken = getIdToken();
      if (idToken) await s.signInWithGoogleIdToken(idToken);
      await s.ping();
      return s;
    } catch (e) {
      onNotice?.(
        `Supabase unreachable: ${e.message} Falling back to Google Sheets or this browser's storage.`,
        "bad",
      );
    }
  }
  const endpoint = getEndpoint(),
    token = getToken();
  if (endpoint) {
    try {
      const s = new SheetsStore(endpoint, token);
      await s.ping();
      return s;
    } catch (e) {
      onNotice?.(
        `Google Sheet unreachable: ${e.message} Falling back to this browser's storage — changes will NOT reach the sheet.`,
        "bad",
      );
    }
  } else if (!supabaseUrl) {
    onNotice?.(
      "No Google Sheet connected. Using browser storage — connect the sheet under Data.",
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

export { SheetsStore, SupabaseStore };
