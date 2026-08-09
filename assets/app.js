import {
  openStore, CAT_NAMES, EXPENSE_CATS, CAT_TYPE, TYPES, PAYMENTS, ACCOUNTS,
  MONTHS, YEAR, ENDPOINT_KEY, TOKEN_KEY, endpointSource, getEndpoint, emptyBudget,
} from './store.js';
import { aggregate, money, pct, monthOf, exportWorkbook, importFile } from './xlsxio.js';
import * as charts from './charts.js';

const $ = s => document.querySelector(s);
const view = $('#view');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = { store: null, rows: [], budget: emptyBudget(), month: 0, tab: 'dashboard', editing: null, filter: { q: '', cat: '', month: '' } };

let busy = false;
/** Wraps a write so the UI cannot fire two overlapping sheet writes. */
async function withBusy(label, fn) {
  if (busy) { notice('Another change is still saving — one at a time.', 'bad'); return false; }
  busy = true;
  document.body.style.cursor = 'progress';
  notice(label + '\u2026');
  try {
    await fn();
    return true;
  } catch (e) {
    notice(`${label} failed: ${e.message}`, 'bad');
    return false;
  } finally {
    busy = false;
    document.body.style.cursor = '';
  }
}

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
  const label = { sheets: '\u25cf google sheet', local: '\u25cf browser only', memory: '\u25cf session only' };
  c.textContent = label[state.store.kind] || '\u25cf ?';
  c.title = state.store.kind === 'sheets'
    ? `Reading and writing "${state.store.sheetName || 'your sheet'}" live`
    : 'Not connected to a Google Sheet — changes stay in this browser';
  c.className = 'conn' + (state.store.kind === 'sheets' ? ' remote' : '');
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
    const btn = ev.target.querySelector('button[type=submit]');
    btn.disabled = true;
    if (state.editing) {
      const done = await withBusy('Updating the sheet', async () => {
        await state.store.update(state.editing.id, { ...d, amount });
        state.editing = null;
        await refresh();
      });
      btn.disabled = false;
      if (done) { notice('Entry updated in the sheet.', 'ok'); go('transactions'); }
    } else {
      const done = await withBusy('Writing to the sheet', async () => {
        await state.store.add({ ...d, amount });
        await refresh();
      });
      btn.disabled = false;
      if (done) {
        notice(`Saved ${money(amount)} to ${state.store.kind === 'sheets' ? 'the sheet' : 'browser storage'}.`, 'ok');
        $('#hint').textContent = `${state.rows.length} entries total.`;
        ev.target.reset();
        ev.target.date.value = d.date;
        ev.target.querySelector('[name=amount]').focus();
      }
    }
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
    const where = state.store.kind === 'sheets' ? 'the Google Sheet' : 'browser storage';
    if (!confirm(`Delete this entry from ${where}?\n\n${r.date} \u2014 ${r.category} \u2014 ${money(r.amount)}\n\nThis removes the row and cannot be undone.`)) return;
    const done = await withBusy('Deleting from the sheet', async () => {
      await state.store.remove(r.id); await refresh();
    });
    renderTransactions();
    if (done) notice('Row deleted.', 'ok');
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
    const done = await withBusy('Saving the budget', async () => { await state.store.setBudget(b); await refresh(); });
    if (done) notice('Budget written to the sheet.', 'ok');
  };
}

