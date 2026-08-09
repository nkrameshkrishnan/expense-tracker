/* Storage layer.
   Two interchangeable adapters behind one interface, chosen at runtime:
     LocalStore  - IndexedDB in the browser. Works on GitHub Pages with no server.
     RestStore   - the optional FastAPI + SQLite backend running on your machine.
   A third, MemoryStore, is the fallback when IndexedDB is unavailable
   (private browsing, sandboxed previews) so the UI still functions for the session. */

export const YEAR = 2026;

export const CATEGORIES = [
  ['Salary', 'Income'], ['Other Income', 'Income'],
  ['Rent / Housing', 'Expense'], ['Groceries', 'Expense'], ['Utilities', 'Expense'],
  ['Internet & Phone', 'Expense'], ['Transport', 'Expense'], ['Dining Out', 'Expense'],
  ['Health & Fitness', 'Expense'], ['Insurance', 'Expense'], ['Shopping', 'Expense'],
  ['Entertainment', 'Expense'], ['Subscriptions', 'Expense'], ['Travel', 'Expense'],
  ['Education', 'Expense'], ['Gifts & Donations', 'Expense'], ['Personal Care', 'Expense'],
  ['Savings & Investments', 'Expense'], ['Miscellaneous', 'Expense'],
];
export const CAT_NAMES = CATEGORIES.map(c => c[0]);
export const EXPENSE_CATS = CATEGORIES.filter(c => c[1] === 'Expense').map(c => c[0]);
export const CAT_TYPE = Object.fromEntries(CATEGORIES);

export const TYPES = ['Expense', 'Income', 'Transfer'];
export const PAYMENTS = ['Credit Card', 'Debit Card', 'Cash', 'e-Transfer', 'Pre-authorized Debit', 'Other'];
export const ACCOUNTS = ['Chequing', 'Savings', 'Visa', 'Mastercard', 'Cash Wallet'];
export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const BACKEND_KEY = 'ledger.backendUrl';

const DB_NAME = 'ledger-expense-tracker';
const DB_VERSION = 1;

function emptyBudget() {
  const b = {};
  for (const c of CAT_NAMES) {
    b[c] = {};
    for (let m = 1; m <= 12; m++) b[c][m] = 0;
  }
  return b;
}

/** Normalise anything inbound into the canonical record shape. */
export function normalise(r) {
  const amount = Math.abs(Number(r.amount) || 0);
  let type = r.type || r.typ || 'Expense';
  if (!TYPES.includes(type)) type = 'Expense';
  const category = CAT_NAMES.includes(r.category || r.cat) ? (r.category || r.cat) : 'Miscellaneous';
  return {
    id: r.id,
    date: String(r.date || '').slice(0, 10),
    type,
    category,
    subcategory: r.subcategory || r.sub || '',
    description: r.description || r.desc || '',
    amount: Math.round(amount * 100) / 100,
    payment: r.payment || '',
    account: r.account || '',
    recurring: r.recurring || r.recur || 'No',
    notes: r.notes || r.note || '',
  };
}

/* ------------------------------------------------------------------ IndexedDB */
class LocalStore {
  constructor(db) { this.db = db; this.kind = 'local'; }

  static open() {
    return new Promise((resolve, reject) => {
      if (!('indexedDB' in globalThis)) return reject(new Error('no indexedDB'));
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('transactions')) {
          const os = db.createObjectStore('transactions', { keyPath: 'id', autoIncrement: true });
          os.createIndex('date', 'date');
        }
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      };
      req.onsuccess = () => resolve(new LocalStore(req.result));
      req.onerror = () => reject(req.error || new Error('indexedDB blocked'));
      req.onblocked = () => reject(new Error('indexedDB blocked'));
    });
  }

  _tx(store, mode) { return this.db.transaction(store, mode).objectStore(store); }
  _wrap(req) {
    return new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
  }

  async list() {
    const rows = await this._wrap(this._tx('transactions', 'readonly').getAll());
    return rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id));
  }
  async add(rec) {
    const r = normalise(rec); delete r.id;
    const id = await this._wrap(this._tx('transactions', 'readwrite').add(r));
    return { ...r, id };
  }
  async bulkAdd(list) {
    const os = this.db.transaction('transactions', 'readwrite').objectStore('transactions');
    let n = 0;
    for (const rec of list) { const r = normalise(rec); delete r.id; os.add(r); n++; }
    await new Promise((res, rej) => { os.transaction.oncomplete = res; os.transaction.onerror = () => rej(os.transaction.error); });
    return n;
  }
  async update(id, rec) {
    const r = normalise({ ...rec, id });
    await this._wrap(this._tx('transactions', 'readwrite').put(r));
    return r;
  }
  async remove(id) { await this._wrap(this._tx('transactions', 'readwrite').delete(Number(id))); }
  async clear() {
    await this._wrap(this._tx('transactions', 'readwrite').clear());
    await this._wrap(this._tx('meta', 'readwrite').delete('budget'));
  }
  async getBudget() { return (await this._wrap(this._tx('meta', 'readonly').get('budget'))) || emptyBudget(); }
  async setBudget(b) { await this._wrap(this._tx('meta', 'readwrite').put(b, 'budget')); return b; }
  async isEmpty() { return (await this._wrap(this._tx('transactions', 'readonly').count())) === 0; }
}

