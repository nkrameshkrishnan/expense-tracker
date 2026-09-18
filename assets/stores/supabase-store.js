/* SupabaseStore - the real storage backend. A Supabase/Postgres project is
   the database, reached via the Supabase SDK (loaded lazily - see
   loadSupabaseSdk() in store-helpers.js), with Row Level Security enforcing
   the household allow-list. One of three implementations of the same
   interface (this one, LocalStore, MemoryStore) that openStore() in
   store.js picks between - nothing calling state.store.list()/.add()/etc
   needs to know or care which one it got. */
import {
  sleep,
  currentYear,
  normalise,
  loadSupabaseSdk,
  supabaseClientCache,
  SUPABASE_PAGE_SIZE,
  dbError,
  selectAllRows,
  budgetRowsToShape,
} from "../store-helpers.js";
import { getNonce } from "../auth-config.js";

export class SupabaseStore {
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
    if (!supabaseClientCache.client || supabaseClientCache.key !== key) {
      supabaseClientCache.client = window.supabase.createClient(
        this.url,
        this.anonKey,
      );
      supabaseClientCache.key = key;
    }
    this.sb = supabaseClientCache.client;
    return this.sb;
  }

  /** Exchanges the SAME Google ID token the app already obtains via Google
      Identity Services (see showGate() in auth.js) for a Supabase session -
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
    if (err) throw dbError(err);
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
    if (error) throw dbError(error);
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
    if (error) throw dbError(error);
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
    if (error) throw dbError(error);
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
      if (error) throw dbError(error);
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
    if (error) throw dbError(error);
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
    if (error) throw dbError(error);
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
    if (error) throw dbError(error);
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
    if (error) throw dbError(error);
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
    if (error) throw dbError(error);
    if (this.cache) await this._refreshBalances();
  }
  async deleteBalanceDate(date) {
    const sb = await this._client();
    const { error } = await sb.from("balances").delete().eq("date", date);
    if (error) throw dbError(error);
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
      snake_case, but pages/debts.js and every other store (LocalStore, MemoryStore)
      use camelCase parentId throughout - e.g. relatedTransactions()/the
      outstanding-balance calc in pages/debts.js filter on `d.parentId`. Left as
      parent_id, a Supabase-sourced payment's parentId is always undefined,
      so it never matches its debt: outstanding silently shows the full
      principal as if zero payments had ever been made against it. */
  _normDebt(d) {
    const { parent_id, interest_rate, debt_type, ...rest } = d;
    return {
      ...rest,
      id: Number(d.id) || 0,
      parentId: parent_id != null ? Number(parent_id) : null,
      amount: Number(d.amount) || 0,
      interestRate: interest_rate != null ? Number(interest_rate) : null,
      debtType: debt_type ?? null,
    };
  }

  // Inverse of _normDebt for outbound rows: pages/debts.js/LocalStore/MemoryStore
  // build records with camelCase parentId, but the Postgres column is
  // parent_id - PostgREST rejects an unrecognised parentId key outright
  // (PGRST204) rather than ignoring it, so every write path needs this.
  _toDbDebt(record) {
    const { parentId, interestRate, debtType, ...rest } = record;
    const out = { ...rest };
    if ("parentId" in record) out.parent_id = parentId;
    if ("interestRate" in record) out.interest_rate = interestRate;
    if ("debtType" in record) out.debt_type = debtType;
    return out;
  }

  async addDebt(record) {
    const sb = await this._client();
    const { data, error } = await sb
      .from("debts")
      .insert(this._toDbDebt(record))
      .select()
      .single();
    if (error) throw dbError(error);
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
    if (error) throw dbError(error);
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
    if (error) throw dbError(error);
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
    if (error) throw dbError(error);
    const results = data.map((d) => this._normDebt(d));
    if (this.cache) this.cache.debts.push(...results);
    return { inserted: results.length };
  }
}

/** Postgres rows (one per year/category/month) -> the same {category: {month:
    amount}} shape LocalStore/MemoryStore also use, so the pages calling it never need to
    know which backend produced a budget. */
