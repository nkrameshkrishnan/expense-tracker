/* LocalStore - the no-configuration IndexedDB fallback, used when Supabase
   isn't set up. Always holds the full history at once (no year-scoping like
   SupabaseStore), so callers can invoke ensureYearLoaded()/etc as no-ops
   without branching on which backend is active. */
import { currentYear, emptyBudget, normalise } from "../store-helpers.js";

const DB_NAME = "ledger-expense-tracker";
const DB_VERSION = 1;

export class LocalStore {
  constructor(db) {
    this.db = db;
    this.kind = "local";
  }
  // No-ops: unlike SupabaseStore, IndexedDB always holds the full history
  // already - there is no partial year-scoping to catch up on. These exist
  // so callers can invoke them unconditionally regardless of which adapter is
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
