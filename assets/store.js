/* Storage layer.

   SheetsStore is the real one: your Google Sheet is the database, reached through an
   Apps Script web app. LocalStore (IndexedDB) remains as the no-configuration fallback
   so the app is usable before you wire up the sheet, and MemoryStore covers browsers
   where IndexedDB is blocked.

   Config precedence: what you type under Data → Google Sheet (localStorage) wins over
   the build-time values injected from GitHub secrets. */

import { SHEETS_ENDPOINT, SHEETS_TOKEN, GOOGLE_CLIENT_ID } from './config.js';

export const YEAR = 2026;

export const CATEGORIES = [
  ['Salary', 'Income'], ['Other Income', 'Income'],
  ['Rent / Housing', 'Expense'], ['Groceries', 'Expense'], ['Utilities', 'Expense'],
  ['Internet & Phone', 'Expense'], ['Transport', 'Expense'], ['Gas', 'Expense'], ['Dining Out', 'Expense'],
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
export const ACCOUNTS = [
  'CIBC Chequing', 'WealthSimple Chequing', 'Savings',
  'Visa', 'Mastercard', 'Amex',
  'WealthSimple TFSA', 'WealthSimple RRSP', 'WealthSimple Non-registered',
  'Cash Wallet',
];
export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/* Who the money belongs to. 'Joint' is a real third bucket, not a sum of the other
   two — a shared grocery run is Joint, it is not half Ramesh and half Surya.
   Rows imported before this feature existed have no person and read as Unassigned. */
export const PEOPLE = ['Ramesh', 'Surya', 'Joint'];
export const UNASSIGNED = 'Unassigned';
export const PERSON_KEY = 'ledger.person';

/* Accounts tracked for net worth. Some exist only as balances and never appear
   in transactions (a GIC, a savings account that sat at zero all year), so this
   is deliberately a superset of ACCOUNTS rather than derived from it. */
export const NET_WORTH_ACCOUNTS = [
  { account: 'CIBC Chequing',                owner: 'Ramesh', kind: 'Asset' },
  { account: 'CIBC TFSA (Investment)',       owner: 'Ramesh', kind: 'Asset' },
  { account: 'WealthSimple Chequing',        owner: 'Ramesh', kind: 'Asset' },
  { account: 'WealthSimple TFSA',            owner: 'Ramesh', kind: 'Asset' },
  { account: 'WealthSimple RRSP',            owner: 'Ramesh', kind: 'Asset' },
  { account: 'WealthSimple Non-registered',  owner: 'Ramesh', kind: 'Asset' },
  { account: 'CIBC Visa',                    owner: 'Ramesh', kind: 'Liability' },
  { account: 'CIBC Mastercard',              owner: 'Ramesh', kind: 'Liability' },
  { account: 'Amex (Ramesh)',                owner: 'Ramesh', kind: 'Liability' },
  { account: 'CIBC Chequing (Surya)',        owner: 'Surya',  kind: 'Asset' },
  { account: 'CIBC Savings (Surya)',         owner: 'Surya',  kind: 'Asset' },
  { account: 'CIBC TFSA (Surya)',            owner: 'Surya',  kind: 'Asset' },
  { account: 'CIBC TFSA GIC (Surya)',        owner: 'Surya',  kind: 'Asset' },
  { account: 'WealthSimple Chequing (Surya)',owner: 'Surya',  kind: 'Asset' },
  { account: 'WealthSimple TFSA (Surya)',    owner: 'Surya',  kind: 'Asset' },
  { account: 'WealthSimple RRSP (Surya)',    owner: 'Surya',  kind: 'Asset' },
  { account: 'WealthSimple Non-registered (Surya)', owner: 'Surya', kind: 'Asset' },
  { account: 'Amex (Surya)',                 owner: 'Surya',  kind: 'Liability' },
];

export const CUSTOM_KEY = 'ledger.customLists';
export const ENDPOINT_KEY = 'ledger.sheetsEndpoint';
export const TOKEN_KEY = 'ledger.sheetsToken';
export const ID_TOKEN_KEY = 'ledger.googleIdToken';

export const getClientId = () => (localStorage.getItem('ledger.clientId') || GOOGLE_CLIENT_ID || '').trim();
// sessionStorage can throw in locked-down browser contexts (strict privacy
// modes, some sandboxed embeds). Falls back to an in-memory value for the
// lifetime of the tab rather than crashing the whole app on that one call.
let _idTokenMem = '';
export const getIdToken = () => { try { return sessionStorage.getItem(ID_TOKEN_KEY) || ''; } catch { return _idTokenMem; } };
export const setIdToken = t => {
  try {
    if (t) sessionStorage.setItem(ID_TOKEN_KEY, t); else sessionStorage.removeItem(ID_TOKEN_KEY);
  } catch { /* fall through to memory */ }
  _idTokenMem = t || '';
};

export const getEndpoint = () => (localStorage.getItem(ENDPOINT_KEY) || SHEETS_ENDPOINT || '').trim();
export const getToken = () => (localStorage.getItem(TOKEN_KEY) || SHEETS_TOKEN || '').trim();
export const endpointSource = () =>
  localStorage.getItem(ENDPOINT_KEY) ? 'runtime' : (SHEETS_ENDPOINT ? 'build' : 'none');

const DB_NAME = 'ledger-expense-tracker';
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
  let type = r.type || r.typ || 'Expense';
  if (!TYPES.includes(type)) type = 'Expense';
  const raw = r.category || r.cat;
  return {
    id: r.id,
    date: String(r.date || '').slice(0, 10),
    type,
    // Any non-empty string is allowed: users can create their own categories,
    // and forcing unknown names to Miscellaneous would silently discard them.
    category: String(raw || '').trim() || 'Miscellaneous',
    subcategory: r.subcategory || r.sub || '',
    description: r.description || r.desc || '',
    amount: Math.round(amount * 100) / 100,
    payment: r.payment || '',
    account: r.account || '',
    recurring: (r.recurring === 'Yes' || r.recur === 'Yes') ? 'Yes' : 'No',
    notes: r.notes || r.note || '',
    person: PEOPLE.includes(r.person) ? r.person : '',
  };
}

