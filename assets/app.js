import {
  openStore, CAT_NAMES, EXPENSE_CATS, CAT_TYPE, TYPES, PAYMENTS, ACCOUNTS,
  MONTHS, YEAR, ENDPOINT_KEY, TOKEN_KEY, endpointSource, getEndpoint, emptyBudget,
  PEOPLE, UNASSIGNED, PERSON_KEY, CUSTOM_KEY,
  getClientId, getIdToken, setIdToken, NET_WORTH_ACCOUNTS,
} from './store.js';
import { aggregate, money, pct, monthOf, exportWorkbook, importFile,
         byPersonFilter, personBreakdown, personSeries } from './xlsxio.js';
import * as charts from './charts.js';

const $ = s => document.querySelector(s);
const view = $('#view');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = {
  store: null, rows: [], budget: emptyBudget(), month: 0, tab: 'dashboard', editing: null,
  person: localStorage.getItem(PERSON_KEY) || '',        // '' = whole family
  balances: [],
  filter: { q: '', cat: '', month: '', type: '' },
};

/* ------------------------------------------------------------ Google sign-in
   The ID token lives in sessionStorage, so closing the tab signs you out.
   It is only ever a claim - Apps Script decides whether it is honoured. */
/* A true full-viewport overlay rather than a sibling whose visibility has to
   stay manually in sync with #view. That sync WAS the bug: only the initial
   page-load path and a successful sign-in ever touched it, so any auth
   failure that happened mid-session (a token expiring after ~an hour, then
   the user clicking Reload, Add, or anything else that hits the sheet) left
   the previous page's content fully rendered underneath a banner that
   explained nothing and offered no way back in. Wrapping this in a fixed,
   opaque, high-z-index layer means showing it can never result in stale
   content bleeding through, no matter which code path triggered it. */
function showGate(message) {
  const gate = $('#gate');
  gate.hidden = false;
  gate.innerHTML = `
    <div class="gate-card">
      <div class="gate-mark">&#8214;</div>
      <h1 class="gate-title">Ledger</h1>
      <p class="gate-sub">${esc(message || 'Sign in with the Google account linked to this tracker.')}</p>
      <div id="gsi-button"></div>
      <p class="gate-note">Access is verified by Apps Script against an allow-list.
        Signing in here does not grant access on its own.</p>
    </div>`;

  const cid = getClientId();
  if (!cid) {
    $('#gsi-button').innerHTML =
      `<p class="gate-error">No Google client ID configured. Set GOOGLE_CLIENT_ID in
       assets/config.js (and OAUTH_CLIENT_ID in Code.gs), then reload.</p>`;
    return;
  }
  const start = () => {
    google.accounts.id.initialize({
      client_id: cid,
      callback: async res => {
        setIdToken(res.credential);
        gate.hidden = true;
        await boot();
      },
      // auto_select removed on purpose. Google's own docs: on ITP browsers
      // (Safari, Firefox) the automatic One Tap prompt opens a pop-up, and
      // Safari blocks pop-ups that were not triggered by a direct click. That
      // failure is silent from here - no error, no callback, nothing - so a
      // user on Safari could sign in with Google's own UI and still see
      // exactly this same gate afterward with no clue why. The rendered
      // button below is click-triggered, which satisfies the user-gesture
      // requirement on every browser, so it is the primary path now.
    });
    google.accounts.id.renderButton($('#gsi-button'),
      { theme: 'filled_black', size: 'large', text: 'signin_with', shape: 'rectangular' });

    // Still attempt the automatic prompt as a nice-to-have on browsers where
    // it works cleanly - but listen for the moment it is skipped or blocked,
    // and say so plainly instead of leaving the screen looking identical to
    // "please sign in" with no indication anything was even attempted.
    google.accounts.id.prompt(notification => {
      if (notification.isNotDisplayed?.() || notification.isSkippedMoment?.()) {
        const hint = $('.gate-sub');
        if (hint) hint.textContent =
          'The automatic prompt did not open in this browser (common in Safari) \u2014 use the button below instead.';
      }
    });
  };
  if (window.google?.accounts?.id) start();
  else window.addEventListener('load', () => window.google?.accounts?.id && start(), { once: true });
}

function signOut() {
  setIdToken('');
  try { google.accounts.id.disableAutoSelect(); } catch {}
  location.reload();
}

/* ------------------------------------------------------- user-defined lists
   Dropdown options come from three places merged together:
     1. the built-in constants in store.js
     2. every value already present in your transactions - so a category that
        arrived via import shows up without being registered anywhere
     3. anything you create with "+ New", kept in localStorage
   That means a new value survives even before any transaction uses it, and an
   imported value needs no registration at all. */
function loadCustom() {
  try { return JSON.parse(localStorage.getItem(CUSTOM_KEY)) || {}; } catch { return {}; }
}
function addCustom(kind, value) {
  const v = String(value || '').trim();
  if (!v) return '';
  const c = loadCustom();
  c[kind] = [...new Set([...(c[kind] || []), v])];
  localStorage.setItem(CUSTOM_KEY, JSON.stringify(c));
  return v;
}
function removeCustom(kind, value) {
  const c = loadCustom();
  c[kind] = (c[kind] || []).filter(x => x !== value);
  localStorage.setItem(CUSTOM_KEY, JSON.stringify(c));
}
const BUILTIN = { category: CAT_NAMES, payment: PAYMENTS, account: ACCOUNTS, subcategory: [] };

/** Merged, de-duplicated, sorted option list for a dropdown. */
function listFor(kind, forCategory) {
  const custom = loadCustom()[kind] || [];
  let fromData;
  if (kind === 'subcategory') {
    // Subcategories are scoped to their category - "Hydro" belongs under
    // Rent / Housing, not under Groceries.
    const pool = forCategory ? state.rows.filter(r => r.category === forCategory) : state.rows;
    fromData = pool.map(r => r.subcategory);
  } else {
    fromData = state.rows.map(r => r[kind]);
  }
  return [...new Set([...(BUILTIN[kind] || []), ...fromData.filter(Boolean), ...custom])]
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
}

/** <select> with every known option plus a "+ New" escape hatch. */
function selectWithNew(id, kind, selected, { blank = false, forCategory = null } = {}) {
  const opts = listFor(kind, forCategory);
  return `<select id="${id}" data-kind="${esc(kind)}">
    ${blank ? '<option value=""></option>' : ''}
    ${opts.map(o => `<option${o === selected ? ' selected' : ''}>${esc(o)}</option>`).join('')}
    ${selected && !opts.includes(selected) ? `<option selected>${esc(selected)}</option>` : ''}
    <option value="__new__">+ New\u2026</option>
  </select>`;
}

/** Turns "+ New" into an inline text field rather than a browser prompt. */
function wireNewOption(selectId, kind, onAdded) {
  const sel = $('#' + selectId);
  if (!sel) return;
  sel.dataset.prev = sel.value;
  sel.onchange = () => {
    if (sel.value !== '__new__') { sel.dataset.prev = sel.value; onAdded?.(sel.value); return; }
    const prev = sel.dataset.prev || '';
    const wrap = document.createElement('span');
    wrap.className = 'newopt';
    wrap.innerHTML = `<input class="newopt-input" placeholder="New ${esc(kind)}\u2026" autocomplete="off">
      <button type="button" class="newopt-ok">Add</button>
      <button type="button" class="newopt-cancel">\u2715</button>`;
    sel.style.display = 'none';
    sel.after(wrap);
    const input = wrap.querySelector('.newopt-input');
    input.focus();
    const close = value => {
      wrap.remove(); sel.style.display = '';
      if (value) {
        addCustom(kind, value);
        const o = document.createElement('option');
        o.textContent = value;
        sel.insertBefore(o, sel.querySelector('option[value="__new__"]'));
        sel.value = value;
      } else {
        sel.value = prev;
      }
      sel.dataset.prev = sel.value;
      onAdded?.(sel.value);
    };
    wrap.querySelector('.newopt-ok').onclick = () => close(input.value.trim());
    wrap.querySelector('.newopt-cancel').onclick = () => close(null);
    input.onkeydown = e => {
      if (e.key === 'Enter') { e.preventDefault(); close(input.value.trim()); }
      if (e.key === 'Escape') { e.preventDefault(); close(null); }
    };
  };
}

/** Rows for whoever is currently selected. Every page reads through this. */
const scoped = () => byPersonFilter(state.rows, state.person);
const personLabel = () => state.person || 'Family';

/** Segmented control in the header rail. Present on every tab, so the choice
    follows you between Dashboard, Transactions, Add and Budget. */
