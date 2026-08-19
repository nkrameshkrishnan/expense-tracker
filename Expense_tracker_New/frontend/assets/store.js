/* Storage layer for the SaaS build. ApiStore is the real one: it talks to
   the server-mediated API (API Gateway + Lambda + Aurora, see
   ../../backend) instead of a Google Sheet or Supabase directly — the
   browser never holds a database credential of any kind, only a
   short-lived Cognito ID token. LocalStore (IndexedDB) and MemoryStore
   remain unchanged from the original project as offline/no-config
   fallbacks; app.js calls the same interface regardless of which one is
   active. */

import {
  API_ENDPOINT,
  COGNITO_USER_POOL_ID,
  COGNITO_CLIENT_ID,
  COGNITO_DOMAIN,
  COGNITO_REGION,
} from "./config.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

export const PEOPLE = ["Ramesh", "Surya", "Joint"];
export const UNASSIGNED = "Unassigned";
export const PERSON_KEY = "ledger.person";

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

/* ----------------------------------------------------------- Cognito auth
   Config precedence matches the original project: what's typed under a
   runtime settings screen (localStorage) wins over build-time config.js
   values, so this can be pointed at a different deployment without a
   rebuild. */
export const API_ENDPOINT_KEY = "ledger.apiEndpoint";
export const getApiEndpoint = () =>
  (localStorage.getItem(API_ENDPOINT_KEY) || API_ENDPOINT || "").trim();
export const apiEndpointSource = () =>
  localStorage.getItem(API_ENDPOINT_KEY)
    ? "runtime"
    : API_ENDPOINT
      ? "build"
      : "none";

export const getCognitoConfig = () => ({
  userPoolId: COGNITO_USER_POOL_ID,
  clientId: COGNITO_CLIENT_ID,
  domain: COGNITO_DOMAIN,
  region: COGNITO_REGION,
});

const ID_TOKEN_KEY = "ledger.cognitoIdToken";

/** auth.js's exact wording for "your token is fine, but you are not a
    member of the tenant you asked to act as" - the one 401 that is NOT a
    dead session. Kept as a constant so the match below is obviously tied
    to a specific server message rather than to any 401 body. */
const NOT_A_MEMBER = "not a member of the requested tenant";

// sessionStorage can throw in locked-down browser contexts; falls back to
// an in-memory value for the lifetime of the tab rather than crashing the
// whole app on that one call — same pattern the original store.js uses for
// the Google ID token.
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
    id: Number(r.id) || 0,
    date: String(r.date || "").slice(0, 10),
    type,
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

/* ------------------------------------------------------------------ ApiStore
   Talks to the Lambda behind API Gateway (../../backend/src/handler.js).
   Deliberately mirrors SheetsStore's shape from the original project — same
   {action, ...} POST contract, same year-scoped GET, same retry-on-network-
   blip behaviour — the difference is entirely in the transport (Bearer JWT
   instead of an idToken query param) and the server it talks to. */
class ApiStore {
  constructor(endpoint, idToken) {
    this.endpoint = endpoint.replace(/\/+$/, "");
    this.idToken = idToken;
    this.kind = "api";
    this.cache = null;
    this.activeTenantId = null;
    // Bumped every time the cache is reset for a tenant change. Requests
    // capture it before they go out and drop their response if it moved
    // while they were in flight - see the comment on resetCache().
    this.generation = 0;
    // Set by app.js: called when the server rejects this session's
    // X-Active-Tenant because the membership is gone, so the persisted
    // per-user choice in localStorage can be cleared too. store.js has no
    // business knowing that key's shape, so it asks rather than writes.
    this.onActiveTenantRejected = null;
  }

  setActiveTenant(tenantId) {
    this.activeTenantId = tenantId || null;
  }

  /** Read-only accessor so views never reach into the field directly. */
  getActiveTenant() {
    return this.activeTenantId;
  }

  _clearCache() {
    this.cache = null;
    this.user = null;
  }

  resetCache() {
    // Switching tenants must not keep serving the previous tenant's
    // cached transactions/budget/balances/etc - the next _ensure() call
    // (triggered by refresh()) needs to hit the API fresh, scoped to
    // whatever tenant setActiveTenant() was just called with.
    //
    // Clearing alone is not enough: boot() fires ensureAllYearsLoaded()
    // without awaiting it, so a switch can happen while a request for the
    // PREVIOUS tenant is still in flight. That response would otherwise
    // land in _fill() afterwards and push the old tenant's rows onto the
    // new tenant's freshly-loaded cache (and overwrite budget/balances/
    // members/tenant/user with the old tenant's values). Bumping the
    // generation here lets every in-flight request notice, on arrival,
    // that the cache it was fetched for no longer exists, and drop itself.
    this._clearCache();
    this.generation++;
  }

