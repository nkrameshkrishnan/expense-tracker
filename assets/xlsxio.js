/* Spreadsheet in / spreadsheet out, plus the aggregation the dashboard runs on. */
import { CAT_NAMES, EXPENSE_CATS, CAT_TYPE, MONTHS, PAYMENTS, PEOPLE, UNASSIGNED, YEAR, normalise } from './store.js';

export const money = n => (n < 0 ? '-' : '') + '$' + Math.abs(n).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const pct = n => (n * 100).toFixed(1) + '%';
export const monthOf = r => Number(String(r.date).slice(5, 7)) || 0;

/** Filter by person. '' means everyone — the family view. */
export function byPersonFilter(rows, person) {
  if (!person) return rows;
  if (person === UNASSIGNED) return rows.filter(r => !r.person);
  return rows.filter(r => r.person === person);
}

/** Per-person totals for a period. Always computed across everyone, so the
    comparison stays meaningful even while the page is filtered to one person. */
export function personBreakdown(rows, month) {
  const inScope = rows.filter(r => Number(String(r.date).slice(0, 4)) === YEAR && (month === 0 || monthOf(r) === month));
  const buckets = [...PEOPLE, UNASSIGNED].map(p => {
    const mine = p === UNASSIGNED ? inScope.filter(r => !r.person) : inScope.filter(r => r.person === p);
    return {
      person: p,
      expense: mine.filter(r => r.type === 'Expense').reduce((a, r) => a + r.amount, 0),
      income:  mine.filter(r => r.type === 'Income').reduce((a, r) => a + r.amount, 0),
      count:   mine.length,
    };
  }).filter(b => b.count > 0);
  const total = buckets.reduce((a, b) => a + b.expense, 0);
  for (const b of buckets) b.share = total > 0 ? b.expense / total : 0;
  return buckets;
}

/** Monthly expense series split by person — feeds the comparison chart. */
export function personSeries(rows) {
  const people = [...PEOPLE, UNASSIGNED];
  return people.map(p => ({
    person: p,
    data: MONTHS.map((_, i) => {
      const m = i + 1;
      return rows.filter(r =>
        Number(String(r.date).slice(0, 4)) === YEAR && monthOf(r) === m && r.type === 'Expense' &&
        (p === UNASSIGNED ? !r.person : r.person === p)
      ).reduce((a, r) => a + r.amount, 0);
    }),
  })).filter(s => s.data.some(v => v > 0));
}

/** All dashboard numbers come from here. month = 0 means the whole year. */
export function aggregate(rows, budget, month) {
  const inScope = rows.filter(r => Number(String(r.date).slice(0, 4)) === YEAR && (month === 0 || monthOf(r) === month));
  const sum = f => inScope.filter(f).reduce((a, r) => a + r.amount, 0);

  const income = sum(r => r.type === 'Income');
  const expense = sum(r => r.type === 'Expense');

  const byCat = {};
  for (const c of CAT_NAMES) byCat[c] = sum(r => r.type !== 'Transfer' && r.category === c);

  const budgetFor = c => {
    if (!budget[c]) return 0;
    return month === 0
      ? Object.values(budget[c]).reduce((a, b) => a + (Number(b) || 0), 0)
      : Number(budget[c][month]) || 0;
  };
  const expenseBudget = EXPENSE_CATS.reduce((a, c) => a + budgetFor(c), 0);

  const catRows = EXPENSE_CATS.map(c => {
    const actual = byCat[c], b = budgetFor(c);
    return { category: c, actual, budget: b, variance: b - actual, used: b > 0 ? actual / b : 0 };
  });

  const byPayment = PAYMENTS.map(p => ({
    method: p,
    amount: inScope.filter(r => r.type === 'Expense' && r.payment === p).reduce((a, r) => a + r.amount, 0),
  }));
  const unattributed = inScope.filter(r => r.type === 'Expense' && !r.payment).reduce((a, r) => a + r.amount, 0);

  const series = MONTHS.map((_, i) => {
    const m = i + 1;
    const inM = rows.filter(r => Number(String(r.date).slice(0, 4)) === YEAR && monthOf(r) === m);
    const inc = inM.filter(r => r.type === 'Income').reduce((a, r) => a + r.amount, 0);
    const exp = inM.filter(r => r.type === 'Expense').reduce((a, r) => a + r.amount, 0);
    const bud = EXPENSE_CATS.reduce((a, c) => a + (Number(budget[c]?.[m]) || 0), 0);
    return { month: MONTHS[i], income: inc, expense: exp, net: inc - exp, budget: bud, hasData: inM.length > 0 };
  });

  const days = month === 0 ? 365 : new Date(YEAR, month, 0).getDate();

  return {
    count: inScope.length, income, expense, net: income - expense,
    savingsRate: income > 0 ? (income - expense) / income : 0,
    expenseBudget, budgetUsed: expenseBudget > 0 ? expense / expenseBudget : 0,
    avgDaily: expense / days,
    catRows,
    top5: [...catRows].filter(r => r.actual > 0).sort((a, b) => b.actual - a.actual).slice(0, 5),
    overBudget: catRows.filter(r => r.budget > 0 && r.actual > r.budget).sort((a, b) => a.variance - b.variance),
    byPayment: byPayment.filter(p => p.amount > 0), unattributed,
    series,
  };
}