function renderPeopleSwitch() {
  const el = $('#people');
  if (!el) return;
  const present = new Set(state.rows.map(r => r.person || UNASSIGNED));
  const opts = ['', ...PEOPLE.filter(p => present.has(p))];
  if (present.has(UNASSIGNED)) opts.push(UNASSIGNED);
  el.innerHTML = opts.map(p => {
    const label = p === '' ? 'Family' : p === UNASSIGNED ? 'Unassigned' : p;
    return `<button class="person-btn${state.person === p ? ' on' : ''}" data-person="${esc(p)}">${esc(label)}</button>`;
  }).join('');
  el.querySelectorAll('.person-btn').forEach(b => b.onclick = () => {
    state.person = b.dataset.person;
    localStorage.setItem(PERSON_KEY, state.person);
    go(state.tab);
  });
}

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
    // A Google sign-in can expire mid-session (roughly hourly). Previously
    // every action here just showed a red banner and left the page sitting
    // in a half-authenticated state with no way forward. Route auth failures
    // to the same re-sign-in screen the app uses on first load, instead.
    if (e?.auth) { setIdToken(''); showGate(e.message); return false; }
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
  state.balances = (await state.store.getBalances?.()) || [];
  $('#foot-count').textContent = `${state.rows.length} transactions stored`;
  renderPeopleSwitch();
  const c = $('#conn');
  const label = { sheets: '\u25cf google sheet', local: '\u25cf browser only', memory: '\u25cf session only' };
  const who = state.store.user?.email ? ` \u00b7 ${state.store.user.email.split('@')[0]}` : '';
  c.innerHTML = (label[state.store.kind] || '\u25cf ?') + esc(who)
    + (getIdToken() ? ' <button class="signout-btn" id="signout">sign out</button>' : '');
  $('#signout')?.addEventListener('click', signOut);
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
  const a = aggregate(scoped(), state.budget, state.month);
  const label = state.month === 0 ? `Full year ${YEAR}` : `${MONTHS[state.month - 1]} ${YEAR}`;
  // Comparison is always computed across everyone, so it stays meaningful
  // even while the rest of the page is filtered to one person.
  const people = personBreakdown(state.rows, state.month);
  const pSeries = personSeries(state.rows);
  const showCompare = people.length > 1;

  view.innerHTML = `
  <div class="head">
    <div><h1>Dashboard</h1><p class="sub">${esc(personLabel())} &middot; ${esc(label)} &middot; ${a.count} transactions</p></div>
    <div class="spacer"></div>${monthSelect('m-sel', state.month)}
  </div>

  <div class="kpis">
    ${kpi('Income', money(a.income), a.income === 0 ? 'no income recorded' : '')}
    ${kpi('Expense', money(a.expense), `${a.count} entries`)}
    ${kpi('Net', money(a.net), a.net < 0 ? 'spending exceeds income' : '', a.net < 0 ? 'neg' : 'pos')}
    ${kpi('Savings rate', a.income > 0 ? pct(a.savingsRate) : '\u2014', a.income > 0 ? '' : 'needs income data')}
    ${kpi('Budget used', a.expenseBudget > 0 ? pct(a.budgetUsed) : '\u2014',
        a.expenseBudget > 0 ? (state.person ? `of ${money(a.expenseBudget)} household` : `of ${money(a.expenseBudget)}`) : 'no budget set',
        a.budgetUsed > 1 ? 'neg' : '')}
    ${kpi('Avg / day', money(a.avgDaily), state.month === 0 ? 'over 365 days' : `over ${new Date(YEAR, state.month, 0).getDate()} days`)}
  </div>

  ${a.overBudget.length ? `<div class="eyebrow">Over budget &mdash; ${label}</div>
  <div class="tablewrap"><table><thead><tr><th>Category</th><th class="n">Actual</th><th class="n">Budget</th><th class="n">Over by</th><th class="n">Used</th></tr></thead><tbody>
    ${a.overBudget.map(r => `<tr><td>${esc(r.category)}</td><td class="n num">${money(r.actual)}</td><td class="n num">${money(r.budget)}</td><td class="n num over">${money(-r.variance)}</td><td class="n num over">${pct(r.used)}</td></tr>`).join('')}
  </tbody></table></div>` : ''}

  ${showCompare ? `
  <div class="eyebrow">Who spent what &mdash; ${esc(label)}</div>
  <div class="person-cards">
    ${people.map(b => `
      <div class="person-card${state.person === (b.person === UNASSIGNED ? UNASSIGNED : b.person) ? ' on' : ''}" data-jump="${esc(b.person)}">
        <div class="person-card-head">
          <span class="person-swatch" data-p="${esc(b.person)}"></span>
          <span class="person-card-name">${esc(b.person)}</span>
        </div>
        <div class="person-card-val num">${money(b.expense)}</div>
        <div class="person-card-bar"><div class="person-card-fill" data-p="${esc(b.person)}" style="width:${(b.share*100).toFixed(1)}%"></div></div>
        <div class="person-card-meta">
          <span class="muted">${pct(b.share)} of spend</span>
          ${b.income > 0 ? `<span class="tx-income num">+${money(b.income)}</span>` : `<span class="muted num">${b.count} entries</span>`}
        </div>
      </div>`).join('')}
  </div>` : ''}

  <div class="eyebrow">Charts</div>
  <div class="grid2">
    ${showCompare ? `
    <div class="panel"><h3>Spend split by person &mdash; ${esc(label)}</h3><div class="chartbox"><canvas id="c-person-split"></canvas></div></div>
    <div class="panel"><h3>Monthly spend by person</h3><div class="chartbox"><canvas id="c-person-month"></canvas></div></div>` : ''}
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
  if (showCompare) {
    charts.personSplit(people);
    charts.personByMonth(pSeries, MONTHS);
  }
  view.querySelectorAll('[data-jump]').forEach(el => el.onclick = () => {
    const p = el.dataset.jump;
    state.person = state.person === p ? '' : p;
    localStorage.setItem(PERSON_KEY, state.person);
    go('dashboard');
  });
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
  const today = new Date().toISOString().slice(0, 10);
  const selType = e?.type || 'Expense';
  const selCat  = e?.category || 'Groceries';
  // Default to whoever is selected in the header, so a run of Surya's receipts
  // does not need the field touched on every entry.
  const selPerson = e?.person || (PEOPLE.includes(state.person) ? state.person : 'Ramesh');

  const curMonth = new Date().getMonth() + 1;
  const ctxActual = scoped()
    // Expense only - a transfer into this category is not spending against budget
    .filter(r => r.type === 'Expense' && r.category === selCat && monthOf(r) === curMonth
                 && Number(String(r.date).slice(0, 4)) === YEAR)
    .reduce((a, r) => a + r.amount, 0);
  const ctxBudget = Number(state.budget[selCat]?.[curMonth]) || 0;
  const ctxOver = ctxBudget > 0 && ctxActual > ctxBudget;
  const recent = scoped().filter(r => r.category === selCat).slice(0, 5);
  const allSubs = [...new Set(state.rows.map(r => r.subcategory).filter(Boolean))];

  const opt = (list, sel, blank) =>
    (blank ? `<option value=""></option>` : '') +
    list.map(o => `<option${o === sel ? ' selected' : ''}>${esc(o)}</option>`).join('');

  const dayName = d => { try { return new Date(d + 'T12:00:00').toLocaleDateString('en-CA', { weekday: 'long' }); } catch { return ''; } };

  view.innerHTML = `
  <div class="head">
    <div>
      <h1>${e ? 'Edit entry' : 'Add entry'}</h1>
      <p class="sub">${e ? `Editing #${e.id} \u2014 ${esc(e.category)} ${money(e.amount)}` : 'Amount is always positive \u2014 Type carries the sign.'}</p>
    </div>
    ${e ? `<div class="spacer"></div><button class="btn ghost" id="cancel">\u2190 Back</button>` : ''}
  </div>

  <div class="add-layout">
    <div class="add-main">

      <div class="add-type-row">
        ${TYPES.map(t => `<button type="button" class="add-type-btn${t === selType ? ' on' : ''}" data-type="${t}">${t}</button>`).join('')}
      </div>

      <div class="add-person-row">
        <span class="add-label" style="margin-right:4px">Whose</span>
        ${PEOPLE.map(pp => `<button type="button" class="add-person-btn${pp === selPerson ? ' on' : ''}" data-person="${pp}"><span class="person-swatch" data-p="${pp}"></span>${pp}</button>`).join('')}
      </div>

      <form id="f" autocomplete="off">
        <input type="hidden" name="type" id="type-hidden" value="${selType}">
        <input type="hidden" name="person" id="person-hidden" value="${esc(selPerson)}">

        <div class="add-amount-wrap">
          <span class="add-currency">$</span>
          <input class="add-amount num" type="number" name="amount" step="0.01" min="0.01"
            value="${e?.amount ?? ''}" placeholder="0.00" inputmode="decimal"
            autocomplete="off" id="amount-input">
          <span class="add-currency-code">CAD</span>
        </div>
        <div class="err" id="err"></div>

        <div class="add-primary">
          <div class="add-field">
            <label for="f-date" class="add-label">Date</label>
            <input id="f-date" type="date" name="date" value="${esc(e?.date || today)}" required>
            <span class="add-field-hint muted" id="day-name">${dayName(e?.date || today)}</span>
          </div>
          <div class="add-field">
            <label for="f-cat" class="add-label">Category</label>
            ${selectWithNew('f-cat', 'category', selCat)}
            <span class="add-field-hint ${ctxOver ? 'over' : 'muted'}" id="cat-hint">
              ${ctxBudget > 0
                ? `${MONTHS[curMonth-1]}: ${money(ctxActual)} of ${money(ctxBudget)}${ctxOver ? ' \u2014 over' : ''}`
                : ctxActual > 0 ? `${MONTHS[curMonth-1]}: ${money(ctxActual)} spent` : 'no budget set'}
            </span>
          </div>
        </div>

        <div class="add-field add-field-full">
          <label for="f-desc" class="add-label">Description</label>
          <input id="f-desc" name="description" value="${esc(e?.description || '')}"
            placeholder="What was it?" list="subs-dl">
          <datalist id="subs-dl">
            ${[...new Set(state.rows.filter(r=>r.category===selCat).map(r=>r.description).filter(Boolean))].map(s=>`<option>${esc(s)}</option>`).join('')}
          </datalist>
        </div>

        <details class="add-details" ${e && (e.subcategory || e.payment || e.account || e.notes) ? 'open' : ''}>
          <summary class="add-details-toggle">More details <span class="muted">(subcategory, payment, account, notes)</span></summary>
          <div class="add-secondary">
            <div class="add-field">
              <label for="f-sub" class="add-label">Subcategory</label>
              ${selectWithNew('f-sub', 'subcategory', e?.subcategory || '', { blank: true, forCategory: selCat })}
              <span class="add-field-hint muted" id="sub-hint">options for ${esc(selCat)}</span>
            </div>
            <div class="add-field">
              <label for="f-pay" class="add-label">Payment method</label>
              ${selectWithNew('f-pay', 'payment', e?.payment || '', { blank: true })}
            </div>
            <div class="add-field">
              <label for="f-acc" class="add-label">Account</label>
              ${selectWithNew('f-acc', 'account', e?.account || '', { blank: true })}
            </div>
            <div class="add-field">
              <label for="f-rec" class="add-label">Recurring?</label>
              <select id="f-rec" name="recurring">${opt(['No', 'Yes'], e?.recurring || 'No')}</select>
            </div>
            <div class="add-field add-field-wide">
              <label for="f-notes" class="add-label">Notes</label>
              <input id="f-notes" name="notes" value="${esc(e?.notes || '')}" placeholder="Anything else\u2026">
            </div>
          </div>
        </details>

        <div class="add-submit-row">
          <button class="btn add-submit" type="submit" id="sub-btn">${e ? 'Save changes' : 'Add entry'}</button>
          ${e ? `<button class="btn ghost" type="button" id="cancel2">Cancel</button>`
              : `<button class="btn ghost" type="reset">Clear</button>`}
          <span class="add-hint num muted" id="hint"></span>
        </div>
      </form>
    </div>

    <div class="add-context" id="ctx-panel">
      <div class="add-ctx-section">
        <div class="add-ctx-head" id="ctx-cat-name">${esc(selCat)}</div>
        <div class="add-ctx-stats" id="ctx-stats">
          ${ctxBudget > 0 ? `
            <div class="add-ctx-bar-wrap">
              <div class="add-ctx-bar-track">
                <div class="add-ctx-bar-fill ${ctxOver ? 'over' : ''}"
                  style="width:${Math.min(ctxActual/ctxBudget*100,100).toFixed(1)}%"></div>
              </div>
            </div>
            <div class="add-ctx-row"><span class="muted">Spent ${MONTHS[curMonth-1]}</span><span class="num ${ctxOver ? 'over' : ''}">${money(ctxActual)}</span></div>
            <div class="add-ctx-row"><span class="muted">Budget</span><span class="num">${money(ctxBudget)}</span></div>
            <div class="add-ctx-row"><span class="muted">Remaining</span><span class="num ${ctxOver ? 'over' : 'tx-income'}">${money(ctxBudget - ctxActual)}</span></div>`
          : `<p class="muted" style="font-size:12px;margin:0">No budget set. <a href="#budget" id="go-budget" style="color:var(--ink)">Set one \u2192</a></p>`}
        </div>
      </div>
      ${recent.length ? `
      <div class="add-ctx-section">
        <div class="add-ctx-subhead">Recent in this category</div>
        ${recent.map(r => `
          <div class="add-recent-row">
            <div class="add-recent-body">
              <span class="add-recent-desc">${esc(r.description || r.subcategory || '\u2014')}</span>
              <span class="add-recent-date num muted">${esc(r.date)}</span>
            </div>
            <span class="add-recent-amt num">${money(r.amount)}</span>
          </div>`).join('')}
      </div>` : ''}
    </div>
  </div>`;

  // selectWithNew() builds plain selects; FormData needs name attributes.
  [['f-cat','category'],['f-sub','subcategory'],['f-pay','payment'],['f-acc','account']]
    .forEach(([id,name]) => { const el = $('#'+id); if (el) el.name = name; });

  wireNewOption('f-sub', 'subcategory');
  wireNewOption('f-pay', 'payment');
  wireNewOption('f-acc', 'account');

  view.querySelectorAll('.add-type-btn').forEach(btn => {
    btn.onclick = () => {
      view.querySelectorAll('.add-type-btn').forEach(b => b.classList.remove('on'));
      btn.classList.add('on');
      $('#type-hidden').value = btn.dataset.type;
    };
  });

  view.querySelectorAll('.add-person-btn').forEach(btn => {
    btn.onclick = () => {
      view.querySelectorAll('.add-person-btn').forEach(b => b.classList.remove('on'));
      btn.classList.add('on');
      $('#person-hidden').value = btn.dataset.person;
    };
  });

  $('#f-date').oninput = ev => { $('#day-name').textContent = dayName(ev.target.value); };

  wireNewOption('f-cat', 'category', () => refreshSubOptions());

  /* Subcategories are scoped to the chosen category, so switching category has
     to rebuild that list. Keeps the current value if it still applies. */
  function refreshSubOptions() {
    const cat = $('#f-cat').value;
    const sub = $('#f-sub');
    if (!sub || cat === '__new__') return;
    const keep = sub.value;
    const opts = listFor('subcategory', cat);
    sub.innerHTML = '<option value=""></option>'
      + opts.map(o => `<option${o === keep ? ' selected' : ''}>${esc(o)}</option>`).join('')
      + (keep && !opts.includes(keep) ? `<option selected>${esc(keep)}</option>` : '')
      + '<option value="__new__">+ New\u2026</option>';
    sub.name = 'subcategory';
    sub.dataset.prev = sub.value;
    wireNewOption('f-sub', 'subcategory');
    const hint = $('#sub-hint');
    if (hint) hint.textContent = opts.length ? `${opts.length} option${opts.length>1?'s':''} for ${cat}` : `no subcategories yet for ${cat}`;
  }

  $('#f-cat').addEventListener('change', () => {
    const cat = $('#f-cat').value;
    if (cat === '__new__') return;
    const act = scoped().filter(r => r.type === 'Expense' && r.category === cat && monthOf(r) === curMonth
                                     && Number(String(r.date).slice(0, 4)) === YEAR).reduce((a,r)=>a+r.amount,0);
    const bud = Number(state.budget[cat]?.[curMonth]) || 0;
    const over = bud > 0 && act > bud;
    const hint = $('#cat-hint');
    if (hint) {
      hint.textContent = bud > 0 ? `${MONTHS[curMonth-1]}: ${money(act)} of ${money(bud)}${over ? ' — over' : ''}` : act > 0 ? `${MONTHS[curMonth-1]}: ${money(act)} spent` : 'no budget set';
      hint.className = `add-field-hint ${over ? 'over' : 'muted'}`;
    }
    refreshSubOptions();
    const head = $('#ctx-cat-name'); if (head) head.textContent = cat;
    const stats = $('#ctx-stats');
    if (stats) {
      if (bud > 0) {
        stats.innerHTML = `<div class="add-ctx-bar-wrap"><div class="add-ctx-bar-track"><div class="add-ctx-bar-fill ${over?'over':''}" style="width:${Math.min(act/bud*100,100).toFixed(1)}%"></div></div></div>
          <div class="add-ctx-row"><span class="muted">Spent ${MONTHS[curMonth-1]}</span><span class="num ${over?'over':''}">${money(act)}</span></div>
          <div class="add-ctx-row"><span class="muted">Budget</span><span class="num">${money(bud)}</span></div>
          <div class="add-ctx-row"><span class="muted">Remaining</span><span class="num ${over?'over':'tx-income'}">${money(bud-act)}</span></div>`;
      } else {
        stats.innerHTML = `<p class="muted" style="font-size:12px;margin:0">No budget set. <a href="#budget" id="go-budget" style="color:var(--ink)">Set one \u2192</a></p>`;
        $('#go-budget')?.addEventListener('click', ev => { ev.preventDefault(); go('budget'); });
      }
    }
  });

  refreshSubOptions();

  $('#cancel')?.addEventListener('click',  () => { state.editing = null; go('transactions'); });
  $('#cancel2')?.addEventListener('click', () => { state.editing = null; go('transactions'); });
  $('#go-budget')?.addEventListener('click', ev => { ev.preventDefault(); go('budget'); });

  setTimeout(() => { $('#amount-input')?.focus(); }, 50);

  $('#f').onsubmit = async ev => {
    ev.preventDefault();
    const d = Object.fromEntries(new FormData(ev.target));
    const amount = Number(d.amount);
    const errEl = $('#err');
    errEl.textContent = '';

    if (!d.date)       { errEl.textContent = 'Pick a date.'; return; }
    if (!(amount > 0)) { errEl.textContent = 'Amount must be greater than zero.'; $('#amount-input').focus(); return; }

    if (Number(d.date.slice(0,4)) !== YEAR)
      errEl.textContent = `${d.date} is outside ${YEAR} \u2014 it will save but won\u2019t appear on the dashboard.`;

    const btn = $('#sub-btn');
    btn.disabled = true;

    if (state.editing) {
      const done = await withBusy('Updating', async () => {
        await state.store.update(state.editing.id, { ...d, amount });
        state.editing = null;
        await refresh();
      });
      btn.disabled = false;
      if (done) { notice('Entry updated.', 'ok'); go('transactions'); }
    } else {
      const done = await withBusy('Saving', async () => {
        await state.store.add({ ...d, amount });
        await refresh();
      });
      btn.disabled = false;
      if (done) {
        notice(`${money(amount)} saved.`, 'ok');
        $('#hint').textContent = `${state.rows.length} total`;
        ev.target.reset();
        $('#type-hidden').value = d.type;
        $('#person-hidden').value = d.person;
        view.querySelectorAll('.add-type-btn').forEach(b => b.classList.toggle('on', b.dataset.type === d.type));
        view.querySelectorAll('.add-person-btn').forEach(b => b.classList.toggle('on', b.dataset.person === d.person));
        $('#f-date').value = d.date;
        $('#f-cat').value  = d.category;
        setTimeout(() => { $('#amount-input').focus(); }, 50);
      }
    }
  };
}

/* ============================================================== TRANSACTIONS */
// Persists across re-renders (filtering, editing, deleting) so collapsing a
// month doesn't spring back open every time the list redraws.
const txCollapsed = new Set();

function renderTransactions() {
  const f = state.filter;
  let rows = scoped();
  if (f.q) {
    const q = f.q.toLowerCase();
    rows = rows.filter(r => (r.description + ' ' + r.subcategory + ' ' + r.notes + ' ' + r.category).toLowerCase().includes(q));
  }
  if (f.cat) rows = rows.filter(r => r.category === f.cat);
  if (f.type) rows = rows.filter(r => r.type === f.type);
  if (f.month) rows = rows.filter(r => monthOf(r) === Number(f.month));

  const income  = rows.filter(r => r.type === 'Income').reduce((a, r) => a + r.amount, 0);
  const expense = rows.filter(r => r.type === 'Expense').reduce((a, r) => a + r.amount, 0);
  const net = income - expense;
  const hasFilters = f.q || f.cat || f.month || f.type;

  // Group rows by YYYY-MM for section headers
  const groups = [];
  const seen = new Map();
  for (const r of rows) {
    const key = String(r.date).slice(0, 7); // YYYY-MM
    if (!seen.has(key)) { seen.set(key, groups.length); groups.push({ key, label: '', rows: [] }); }
    groups[seen.get(key)].rows.push(r);
  }
  // Label each group e.g. "Jul 2026"
  for (const g of groups) {
    const [y, m] = g.key.split('-');
    g.label = (MONTHS[Number(m) - 1] || m) + ' ' + y;
    g.income  = g.rows.filter(r => r.type === 'Income').reduce((a, r) => a + r.amount, 0);
    g.expense = g.rows.filter(r => r.type === 'Expense').reduce((a, r) => a + r.amount, 0);
  }

  // First time we see these groups (e.g. first load, or a filter just narrowed
  // the list to new months): collapse everything except the newest month, so
  // opening the page doesn't dump the whole year down the screen at once.
  // A month the user has explicitly toggled keeps whatever state they set.
  groups.forEach((g, i) => {
    if (!txCollapsed.has('__seen:' + g.key)) {
      txCollapsed.add('__seen:' + g.key);
      if (i > 0) txCollapsed.add(g.key);
    }
  });

  const typeIcon = t => t === 'Income' ? '↑' : t === 'Transfer' ? '⇄' : '↓';
  const typeClass = t => t === 'Income' ? 'tx-income' : t === 'Transfer' ? 'tx-transfer' : '';

  const txRow = r => `
    <div class="tx-row ${typeClass(r.type)}" data-id="${r.id}">
      <div class="tx-date num">${String(r.date).slice(8, 10)}</div>
      <div class="tx-type-icon ${typeClass(r.type)}">${typeIcon(r.type)}</div>
      <div class="tx-body">
        <div class="tx-desc">${esc(r.description) || `<span class="muted">${esc(r.category)}</span>`}
          ${r.recurring === 'Yes' ? '<span class="tx-badge">Recurring</span>' : ''}
        </div>
        <div class="tx-meta">
          ${!state.person ? `<span class="person-chip" data-p="${esc(r.person || UNASSIGNED)}">${esc(r.person || UNASSIGNED)}</span>` : ''}
          <span class="tx-cat">${esc(r.category)}${r.subcategory ? ' · ' + esc(r.subcategory) : ''}</span>
          ${r.payment ? `<span class="tx-sep">·</span><span class="tx-pay">${esc(r.payment)}</span>` : ''}
        </div>
      </div>
      <div class="tx-amount num ${typeClass(r.type)}">${r.type === 'Income' ? '+' : ''}${money(r.amount)}</div>
      <div class="tx-actions">
        <button class="txbtn edit" data-edit="${r.id}" title="Edit">✎</button>
        <button class="txbtn del" data-del="${r.id}" title="Delete">✕</button>
      </div>
    </div>`;

  const activePills = [
    f.q    ? `<span class="fpill" data-clear="q">${esc(f.q)} ✕</span>` : '',
    f.cat  ? `<span class="fpill" data-clear="cat">${esc(f.cat)} ✕</span>` : '',
    f.type ? `<span class="fpill" data-clear="type">${esc(f.type)} ✕</span>` : '',
    f.month ? `<span class="fpill" data-clear="month">${MONTHS[Number(f.month)-1]} ✕</span>` : '',
  ].filter(Boolean).join('');

  view.innerHTML = `
  <div class="head">
    <div><h1>Transactions</h1>
      <p class="sub">${esc(personLabel())} &middot; ${rows.length} of ${scoped().length} entries${hasFilters ? ' · filtered' : ''}</p>
    </div>
    <div class="spacer"></div>
    <button class="btn" id="tx-add">+ Add entry</button>
  </div>

  <div class="tx-summary">
    <div class="tx-sum-item ${expense > 0 ? '' : 'muted-block'}">
      <span class="tx-sum-label">Expense</span>
      <span class="tx-sum-val num">${money(expense)}</span>
    </div>
    <div class="tx-sum-item ${income > 0 ? '' : 'muted-block'}">
      <span class="tx-sum-label">Income</span>
      <span class="tx-sum-val num tx-income">${money(income)}</span>
    </div>
    <div class="tx-sum-item ${net !== 0 ? '' : 'muted-block'}">
      <span class="tx-sum-label">Net</span>
      <span class="tx-sum-val num ${net < 0 ? 'tx-over' : 'tx-income'}">${net >= 0 ? '+' : ''}${money(net)}</span>
    </div>
  </div>

  <div class="tx-filterbar">
    <div class="tx-search-wrap">
      <span class="tx-search-icon">⌕</span>
      <input id="q" class="tx-search" value="${esc(f.q)}" placeholder="Search description, category, notes…" autocomplete="off">
      ${f.q ? `<button class="tx-search-clear" id="qclear">✕</button>` : ''}
    </div>
    <div class="tx-filter-selects">
      <select id="fm">
        <option value="">All months</option>
        ${MONTHS.map((m, i) => `<option value="${i+1}"${String(i+1) === f.month ? ' selected' : ''}>${m}</option>`).join('')}
      </select>
      <select id="fc">
        <option value="">All categories</option>
        ${listFor('category').map(c => `<option${c === f.cat ? ' selected' : ''}>${esc(c)}</option>`).join('')}
      </select>
      <select id="ft">
        <option value="">All types</option>
        ${TYPES.map(t => `<option${t === f.type ? ' selected' : ''}>${esc(t)}</option>`).join('')}
      </select>
      ${hasFilters ? `<button class="btn ghost tx-reset" id="clearf">Reset</button>` : ''}
    </div>
  </div>

  ${activePills ? `<div class="tx-pills">${activePills}</div>` : ''}

  ${groups.length > 1 ? `<div class="tx-collapse-all">
    <button class="tx-collapse-btn" id="tx-expand-all">Expand all</button>
    <span class="tx-sep">·</span>
    <button class="tx-collapse-btn" id="tx-collapse-all">Collapse all</button>
  </div>` : ''}

  <div class="tx-list">
    ${rows.length === 0
      ? `<div class="empty">${hasFilters ? 'No entries match those filters.' : 'No transactions yet — add one with the button above.'}</div>`
      : groups.map(g => {
          const closed = txCollapsed.has(g.key);
          return `
          <div class="tx-group${closed ? ' closed' : ''}" data-month="${g.key}">
            <button class="tx-group-header" data-toggle="${g.key}" aria-expanded="${!closed}">
              <span class="tx-group-chevron">▾</span>
              <span class="tx-group-label">${esc(g.label)}</span>
              <span class="tx-group-count muted">${g.rows.length}</span>
              <span class="tx-group-stats num">
                ${g.income > 0 ? `<span class="tx-income">+${money(g.income)}</span>` : ''}
                ${g.income > 0 && g.expense > 0 ? '<span class="tx-sep">·</span>' : ''}
                ${g.expense > 0 ? `<span>${money(g.expense)}</span>` : ''}
              </span>
            </button>
            <div class="tx-group-body">${g.rows.map(txRow).join('')}</div>
          </div>`;
        }).join('')
    }
  </div>`;

  // — month group collapse/expand
  view.querySelectorAll('[data-toggle]').forEach(btn => btn.onclick = () => {
    const key = btn.dataset.toggle;
    const group = btn.closest('.tx-group');
    const nowClosed = !group.classList.contains('closed');
    group.classList.toggle('closed', nowClosed);
    btn.setAttribute('aria-expanded', String(!nowClosed));
    if (nowClosed) txCollapsed.add(key); else txCollapsed.delete(key);
  });
  $('#tx-expand-all')?.addEventListener('click', () => {
    groups.forEach(g => txCollapsed.delete(g.key));
    view.querySelectorAll('.tx-group').forEach(el => el.classList.remove('closed'));
    view.querySelectorAll('[data-toggle]').forEach(b => b.setAttribute('aria-expanded', 'true'));
  });
  $('#tx-collapse-all')?.addEventListener('click', () => {
    groups.forEach(g => txCollapsed.add(g.key));
    view.querySelectorAll('.tx-group').forEach(el => el.classList.add('closed'));
    view.querySelectorAll('[data-toggle]').forEach(b => b.setAttribute('aria-expanded', 'false'));
  });

  // — filter events
  const refilter = () => renderTransactions();

  /* Typing must NOT re-render the search box. renderTransactions() replaces
     view.innerHTML, which destroys the <input> and rebuilds it with the caret
     at position 0 - so the next character lands at the front and the text comes
     out backwards ("coffee" -> "eeffoc"). Instead, remember the caret, re-render,
     then restore focus and caret onto the fresh input. Debounced so a 687-row
     list isn't rebuilt on every keystroke. */
  let qTimer = null;
  $('#q').oninput = e => {
    f.q = e.target.value;
    const caret = e.target.selectionStart;
    clearTimeout(qTimer);
    qTimer = setTimeout(() => {
      refilter();
      const el = $('#q');
      if (el) { el.focus(); el.setSelectionRange(caret, caret); }
    }, 150);
  };
  $('#qclear')?.addEventListener('click', () => { f.q = ''; refilter(); $('#q')?.focus(); });
  $('#fm').onchange = e => { f.month = e.target.value; refilter(); };
  $('#fc').onchange = e => { f.cat = e.target.value; refilter(); };
  $('#ft').onchange = e => { f.type = e.target.value; refilter(); };
  $('#clearf')?.addEventListener('click', () => { state.filter = { q: '', cat: '', month: '', type: '' }; refilter(); });

  // — active filter pills
  view.querySelectorAll('[data-clear]').forEach(el => el.onclick = () => {
    state.filter[el.dataset.clear] = '';
    refilter();
  });

  // — add button shortcut
  $('#tx-add').onclick = () => { state.editing = null; go('add'); };

  // — edit
  view.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => {
    state.editing = state.rows.find(r => r.id === Number(b.dataset.edit));
    go('add');
  });

  // — delete with inline confirm replacing browser dialog
  view.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    const r = state.rows.find(x => x.id === Number(b.dataset.del));
    if (!r) return;
    const row = b.closest('.tx-row');
    // swap the row for an inline confirmation
    const orig = row.innerHTML;
    row.innerHTML = `
      <div class="tx-confirm">
        <span>Delete <b>${esc(r.category)}</b> ${money(r.amount)} on ${esc(r.date)}?</span>
        <div style="display:flex;gap:8px;flex-shrink:0">
          <button class="btn danger" style="padding:4px 12px;font-size:12px" id="cd-yes">Delete</button>
          <button class="btn ghost"  style="padding:4px 12px;font-size:12px" id="cd-no">Cancel</button>
        </div>
      </div>`;
    row.querySelector('#cd-no').onclick = () => { row.innerHTML = orig; wireActions(); };
    row.querySelector('#cd-yes').onclick = async () => {
      row.style.opacity = '.4';
      const done = await withBusy('Deleting', async () => {
        await state.store.remove(r.id); await refresh();
      });
      if (done) { renderTransactions(); notice('Entry deleted.', 'ok'); }
      else row.style.opacity = '';
    };
  });

  function wireActions() {
    view.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => {
      state.editing = state.rows.find(r => r.id === Number(b.dataset.edit));
      go('add');
    });
  }
}

/* ==================================================================== BUDGET */
function renderBudget() {
  // Includes user-created categories, not just the built-in list.
  const allCats = listFor('category');
  // Budget is deliberately household-level: one ceiling for the two of you.
  // The bars therefore always show combined spend, whoever is selected above.
  const actuals = {};
  for (const c of listFor('category')) {
    actuals[c] = {};
    for (let m = 1; m <= 12; m++) {
      actuals[c][m] = state.rows
        // type === 'Expense' is essential, not cosmetic. Without it a credit-card
        // payment, a CIBC->Wealthsimple move, or a transfer between Ramesh and
        // Surya all counted as spending. That inflated "spent so far" from
        // $69,317 to $480,533 - it was adding $411,216 of money that only ever
        // moved between the household's own accounts.
        .filter(r => r.type === 'Expense' && r.category === c && monthOf(r) === m
                     && Number(String(r.date).slice(0, 4)) === YEAR)
        .reduce((a, r) => a + r.amount, 0);
    }
  }

  // Summary numbers for the header strip
  const totalBudget = EXPENSE_CATS.reduce((a, c) => {
    return a + Object.values(state.budget[c] || {}).reduce((s, v) => s + (Number(v) || 0), 0);
  }, 0);
  const totalSpent = EXPENSE_CATS.reduce((a, c) =>
    a + Object.values(actuals[c] || {}).reduce((s, v) => s + v, 0), 0);
  const budgetedCats = CAT_NAMES.filter(c => Object.values(state.budget[c] || {}).some(v => Number(v) > 0)).length;

  const renderCard = c => {
    const type = CAT_TYPE[c];
    const vals = Array.from({length: 12}, (_, i) => Number(state.budget[c]?.[i+1]) || 0);
    const uniform = vals.every(v => v === vals[0]);
    const annualBudget = vals.reduce((a, v) => a + v, 0);
    const annualActual = Object.values(actuals[c]).reduce((a, v) => a + v, 0);
    const isOver = annualBudget > 0 && annualActual > annualBudget;
    const pct = annualBudget > 0 ? Math.min(annualActual / annualBudget, 1) : 0;
    const hasBudget = annualBudget > 0;
    const hasActual = annualActual > 0;

    return `<div class="bcard" data-cat="${esc(c)}">
      <div class="bcard-head">
        <div class="bcard-name">
          <span class="bcard-dot ${type === 'Income' ? 'income' : ''}"></span>
          ${esc(c)}
        </div>
        <div class="bcard-annual">
          <span class="bcard-total num" data-annual>${hasBudget ? money(annualBudget) : '<span class="muted">—</span>'}</span>
          <span class="bcard-label">/yr</span>
        </div>
      </div>

      ${hasActual || hasBudget ? `<div class="bcard-bar-wrap">
        <div class="bcard-bar-track">
          <div class="bcard-bar-fill ${isOver ? 'over' : ''}" style="width:${(pct*100).toFixed(1)}%"></div>
        </div>
        <span class="bcard-bar-label num ${isOver ? 'over' : 'muted'}">${hasBudget ? (pct*100).toFixed(0)+'%' : ''}</span>
      </div>
      <div class="bcard-context">
        ${hasActual ? `<span class="num muted" style="font-size:11px">spent ${money(annualActual)}</span>` : '<span class="muted" style="font-size:11px">no spend yet</span>'}
      </div>` : `<div style="height:8px"></div>`}

      <div class="bcard-mode">
        <label class="bcard-toggle">
          <input type="checkbox" class="uniform-check" ${uniform ? 'checked' : ''}>
          <span>Same every month</span>
        </label>
      </div>

      <div class="bcard-uniform" style="${uniform ? '' : 'display:none'}">
        <div class="bcard-uniform-row">
          <span class="bcard-uniform-label">Monthly</span>
          <input class="num bcard-flat-input" type="number" step="1" min="0"
            data-flat value="${vals[0]}" placeholder="0">
          <span class="bcard-uniform-label muted">× 12</span>
        </div>
      </div>

      <div class="bcard-months" style="${uniform ? 'display:none' : ''}">
        ${MONTHS.map((m, i) => {
          const a = actuals[c][i+1];
          const b = vals[i];
          const mo = b > 0 && a > b;
          return `<div class="bmonth">
            <span class="bmonth-label">${m}</span>
            <input class="num bmonth-input ${mo ? 'over' : ''}" type="number" step="1" min="0"
              data-m="${i+1}" value="${b}" placeholder="0">
            ${a > 0 ? `<span class="bmonth-actual num ${mo ? 'over' : 'muted'}">${money(a)}</span>` : '<span class="bmonth-actual"></span>'}
          </div>`;
        }).join('')}
      </div>
    </div>`;
  };

  view.innerHTML = `
  <div class="head">
    <div><h1>Budget</h1><p class="sub">One shared household ceiling per category. Bars show <b>combined</b> spend for both of you, regardless of who is selected above. Zero means "not budgeted".</p></div>
    <div class="spacer"></div>
    <div class="actions">
      <button class="btn ghost" id="b-clear-all">Clear all</button>
      <button class="btn" id="b-save">Save budget</button>
    </div>
  </div>

  <div class="b-summary">
    <div class="b-sum-item">
      <span class="b-sum-val num">${money(totalBudget)}</span>
      <span class="b-sum-key">annual expense budget</span>
    </div>
    <div class="b-sum-item">
      <span class="b-sum-val num ${totalSpent > totalBudget && totalBudget > 0 ? 'over' : ''}">${money(totalSpent)}</span>
      <span class="b-sum-key">spent so far ${YEAR}</span>
    </div>
    <div class="b-sum-item">
      <span class="b-sum-val num">${budgetedCats}</span>
      <span class="b-sum-key">categories budgeted</span>
    </div>
  </div>

  <div class="eyebrow">Income</div>
  <div class="bcards">
    ${allCats.filter(c => CAT_TYPE[c] === 'Income').map(renderCard).join('')}
  </div>

  <div class="eyebrow">Expenses</div>
  <div class="bcards">
    ${allCats.filter(c => CAT_TYPE[c] !== 'Income').map(renderCard).join('')}
  </div>

  <p class="note" style="margin-top:18px">Bar shows actual spend vs this year's budget. Red = over. Nothing saves until you click <b>Save budget</b>.</p>`;

  // --- wire up each card
  view.querySelectorAll('.bcard').forEach(card => {
    const cat = card.dataset.cat;

    const getAnnual = () => {
      const uniformEl = card.querySelector('.bcard-flat-input');
      if (!card.querySelector('.bcard-uniform-row').parentElement.hidden) {
        const v = Number(uniformEl?.value) || 0;
        return v * 12;
      }
      return [...card.querySelectorAll('[data-m]')].reduce((a, i) => a + (Number(i.value) || 0), 0);
    };

    const updateAnnual = () => {
      const a = getAnnual();
      card.querySelector('[data-annual]').innerHTML = a > 0 ? money(a) : '<span class="muted">—</span>';
    };

    // toggle uniform ↔ monthly
    card.querySelector('.uniform-check').onchange = e => {
      const uniformDiv = card.querySelector('.bcard-uniform');
      const monthsDiv = card.querySelector('.bcard-months');
      const isUniform = e.target.checked;
      uniformDiv.style.display = isUniform ? '' : 'none';
      monthsDiv.style.display = isUniform ? 'none' : '';
      if (isUniform) {
        // sync flat input to first month value
        const first = Number(card.querySelector('[data-m="1"]')?.value) || 0;
        card.querySelector('.bcard-flat-input').value = first;
      } else {
        // spread flat value to all months
        const flat = Number(card.querySelector('.bcard-flat-input')?.value) || 0;
        card.querySelectorAll('[data-m]').forEach(i => { i.value = flat; });
      }
      updateAnnual();
    };

    // flat input changes
    card.querySelector('.bcard-flat-input')?.addEventListener('input', updateAnnual);

    // monthly inputs
    card.querySelectorAll('[data-m]').forEach(inp => inp.addEventListener('input', () => {
      updateAnnual();
      // colour the input red if actual > budget for that month
      const m = Number(inp.dataset.m);
      const b = Number(inp.value) || 0;
      const a = actuals[cat][m] || 0;
      inp.classList.toggle('over', b > 0 && a > b);
    }));

    updateAnnual();
  });

  // save
  $('#b-save').onclick = async () => {
    const b = {};
    view.querySelectorAll('.bcard').forEach(card => {
      const c = card.dataset.cat;
      b[c] = {};
      const isUniform = card.querySelector('.uniform-check').checked;
      if (isUniform) {
        const flat = Number(card.querySelector('.bcard-flat-input')?.value) || 0;
        for (let m = 1; m <= 12; m++) b[c][m] = flat;
      } else {
        card.querySelectorAll('[data-m]').forEach(i => { b[c][Number(i.dataset.m)] = Number(i.value) || 0; });
      }
    });
    const done = await withBusy('Saving the budget', async () => { await state.store.setBudget(b); await refresh(); });
    if (done) { notice('Budget saved.', 'ok'); renderBudget(); }
  };

  // clear all
  $('#b-clear-all').onclick = () => {
    if (!confirm('Reset every budget amount to zero?')) return;
    view.querySelectorAll('input[type=number]').forEach(i => { i.value = 0; });
    view.querySelectorAll('[data-annual]').forEach(el => { el.innerHTML = '<span class="muted">—</span>'; });
    view.querySelectorAll('.b-sum-val').forEach((el, i) => { if (i < 2) el.textContent = money(0); });
    view.querySelector('.b-sum-item:nth-child(3) .b-sum-val').textContent = '0';
  };
}

