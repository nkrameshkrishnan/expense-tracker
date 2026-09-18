/* MemoryStore - last-resort in-tab-only fallback for browsers where
   IndexedDB is blocked (some locked-down/private-browsing contexts). Nothing
   persists past a reload. */
import { currentYear, emptyBudget, normalise } from "../store-helpers.js";

export class MemoryStore {
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