  _headers(extra = {}) {
    return {
      Authorization: `Bearer ${this.idToken}`,
      ...(this.activeTenantId ? { "X-Active-Tenant": this.activeTenantId } : {}),
      ...extra,
    };
  }

  /** A 401 body's `error` string, or "" if there isn't one. Never throws:
      an unparseable body just means "no distinguishing message", which
      falls through to the normal session-expired handling. */
  async _errorText(res) {
    try {
      const body = await res.json();
      return String(body?.error || "");
    } catch {
      return "";
    }
  }

  /** True for the one 401 that means "this session's active tenant is no
      longer yours" rather than "sign in again" - e.g. an owner removed you
      from a household you had switched into. Forcing a full sign-out for
      that (which is what treating every 401 as auth failure did) is both
      wrong and unrecoverable-looking: the credentials are fine, only the
      tenant choice is stale. */
  _isTenantRejection(message) {
    return this.activeTenantId && message.toLowerCase().includes(NOT_A_MEMBER);
  }

  /** Forget the active tenant entirely - in memory, in the cache (which
      holds the rejected tenant's data), and, via app.js's callback, in
      localStorage - so the retry and every later request fall back to the
      JWT's own default tenant.

      Deliberately does NOT bump `generation`: this runs INSIDE the very
      request that is about to repopulate the cache, and invalidating that
      request's own generation would make it discard its own retry and
      leave the cache empty. The counter tracks user-initiated switches;
      this is a forced fallback on a request already in flight. */
  _dropActiveTenant() {
    this.setActiveTenant(null);
    this._clearCache();
    try {
      this.onActiveTenantRejected?.();
    } catch {
      /* clearing a persisted preference must never break the retry */
    }
  }