/* ====================================================================== DATA */
function renderData() {
  const src = endpointSource();
  const ep = localStorage.getItem(ENDPOINT_KEY) || '';
  const tk = localStorage.getItem(TOKEN_KEY) || '';
  const live = state.store.kind === 'sheets';

  view.innerHTML = `
  <div class="head"><div><h1>Data</h1><p class="sub">Where your data lives, and how to get it in and out.</p></div></div>

  <div class="eyebrow">Google Sheet connection</div>
  <div class="panel stack">
    <p class="note" style="margin:0">Status: <b>${live
      ? 'connected \u2014 reading and writing "' + esc(state.store.sheetName || 'your sheet') + '" live'
      : state.store.kind === 'memory' ? 'session memory only, nothing is being saved'
      : 'not connected \u2014 changes stay in this browser'}</b>.
      Endpoint source: <b>${src === 'build' ? 'GitHub secret, injected at deploy' : src === 'runtime' ? 'entered here, stored in this browser only' : 'none'}</b>.</p>
    <div class="stack" style="max-width:620px">
      <label class="f"><span>Apps Script web app URL</span>
        <input id="ep" placeholder="https://script.google.com/macros/s/AKfy.../exec" value="${esc(ep)}"></label>
      <label class="f"><span>Shared token (must match SHARED_TOKEN in Code.gs)</span>
        <input id="tk" type="password" value="${esc(tk)}"></label>
    </div>
    <div class="actions">
      <button class="btn" id="connect">Connect &amp; test</button>
      <button class="btn ghost" id="disconnect">Disconnect</button>
      <button class="btn ghost" id="reload" ${live ? '' : 'disabled'}>Reload from sheet</button>
    </div>
    <p class="note"><b>Anything set here stays in this browser and is never published.</b> Values injected from
    GitHub secrets end up in <code>assets/config.js</code>, which is served to every visitor of the site \u2014
    a secret in Actions is not a secret in a static page. Use this box instead if the sheet holds anything private.</p>
  </div>

  <div class="eyebrow">Export</div>
  <div class="panel stack">
    <div class="actions">
      <button class="btn" id="xlsx">Download .xlsx</button>
      <button class="btn ghost" id="json">Download .json backup</button>
      <span class="muted">${state.rows.length} transactions</span>
    </div>
    <p class="note">Three sheets \u2014 Transactions, Budget, and a Pivot cross-tab of live SUMIFS formulas that keep
    working in Google Sheets. No charts: the browser cannot write chart objects into an .xlsx. The charts you see
    on the Dashboard are rendered live from the sheet data instead.</p>
  </div>

  <div class="eyebrow">Import</div>
  <div class="panel stack">
    <input type="file" id="file" accept=".xlsx,.xls,.csv">
    <div class="actions"><label><input type="checkbox" id="replace"> Replace everything first</label></div>
    <div id="imp" class="note"></div>
    <p class="note">Needs a flat table with at least <code>Date</code> and <code>Amount</code> columns. Rows are
    appended to the connected sheet in batches of 500.</p>
  </div>

  <div class="eyebrow">Danger zone</div>
  <div class="panel"><div class="actions">
    <button class="btn danger" id="wipe">Delete every row${live ? ' from the sheet' : ''}</button>
    <span class="muted">Export first \u2014 this cannot be undone.</span>
  </div></div>`;

  $('#connect').onclick = async () => {
    const url = $('#ep').value.trim(), token = $('#tk').value.trim();
    if (!/^https:\/\/script\.google\.com\/macros\/s\/.+\/exec$/.test(url)) {
      return notice('That does not look like an Apps Script /exec URL. Deploy the script as a Web app and copy the URL ending in /exec.', 'bad');
    }
    if (!token) return notice('Set a token. It has to match SHARED_TOKEN in Code.gs.', 'bad');
    localStorage.setItem(ENDPOINT_KEY, url);
    localStorage.setItem(TOKEN_KEY, token);
    await withBusy('Testing the connection', async () => {
      state.store = await openStore(() => {});
      if (state.store.kind !== 'sheets') throw new Error('could not reach the sheet with those settings');
      await refresh();
    });
    if (state.store.kind === 'sheets') notice(`Connected to "${state.store.sheetName}" \u2014 ${state.rows.length} rows loaded.`, 'ok');
    renderData();
  };

  $('#disconnect').onclick = async () => {
    localStorage.removeItem(ENDPOINT_KEY); localStorage.removeItem(TOKEN_KEY);
    state.store = await openStore(notice); await refresh(); renderData();
  };

  $('#reload').onclick = async () => {
    const done = await withBusy('Reloading from the sheet', async () => {
      state.store.cache = null; await refresh();
    });
    if (done) { renderData(); notice(`Reloaded ${state.rows.length} rows.`, 'ok'); }
  };

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
      const dest = state.store.kind === 'sheets' ? 'your Google Sheet' : 'browser storage';
      if (!confirm(`Import ${rows.length} rows from "${sheet}" into ${dest}?${skipped ? `\n\n${skipped} rows will be skipped (no valid date or amount).` : ''}`)) { out.textContent = 'Cancelled.'; return; }
      const done = await withBusy(`Writing ${rows.length} rows`, async () => {
        if ($('#replace').checked) await state.store.clear();
        await state.store.bulkAdd(rows);
        await refresh();
      });
      if (done) {
        out.innerHTML = `<b class="under">Imported ${rows.length} rows.</b>${skipped ? ` ${skipped} skipped${reasons.length ? ' (e.g. ' + esc(reasons.join(', ')) + ')' : ''}.` : ''}`;
        notice(`Imported ${rows.length} transactions.`, 'ok');
      }
    } catch (err) { out.innerHTML = `<b class="over">${esc(err.message)}</b>`; }
  };

  $('#wipe').onclick = async () => {
    const where = state.store.kind === 'sheets' ? 'your Google Sheet' : 'browser storage';
    if (!confirm(`Delete all ${state.rows.length} transactions from ${where}?\n\nThis cannot be undone.`)) return;
    if (!confirm('Really sure? Export a backup first if you have not.')) return;
    const done = await withBusy('Clearing the sheet', async () => { await state.store.clear(); await refresh(); });
    renderData();
    if (done) notice('All rows deleted.', 'ok');
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

/** First run only, and only into browser storage. Seeding a live Google Sheet
    behind your back would be the wrong default — do that from Data → Import. */
async function seedIfEmpty() {
  if (state.store.kind === 'sheets') return;
  if (!(await state.store.isEmpty())) return;
  try {
    const [rows, budget] = await Promise.all([
      fetch('./data/seed.json').then(r => r.json()),
      fetch('./data/seed-budget.json').then(r => r.json()).catch(() => null),
    ]);
    await state.store.bulkAdd(rows);
    if (budget) await state.store.setBudget(budget);
    notice(`Loaded ${rows.length} rows from your Expense.xlsx into browser storage. Connect your Google Sheet under Data to make it the source of truth.`);
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
