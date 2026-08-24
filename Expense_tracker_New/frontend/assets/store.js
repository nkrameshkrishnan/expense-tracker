/* Storage layer for the SaaS build. ApiStore is the only real store: it
   talks to the server-mediated API (API Gateway + Lambda + Aurora, see
   ../../backend) instead of a Google Sheet or Supabase directly — the
   browser never holds a database credential of any kind, only a
   short-lived Cognito ID token. There is deliberately no local/offline
   fallback (this is multi-tenant SaaS, not a personal tool with no server
   of its own) — see DisconnectedStore below for what openStore() returns
   when a real connection isn't currently working. app.js calls the same
   interface regardless of which one is active. */

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
// Must match backend/src/routes/tenants.js's CURRENCIES exactly - the
// backend is the source of truth for what it accepts; this list is what
// the Profile picker offers. Keep both in sync by hand if this ever grows.
export const CURRENCIES = ["CAD", "USD", "EUR", "GBP", "INR", "AUD"];
export const PAYMENTS = [
  "Credit Card",
  "Debit Card",
  "Cash",
  "e-Transfer",
  "Pre-authorized Debit",
  "Other",
];
// Generic account-type labels, not any real bank/brokerage's names - this
// app is multi-tenant (see NET_WORTH_ACCOUNTS/BUILTIN.person above), so a
// built-in default list is every new tenant's starting point, not one
// household's actual accounts. Real, specific accounts come from what a
// tenant adds via "+ New" (see app.js's addCustom/listFor).
export const ACCOUNTS = ["Checking", "Savings", "Credit Card", "Cash"];
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

export const UNASSIGNED = "Unassigned";
export const PERSON_KEY = "ledger.person";

// No fixed PEOPLE list, unlike the original single-household project this
// was adapted from: this backend is multi-tenant (see validate.js's own
// "person: text(...)" comment, which already treats it as free text
// server-side), so hardcoding a household's real member names here would
// mean every OTHER tenant's household sees someone else's names as their
// only options - and normalise() below would silently discard any person
// name that isn't in the list, which is exactly what happened before this
// was fixed. person is now a listFor()-managed field like category/payment/
// account (see app.js's BUILTIN), seeded with nothing built-in.

// No hardcoded starter accounts either, for the same reason - a brand-new
// tenant starts with zero net-worth accounts and adds their own (the "+
// New" flow already exists for this); showing every signup someone else's
// real-looking bank/brokerage accounts was never correct for a SaaS
// product, even as a demo.
export const NET_WORTH_ACCOUNTS = [];

export const CUSTOM_KEY = "ledger.customLists";

// The tenant's chosen display currency, set once per refresh() (see
// app.js) and read by formatMoney below - not React/observable state,
// just a module-level value every formatter call reads fresh, the same
// "shared singleton other modules import" shape as CAT_NAMES/ACCOUNTS
// above. No currency conversion anywhere (see this feature's spec) - this
// only changes how already-stored numbers are formatted.
let _currency = "CAD";
export function setCurrency(code) {
  _currency = code;
}
export function currentCurrency() {
  return _currency;
}

/** Formats `n` as money in the tenant's current currency - symbol,
    decimal places, and placement all come from Intl.NumberFormat's own
    knowledge of the currency code, not a hand-maintained per-currency
    table. */
export function formatMoney(n) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: _currency,
    currencyDisplay: "narrowSymbol",
  }).format(n);
}