/* ------------------------------------------------------------- Google Sheets */
class SheetsStore {
  constructor(endpoint, token) {
    this.endpoint = endpoint.replace(/\/+$/, '');
    this.token = token;
    this.kind = 'sheets';
    this.cache = null;
    this.sheetName = '';
  }

  async _get() {
    const url = `${this.endpoint}?idToken=${encodeURIComponent(getIdToken())}&t=${Date.now()}`;
    const res = await fetch(url, { method: 'GET', redirect: 'follow' });
    if (!res.ok) throw new Error(`Sheet responded ${res.status}. Check the deployment is set to "Anyone".`);
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      // Almost always Google's sign-in page: the web app is not public.
      throw new Error('Got HTML instead of JSON — redeploy the Apps Script with Access set to "Anyone".');
    }
    if (!data.ok) {
      const err = new Error(data.error || 'Sheet refused the request.');
      if (/sign in|sign-in|not permitted|rejected that sign/i.test(err.message)) err.auth = true;
      throw err;
    }
    return data;
  }

  /* text/plain dodges the CORS preflight that Apps Script cannot answer. */
  async _post(payload) {
    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ ...payload, idToken: getIdToken() }),
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`Sheet responded ${res.status}.`);
    const data = JSON.parse(await res.text());
    if (!data.ok) {
      const err = new Error(data.error || 'Write rejected by the sheet.');
      if (/sign in|sign-in|not permitted|rejected that sign/i.test(err.message)) err.auth = true;
      throw err;
    }
    this.cache = null;                       // the sheet is the truth; reread next time
    return data;
  }

  _fill(d) {
    this.cache = { transactions: d.transactions.map(normalise), budget: d.budget,
                   balances: d.balances || [], debts: d.debts || [] };
    this.sheetName = d.sheetName || '';
    this.user = d.user || null;      // verified by Apps Script, not by the browser
    return this.cache;
  }
  async ping() { return this._fill(await this._get()); }
  async _ensure() { return this.cache || this._fill(await this._get()); }

  async list() { return (await this._ensure()).transactions; }
  async getBalances() { return (await this._ensure()).balances || []; }
  async getDebts() { return (await this._ensure()).debts || []; }
  async addDebt(record) { return (await this._post({ action: 'addDebt', record })).id; }
  async updateDebt(id, record) { await this._post({ action: 'updateDebt', id, record }); }
  async deleteDebt(id) { await this._post({ action: 'deleteDebt', id }); }
  async importDebts(records) { return this._post({ action: 'importDebts', records }); }
  async setBalances(date, entries) { await this._post({ action: 'setBalances', date, entries }); }
  async deleteBalanceDate(date) { await this._post({ action: 'deleteBalanceDate', date }); }
  async getBudget() {
    const b = (await this._ensure()).budget;
    const full = emptyBudget();
    if (b) for (const c of Object.keys(b)) if (full[c]) for (let m = 1; m <= 12; m++) full[c][m] = Number(b[c][m]) || 0;
    return full;
  }
  async setBudget(budget) { await this._post({ action: 'setBudget', budget }); return budget; }

  async add(rec) {
    const r = normalise(rec); delete r.id;
    return normalise((await this._post({ action: 'create', record: r })).record);
  }
  async bulkAdd(list, onProgress) {
    const records = list.map(r => { const n = normalise(r); delete n.id; return n; });
    // Apps Script now writes a chunk with a handful of batched range calls, so
    // larger chunks mean fewer HTTP round trips without risking the 6-min limit.
    const CHUNK = 1000;
    let inserted = 0;
    for (let i = 0; i < records.length; i += CHUNK) {
      inserted += (await this._post({ action: 'bulk', records: records.slice(i, i + CHUNK) })).inserted;
      onProgress?.(Math.min(i + CHUNK, records.length), records.length);
    }
    return inserted;
  }
  async update(id, rec) {
    const r = normalise({ ...rec, id });
    return normalise((await this._post({ action: 'update', id, record: r })).record);
  }
  async remove(id) { await this._post({ action: 'delete', id }); }
  async clear() { await this._post({ action: 'clear' }); }
  async isEmpty() { return (await this.list()).length === 0; }
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
          db.createObjectStore('transactions', { keyPath: 'id', autoIncrement: true }).createIndex('date', 'date');
        }
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      };
      req.onsuccess = () => resolve(new LocalStore(req.result));
      req.onerror = () => reject(req.error || new Error('indexedDB blocked'));
      req.onblocked = () => reject(new Error('indexedDB blocked'));
    });
  }
  _tx(s, m) { return this.db.transaction(s, m).objectStore(s); }
  _wrap(req) { return new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); }); }
  async list() {
    const rows = await this._wrap(this._tx('transactions', 'readonly').getAll());
    return rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id));
  }
  async add(rec) { const r = normalise(rec); delete r.id; const id = await this._wrap(this._tx('transactions', 'readwrite').add(r)); return { ...r, id }; }
  async bulkAdd(list) {
    const os = this.db.transaction('transactions', 'readwrite').objectStore('transactions');
    for (const rec of list) { const r = normalise(rec); delete r.id; os.add(r); }
    await new Promise((res, rej) => { os.transaction.oncomplete = res; os.transaction.onerror = () => rej(os.transaction.error); });
    return list.length;
  }
  async update(id, rec) { const r = normalise({ ...rec, id }); await this._wrap(this._tx('transactions', 'readwrite').put(r)); return r; }
  async remove(id) { await this._wrap(this._tx('transactions', 'readwrite').delete(Number(id))); }
  async clear() { await this._wrap(this._tx('transactions', 'readwrite').clear()); await this._wrap(this._tx('meta', 'readwrite').delete('budget')); }
  async getBudget() { return (await this._wrap(this._tx('meta', 'readonly').get('budget'))) || emptyBudget(); }
  async getBalances() { return (await this._wrap(this._tx('meta', 'readonly').get('balances'))) || []; }
  async getDebts() { return (await this._wrap(this._tx('meta', 'readonly').get('debts'))) || []; }
  async addDebt(record) {
    const all = await this.getDebts();
    const id = Math.max(0, ...all.map(d => Number(d.id) || 0)) + 1;
    await this._wrap(this._tx('meta', 'readwrite').put([...all, { ...record, id }], 'debts'));
    return id;
  }
  async updateDebt(id, record) {
    const all = await this.getDebts();
    await this._wrap(this._tx('meta', 'readwrite').put(
      all.map(d => (Number(d.id) === Number(id) ? { ...record, id: Number(id) } : d)), 'debts'));
  }
  async deleteDebt(id) {
    const all = await this.getDebts();
    await this._wrap(this._tx('meta', 'readwrite').put(
      all.filter(d => Number(d.id) !== Number(id) && Number(d.parentId) !== Number(id)), 'debts'));
  }
  async importDebts(records) {
    const all = await this.getDebts();
    let id = Math.max(0, ...all.map(d => Number(d.id) || 0)) + 1;
    const fileToReal = {};
    for (const r of records) if (r.kind !== 'Payment') { fileToReal[String(r.fileRef)] = id++; }
    const rows = []; let nD = 0, nP = 0, skipped = 0;
    id = Math.max(0, ...all.map(d => Number(d.id) || 0)) + 1;
    for (const r of records) {
      if (r.kind !== 'Payment') { rows.push({ ...r, id, parentId: null }); id++; nD++; continue; }
      const parentReal = fileToReal[String(r.parentFileRef)];
      if (!parentReal) { skipped++; continue; }
      rows.push({ ...r, id, parentId: parentReal }); id++; nP++;
    }
    await this._wrap(this._tx('meta', 'readwrite').put([...all, ...rows], 'debts'));
    return { debts: nD, payments: nP, skipped };
  }
  async setBalances(date, entries) {
    const all = (await this.getBalances()).filter(b => b.date !== date);
    await this._wrap(this._tx('meta', 'readwrite').put([...all, ...entries.map(e => ({ ...e, date }))], 'balances'));
  }
  async deleteBalanceDate(date) {
    const all = (await this.getBalances()).filter(b => b.date !== date);
    await this._wrap(this._tx('meta', 'readwrite').put(all, 'balances'));
  }
  async setBudget(b) { await this._wrap(this._tx('meta', 'readwrite').put(b, 'budget')); return b; }
  async isEmpty() { return (await this._wrap(this._tx('transactions', 'readonly').count())) === 0; }
}