/* ------------------------------------------------------------------ export */
export function exportWorkbook(rows, budget) {
  if (typeof XLSX === 'undefined') throw new Error('SheetJS failed to load — check your connection.');
  const wb = XLSX.utils.book_new();
  const sorted = [...rows].sort((a, b) => (a.date < b.date ? -1 : 1));

  const txAoa = [['Date', 'Month', 'Year', 'Type', 'Category', 'Subcategory', 'Description',
    'Amount (CAD)', 'Payment Method', 'Account', 'Recurring?', 'Notes', 'Person']];
  for (const r of sorted) {
    txAoa.push([r.date, MONTHS[monthOf(r) - 1] || '', Number(String(r.date).slice(0, 4)) || '',
      r.type, r.category, r.subcategory, r.description, r.amount, r.payment, r.account,
      r.recurring, r.notes, r.person || '']);
  }
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(txAoa), 'Transactions');

  const bgAoa = [['Category', 'Type', ...MONTHS, 'Annual Total']];
  CAT_NAMES.forEach((c, i) => {
    const r = 2 + i;
    bgAoa.push([c, CAT_TYPE[c], ...MONTHS.map((_, m) => Number(budget[c]?.[m + 1]) || 0),
      { f: `SUM(C${r}:N${r})` }]);
  });
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(bgAoa), 'Budget');

  // Live cross-tab. Classic functions only, so it behaves the same in Excel and Sheets.
  const last = txAoa.length;
  const pvAoa = [['Category', 'Type', ...MONTHS, 'Total']];
  CAT_NAMES.forEach((c, i) => {
    const r = 2 + i;
    const cells = MONTHS.map((_, m) => ({
      f: `SUMIFS(Transactions!$H$2:$H$${last},Transactions!$E$2:$E$${last},$A${r},` +
         `Transactions!$B$2:$B$${last},${String.fromCharCode(67 + m)}$1)`,
    }));
    pvAoa.push([c, CAT_TYPE[c], ...cells, { f: `SUM(C${r}:N${r})` }]);
  });
  const tr = CAT_NAMES.length + 2;
  pvAoa.push(['TOTAL', '', ...MONTHS.map((_, m) => {
    const L = String.fromCharCode(67 + m);
    return { f: `SUM(${L}2:${L}${tr - 1})` };
  }), { f: `SUM(C${tr}:N${tr})` }]);
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(pvAoa), 'Pivot');

  XLSX.writeFile(wb, `Expense_Tracker_${YEAR}_export.xlsx`);
}

/* ------------------------------------------------------------------ import */
const HEADER_ALIASES = {
  date: 'date', 'transaction date': 'date',
  type: 'type', 'transaction type': 'type',
  category: 'category', cat: 'category',
  subcategory: 'subcategory', 'sub category': 'subcategory', sub: 'subcategory',
  description: 'description', desc: 'description', memo: 'description', details: 'description',
  amount: 'amount', 'amount (cad)': 'amount', value: 'amount', debit: 'amount',
  'payment method': 'payment', payment: 'payment', method: 'payment',
  account: 'account', card: 'account',
  'recurring?': 'recurring', recurring: 'recurring',
  notes: 'notes', note: 'notes',
  person: 'person', who: 'person', member: 'person', owner: 'person',
};

function excelSerialToISO(v) {
  const d = new Date(Date.UTC(1899, 11, 30) + v * 86400000);
  return d.toISOString().slice(0, 10);
}

/** Parses a file exported from this app or the tracker workbook.
    Returns {rows, skipped, reasons} — it never silently drops data. */
export async function importFile(file) {
  if (typeof XLSX === 'undefined') throw new Error('SheetJS failed to load — check your connection.');
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { cellDates: false });

  let best = null;
  for (const name of wb.SheetNames) {
    const aoa = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, blankrows: false });
    for (let i = 0; i < Math.min(aoa.length, 8); i++) {
      const hdr = (aoa[i] || []).map(h => String(h ?? '').trim().toLowerCase());
      const map = {};
      hdr.forEach((h, idx) => { if (HEADER_ALIASES[h] !== undefined) map[HEADER_ALIASES[h]] = idx; });
      if (map.date !== undefined && map.amount !== undefined) {
        const score = Object.keys(map).length;
        if (!best || score > best.score) best = { aoa, headerRow: i, map, score, sheet: name };
      }
    }
  }
  if (!best) {
    throw new Error('No sheet had both a Date and an Amount column. ' +
      'This importer expects a flat transaction table — the original month-tab layout is not auto-detected.');
  }

  const rows = [], reasons = [];
  let skipped = 0;
  for (let i = best.headerRow + 1; i < best.aoa.length; i++) {
    const raw = best.aoa[i] || [];
    const get = k => (best.map[k] === undefined ? '' : raw[best.map[k]]);
    let date = get('date');
    if (typeof date === 'number') date = excelSerialToISO(date);
    else if (date instanceof Date) date = date.toISOString().slice(0, 10);
    else date = String(date || '').trim().slice(0, 10);

    const amount = Number(String(get('amount')).replace(/[$,\s]/g, ''));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !isFinite(amount) || amount === 0) {
      if (raw.some(c => c !== '' && c != null)) { skipped++; if (reasons.length < 5) reasons.push(`row ${i + 1}`); }
      continue;
    }
    let type = String(get('type') || '').trim();
    if (!type) type = amount < 0 ? 'Expense' : 'Expense';
    rows.push(normalise({ date, type, category: String(get('category') || '').trim(),
      subcategory: get('subcategory'), description: get('description'), amount,
      payment: get('payment'), account: get('account'),
      recurring: get('recurring'), notes: get('notes'), person: get('person') }));
  }
  return { rows, skipped, reasons, sheet: best.sheet };
}