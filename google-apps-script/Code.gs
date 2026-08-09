/**
 * Ledger — Google Sheets API, bound to the Expense_Tracker_2026 workbook.
 *
 * This writes into the tracker's OWN layout so the existing Dashboard, Pivot and
 * charts keep working. It does not create its own tables.
 *
 *   Transactions   A Date · B Month · C Year · D Type · E Category · F Subcategory
 *                  G Description · H Amount · I Payment · J Account · K Recurring
 *                  L Notes · M ID  (M is added by this script; A–L untouched)
 *   Budget         categories matched by name in column A; months in C–N only.
 *                  Columns B (Type) and O (annual formula) are never written.
 *
 * Design decisions that matter:
 *
 *  - Column A is written as a real Date object, not a string. The tracker's
 *    B column is =TEXT($A2,"mmm"); TEXT() on a string returns an error and would
 *    break every SUMIFS downstream.
 *  - B and C are left alone wherever a formula already exists, so the sheet keeps
 *    calculating for itself. Past the pre-filled block they are written as values.
 *  - Deleting CLEARS a row instead of removing it, and new rows reuse the first
 *    cleared slot. Deleting rows would eat into the tracker's pre-filled formula
 *    block one row at a time.
 *
 * Setup: Extensions → Apps Script, paste this, set SHARED_TOKEN, run `setup` once,
 * then Deploy → New deployment → Web app → Execute as Me, Access Anyone.
 */

// Long random string. Must match the token in the web app. The script refuses to
// run while this is the placeholder.
var SHARED_TOKEN = 'CHANGE_ME';

var TX_SHEET = 'Transactions';
var BUDGET_SHEET = 'Budget';

var C_DATE = 1, C_MONTH = 2, C_YEAR = 3, C_TYPE = 4, C_CATEGORY = 5, C_SUBCAT = 6,
    C_DESC = 7, C_AMOUNT = 8, C_PAYMENT = 9, C_ACCOUNT = 10, C_RECUR = 11,
    C_NOTES = 12, C_ID = 13, C_PERSON = 14;
var LAST_COL = C_PERSON;

var EXPECTED = ['Date', 'Month', 'Year', 'Type', 'Category', 'Subcategory',
                'Description', 'Amount (CAD)', 'Payment Method', 'Account',
                'Recurring?', 'Notes'];

var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
              'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

var BUDGET_FIRST_MONTH_COL = 3;   // C

/* ------------------------------------------------------------------ plumbing */

function json(o) {
  return ContentService.createTextOutput(JSON.stringify(o))
    .setMimeType(ContentService.MimeType.JSON);
}
function ok(d) { return json(Object.assign({ ok: true }, d)); }
function fail(m, c) { return json({ ok: false, error: String(m), code: c || 'ERROR' }); }

function checkToken(t) {
  if (SHARED_TOKEN === 'CHANGE_ME') {
    throw new Error('SHARED_TOKEN is still the placeholder. Set it in Code.gs first.');
  }
  if (String(t || '') !== SHARED_TOKEN) throw new Error('Bad or missing token.');
}

/** Refuses to touch a workbook whose shape it does not recognise. */
function book() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('No bound spreadsheet — create this script from Extensions > Apps Script inside the Sheet.');

  var tx = ss.getSheetByName(TX_SHEET);
  if (!tx) throw new Error('No "' + TX_SHEET + '" tab. Open the tracker workbook and run this script from there.');

  var head = tx.getRange(1, 1, 1, EXPECTED.length).getValues()[0];
  for (var i = 0; i < EXPECTED.length; i++) {
    if (String(head[i]).trim() !== EXPECTED[i]) {
      throw new Error('Transactions header mismatch in column ' + (i + 1) +
        ': expected "' + EXPECTED[i] + '", found "' + head[i] + '". ' +
        'Do not reorder or rename the header row.');
    }
  }

  var bg = ss.getSheetByName(BUDGET_SHEET);
  if (!bg) throw new Error('No "' + BUDGET_SHEET + '" tab.');

  ensureIdColumn(tx);
  return { ss: ss, tx: tx, bg: bg };
}

/** Adds the ID and Person columns and back-fills ids for pre-existing rows. */
function ensureIdColumn(tx) {
  if (String(tx.getRange(1, C_ID).getValue()).trim() !== 'ID') {
    tx.getRange(1, C_ID).setValue('ID').setFontWeight('bold');
  }
  if (String(tx.getRange(1, C_PERSON).getValue()).trim() !== 'Person') {
    tx.getRange(1, C_PERSON).setValue('Person').setFontWeight('bold');
  }
  var last = tx.getLastRow();
  if (last < 2) return;

  var dates = tx.getRange(2, C_DATE, last - 1, 1).getValues();
  var ids = tx.getRange(2, C_ID, last - 1, 1).getValues();
  var max = 0, missing = false;
  for (var i = 0; i < ids.length; i++) {
    var n = Number(ids[i][0]);
    if (n > max) max = n;
    if (dates[i][0] !== '' && dates[i][0] !== null && !(n > 0)) missing = true;
  }
  if (!missing) return;
  for (var j = 0; j < ids.length; j++) {
    if (dates[j][0] !== '' && dates[j][0] !== null && !(Number(ids[j][0]) > 0)) {
      ids[j][0] = ++max;
    }
  }
  tx.getRange(2, C_ID, ids.length, 1).setValues(ids);
}

