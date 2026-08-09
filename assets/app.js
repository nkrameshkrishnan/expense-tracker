import {
  openStore, CAT_NAMES, EXPENSE_CATS, CAT_TYPE, TYPES, PAYMENTS, ACCOUNTS,
  MONTHS, YEAR, BACKEND_KEY, emptyBudget,
} from './store.js';
import { aggregate, money, pct, monthOf, exportWorkbook, importFile } from './xlsxio.js';
import * as charts from './charts.js';

const $ = s => document.querySelector(s);
const view = $('#view');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = { store: null, rows: [], budget: emptyBudget(), month: 0, tab: 'dashboard', editing: null, filter: { q: '', cat: '', month: '' } };

function notice(msg, kind = '') {
  const b = $('#banner');
  b.className = 'banner ' + kind;
  b.innerHTML = esc(msg);
  b.hidden = false;
  if (kind === 'ok') setTimeout(() => { b.hidden = true; }, 4000);
}

async function refresh() {
  state.rows = await state.store.list();
  state.budget = await state.store.getBudget();
  $('#foot-count').textContent = `${state.rows.length} transactions stored`;
  const c = $('#conn');
  c.textContent = state.store.kind === 'remote' ? '\u25cf backend' : state.store.kind === 'memory' ? '\u25cf session only' : '\u25cf local';
  c.className = 'conn' + (state.store.kind === 'remote' ? ' remote' : '');
}

/* ================================================================= DASHBOARD */
function monthSelect(id, value) {
  return `<label class="f"><span>Period</span><select id="${id}">
    <option value="0"${value === 0 ? ' selected' : ''}>Full year ${YEAR}</option>
    ${MONTHS.map((m, i) => `<option value="${i + 1}"${value === i + 1 ? ' selected' : ''}>${m} ${YEAR}</option>`).join('')}
  </select></label>`;
}