/* ------------------------------------------------------------------ memory */
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
  async getBalances() { return this.balances || (this.balances = []); }
  async getDebts() { return this.debts || (this.debts = []); }
  async addDebt(record) {
    this.debts = this.debts || [];
    const id = Math.max(0, ...this.debts.map(d => Number(d.id) || 0)) + 1;
    this.debts.push({ ...record, id });
    return id;
  }
  async updateDebt(id, record) {
    this.debts = (this.debts || []).map(d => (Number(d.id) === Number(id) ? { ...record, id: Number(id) } : d));
  }
  async deleteDebt(id) {
    this.debts = (this.debts || []).filter(d => Number(d.id) !== Number(id) && Number(d.parentId) !== Number(id));
  }
  async importDebts(records) {
    this.debts = this.debts || [];
    let id = Math.max(0, ...this.debts.map(d => Number(d.id) || 0)) + 1;
    const fileToReal = {};
    for (const r of records) if (r.kind !== 'Payment') { fileToReal[String(r.fileRef)] = id++; }
    const rows = []; let nD = 0, nP = 0, skipped = 0;
    id = Math.max(0, ...this.debts.map(d => Number(d.id) || 0)) + 1;
    for (const r of records) {
      if (r.kind !== 'Payment') { rows.push({ ...r, id, parentId: null }); id++; nD++; continue; }
      const parentReal = fileToReal[String(r.parentFileRef)];
      if (!parentReal) { skipped++; continue; }
      rows.push({ ...r, id, parentId: parentReal }); id++; nP++;
    }
    this.debts.push(...rows);
    return { debts: nD, payments: nP, skipped };
  }
  async setBalances(date, entries) {
    this.balances = [...(this.balances || []).filter(b => b.date !== date),
                     ...entries.map(e => ({ ...e, date }))];
  }
  async deleteBalanceDate(date) { this.balances = (this.balances || []).filter(b => b.date !== date); }
  async isEmpty() { return this.rows.length === 0; }
}

export async function openStore(onNotice) {
  const endpoint = getEndpoint(), token = getToken();
  if (endpoint) {
    try {
      const s = new SheetsStore(endpoint, token);
      await s.ping();
      return s;
    } catch (e) {
      onNotice?.(`Google Sheet unreachable: ${e.message} Falling back to this browser's storage — changes will NOT reach the sheet.`, 'bad');
    }
  } else {
    onNotice?.('No Google Sheet connected. Using browser storage — connect the sheet under Data.');
  }
  try {
    return await LocalStore.open();
  } catch {
    onNotice?.('IndexedDB unavailable, so nothing will persist. Export before closing the tab.', 'bad');
    return new MemoryStore();
  }
}

export { SheetsStore };