  async _get(opts = {}, attempt = 1, retriedWithoutTenant = false) {
    const { year, txYear } = opts;
    const params = new URLSearchParams();
    if (year) params.set("year", year);
    if (txYear !== undefined && txYear !== null) params.set("txYear", txYear);
    let res;
    try {
      res = await fetch(`${this.endpoint}/data?${params}`, {
        method: "GET",
        headers: this._headers(),
        cache: "no-store",
      });
    } catch (networkErr) {
      if (attempt < 4) {
        await sleep(500 * attempt);
        return this._get(opts, attempt + 1, retriedWithoutTenant);
      }
      throw new Error(
        `Could not reach the API (${networkErr.message}). Check your connection.`,
      );
    }
    if (res.status === 401) {
      const message = await this._errorText(res);
      if (!retriedWithoutTenant && this._isTenantRejection(message)) {
        this._dropActiveTenant();
        return this._get(opts, 1, true); // once, headerless - never a loop
      }
      const err = new Error("Sign-in expired. Please sign in again.");
      err.auth = true;
      throw err;
    }
    if (!res.ok) {
      if (res.status >= 500 && attempt < 4) {
        await sleep(500 * attempt);
        return this._get(opts, attempt + 1, retriedWithoutTenant);
      }
      throw new Error(`API responded ${res.status}.`);
    }
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "API refused the request.");
    return data;
  }

  async _post(payload, attempt = 1, retriedWithoutTenant = false) {
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
      res = await fetch(`${this.endpoint}/data`, {
        method: "POST",
        headers: this._headers({ "Content-Type": "application/json" }),
        body: JSON.stringify(payload),
        cache: "no-store",
      });
    } catch (networkErr) {
      if (idempotent && attempt < 2) {
        await sleep(600);
        return this._post(payload, attempt + 1, retriedWithoutTenant);
      }
      throw new Error(
        `Could not reach the API (${networkErr.message}). Check your connection and try again.`,
      );
    }
    if (res.status === 401) {
      const message = await this._errorText(res);
      // Safe to replay for ANY action, unlike the network-blip retry above:
      // a 401 means the request was rejected before it reached a route, so
      // nothing was written and there is nothing to double-apply.
      if (!retriedWithoutTenant && this._isTenantRejection(message)) {
        this._dropActiveTenant();
        return this._post(payload, 1, true);
      }
      const err = new Error("Sign-in expired. Please sign in again.");
      err.auth = true;
      throw err;
    }
    if (!res.ok) {
      if (idempotent && res.status >= 500 && attempt < 2) {
        await sleep(600);
        return this._post(payload, attempt + 1, retriedWithoutTenant);
      }
      throw new Error(`API responded ${res.status}.`);
    }
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Write rejected by the API.");
    return data;
  }

  _fill(d) {
    const rows = d.transactions.map(normalise);
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
    this.user = d.user || null;
    this.cache.members = d.members || [];
    this.cache.invites = d.invites || [];
    this.cache.tenant = d.tenant || { plan: "free", status: "active" };
    return this.cache;
  }

  async ping() {
    return this._ensure();
  }

  async _ensure() {
    if (this.cache) return this.cache;
    const y = currentYear();
    const gen = this.generation;
    const d = await this._get({ txYear: y });
    // A tenant switch landed while this was in flight: this response
    // belongs to the previous tenant, so it must not be filled in. Start
    // over instead of returning nothing - callers (list(), getBudget(),
    // getMembers(), ...) all need a cache back. Terminates because each
    // extra pass needs another switch to have happened mid-request.
    if (gen !== this.generation) return this._ensure();
    this._fill(d);
    this.cache.loadedTxYears = new Set([y]);
    this.cache.allYearsLoaded = this.cache.allTxYears.length <= 1;
    return this.cache;
  }

  /** "The cache this work was started for is gone" - either a tenant
      switch bumped the generation, or something cleared it outright. Both
      mean the response in hand must not be written anywhere. */
  _stale(gen) {
    return gen !== this.generation || !this.cache;
  }

  async ensureYearLoaded(year) {
    const gen = this.generation;
    await this._ensure();
    if (this._stale(gen)) return;
    if (this.cache.allYearsLoaded || this.cache.loadedTxYears.has(year)) return;
    const d = await this._get({ txYear: year });
    if (this._stale(gen)) return; // stale tenant - drop it silently
    this._fill(d);
    this.cache.loadedTxYears.add(year);
  }

  async ensureAllYearsLoaded() {
    // Captured before _ensure(), not after: priming the cache is itself a
    // network round trip a switch can land in the middle of.
    const gen = this.generation;
    await this._ensure();
    if (this._stale(gen)) return;
    if (this.cache.allYearsLoaded) return;
    const d = await this._get({});
    // The case this fix exists for: boot() fires this without awaiting it,
    // so a switch from the Household panel can easily beat it home.
    if (this._stale(gen)) return;
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
  async getMembers() {
    return (await this._ensure()).members || [];
  }
  async getInvites() {
    return (await this._ensure()).invites || [];
  }
  async getRole() {
    return this.user?.role || "member";
  }
  async createInvite(email, role) {
    const r = await this._post({ action: "createInvite", email, role });
    await this._refreshMeta();
    return r.invite;
  }
  async revokeInvite(token) {
    await this._post({ action: "revokeInvite", token });
    await this._refreshMeta();
  }
  async getTenant() {
    return (await this._ensure()).tenant || { plan: "free", status: "active" };
  }
  async getUserEmail() {
    return this.user?.email || null;
  }
  async getMyTenants() {
    const r = await this._post({ action: "listMyTenants" });
    return r.tenants || [];
  }
  async joinTenant(inviteToken) {
    return this._post({ action: "joinTenant", inviteToken });
  }
  async createCheckoutSession(priceId, successUrl, cancelUrl) {
    return this._post({
      action: "createCheckoutSession",
      priceId,
      successUrl,
      cancelUrl,
    });
  }
  async createPortalSession(returnUrl) {
    return this._post({ action: "createPortalSession", returnUrl });
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
  async _refreshMeta() {
    if (!this.cache) return;
    const gen = this.generation;
    const d = await this._get({ txYear: -1 });
    // Same guard as the loaders above: writing this straight into
    // this.cache would splice the previous tenant's budget/balances/
    // members into the tenant now being displayed.
    if (this._stale(gen)) return;
    this.cache.budget = d.budget;
    this.cache.budgetYear = d.budgetYear || currentYear();
    this.cache.balances = d.balances || [];
    this.cache.debts = d.debts || [];
    this.cache.members = d.members || [];
    this.cache.invites = d.invites || [];
    this.cache.tenant = d.tenant || this.cache.tenant;
    this.user = d.user || this.user;
  }
  async add(rec) {
    const r = normalise(rec);
    delete r.id;
    const result = normalise(
      (await this._post({ action: "create", record: r })).record,
    );
    if (this.cache) this.cache.transactions.push(result);
    return result;
  }
  async bulkAdd(list, onProgress) {
    const records = list.map((r) => {
      const n = normalise(r);
      delete n.id;
      return n;
    });
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
      else this.cache.transactions.push(result);
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

/* ------------------------------------------------------------------ IndexedDB
   Unchanged from the original project — offline/no-config fallback so the
   app is usable before a backend is wired up. */
class LocalStore {
  constructor(db) {
    this.db = db;
    this.kind = "local";
  }
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
      if (r.kind !== "Payment") fileToReal[String(r.fileRef)] = id++;
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
      if (r.kind !== "Payment") fileToReal[String(r.fileRef)] = id++;
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
  const endpoint = getApiEndpoint();
  const idToken = getIdToken();
  if (endpoint && idToken) {
    try {
      const s = new ApiStore(endpoint, idToken);
      await s.ping();
      return s;
    } catch (e) {
      onNotice?.(
        `API unreachable: ${e.message} Falling back to this browser's storage — changes will NOT reach the server.`,
        "bad",
      );
    }
  } else if (!endpoint) {
    onNotice?.("No API connected. Using browser storage — sign in to connect.");
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

export { ApiStore };