function isoDate(v) {
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  return String(v || '').slice(0, 10);
}

function toDateObj(s) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '').slice(0, 10));
  if (!m) throw new Error('Date must be YYYY-MM-DD, got: ' + s);
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/* -------------------------------------------------------------- transactions */

function readTransactions(tx) {
  var last = tx.getLastRow();
  if (last < 2) return [];
  var v = tx.getRange(2, 1, last - 1, LAST_COL).getValues();
  var out = [];
  for (var i = 0; i < v.length; i++) {
    var r = v[i];
    if (r[C_DATE - 1] === '' || r[C_DATE - 1] === null) continue;   // blank / cleared slot
    out.push({
      id: Number(r[C_ID - 1]) || 0,
      date: isoDate(r[C_DATE - 1]),
      type: String(r[C_TYPE - 1] || 'Expense'),
      category: String(r[C_CATEGORY - 1] || ''),
      subcategory: String(r[C_SUBCAT - 1] || ''),
      description: String(r[C_DESC - 1] || ''),
      amount: Number(r[C_AMOUNT - 1]) || 0,
      payment: String(r[C_PAYMENT - 1] || ''),
      account: String(r[C_ACCOUNT - 1] || ''),
      recurring: String(r[C_RECUR - 1] || 'No'),
      notes: String(r[C_NOTES - 1] || ''),
      person: String(r[C_PERSON - 1] || ''),
    });
  }
  out.sort(function (a, b) {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    return b.id - a.id;
  });
  return out;
}

function nextId(tx) {
  var last = tx.getLastRow();
  if (last < 2) return 1;
  var ids = tx.getRange(2, C_ID, last - 1, 1).getValues();
  var max = 0;
  for (var i = 0; i < ids.length; i++) {
    var n = Number(ids[i][0]);
    if (n > max) max = n;
  }
  return max + 1;
}

function findRowById(tx, id) {
  var last = tx.getLastRow();
  if (last < 2) return -1;
  var ids = tx.getRange(2, C_ID, last - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (Number(ids[i][0]) === Number(id)) return i + 2;
  }
  return -1;
}

/** First row whose Date is empty — reuses cleared slots inside the formula block. */
function firstFreeRow(tx) {
  var last = tx.getLastRow();
  if (last < 2) return 2;
  var col = tx.getRange(2, C_DATE, last - 1, 1).getValues();
  for (var i = 0; i < col.length; i++) {
    if (col[i][0] === '' || col[i][0] === null) return i + 2;
  }
  return last + 1;
}

function validate(rec) {
  var amount = Math.abs(Number(rec.amount) || 0);
  if (!(amount > 0)) throw new Error('Amount must be greater than zero.');
  var type = rec.type;
  if (['Expense', 'Income', 'Transfer'].indexOf(type) === -1) type = 'Expense';
  return {
    date: toDateObj(rec.date),
    type: type,
    category: String(rec.category || 'Miscellaneous'),
    subcategory: String(rec.subcategory || ''),
    description: String(rec.description || ''),
    amount: Math.round(amount * 100) / 100,
    payment: String(rec.payment || ''),
    account: String(rec.account || ''),
    recurring: rec.recurring === 'Yes' ? 'Yes' : 'No',
    notes: String(rec.notes || ''),
    person: ['Ramesh', 'Surya', 'Joint'].indexOf(rec.person) === -1 ? '' : rec.person,
  };
}

function writeRow(tx, row, v, id) {
  tx.getRange(row, C_DATE).setValue(v.date).setNumberFormat('yyyy-mm-dd');

  // Leave B and C alone where the tracker's own formulas already live.
  if (String(tx.getRange(row, C_MONTH).getFormula() || '') === '') {
    tx.getRange(row, C_MONTH).setValue(MONTHS[v.date.getMonth()]);
  }
  if (String(tx.getRange(row, C_YEAR).getFormula() || '') === '') {
    tx.getRange(row, C_YEAR).setValue(v.date.getFullYear());
  }

  tx.getRange(row, C_TYPE, 1, C_NOTES - C_TYPE + 1).setValues([[
    v.type, v.category, v.subcategory, v.description, v.amount,
    v.payment, v.account, v.recurring, v.notes]]);
  tx.getRange(row, C_AMOUNT).setNumberFormat('"$"#,##0.00');
  tx.getRange(row, C_ID).setValue(id);
  tx.getRange(row, C_PERSON).setValue(v.person);
}

function recOf(v, id) {
  return {
    id: id, date: isoDate(v.date), type: v.type, category: v.category,
    subcategory: v.subcategory, description: v.description, amount: v.amount,
    payment: v.payment, account: v.account, recurring: v.recurring, notes: v.notes,
    person: v.person,
  };
}