// Deterministic person -> palette-index mapping, so the same name always
// gets the same colour across swatches/chips/charts without this app
// needing to know a tenant's household member names in advance. Kept here
// (not in app.js/charts.js) so both modules derive the same colour for the
// same name from one definition. "Unassigned" is handled by each caller as
// an explicit, separate case - it is a state, not a person, and must not
// collide with a real name's colour.
export const PERSON_PALETTE_SIZE = 5;
export function personColorIndex(name) {
  const s = String(name || "");
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % PERSON_PALETTE_SIZE;
}

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
    // Free text, matching the backend's own validate.js - this used to be
    // allow-listed against a fixed 3-name PEOPLE constant, which silently
    // discarded any other tenant's real person value back to "" on every
    // read.
    person: String(r.person || "").trim(),
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
      ...(this.activeTenantId
        ? { "X-Active-Tenant": this.activeTenantId }
        : {}),
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
      // networkErr.message is a raw browser string ("Failed to fetch" and
      // similar) - meaningless to whoever is reading the banner it ends up
      // in. Keep it in the console for debugging; the thrown message stays
      // plain language, since callers show it to the user as-is.
      console.error(`[store] GET failed: ${networkErr.message}`);
      throw new Error(
        "Couldn't reach your Ledger account. Check your connection and try again.",
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
      console.error(`[store] GET responded ${res.status}`);
      throw new Error(
        "Something went wrong loading your data. Try again in a moment.",
      );
    }
    const data = await res.json();
    if (!data.ok)
      throw new Error(data.error || "Something went wrong. Try again.");
    return data;
  }

  async _post(
    payload,
    attempt = 1,
    retriedWithoutTenant = false,
    path = "/data",
  ) {
    const idempotent = [
      "update",
      "delete",
      "clear",
      "setBudget",
      "setCurrency",
      "setBalances",
      "deleteBalanceDate",
      "deleteDebt",
      "updateDebt",
      "getUploadUrl",
      "getScanStatus",
    ].includes(payload.action);
    let res;
    try {
      res = await fetch(`${this.endpoint}${path}`, {
        method: "POST",
        headers: this._headers({ "Content-Type": "application/json" }),
        body: JSON.stringify(payload),
        cache: "no-store",
      });
    } catch (networkErr) {
      if (idempotent && attempt < 2) {
        await sleep(600);
        return this._post(payload, attempt + 1, retriedWithoutTenant, path);
      }
      // See the matching comment in _get() above - keep the raw browser
      // error out of what the user actually sees.
      console.error(`[store] POST failed: ${networkErr.message}`);
      throw new Error(
        "Couldn't reach your Ledger account. Check your connection and try again.",
      );
    }
    if (res.status === 401) {
      const message = await this._errorText(res);
      // Safe to replay for ANY action, unlike the network-blip retry above:
      // a 401 means the request was rejected before it reached a route, so
      // nothing was written and there is nothing to double-apply.
      if (!retriedWithoutTenant && this._isTenantRejection(message)) {
        this._dropActiveTenant();
        return this._post(payload, 1, true, path);
      }
      const err = new Error("Sign-in expired. Please sign in again.");
      err.auth = true;
      throw err;
    }
    if (!res.ok) {
      if (idempotent && res.status >= 500 && attempt < 2) {
        await sleep(600);
        return this._post(payload, attempt + 1, retriedWithoutTenant, path);
      }
      console.error(`[store] POST responded ${res.status}`);
      // /extract (see extractTransactions below) returns real, specific
      // user-facing error text on its 4xx/403 responses (plan gate, cap
      // exceeded, file too large, too many PDF pages, malformed request) -
      // surface it instead of the generic message below, which would
      // otherwise hide all of that from the user regardless of what
      // actually went wrong. Every other action still goes through /data,
      // whose generic wording stays exactly as it was.
      if (path === "/extract") {
        const message = await this._errorText(res);
        if (message) throw new Error(message);
      }
      throw new Error(
        "Something went wrong saving your change. Try again in a moment.",
      );
    }
    const data = await res.json();
    if (!data.ok)
      throw new Error(data.error || "Something went wrong. Try again.");
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
  /** The full plan list (id, seatCap, features, priceId, and live amount/
      currency when Stripe resolves it) - see backend/src/routes/billing.js's
      getPlans for what's actually in each entry. This is the only place
      app.js learns which tiers exist at all; it keeps no independent list
      of its own (see app.js's PLAN_COPY). */
  async getPlans() {
    const r = await this._post({ action: "getPlans" });
    return r.plans || [];
  }
  async getUploadUrl(fileType) {
    const r = await this._post({ action: "getUploadUrl", fileType });
    return { url: r.url, key: r.key };
  }
  async uploadToS3(url, file) {
    const res = await fetch(url, { method: "PUT", body: file });
    if (!res.ok) throw new Error("Could not upload this file. Try again.");
  }
  async getScanStatus(key) {
    const r = await this._post({ action: "getScanStatus", key });
    return r.status;
  }
  /** Uploads `file` to S3, polls for a GuardDuty scan verdict, then calls
      /extract once the file is confirmed clean. Polls with exponential
      backoff (starts at 2s, doubles each iteration, capped at 8s) for up
      to 60 seconds total - if the scan hasn't resolved by then, this gives
      up rather than polling forever (see this feature's spec, Section B,
      Error handling). Backoff instead of a fixed 2s interval cuts the
      worst-case poll count from ~30 down to ~7-8, which matters because
      each poll is a real request against the same per-IP rate limit
      (60 req/60s) every other action shares - a fixed interval could burn
      roughly half that budget on one import alone. An infected or
      otherwise non-clean verdict throws before /extract is ever called -
      the same fail-closed behavior ExtractFunction's own server-side
      check enforces independently. */
  async extractTransactions(fileName, fileType, file, categoryNames) {
    const { url, key } = await this.getUploadUrl(fileType);
    await this.uploadToS3(url, file);

    const POLL_INTERVAL_MS = 2000;
    const POLL_INTERVAL_MAX_MS = 8000;
    const POLL_TIMEOUT_MS = 60000;
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    let pollInterval = POLL_INTERVAL_MS;
    let status = "pending";
    while (status === "pending") {
      if (Date.now() > deadline)
        throw new Error(
          "This file is taking longer than expected to scan. Try again in a moment.",
        );
      await sleep(pollInterval);
      pollInterval = Math.min(pollInterval * 2, POLL_INTERVAL_MAX_MS);
      status = await this.getScanStatus(key);
    }
    if (status !== "clean")
      throw new Error("This file could not be processed.");

    const r = await this._post(
      { fileType, s3Key: key, categoryNames },
      1,
      false,
      "/extract",
    );
    return { transactions: r.transactions || [], skipped: r.skipped || 0 };
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
  async setCurrency(currency) {
    await this._post({ action: "setCurrency", currency });
    await this._refreshMeta();
    return currency;
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

/* -------------------------------------------------------------- disconnected
   Placeholder used only when there is no working connection to a Ledger
   account — never a storage tier a user should knowingly be "on". This is a
   multi-tenant SaaS: every session must be connected to a real account, so
   nothing here ever persists (no IndexedDB, no localStorage cache of rows).
   Reads return empty so the app can still render its own shell instead of
   crashing outright; writes throw, so every action correctly surfaces "not
   connected" through the same withBusy()/notice() path every other store
   error already goes through, rather than silently accepting a change that
   was never actually saved anywhere. */
function notConnected() {
  throw new Error(
    "Not connected to your Ledger account — reconnect to make changes.",
  );
}
class DisconnectedStore {
  constructor() {
    this.kind = "disconnected";
  }
  async ensureYearLoaded() {}
  async ensureAllYearsLoaded() {}
  async list() {
    return [];
  }
  async add() {
    notConnected();
  }
  async bulkAdd() {
    notConnected();
  }
  async update() {
    notConnected();
  }
  async remove() {
    notConnected();
  }
  async clear() {
    notConnected();
  }
  async getBudget() {
    return emptyBudget();
  }
  async setBudget() {
    notConnected();
  }
  async setCurrency() {
    notConnected();
  }
  async getBalances() {
    return [];
  }
  async getDebts() {
    return [];
  }
  async addDebt() {
    notConnected();
  }
  async updateDebt() {
    notConnected();
  }
  async deleteDebt() {
    notConnected();
  }
  async importDebts() {
    notConnected();
  }
  async setBalances() {
    notConnected();
  }
  async deleteBalanceDate() {
    notConnected();
  }
  async isEmpty() {
    return true;
  }
  // A read, not a write - fails open with an empty list (rather than
  // notConnected()'s throw), so the Billing/plan-gate pages still render
  // their shell instead of erroring out. There is no static fallback list
  // any more (see app.js's PLAN_COPY, which only has display copy, not
  // plan existence) - an empty result means those pages show "plans
  // unavailable" rather than a stale-but-plausible-looking price.
  async getPlans() {
    return [];
  }
  async extractTransactions() {
    notConnected();
  }
  async getUploadUrl() {
    notConnected();
  }
  async uploadToS3() {
    notConnected();
  }
  async getScanStatus() {
    notConnected();
  }
}

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

export { ApiStore };