/* ================================================================= NET WORTH */
/* Balances are snapshots, not movements. Nothing here feeds Income, Expense or
   Budget - a TFSA balance already contains the contributions recorded as
   Transfers, so counting both would double them. */

/* No balance seeding from a bundled file, deliberately. An earlier version
   shipped data/seed-balances.json containing real account balances - in a
   PUBLIC repo, which is the same mistake that put 687 transactions on
   raw.githubusercontent.com. Balances arrive one of two ways now: typed into
   Record balances, or imported from a file you choose at runtime. Neither
   touches the repository. */

function renderNetWorth() {
  const snaps = state.balances || [];
  const dates = [...new Set(snaps.map(b => b.date))].sort().reverse();
  const latest = dates[0] || null;
  const prev = dates[1] || null;

  const at = d => snaps.filter(b => b.date === d);
  const scopeOwner = state.person && state.person !== UNASSIGNED ? state.person : null;
  const sumOf = (d, kind) => at(d)
    .filter(b => b.kind === kind && (!scopeOwner || b.owner === scopeOwner))
    .reduce((a, b) => a + Number(b.balance || 0), 0);

  const assets = latest ? sumOf(latest, 'Asset') : 0;
  const liabs  = latest ? sumOf(latest, 'Liability') : 0;
  const net = assets - liabs;
  const prevNet = prev ? sumOf(prev, 'Asset') - sumOf(prev, 'Liability') : null;
  const delta = prevNet === null ? null : net - prevNet;

  const accounts = NET_WORTH_ACCOUNTS.filter(a => !scopeOwner || a.owner === scopeOwner);
  const valueAt = (d, acct) => {
    const hit = at(d).find(b => b.account === acct);
    return hit ? Number(hit.balance || 0) : null;
  };

  const series = [...dates].reverse().map(d => ({
    date: d,
    net: sumOf(d, 'Asset') - sumOf(d, 'Liability'),
    assets: sumOf(d, 'Asset'),
    liabs: sumOf(d, 'Liability'),
    covered: at(d).filter(b => !scopeOwner || b.owner === scopeOwner).length,
  }));

  // Comparing snapshots that cover different numbers of accounts is misleading:
  // net worth appears to jump when really the coverage changed. Say so.
  const maxCover = Math.max(0, ...series.map(s => s.covered));
  const uneven = series.some(s => s.covered !== maxCover);
  const missing = latest
    ? accounts.filter(a => valueAt(latest, a.account) === null)
    : accounts;

  const fmtDate = d => { try {
    return new Date(d + 'T12:00:00').toLocaleDateString('en-CA', { day:'numeric', month:'long', year:'numeric' });
  } catch { return d; } };

  view.innerHTML = `
  <div class="head">
    <div><h1>Net worth</h1>
      <p class="sub">${esc(personLabel())}${latest ? ' &middot; ' + dates.length + ' snapshot' + (dates.length>1?'s':'') : ''}</p>
    </div>
    <div class="spacer"></div>
    <button class="btn" id="nw-record">Record balances</button>
  </div>

  ${!latest ? `<div class="empty">No balances recorded yet. Click <b>Record balances</b> to enter what each
     account is worth today &mdash; separate from your transactions, and never affects income or expense.</div>` : `

  <div class="nw-asat">
    <span class="nw-asat-label">Net worth as at</span>
    <span class="nw-asat-date">${esc(fmtDate(latest))}</span>
    <span class="nw-asat-note">${latest === dates[0] && dates.length > 1
      ? `updates automatically when you record a newer snapshot`
      : `record a newer snapshot to move this forward`}</span>
  </div>

  <div class="kpis" style="grid-template-columns:repeat(4,1fr)">
    ${kpi('Assets', money(assets), `${at(latest).filter(b=>b.kind==='Asset'&&(!scopeOwner||b.owner===scopeOwner)).length} accounts`)}
    ${kpi('Liabilities', money(liabs), liabs > 0 ? 'owed' : 'nothing owed')}
    ${kpi('Net worth', money(net), '', net < 0 ? 'neg' : 'pos')}
    ${kpi('Change', delta === null ? '\u2014' : (delta >= 0 ? '+' : '') + money(delta),
          prev ? `since ${prev}` : 'need a second snapshot', delta === null ? '' : delta < 0 ? 'neg' : 'pos')}
  </div>

  ${missing.length ? `<div class="nw-warn">
    <b>${missing.length} account${missing.length>1?'s have':' has'} no balance in this snapshot</b> &mdash;
    ${esc(missing.slice(0,4).map(a=>a.account).join(', '))}${missing.length>4 ? ` and ${missing.length-4} more` : ''}.
    They are excluded from the totals above rather than counted as zero.
  </div>` : ''}

  ${uneven ? `<div class="nw-warn">
    Snapshots cover different numbers of accounts (${Math.min(...series.map(s=>s.covered))}\u2013${maxCover}),
    so the trend below partly reflects <b>changing coverage, not changing wealth</b>.
    Record every account on the same date for a comparable line.
  </div>` : ''}

  <div class="eyebrow">By account &mdash; ${esc(latest)}</div>
  <div class="tablewrap"><table><thead><tr>
    <th>Account</th><th>Owner</th><th>Kind</th><th class="n">Balance</th>
    <th class="n">${prev ? 'Change' : ''}</th></tr></thead><tbody>
    ${accounts.map(a => {
      const v = valueAt(latest, a.account);
      const p = prev ? valueAt(prev, a.account) : null;
      const ch = (v !== null && p !== null) ? v - p : null;
      return `<tr class="${v === null ? 'nw-blank' : ''}">
        <td>${esc(a.account)}</td>
        <td><span class="person-chip" data-p="${esc(a.owner)}">${esc(a.owner)}</span></td>
        <td><span class="tag">${a.kind}</span></td>
        <td class="n num">${v === null ? '<span class="muted">not recorded</span>' : money(v)}</td>
        <td class="n num ${ch === null ? 'muted' : ch < 0 ? 'tx-over' : 'tx-income'}">${
          ch === null ? '\u2014' : (ch >= 0 ? '+' : '') + money(ch)}</td></tr>`;
    }).join('')}
  </tbody></table></div>

  ${series.length > 1 ? `
  <div class="eyebrow">Over time</div>
  <div class="grid2">
    <div class="panel"><h3>Net worth trend</h3><div class="chartbox"><canvas id="c-nw-trend"></canvas></div></div>
    <div class="panel"><h3>Assets by account &mdash; ${esc(latest)}</h3><div class="chartbox"><canvas id="c-nw-split"></canvas></div></div>
  </div>` : `<p class="note">Record a second snapshot to see a trend. Monthly is plenty &mdash; balances move slowly.</p>`}

  <div class="eyebrow">Snapshots</div>
  <div class="tablewrap"><table><thead><tr><th>Date</th><th class="n">Accounts</th><th class="n">Assets</th><th class="n">Liabilities</th><th class="n">Net worth</th><th></th></tr></thead><tbody>
    ${[...series].reverse().map(x => `<tr>
      <td class="num">${esc(x.date)}</td>
      <td class="n num ${x.covered < maxCover ? 'muted' : ''}">${x.covered}${x.covered < maxCover ? ' of ' + maxCover : ''}</td>
      <td class="n num">${money(x.assets)}</td>
      <td class="n num">${money(x.liabs)}</td>
      <td class="n num"><b>${money(x.net)}</b></td>
      <td><button class="rowbtn" data-delsnap="${esc(x.date)}" title="Delete this snapshot">\u2715</button></td>
    </tr>`).join('')}
  </tbody></table></div>
  `}`;

  $('#nw-record').onclick = () => renderBalanceForm(latest);
  view.querySelectorAll('[data-delsnap]').forEach(b => b.onclick = async () => {
    if (!confirm(`Delete the whole snapshot dated ${b.dataset.delsnap}?`)) return;
    const done = await withBusy('Deleting snapshot', async () => {
      await state.store.deleteBalanceDate(b.dataset.delsnap);
      state.balances = await state.store.getBalances();
    });
    if (done) { renderNetWorth(); notice('Snapshot deleted.', 'ok'); }
  });

  if (typeof Chart !== 'undefined' && series.length > 1) {
    charts.netWorthTrend(series);
    charts.assetSplit(at(latest).filter(b => b.kind === 'Asset' && (!scopeOwner || b.owner === scopeOwner)));
  }
}