/** Clear rather than delete, so the pre-filled formula block stays intact. */
function clearRow(tx, row) {
  tx.getRange(row, C_DATE).clearContent();
  tx.getRange(row, C_TYPE, 1, C_NOTES - C_TYPE + 1).clearContent();
  tx.getRange(row, C_ID).clearContent();
  tx.getRange(row, C_PERSON).clearContent();
  if (String(tx.getRange(row, C_MONTH).getFormula() || '') === '') {
    tx.getRange(row, C_MONTH, 1, 2).clearContent();
  }
}

/* -------------------------------------------------------------------- budget */

function budgetRowIndex(bg) {
  var last = bg.getLastRow();
  var col = bg.getRange(1, 1, last, 1).getValues();
  var idx = {};
  for (var i = 0; i < col.length; i++) {
    var name = String(col[i][0] || '').trim();
    if (name && name.indexOf('TOTAL') !== 0 && name !== 'Category' && name.indexOf('PLANNED') !== 0) {
      if (!(name in idx)) idx[name] = i + 1;
    }
  }
  return idx;
}

function readBudget(bg) {
  var idx = budgetRowIndex(bg);
  var out = {};
  for (var name in idx) {
    var vals = bg.getRange(idx[name], BUDGET_FIRST_MONTH_COL, 1, 12).getValues()[0];
    var row = {};
    for (var m = 1; m <= 12; m++) row[m] = Number(vals[m - 1]) || 0;
    out[name] = row;
  }
  return out;
}

function writeBudget(bg, budget) {
  var idx = budgetRowIndex(bg);
  var written = 0, unknown = [];
  for (var name in budget) {
    if (!(name in idx)) { unknown.push(name); continue; }
    var line = [];
    for (var m = 1; m <= 12; m++) line.push(Number((budget[name] || {})[m]) || 0);
    // Columns C–N only: B (Type) and O (annual formula) are the sheet's own.
    bg.getRange(idx[name], BUDGET_FIRST_MONTH_COL, 1, 12).setValues([line]);
    written++;
  }
  return { written: written, unknown: unknown };
}

/* ----------------------------------------------------------------- endpoints */

function doGet(e) {
  try {
    var p = (e && e.parameter) || {};
    checkToken(p.token);
    var b = book();
    return ok({
      transactions: readTransactions(b.tx),
      budget: readBudget(b.bg),
      sheetName: b.ss.getName(),
      layout: 'tracker',
    });
  } catch (err) {
    return fail(err.message);
  }
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    if (!lock.tryLock(25000)) return fail('Sheet is busy, try again.', 'LOCKED');

    var body = {};
    if (e && e.postData && e.postData.contents) body = JSON.parse(e.postData.contents);
    checkToken(body.token);

    var b = book();
    var tx = b.tx;

    if (body.action === 'create') {
      var v = validate(body.record || {});
      var id = nextId(tx);
      var row = firstFreeRow(tx);
      writeRow(tx, row, v, id);
      return ok({ record: recOf(v, id) });
    }

    if (body.action === 'bulk') {
      var recs = body.records || [];
      if (!recs.length) return fail('No records supplied.');
      if (recs.length > 500) return fail('Capped at 500 rows per request.');
      var validated = [];
      for (var i = 0; i < recs.length; i++) validated.push(validate(recs[i]));  // all-or-nothing
      var id0 = nextId(tx);
      for (var k = 0; k < validated.length; k++) {
        writeRow(tx, firstFreeRow(tx), validated[k], id0 + k);
      }
      return ok({ inserted: validated.length });
    }

    if (body.action === 'update') {
      var ur = findRowById(tx, body.id);
      if (ur === -1) return fail('No transaction with id ' + body.id, 'NOT_FOUND');
      var uv = validate(body.record || {});
      writeRow(tx, ur, uv, Number(body.id));
      return ok({ record: recOf(uv, Number(body.id)) });
    }

    if (body.action === 'delete') {
      var dr = findRowById(tx, body.id);
      if (dr === -1) return fail('No transaction with id ' + body.id, 'NOT_FOUND');
      clearRow(tx, dr);
      return ok({ deleted: Number(body.id) });
    }

    if (body.action === 'clear') {
      var last = tx.getLastRow();
      for (var r = 2; r <= last; r++) clearRow(tx, r);
      return ok({ cleared: true });
    }

    if (body.action === 'setBudget') {
      var res = writeBudget(b.bg, body.budget || {});
      if (!res.written) return fail('No matching categories found on the Budget tab.');
      return ok(res);
    }

    return fail('Unknown action: ' + body.action, 'BAD_ACTION');
  } catch (err) {
    return fail(err.message);
  } finally {
    try { lock.releaseLock(); } catch (ignored) {}
  }
}

/** Run once from the editor: adds the ID column, back-fills ids, triggers auth. */
function setup() {
  var b = book();
  var rows = readTransactions(b.tx);
  Logger.log('OK. %s transactions, %s budget categories, sheet "%s".',
    rows.length, Object.keys(readBudget(b.bg)).length, b.ss.getName());
}