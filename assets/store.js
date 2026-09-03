/* Storage layer.

   SupabaseStore is the real one: a Supabase/Postgres project is the database,
   reached directly via the Supabase SDK (loaded from a CDN on first use - see
   loadSupabaseSdk() below), with Row Level Security enforcing the household
   allow-list. LocalStore (IndexedDB) remains as the no-configuration fallback
   so the app is usable before Supabase is wired up, and MemoryStore covers
   browsers where IndexedDB is blocked.

   The Google Sheets/Apps Script backend (SheetsStore) that used to sit ahead
   of Supabase in this chain has been removed - Supabase is now the only real
   backend. GOOGLE_CLIENT_ID / Google sign-in stays: it is the identity
   provider whose ID token Supabase exchanges for a session (see
   signInWithGoogleIdToken below), not something specific to Sheets.

   Config precedence: what you type under Data → Supabase (localStorage) wins over
   the build-time values injected from GitHub secrets. */

import { GOOGLE_CLIENT_ID, SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

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
   The real storage backend - one of three implementations of the same
   interface (this one, LocalStore, MemoryStore) that openStore() below picks
   between. Nothing in app.js changes to support this - it only ever calls
   state.store.list()/.add()/.getBudget()/etc, never anything backend-specific.

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

// PostgREST (what supabase-js talks to) caps any single response at 1000
// rows by default - a project-level setting, not something this code
// controls, and it fails silently: no error, just a truncated result. A
// real transaction history WILL cross 1000 rows eventually, and every read
// below used to be a plain .select() with no .range(), so rows past the
// cap simply vanished from the app with nothing indicating why. buildQuery
// must return a FRESH query object each call - a supabase-js query builder
// is not safely re-usable across repeated awaits.
const SUPABASE_PAGE_SIZE = 1000;
async function selectAllRows(buildQuery) {
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

class SupabaseStore {
  constructor(url, anonKey) {
    this.kind = "supabase";
    this.url = url;
    this.anonKey = anonKey;
    this.sb = null; // created lazily once the SDK has loaded
    this.cache = null; // accumulating, year-aware cache - see _loadYear()/ensureYearLoaded() below
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
      selectAllRows((from, to) =>
        sb
          .from("transactions")
          .select("*")
          .gte("date", `${year}-01-01`)
          .lte("date", `${year}-12-31`)
          .order("date", { ascending: false })
          .range(from, to),
      ),
      selectAllRows((from, to) =>
        sb.from("budget").select("*").eq("year", year).range(from, to),
      ),
      selectAllRows((from, to) =>
        sb
          .from("balances")
          .select("*")
          .order("date", { ascending: false })
          .range(from, to),
      ),
      selectAllRows((from, to) => sb.from("debts").select("*").range(from, to)),
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
      debts: (debts || []).map((d) => this._normDebt(d)),
    };
    return this.cache;
  }

  async ensureYearLoaded(year) {
    await this._ensure();
    if (this.cache.allYearsLoaded || this.cache.loadedYears.has(year)) return;
    const sb = await this._client();
    const { data, error } = await selectAllRows((from, to) =>
      sb
        .from("transactions")
        .select("*")
        .gte("date", `${year}-01-01`)
        .lte("date", `${year}-12-31`)
        .range(from, to),
    );
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
    const { data, error } = await selectAllRows((from, to) =>
      sb
        .from("transactions")
        .select("*")
        .order("date", { ascending: false })
        .range(from, to),
    );
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

  /** Postgres bigint/numeric columns (id, parent_id, amount) serialize as
      strings over JSON, unlike Sheets which always returns real numbers -
      same class of issue fixed in normalise() for transactions. Debts don't
      go through normalise() at all, so each method here coerces explicitly
      instead. Also renames parent_id -> parentId: the Postgres column is
      snake_case, but app.js and every other store (LocalStore, MemoryStore)
      use camelCase parentId throughout - e.g. relatedTransactions()/the
      outstanding-balance calc in app.js filter on `d.parentId`. Left as
      parent_id, a Supabase-sourced payment's parentId is always undefined,
      so it never matches its debt: outstanding silently shows the full
      principal as if zero payments had ever been made against it. */
  _normDebt(d) {
    const { parent_id, interest_rate, ...rest } = d;
    return {
      ...rest,
      id: Number(d.id) || 0,
      parentId: parent_id != null ? Number(parent_id) : null,
      amount: Number(d.amount) || 0,
      interestRate: interest_rate != null ? Number(interest_rate) : null,
    };
  }

  // Inverse of _normDebt for outbound rows: app.js/LocalStore/MemoryStore
  // build records with camelCase parentId, but the Postgres column is
  // parent_id - PostgREST rejects an unrecognised parentId key outright
  // (PGRST204) rather than ignoring it, so every write path needs this.
  _toDbDebt(record) {
    const { parentId, interestRate, ...rest } = record;
    const out = { ...rest };
    if ("parentId" in record) out.parent_id = parentId;
    if ("interestRate" in record) out.interest_rate = interestRate;
    return out;
  }

  async addDebt(record) {
    const sb = await this._client();
    const { data, error } = await sb
      .from("debts")
      .insert(this._toDbDebt(record))
      .select()
      .single();
    if (error) throw new Error(error.message);
    const result = this._normDebt(data);
    if (this.cache) this.cache.debts.push(result);
    return result.id;
  }
  async updateDebt(id, record) {
    const r = this._toDbDebt(record);
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
        (d) => d.id !== numId && d.parentId !== numId,
      );
  }
  async importDebts(records) {
    const sb = await this._client();
    const { data, error } = await sb
      .from("debts")
      .insert(records.map((r) => this._toDbDebt(r)))
      .select();
    if (error) throw new Error(error.message);
    const results = data.map((d) => this._normDebt(d));
    if (this.cache) this.cache.debts.push(...results);
    return { inserted: results.length };
  }
}

/** Postgres rows (one per year/category/month) -> the same {category: {month:
    amount}} shape LocalStore/MemoryStore also use, so app.js never needs to
    know which backend produced a budget. */
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
  // No-ops: unlike SupabaseStore, IndexedDB always holds the full history
  // already - there is no partial year-scoping to catch up on. These exist
  // so app.js can call them unconditionally regardless of which adapter is
  // active, without an `if (store.kind === 'supabase')` check at every call site.
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
      if (r.kind === "Debt") {
        fileToReal[String(r.fileRef)] = id++;
      }
    const rows = [];
    let nD = 0,
      nP = 0,
      skipped = 0;
    id = Math.max(0, ...all.map((d) => Number(d.id) || 0)) + 1;
    for (const r of records) {
      if (r.kind === "Debt") {
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
      if (r.kind === "Debt") {
        fileToReal[String(r.fileRef)] = id++;
      }
    const rows = [];
    let nD = 0,
      nP = 0,
      skipped = 0;
    id = Math.max(0, ...this.debts.map((d) => Number(d.id) || 0)) + 1;
    for (const r of records) {
      if (r.kind === "Debt") {
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
  // Supabase is the only real backend now. Falls through to Local/Memory on
  // any failure - the same graceful degradation the app always had, just
  // with one fewer intermediate backend to fall through first.
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

export { SupabaseStore };