/** Enter every account's balance for one date. Grouped, running total, carry-forward. */
function renderBalanceForm(copyFrom) {
  const today = new Date().toISOString().slice(0, 10);
  const snaps = state.balances || [];
  const dates = [...new Set(snaps.map(b => b.date))].sort().reverse();
  const source = copyFrom || dates[0] || null;
  const existing = snaps.filter(b => b.date === source);
  const prefill = a => {
    const hit = existing.find(x => x.account === a.account);
    return hit ? Number(hit.balance) : '';
  };

  const groupRows = owner => NET_WORTH_ACCOUNTS.filter(a => a.owner === owner).map(a => `
    <tr>
      <td>${esc(a.account)}</td>
      <td><span class="tag ${a.kind === 'Liability' ? 'tag-liab' : ''}">${a.kind}</span></td>
      <td class="n">
        <div class="nw-input-wrap">
          <span class="nw-currency">$</span>
          <input class="num nw-input" type="number" step="0.01" inputmode="decimal"
            data-account="${esc(a.account)}" data-owner="${esc(a.owner)}" data-kind="${a.kind}"
            value="${prefill(a)}" placeholder="0.00">
        </div>
      </td>
    </tr>`).join('');

  view.innerHTML = `
  <div class="head">
    <div><h1>Record balances</h1>
      <p class="sub">One snapshot per date. Saving the same date again replaces it rather than duplicating.</p></div>
    <div class="spacer"></div><button class="btn ghost" id="nw-back">&larr; Back</button>
  </div>

  <div class="nw-form-bar">
    <label class="f"><span>Snapshot date</span><input type="date" id="nw-date" value="${today}"></label>
    ${source ? `<button class="btn ghost" id="nw-copy" type="button">Copy from ${esc(source)}</button>` : ''}
    <button class="btn ghost" id="nw-clear" type="button">Clear all</button>
    <label class="btn ghost nw-import-btn" for="nw-import">Import file\u2026</label>
    <input type="file" id="nw-import" accept=".json,.csv" hidden>
    <div class="spacer"></div>
    <div class="nw-running">
      <span class="nw-running-label">Running net worth</span>
      <span class="nw-running-val num" id="nw-total">$0.00</span>
      <span class="nw-running-sub" id="nw-breakdown">&mdash;</span>
    </div>
  </div>

  <div id="nw-import-out" class="note" style="margin:0 0 10px"></div>

  ${['Ramesh','Surya'].map(owner => `
    <div class="eyebrow">${owner} <span class="muted" style="text-transform:none;letter-spacing:0" id="nw-sub-${owner}"></span></div>
    <div class="tablewrap"><table><thead><tr><th>Account</th><th>Kind</th><th class="n" style="width:190px">Balance (CAD)</th></tr></thead>
      <tbody>${groupRows(owner)}</tbody></table></div>`).join('')}

  <div class="actions" style="margin-top:18px">
    <button class="btn" id="nw-save">Save snapshot</button>
    <span class="muted" id="nw-hint">Blank accounts are omitted from the snapshot, not recorded as zero.</span>
  </div>

  <p class="note"><b>Import file\u2026</b> loads a <code>.json</code> or <code>.csv</code> from your machine
    (columns <code>date, account, owner, kind, balance</code>). It is read in the browser and written straight
    to your sheet &mdash; never uploaded, never stored in the repository.</p>
  <p class="note">Enter liabilities as positive numbers &mdash; a $500 card balance is <code>500</code>, and it is
    subtracted from net worth automatically. Balances never affect your income, expense or budget figures.</p>`;

  const recalc = () => {
    let A = 0, L = 0, filled = 0;
    const perOwner = { Ramesh: 0, Surya: 0 };
    view.querySelectorAll('.nw-input').forEach(i => {
      if (i.value === '') return;
      filled++;
      const v = Math.abs(Number(i.value) || 0);
      if (i.dataset.kind === 'Liability') { L += v; perOwner[i.dataset.owner] -= v; }
      else { A += v; perOwner[i.dataset.owner] += v; }
    });
    $('#nw-total').textContent = money(A - L);
    $('#nw-total').className = 'nw-running-val num ' + (A - L < 0 ? 'tx-over' : 'tx-income');
    $('#nw-breakdown').textContent = filled
      ? `${money(A)} assets \u2212 ${money(L)} liabilities \u00b7 ${filled} account${filled>1?'s':''}`
      : 'nothing entered yet';
    for (const o of ['Ramesh','Surya']) {
      const el = $('#nw-sub-' + o);
      if (el) el.textContent = perOwner[o] ? `\u00b7 ${money(perOwner[o])}` : '';
    }
  };
  view.querySelectorAll('.nw-input').forEach(i => i.addEventListener('input', recalc));
  recalc();

  $('#nw-back').onclick = () => renderNetWorth();
  $('#nw-clear').onclick = () => { view.querySelectorAll('.nw-input').forEach(i => { i.value = ''; }); recalc(); };
  $('#nw-copy')?.addEventListener('click', () => {
    view.querySelectorAll('.nw-input').forEach(i => {
      const hit = existing.find(x => x.account === i.dataset.account);
      i.value = hit ? Number(hit.balance) : '';
    });
    recalc();
    notice(`Copied ${existing.length} balances from ${source} \u2014 edit what changed, then save.`, 'ok');
  });

  $('#nw-import').onchange = async ev => {
    const file = ev.target.files[0];
    if (!file) return;
    const out = $('#nw-import-out');
    try {
      const text = await file.text();
      let rows;
      if (file.name.toLowerCase().endsWith('.json')) {
        rows = JSON.parse(text);
      } else {
        const lines = text.trim().split(/\r?\n/);
        const head = lines[0].split(',').map(h => h.trim().toLowerCase());
        rows = lines.slice(1).filter(Boolean).map(l => {
          const c = l.split(',');
          const g = k => (head.indexOf(k) === -1 ? '' : String(c[head.indexOf(k)] ?? '').trim());
          return { date: g('date'), account: g('account'), owner: g('owner'),
                   kind: g('kind'), balance: Number(String(g('balance')).replace(/[$,\s]/g, '')) };
        });
      }
      rows = rows.filter(r => /^\d{4}-\d{2}-\d{2}$/.test(r.date) && r.account && isFinite(r.balance));
      if (!rows.length) { out.innerHTML = '<b class="over">No usable rows. Need date, account and balance.</b>'; return; }
      const byDate = {};
      for (const r of rows) (byDate[r.date] ||= []).push({
        account: r.account, owner: r.owner || 'Ramesh',
        kind: r.kind === 'Liability' ? 'Liability' : 'Asset',
        balance: Math.abs(Number(r.balance) || 0), notes: r.notes || 'imported',
      });
      const dateList = Object.keys(byDate).sort();
      if (!confirm(`Import ${rows.length} balances across ${dateList.length} date(s)?\n\n${dateList.join(', ')}\n\nAny existing snapshot on these dates is replaced.`)) return;
      const done = await withBusy(`Importing ${rows.length} balances`, async () => {
        for (const [date, entries] of Object.entries(byDate)) await state.store.setBalances(date, entries);
        state.balances = await state.store.getBalances();
      });
      if (done) { notice(`Imported ${rows.length} balances.`, 'ok'); renderNetWorth(); }
    } catch (err) {
      out.innerHTML = `<b class="over">${esc(err.message)}</b>`;
    }
  };

  $('#nw-save').onclick = async () => {
    const date = $('#nw-date').value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return notice('Pick a valid date.', 'bad');
    const entries = [...view.querySelectorAll('.nw-input')]
      .filter(i => i.value !== '')
      .map(i => ({ account: i.dataset.account, owner: i.dataset.owner,
                   kind: i.dataset.kind, balance: Math.abs(Number(i.value) || 0), notes: '' }));
    if (!entries.length) return notice('Enter at least one balance.', 'bad');
    if (dates.includes(date) && !confirm(`A snapshot for ${date} already exists. Replace it?`)) return;
    const done = await withBusy(`Saving ${entries.length} balances`, async () => {
      await state.store.setBalances(date, entries);
      state.balances = await state.store.getBalances();
    });
    if (done) { notice(`Snapshot saved for ${date}.`, 'ok'); renderNetWorth(); }
  };
}