function renderDashboard() {
  const a = aggregate(state.rows, state.budget, state.month);
  const label = state.month === 0 ? `Full year ${YEAR}` : `${MONTHS[state.month - 1]} ${YEAR}`;

  view.innerHTML = `
  <div class="head">
    <div><h1>Dashboard</h1><p class="sub">${esc(label)} &middot; ${a.count} transactions in period</p></div>
    <div class="spacer"></div>${monthSelect('m-sel', state.month)}
  </div>

  <div class="kpis">
    ${kpi('Income', money(a.income), a.income === 0 ? 'no income recorded' : '')}
    ${kpi('Expense', money(a.expense), `${a.count} entries`)}
    ${kpi('Net', money(a.net), a.net < 0 ? 'spending exceeds income' : '', a.net < 0 ? 'neg' : 'pos')}
    ${kpi('Savings rate', a.income > 0 ? pct(a.savingsRate) : '\u2014', a.income > 0 ? '' : 'needs income data')}
    ${kpi('Budget used', a.expenseBudget > 0 ? pct(a.budgetUsed) : '\u2014', a.expenseBudget > 0 ? `of ${money(a.expenseBudget)}` : 'no budget set', a.budgetUsed > 1 ? 'neg' : '')}
    ${kpi('Avg / day', money(a.avgDaily), state.month === 0 ? 'over 365 days' : `over ${new Date(YEAR, state.month, 0).getDate()} days`)}
  </div>

  ${a.overBudget.length ? `<div class="eyebrow">Over budget &mdash; ${label}</div>
  <div class="tablewrap"><table><thead><tr><th>Category</th><th class="n">Actual</th><th class="n">Budget</th><th class="n">Over by</th><th class="n">Used</th></tr></thead><tbody>
    ${a.overBudget.map(r => `<tr><td>${esc(r.category)}</td><td class="n num">${money(r.actual)}</td><td class="n num">${money(r.budget)}</td><td class="n num over">${money(-r.variance)}</td><td class="n num over">${pct(r.used)}</td></tr>`).join('')}
  </tbody></table></div>` : ''}

  <div class="eyebrow">Charts</div>
  <div class="grid2">
    <div class="panel"><h3>Income vs expense by month</h3><div class="chartbox"><canvas id="c-ie"></canvas></div></div>
    <div class="panel"><h3>Net savings by month</h3><div class="chartbox"><canvas id="c-net"></canvas></div></div>
    <div class="panel"><h3>Expense vs budget ceiling</h3><div class="chartbox"><canvas id="c-trend"></canvas></div></div>
    <div class="panel"><h3>Payment method split &mdash; ${esc(label)}</h3><div class="chartbox"><canvas id="c-pay"></canvas>
      ${a.byPayment.length === 0 ? `<p class="note" style="position:absolute;inset:0;display:grid;place-content:center;text-align:center">No payment methods recorded.<br>Fill the Payment field when adding entries.</p>` : ''}</div>
      ${a.unattributed > 0 ? `<p class="note">${money(a.unattributed)} has no payment method set, so it is excluded here.</p>` : ''}</div>
    <div class="panel"><h3>Actual vs budget by category &mdash; ${esc(label)}</h3><div class="chartbox tall"><canvas id="c-cat"></canvas></div></div>
    <div class="panel"><h3>Top 5 spend categories &mdash; ${esc(label)}</h3><div class="chartbox tall"><canvas id="c-top"></canvas></div></div>
  </div>

  <div class="eyebrow">Category detail &mdash; ${esc(label)}</div>
  <div class="tablewrap"><table><thead><tr><th>Category</th><th class="n">Actual</th><th class="n">Budget</th><th class="n">Variance</th><th class="n">Used</th></tr></thead><tbody>
    ${a.catRows.filter(r => r.actual > 0 || r.budget > 0).map(r => `<tr>
      <td>${esc(r.category)}</td><td class="n num">${money(r.actual)}</td><td class="n num">${money(r.budget)}</td>
      <td class="n num ${r.variance < 0 ? 'over' : 'under'}">${money(r.variance)}</td>
      <td class="n num ${r.used > 1 ? 'over' : ''}">${r.budget > 0 ? pct(r.used) : '\u2014'}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">Nothing recorded yet.</td></tr>'}
  </tbody></table></div>`;

  $('#m-sel').onchange = e => { state.month = Number(e.target.value); renderDashboard(); };

  if (typeof Chart === 'undefined') { notice('Chart.js did not load, so charts are unavailable. Everything else works.', 'bad'); return; }
  charts.incomeVsExpense(a.series);
  charts.netByMonth(a.series);
  charts.trend(a.series);
  charts.paymentSplit(a.byPayment);
  charts.actualVsBudget(a.catRows);
  charts.topFive(a.top5);
}

const kpi = (k, v, m = '', cls = '') => `<div class="kpi ${cls}"><div class="k">${k}</div><div class="v">${v}</div><div class="m">${esc(m)}</div></div>`;

/* ======================================================================= ADD */
function renderAdd() {
  const e = state.editing;
  const opt = (list, sel) => list.map(o => `<option${o === sel ? ' selected' : ''}>${esc(o)}</option>`).join('');
  const today = new Date().toISOString().slice(0, 10);

  view.innerHTML = `
  <div class="head"><div>
    <h1>${e ? 'Edit entry' : 'Add an expense'}</h1>
    <p class="sub">${e ? 'Editing entry #' + e.id : 'Amount is always positive. Type decides whether it counts as spend or income.'}</p>
  </div></div>

  <form id="f" class="formgrid" autocomplete="off">
    <label class="f"><span>Date *</span><input type="date" name="date" value="${esc(e?.date || today)}" required></label>
    <label class="f"><span>Type *</span><select name="type">${opt(TYPES, e?.type || 'Expense')}</select></label>
    <label class="f"><span>Category *</span><select name="category">${opt(CAT_NAMES, e?.category || 'Groceries')}</select></label>
    <label class="f"><span>Amount (CAD) *</span><input type="number" name="amount" step="0.01" min="0.01" value="${e?.amount ?? ''}" required placeholder="0.00"></label>

    <label class="f wide"><span>Description</span><input name="description" value="${esc(e?.description || '')}" placeholder="What was it?"></label>
    <label class="f"><span>Subcategory</span><input name="subcategory" list="subs" value="${esc(e?.subcategory || '')}"></label>
    <label class="f"><span>Recurring?</span><select name="recurring">${opt(['No', 'Yes'], e?.recurring || 'No')}</select></label>

    <label class="f"><span>Payment method</span><select name="payment"><option value=""></option>${opt(PAYMENTS, e?.payment || '')}</select></label>
    <label class="f"><span>Account</span><select name="account"><option value=""></option>${opt(ACCOUNTS, e?.account || '')}</select></label>
    <label class="f wide"><span>Notes</span><input name="notes" value="${esc(e?.notes || '')}"></label>

    <div class="full">
      <div class="err" id="err"></div>
      <div class="actions">
        <button class="btn" type="submit">${e ? 'Save changes' : 'Add entry'}</button>
        ${e ? '<button class="btn ghost" type="button" id="cancel">Cancel</button>' : '<button class="btn ghost" type="reset">Clear</button>'}
        <span class="muted" id="hint"></span>
      </div>
    </div>
  </form>
  <datalist id="subs">${[...new Set(state.rows.map(r => r.subcategory).filter(Boolean))].map(s => `<option>${esc(s)}</option>`).join('')}</datalist>
  <p class="note">Filling <b>Payment method</b> is what makes the payment-split chart work. It is optional everywhere else.</p>`;

  $('#cancel')?.addEventListener('click', () => { state.editing = null; go('transactions'); });

  $('#f').onsubmit = async ev => {
    ev.preventDefault();
    const d = Object.fromEntries(new FormData(ev.target));
    const amount = Number(d.amount);
    if (!d.date) return ($('#err').textContent = 'Pick a date.');
    if (!(amount > 0)) return ($('#err').textContent = 'Amount must be greater than zero. Use the Type field for income, not a minus sign.');
    if (Number(d.date.slice(0, 4)) !== YEAR) {
      $('#err').textContent = `Heads up: ${d.date} is outside ${YEAR}. It will save, but the dashboard only summarises ${YEAR}.`;
    }
    try {
      if (state.editing) {
        await state.store.update(state.editing.id, { ...d, amount });
        state.editing = null;
        await refresh(); notice('Entry updated.', 'ok'); go('transactions');
      } else {
        await state.store.add({ ...d, amount });
        await refresh();
        $('#hint').textContent = `Saved ${money(amount)} \u2014 ${state.rows.length} total.`;
        ev.target.reset();
        ev.target.date.value = d.date;
        ev.target.querySelector('[name=amount]').focus();
      }
    } catch (err) { $('#err').textContent = 'Could not save: ' + err.message; }
  };
}

/* ============================================================== TRANSACTIONS */
function renderTransactions() {
  const f = state.filter;
  let rows = state.rows;
  if (f.q) { const q = f.q.toLowerCase(); rows = rows.filter(r => (r.description + ' ' + r.subcategory + ' ' + r.notes + ' ' + r.category).toLowerCase().includes(q)); }
  if (f.cat) rows = rows.filter(r => r.category === f.cat);
  if (f.month) rows = rows.filter(r => monthOf(r) === Number(f.month));
  const total = rows.reduce((a, r) => a + (r.type === 'Expense' ? r.amount : 0), 0);

  view.innerHTML = `
  <div class="head"><div><h1>Transactions</h1><p class="sub">${rows.length} shown of ${state.rows.length} &middot; ${money(total)} of expense in view</p></div></div>
  <div class="filters">
    <label class="f"><span>Search</span><input id="q" value="${esc(f.q)}" placeholder="description, notes\u2026"></label>
    <label class="f"><span>Category</span><select id="fc"><option value="">All</option>${CAT_NAMES.map(c => `<option${c === f.cat ? ' selected' : ''}>${esc(c)}</option>`).join('')}</select></label>
    <label class="f"><span>Month</span><select id="fm"><option value="">All</option>${MONTHS.map((m, i) => `<option value="${i + 1}"${String(i + 1) === f.month ? ' selected' : ''}>${m}</option>`).join('')}</select></label>
    <button class="btn ghost" id="clearf">Reset</button>
  </div>
  ${rows.length ? `<div class="tablewrap"><table><thead><tr>
    <th class="gutter">#</th><th>Date</th><th>Type</th><th>Category</th><th>Description</th>
    <th class="n">Amount</th><th>Payment</th><th></th></tr></thead><tbody>
    ${rows.map((r, i) => `<tr>
      <td class="gutter">${i + 1}</td>
      <td class="num">${esc(r.date)}</td>
      <td><span class="tag">${esc(r.type)}</span></td>
      <td>${esc(r.category)}${r.subcategory ? `<br><span class="muted" style="font-size:11px">${esc(r.subcategory)}</span>` : ''}</td>
      <td>${esc(r.description) || '<span class="muted">\u2014</span>'}</td>
      <td class="n num">${money(r.amount)}</td>
      <td>${esc(r.payment) || '<span class="muted">\u2014</span>'}</td>
      <td style="white-space:nowrap"><button class="rowbtn edit" data-edit="${r.id}" title="Edit">&#9998;</button><button class="rowbtn" data-del="${r.id}" title="Delete">&#10005;</button></td>
    </tr>`).join('')}
  </tbody></table></div>` : '<div class="empty">Nothing matches those filters.</div>'}`;

  $('#q').oninput = e => { f.q = e.target.value; renderTransactions(); $('#q').focus(); };
  $('#fc').onchange = e => { f.cat = e.target.value; renderTransactions(); };
  $('#fm').onchange = e => { f.month = e.target.value; renderTransactions(); };
  $('#clearf').onclick = () => { state.filter = { q: '', cat: '', month: '' }; renderTransactions(); };

  view.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => {
    state.editing = state.rows.find(r => r.id === Number(b.dataset.edit));
    go('add');
  });
  view.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    const r = state.rows.find(x => x.id === Number(b.dataset.del));
    if (!confirm(`Delete this entry?\n\n${r.date} \u2014 ${r.category} \u2014 ${money(r.amount)}\n\nThis cannot be undone.`)) return;
    await state.store.remove(r.id); await refresh(); renderTransactions(); notice('Entry deleted.', 'ok');
  });
}

/* ==================================================================== BUDGET */
function renderBudget() {
  view.innerHTML = `
  <div class="head"><div><h1>Budget</h1><p class="sub">Monthly ceiling per category. Blank or zero means "not budgeted" and is excluded from Budget&nbsp;Used.</p></div>
  <div class="spacer"></div><div class="actions"><button class="btn" id="save">Save budget</button></div></div>
  <div class="tablewrap"><table><thead><tr><th>Category</th><th>Type</th>
    ${MONTHS.map(m => `<th class="n">${m}</th>`).join('')}<th class="n">Total</th><th></th></tr></thead><tbody>
    ${CAT_NAMES.map(c => `<tr data-cat="${esc(c)}">
      <td>${esc(c)}</td><td><span class="tag">${CAT_TYPE[c]}</span></td>
      ${MONTHS.map((_, i) => `<td class="n"><input class="num" style="width:78px;text-align:right;padding:3px 5px" type="number" step="1" min="0" data-m="${i + 1}" value="${Number(state.budget[c]?.[i + 1]) || 0}"></td>`).join('')}
      <td class="n num" data-total>0</td>
      <td><button class="btn ghost" style="padding:3px 8px;font-size:11px" data-fill>Fill \u2192</button></td>
    </tr>`).join('')}
  </tbody></table></div>
  <p class="note">"Fill \u2192" copies January across the other eleven months. The totals update as you type; nothing is stored until you hit Save.</p>`;

  const recalc = tr => {
    const t = [...tr.querySelectorAll('input')].reduce((a, i) => a + (Number(i.value) || 0), 0);
    tr.querySelector('[data-total]').textContent = money(t);
  };
  view.querySelectorAll('tbody tr').forEach(tr => {
    recalc(tr);
    tr.querySelectorAll('input').forEach(i => i.oninput = () => recalc(tr));
    tr.querySelector('[data-fill]').onclick = () => {
      const v = tr.querySelector('input[data-m="1"]').value;
      tr.querySelectorAll('input').forEach(i => { i.value = v; });
      recalc(tr);
    };
  });
  $('#save').onclick = async () => {
    const b = {};
    view.querySelectorAll('tbody tr').forEach(tr => {
      const c = tr.dataset.cat; b[c] = {};
      tr.querySelectorAll('input').forEach(i => { b[c][i.dataset.m] = Number(i.value) || 0; });
    });
    await state.store.setBudget(b); await refresh(); notice('Budget saved.', 'ok');
  };
}

/* ====================================================================== DATA */
function renderData() {
  const url = localStorage.getItem(BACKEND_KEY) || '';
  view.innerHTML = `
  <div class="head"><div><h1>Data</h1><p class="sub">Import, export, and where your data lives.</p></div></div>

  <div class="eyebrow">Export</div>
  <div class="panel stack">
    <div class="actions">
      <button class="btn" id="xlsx">Download .xlsx</button>
      <button class="btn ghost" id="json">Download .json backup</button>
      <span class="muted">${state.rows.length} transactions</span>
    </div>
    <p class="note">The .xlsx has three sheets &mdash; Transactions, Budget, and a Pivot cross-tab built from live SUMIFS formulas, so it keeps working when you open it in Google Sheets. Charts are not included in this export; the full charted workbook comes from the backend export or the original tracker file.</p>
  </div>

  <div class="eyebrow">Import</div>
  <div class="panel stack">
    <input type="file" id="file" accept=".xlsx,.xls,.csv">
    <div class="actions"><label><input type="checkbox" id="replace"> Replace everything (instead of appending)</label></div>
    <div id="imp" class="note"></div>
    <p class="note">Expects a flat table with at least <code>Date</code> and <code>Amount</code> columns &mdash; anything this app exports, or the tracker workbook's Transactions sheet. The original month-per-tab layout is <b>not</b> auto-detected; that data is already seeded.</p>
  </div>

  <div class="eyebrow">Storage backend</div>
  <div class="panel stack">
    <p class="note" style="margin:0">Currently: <b>${state.store.kind === 'remote' ? 'local FastAPI backend' : state.store.kind === 'memory' ? 'session memory (nothing is being saved)' : 'IndexedDB in this browser'}</b>.
    Leave the box empty to use browser storage. Point it at <code>http://127.0.0.1:8000</code> to use the SQLite backend in <code>backend/</code>.</p>
    <div class="actions">
      <input id="burl" style="min-width:280px" placeholder="http://127.0.0.1:8000" value="${esc(url)}">
      <button class="btn" id="bsave">Connect</button>
      <button class="btn ghost" id="bclear">Use browser storage</button>
    </div>
    <p class="note">Browser storage is per-browser and per-device &mdash; it does not follow you to your phone. The backend is shared across browsers on that machine but only reachable while it is running. Safari blocks HTTPS pages from calling <code>http://localhost</code>; use Chrome, Edge or Firefox for the backend.</p>
  </div>

  <div class="eyebrow">Danger zone</div>
  <div class="panel"><div class="actions">
    <button class="btn danger" id="wipe">Delete all transactions</button>
    <span class="muted">Export first &mdash; this cannot be undone.</span>
  </div></div>`;

  $('#xlsx').onclick = () => { try { exportWorkbook(state.rows, state.budget); notice('Workbook downloaded.', 'ok'); } catch (e) { notice(e.message, 'bad'); } };
  $('#json').onclick = () => {
    const blob = new Blob([JSON.stringify({ year: YEAR, transactions: state.rows, budget: state.budget }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `ledger-backup-${new Date().toISOString().slice(0, 10)}.json`; a.click();
    URL.revokeObjectURL(a.href);
  };

  $('#file').onchange = async e => {
    const file = e.target.files[0]; if (!file) return;
    const out = $('#imp'); out.textContent = 'Reading\u2026';
    try {
      const { rows, skipped, reasons, sheet } = await importFile(file);
      if (!rows.length) { out.innerHTML = `<b class="over">No usable rows found on "${esc(sheet)}".</b>`; return; }
      if (!confirm(`Import ${rows.length} rows from "${sheet}"?${skipped ? `\n\n${skipped} rows will be skipped (missing a valid date or amount).` : ''}`)) { out.textContent = 'Cancelled.'; return; }
      if ($('#replace').checked) await state.store.clear();
      await state.store.bulkAdd(rows);
      await refresh();
      out.innerHTML = `<b class="under">Imported ${rows.length} rows.</b>${skipped ? ` ${skipped} skipped${reasons.length ? ' (e.g. ' + esc(reasons.join(', ')) + ')' : ''}.` : ''}`;
      notice(`Imported ${rows.length} transactions.`, 'ok');
    } catch (err) { out.innerHTML = `<b class="over">${esc(err.message)}</b>`; }
  };

  $('#bsave').onclick = async () => {
    const v = $('#burl').value.trim();
    if (!v) return notice('Enter a URL, or press "Use browser storage".', 'bad');
    localStorage.setItem(BACKEND_KEY, v);
    state.store = await openStore(notice);
    if (state.store.kind !== 'remote') localStorage.removeItem(BACKEND_KEY);
    else notice('Connected to backend at ' + v, 'ok');
    await refresh(); renderData();
  };
  $('#bclear').onclick = async () => {
    localStorage.removeItem(BACKEND_KEY);
    state.store = await openStore(notice); await refresh(); renderData();
    notice('Using browser storage.', 'ok');
  };
  $('#wipe').onclick = async () => {
    if (!confirm(`Delete all ${state.rows.length} transactions and reset the budget?\n\nThis cannot be undone.`)) return;
    if (!confirm('Really sure? Export a backup first if you have not.')) return;
    await state.store.clear(); await refresh(); renderData(); notice('All data deleted.', 'ok');
  };
}

/* ==================================================================== router */
const VIEWS = { dashboard: renderDashboard, add: renderAdd, transactions: renderTransactions, budget: renderBudget, data: renderData };

function go(tab) {
  state.tab = tab;
  charts.destroyAll();
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  location.hash = tab;
  (VIEWS[tab] || renderDashboard)();
  window.scrollTo(0, 0);
}

document.querySelectorAll('#tabs button').forEach(b => b.onclick = () => { if (b.dataset.tab !== 'add') state.editing = null; go(b.dataset.tab); });

/** First run: load the 230 rows carried over from Expense.xlsx. */
async function seedIfEmpty() {
  if (!(await state.store.isEmpty())) return;
  try {
    const [rows, budget] = await Promise.all([
      fetch('./data/seed.json').then(r => r.json()),
      fetch('./data/seed-budget.json').then(r => r.json()).catch(() => null),
    ]);
    await state.store.bulkAdd(rows);
    if (budget) await state.store.setBudget(budget);
    notice(`Loaded ${rows.length} transactions carried over from your Expense.xlsx (Jan / Mar / Apr / Jul 2026). Clear them any time under Data.`);
  } catch {
    notice('No seed data loaded — add your first entry under "Add".');
  }
}

(async function main() {
  const ready = () => (typeof Chart !== 'undefined' && typeof XLSX !== 'undefined');
  if (!ready()) await new Promise(r => window.addEventListener('load', r, { once: true }));
  state.store = await openStore(notice);
  await seedIfEmpty();
  await refresh();
  go((location.hash || '#dashboard').slice(1) in VIEWS ? location.hash.slice(1) : 'dashboard');
})();