/* ------------------------------------------------------------------ in-memory */
class MemoryStore {
  constructor() { this.rows = []; this.seq = 1; this.budget = emptyBudget(); this.kind = 'memory'; }
  async list() { return [...this.rows].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id)); }
  async add(rec) { const r = normalise(rec); r.id = this.seq++; this.rows.push(r); return r; }
  async bulkAdd(l) { for (const x of l) await this.add(x); return l.length; }
  async update(id, rec) { const r = normalise({ ...rec, id: Number(id) }); this.rows = this.rows.map(x => (x.id === r.id ? r : x)); return r; }
  async remove(id) { this.rows = this.rows.filter(x => x.id !== Number(id)); }
  async clear() { this.rows = []; this.budget = emptyBudget(); }
  async getBudget() { return this.budget; }
  async setBudget(b) { this.budget = b; return b; }
  async isEmpty() { return this.rows.length === 0; }
}

/* ------------------------------------------------------------------ REST */
class RestStore {
  constructor(base) { this.base = base.replace(/\/+$/, ''); this.kind = 'remote'; }
  async _req(path, opts = {}) {
    const res = await fetch(this.base + path, {
      headers: { 'Content-Type': 'application/json' }, ...opts,
    });
    if (!res.ok) throw new Error(`${res.status} ${await res.text().catch(() => res.statusText)}`);
    return res.status === 204 ? null : res.json();
  }
  async ping() { return this._req('/api/health'); }
  async list() { return (await this._req('/api/transactions')).map(normalise); }
  async add(rec) { const r = normalise(rec); delete r.id; return normalise(await this._req('/api/transactions', { method: 'POST', body: JSON.stringify(r) })); }
  async bulkAdd(list) {
    const body = JSON.stringify(list.map(r => { const n = normalise(r); delete n.id; return n; }));
    const out = await this._req('/api/transactions/bulk', { method: 'POST', body });
    return out.inserted;
  }
  async update(id, rec) { return normalise(await this._req(`/api/transactions/${id}`, { method: 'PATCH', body: JSON.stringify(normalise({ ...rec, id })) })); }
  async remove(id) { await this._req(`/api/transactions/${id}`, { method: 'DELETE' }); }
  async clear() { await this._req('/api/transactions', { method: 'DELETE' }); }
  async getBudget() { const b = await this._req('/api/budget'); return Object.keys(b).length ? b : emptyBudget(); }
  async setBudget(b) { return this._req('/api/budget', { method: 'PUT', body: JSON.stringify(b) }); }
  async isEmpty() { return (await this.list()).length === 0; }
}

/** Pick an adapter. Falls back cleanly rather than throwing the UI away. */
export async function openStore(onNotice) {
  const url = localStorage.getItem(BACKEND_KEY);
  if (url) {
    try {
      const s = new RestStore(url);
      await s.ping();
      return s;
    } catch (e) {
      onNotice?.(`Backend at ${url} is unreachable (${e.message}). Using local browser storage instead.`, 'bad');
    }
  }
  try {
    return await LocalStore.open();
  } catch {
    onNotice?.('IndexedDB is unavailable here, so data will not survive a reload. Export before you close the tab.', 'bad');
    return new MemoryStore();
  }
}

export { emptyBudget };