/* ====================================================================== DATA */
function renderData() {
  const src = endpointSource();
  const ep = localStorage.getItem(ENDPOINT_KEY) || '';
  const live = state.store.kind === 'sheets';
  const who = state.store.user?.email || '';

  view.innerHTML = `
  <div class="head"><div><h1>Data</h1><p class="sub">Where your data lives, and how to get it in and out.</p></div></div>

  <div class="eyebrow">Google Sheet connection</div>
  <div class="panel stack">
    <p class="note" style="margin:0">Status: <b>${live
      ? 'connected \u2014 reading and writing "' + esc(state.store.sheetName || 'your sheet') + '" live' + (who ? ' as ' + esc(who) : '')
      : state.store.kind === 'memory' ? 'session memory only, nothing is being saved'
      : 'not connected \u2014 changes stay in this browser'}</b>.
      Endpoint source: <b>${src === 'build' ? 'GitHub secret, injected at deploy' : src === 'runtime' ? 'entered here, stored in this browser only' : 'none'}</b>.
      Access: <b>Google sign-in</b>, verified by Apps Script against an allow-list \u2014 there is no separate token to manage here anymore.</p>
    <div class="stack" style="max-width:620px">
      <label class="f"><span>Apps Script web app URL</span>
        <input id="ep" placeholder="https://script.google.com/macros/s/AKfy.../exec" value="${esc(ep)}"></label>
    </div>
    <div class="actions">
      <button class="btn" id="connect">Connect &amp; test</button>
      <button class="btn ghost" id="disconnect">Disconnect</button>
      <button class="btn ghost" id="reload" ${live ? '' : 'disabled'}>Reload from sheet</button>
      ${getIdToken() ? '<button class="btn ghost" id="data-signout">Sign out</button>' : ''}
    </div>
    <p class="note"><b>The endpoint URL stays in this browser and is never published.</b> Values injected from
    GitHub secrets end up in <code>assets/config.js</code>, which is served to every visitor of the site \u2014
    a secret in Actions keeps it out of the repo, not out of the page. Enter it here instead if you would
    rather it never appear in the deployed site at all.</p>
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

  <div class="eyebrow">People</div>
  <div class="panel stack">
    <p class="note" style="margin:0">${(() => {
      const un = state.rows.filter(r => !r.person).length;
      return un
        ? `<b>${un} entries have no person set</b> — everything imported before this feature existed. Assign them in one go:`
        : 'Every entry has a person assigned.';
    })()}</p>
    ${state.rows.filter(r => !r.person).length ? `
    <div class="actions">
      ${PEOPLE.map(pp => `<button class="btn ghost" data-assign="${pp}">Assign all to ${pp}</button>`).join('')}
    </div>
    <p class="note">This rewrites every unassigned row in the sheet. You can still change individual entries afterwards from Transactions → edit.</p>` : ''}
  </div>

  <div class="eyebrow">Danger zone</div>
  <div class="panel"><div class="actions">
    <button class="btn danger" id="wipe">Delete every row${live ? ' from the sheet' : ''}</button>
    <span class="muted">Export first \u2014 this cannot be undone.</span>
  </div></div>`;

  $('#connect').onclick = async () => {
    const url = $('#ep').value.trim();
    if (!/^https:\/\/script\.google\.com\/macros\/s\/.+\/exec$/.test(url)) {
      return notice('That does not look like an Apps Script /exec URL. Deploy the script as a Web app and copy the URL ending in /exec.', 'bad');
    }
    localStorage.setItem(ENDPOINT_KEY, url);
    if (getClientId() && !getIdToken()) { showGate(); return; }
    await withBusy('Testing the connection', async () => {
      state.store = await openStore(() => {});
      if (state.store.kind !== 'sheets') throw new Error('could not reach the sheet with that URL \u2014 check it is deployed and you are signed in with an allowed account');
      await refresh();
    });
    if (state.store.kind === 'sheets') notice(`Connected to "${state.store.sheetName}" \u2014 ${state.rows.length} rows loaded.`, 'ok');
    renderData();
  };

  $('#disconnect').onclick = async () => {
    localStorage.removeItem(ENDPOINT_KEY);
    state.store = await openStore(notice); await refresh(); renderData();
  };

  $('#data-signout')?.addEventListener('click', signOut);

  $('#reload').onclick = async () => {
    const done = await withBusy('Reloading from the sheet', async () => {
      state.store.cache = null; await refresh();
    });
    if (done) { renderData(); notice(`Reloaded ${state.rows.length} rows.`, 'ok'); }
  };

  view.querySelectorAll('[data-assign]').forEach(b => b.onclick = async () => {
    const who = b.dataset.assign;
    const todo = state.rows.filter(r => !r.person);
    if (!confirm(`Assign ${todo.length} unassigned entries to ${who}?\n\nThis updates ${todo.length} rows one at a time and may take a moment.`)) return;
    const done = await withBusy(`Assigning ${todo.length} entries to ${who}`, async () => {
      for (const r of todo) await state.store.update(r.id, { ...r, person: who });
      await refresh();
    });
    if (done) { notice(`${todo.length} entries assigned to ${who}.`, 'ok'); renderData(); }
  });

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
        await state.store.bulkAdd(rows, (n, total) => {
          notice(`Writing to the sheet\u2026 ${n} of ${total} rows`);
        });
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
const VIEWS = { dashboard: renderDashboard, add: renderAdd, transactions: renderTransactions, budget: renderBudget, networth: renderNetWorth, data: renderData };

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

async function boot() {
  state.store = await openStore(notice);
  await seedIfEmpty();
  await refresh();
  go((location.hash || '#dashboard').slice(1) in VIEWS ? location.hash.slice(1) : 'dashboard');
}

(async function main() {
  const ready = () => (typeof Chart !== 'undefined' && typeof XLSX !== 'undefined');
  if (!ready()) await new Promise(r => window.addEventListener('load', r, { once: true }));

  // Only gate when a sheet is actually configured. Without an endpoint the app
  // runs on browser storage alone and there is nothing of yours to protect.
  const needsAuth = !!getEndpoint() && !!getClientId();
  if (needsAuth && !getIdToken()) { showGate(); return; }

  try {
    await boot();
  } catch (e) {
    if (e?.auth || /sign in|not permitted/i.test(e?.message || '')) {
      setIdToken('');
      showGate(e.message);
    } else {
      throw e;
    }
  }
})();