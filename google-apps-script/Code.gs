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
 * Setup: Extensions → Apps Script, paste this, set OAUTH_CLIENT_ID and
 * ALLOWED_EMAILS below, run `setup` once, then Deploy → New deployment →
 * Web app → Execute as Me, Access Anyone.
 */

/* ============================ AUTHENTICATION ============================
 * Access is granted by verifying a Google ID token SERVER-SIDE, here in Apps
 * Script. That matters: a check written in the browser can be deleted by
 * whoever is using the browser, so client-side "login" on a static site is
 * decoration. This runs on Google's servers and cannot be bypassed.
 *
 * The browser signs in with Google Identity Services, receives a signed JWT,
 * and sends it with every request. We ask Google whether that JWT is real,
 * whether it was minted for THIS app, and whether the email is on the list.
 * Forging one would require Google's signing key.
 *
 * SETUP (once):
 *  1. console.cloud.google.com -> new project -> APIs & Services -> Credentials
 *  2. Create OAuth client ID -> Web application
 *     Authorised JavaScript origins:
 *       https://nkrameshkrishnan.github.io
 *       http://localhost:8080          (only if you run it locally)
 *  3. Paste the client ID below AND into assets/config.js
 *  4. List the emails allowed in. Everyone else is refused.
 *
 * The client ID is public by design - it is not a secret and appears in the
 * page source. Security comes from the origin restriction plus this check.
 */
var OAUTH_CLIENT_ID = "CHANGE_ME.apps.googleusercontent.com";
var ALLOWED_EMAILS = [
  "ramesh@example.com", // <- your Google account
  "surya@example.com", // <- Surya's Google account
];

/* ------------------------------------------------------- Rate limiting
 * Apps Script web apps never expose the caller's IP, so per-IP limiting
 * genuinely isn't possible here - CacheService counters keyed by identity
 * are the available substitute. Two layers:
 *  - Global: blocks BEFORE the tokeninfo network call, so a flood of
 *    garbage/forged tokens (no email known yet) can't burn UrlFetchApp
 *    quota or Google's rate limit on our behalf.
 *  - Per-email: once a real signed token names an email, that specific
 *    account is throttled separately - catches someone hammering one
 *    real-but-not-allow-listed account without it also locking out the
 *    OTHER household member's legitimate sign-ins in the same window.
 * put() resets the TTL on every failure, so the window keeps sliding
 * forward as long as failures keep coming and only actually expires after
 * a full quiet period - a deliberate simplification of true sliding-window
 * limiting, appropriate for a two-person household app, not a public API. */
var RATE_LIMIT_WINDOW_SEC = 300;
var RATE_LIMIT_MAX_GLOBAL = 20;
var RATE_LIMIT_MAX_PER_EMAIL = 5;

function isRateLimited(cache, key, max) {
  return (Number(cache.get(key)) || 0) >= max;
}
function recordFailure(cache, key) {
  var count = (Number(cache.get(key)) || 0) + 1;
  cache.put(key, String(count), RATE_LIMIT_WINDOW_SEC);
}

/**
 * Verify a Google ID token and confirm the signer is allowed in.
 * Throws on any doubt. Never returns a "maybe".
 */
function requireUser(idToken) {
  var cache = CacheService.getScriptCache();
  if (isRateLimited(cache, "ratelimit:global", RATE_LIMIT_MAX_GLOBAL)) {
    Logger.log("requireUser: rejected - global rate limit exceeded");
    throw new Error(
      "Too many failed sign-in attempts. Try again in a few minutes.",
    );
  }

  if (OAUTH_CLIENT_ID.indexOf("CHANGE_ME") === 0) {
    throw new Error("OAUTH_CLIENT_ID is not configured in Code.gs.");
  }
  if (!idToken) {
    Logger.log("requireUser: rejected - no idToken supplied");
    recordFailure(cache, "ratelimit:global");
    throw new Error("Sign in with Google to continue.");
  }

  // Google's tokeninfo endpoint validates the signature for us, so no crypto
  // library is needed. Cache briefly so a burst of writes is not 200 round trips.
  var digest = Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, idToken),
  );
  var cached = cache.get("idt:" + digest);
  if (cached) return JSON.parse(cached);

  var res = UrlFetchApp.fetch(
    "https://oauth2.googleapis.com/tokeninfo?id_token=" +
      encodeURIComponent(idToken),
    { muteHttpExceptions: true },
  );
  if (res.getResponseCode() !== 200) {
    Logger.log(
      "requireUser: rejected - Google tokeninfo returned " +
        res.getResponseCode(),
    );
    recordFailure(cache, "ratelimit:global");
    throw new Error("Google rejected that sign-in. Sign in again.");
  }

  var info = JSON.parse(res.getContentText());
  if (info.aud !== OAUTH_CLIENT_ID) {
    Logger.log("requireUser: rejected - token issued for a different aud");
    recordFailure(cache, "ratelimit:global");
    throw new Error("That sign-in was issued for a different app.");
  }
  if (String(info.email_verified) !== "true") {
    Logger.log("requireUser: rejected - email not verified");
    recordFailure(cache, "ratelimit:global");
    throw new Error("Google account email is not verified.");
  }
  if (Number(info.exp) * 1000 < Date.now()) {
    Logger.log("requireUser: rejected - token expired");
    recordFailure(cache, "ratelimit:global");
    throw new Error("Sign-in expired. Sign in again.");
  }

  var email = String(info.email || "").toLowerCase();
  if (
    isRateLimited(cache, "ratelimit:email:" + email, RATE_LIMIT_MAX_PER_EMAIL)
  ) {
    Logger.log("requireUser: rejected - per-email rate limit for " + email);
    throw new Error(
      "Too many failed attempts for this account. Try again in a few minutes.",
    );
  }

  var allowed = false;
  for (var i = 0; i < ALLOWED_EMAILS.length; i++) {
    if (String(ALLOWED_EMAILS[i]).toLowerCase() === email) {
      allowed = true;
      break;
    }
  }
  if (!allowed) {
    // Logs the email, not the token - the point is to see WHO was refused
    // (a real allow-list gap vs. someone probing), never a credential.
    Logger.log(
      "requireUser: rejected - " + email + " is not on ALLOWED_EMAILS",
    );
    recordFailure(cache, "ratelimit:global");
    recordFailure(cache, "ratelimit:email:" + email);
    throw new Error(
      "Account " + email + " is not permitted to use this tracker.",
    );
  }

  // Cache until the token expires, capped at 5 minutes.
  var ttl = Math.max(
    0,
    Math.min(300, Number(info.exp) - Math.floor(Date.now() / 1000)),
  );
  if (ttl > 0) cache.put("idt:" + digest, JSON.stringify(info), ttl);
  return info;
}

var TX_SHEET = "Transactions";
/* Budget is per-year: each year gets its own tab ("Budget 2027", "Budget
   2028", ...) rather than one tab with 12 fixed month columns re-used every
   January - that fixed-column design has no way to represent "January 2027"
   distinctly from "January 2026", so setting next year's budget would
   silently overwrite this year's numbers in the same cells.

   The ORIGINAL tracker's tab is named plain "Budget" with no year suffix,
   holding 2026's data specifically - that is a one-time historical fact
   about this specific workbook, not an ongoing pattern. LEGACY_BUDGET_YEAR
   records it so the migration below only ever fires for 2026. */
var LEGACY_BUDGET_YEAR = 2026;

function budgetSheetName(year) {
  return "Budget " + year;
}

/**
 * Resolve (or create) the Budget tab for a specific year.
 *
 * First call for the legacy year renames the original unsuffixed "Budget"
 * tab in place rather than duplicating its data into a second tab - a
 * rename is a single, safe, non-destructive operation, and it only ever
 * fires once (the plain "Budget" name stops existing right after).
 * Every other year gets a freshly created tab with the same structure.
 */
function budgetSheet(ss, year) {
  var name = budgetSheetName(year);
  var bg = ss.getSheetByName(name);
  if (bg) return bg;

  if (year === LEGACY_BUDGET_YEAR) {
    var legacy = ss.getSheetByName("Budget");
    if (legacy) {
      legacy.setName(name);
      return legacy;
    }
  }

  return createBudgetSheet(ss, name);
}

/** Build a fresh Budget tab matching the tracker's existing layout: a
 *  Category/Type pair in A:B, twelve month columns C:N, an Annual Total
 *  formula in O, one row per known category. */
function createBudgetSheet(ss, name) {
  var bg = ss.insertSheet(name);
  var header = [
    "Category",
    "Type",
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
    "Annual Total",
  ];
  bg.getRange(3, 1, 1, header.length).setValues([header]).setFontWeight("bold");
  var cats = [
    ["Salary", "Income"],
    ["Dividends", "Income"],
    ["Other Income", "Income"],
    ["Rent / Housing", "Expense"],
    ["Groceries", "Expense"],
    ["Utilities", "Expense"],
    ["Internet & Phone", "Expense"],
    ["Transport", "Expense"],
    ["Gas", "Expense"],
    ["Dining Out", "Expense"],
    ["Health & Fitness", "Expense"],
    ["Insurance", "Expense"],
    ["Shopping", "Expense"],
    ["Entertainment", "Expense"],
    ["Subscriptions", "Expense"],
    ["Travel", "Expense"],
    ["Education", "Expense"],
    ["Gifts & Donations", "Expense"],
    ["Personal Care", "Expense"],
    ["Savings & Investments", "Expense"],
    ["Miscellaneous", "Expense"],
  ];
  for (var i = 0; i < cats.length; i++) {
    var r = 4 + i;
    bg.getRange(r, 1, 1, 2).setValues([cats[i]]);
    bg.getRange(r, 15).setFormula("=SUM(C" + r + ":N" + r + ")");
  }
  bg.getRange(4, 3, cats.length, 12).setNumberFormat('"$"#,##0.00');
  bg.getRange(4, 15, cats.length, 1).setNumberFormat('"$"#,##0.00');
  bg.setFrozenRows(3);
  return bg;
}

/* Net-worth snapshots live on their own tab, deliberately separate from
   Transactions. A balance answers "what is this account worth today"; a
   transaction answers "where did money move". Mixing them double-counts:
   a TFSA balance already contains the contributions recorded as transfers. */
var BALANCE_SHEET = "Balances";
var BAL_HEADERS = ["Date", "Account", "Owner", "Kind", "Balance", "Notes"];

/* Debts and loans. One tab holds both the agreement and its repayments:
   Kind='Debt' rows carry the principal, Kind='Payment' rows point at a debt
   via ParentID. Outstanding = principal minus payments, computed on read, so
   the running balance can never drift out of step with its own history. */
var DEBT_SHEET = "Debts";
var DEBT_HEADERS = [
  "ID",
  "Kind",
  "ParentID",
  "Counterparty",
  "Direction",
  "Description",
  "Date",
  "Amount",
  "Owner",
  "Notes",
];

var C_DATE = 1,
  C_MONTH = 2,
  C_YEAR = 3,
  C_TYPE = 4,
  C_CATEGORY = 5,
  C_SUBCAT = 6,
  C_DESC = 7,
  C_AMOUNT = 8,
  C_PAYMENT = 9,
  C_ACCOUNT = 10,
  C_RECUR = 11,
  C_NOTES = 12,
  C_ID = 13,
  C_PERSON = 14;
var LAST_COL = C_PERSON;

var EXPECTED = [
  "Date",
  "Month",
  "Year",
  "Type",
  "Category",
  "Subcategory",
  "Description",
  "Amount (CAD)",
  "Payment Method",
  "Account",
  "Recurring?",
  "Notes",
];

var MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

var BUDGET_FIRST_MONTH_COL = 3; // C

/* ------------------------------------------------------------------ plumbing */

function json(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(
    ContentService.MimeType.JSON,
  );
}
function ok(d) {
  return json(Object.assign({ ok: true }, d));
}
function fail(m, c) {
  return json({ ok: false, error: String(m), code: c || "ERROR" });
}

/** Refuses to touch a workbook whose shape it does not recognise. */
function book() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss)
    throw new Error(
      "No bound spreadsheet — create this script from Extensions > Apps Script inside the Sheet.",
    );
  SHEET_TZ = ss.getSpreadsheetTimeZone();

  var tx = ss.getSheetByName(TX_SHEET);
  if (!tx)
    throw new Error(
      'No "' +
        TX_SHEET +
        '" tab. Open the tracker workbook and run this script from there.',
    );

  var head = tx.getRange(1, 1, 1, EXPECTED.length).getValues()[0];
  for (var i = 0; i < EXPECTED.length; i++) {
    if (String(head[i]).trim() !== EXPECTED[i]) {
      throw new Error(
        "Transactions header mismatch in column " +
          (i + 1) +
          ': expected "' +
          EXPECTED[i] +
          '", found "' +
          head[i] +
          '". ' +
          "Do not reorder or rename the header row.",
      );
    }
  }

  ensureIdColumn(tx);
  return { ss: ss, tx: tx };
}

/** Adds the ID and Person columns and back-fills ids for pre-existing rows. */
function ensureIdColumn(tx) {
  if (String(tx.getRange(1, C_ID).getValue()).trim() !== "ID") {
    tx.getRange(1, C_ID).setValue("ID").setFontWeight("bold");
  }
  if (String(tx.getRange(1, C_PERSON).getValue()).trim() !== "Person") {
    tx.getRange(1, C_PERSON).setValue("Person").setFontWeight("bold");
  }
  var last = tx.getLastRow();
  if (last < 2) return;

  var dates = tx.getRange(2, C_DATE, last - 1, 1).getValues();
  var ids = tx.getRange(2, C_ID, last - 1, 1).getValues();
  var max = 0,
    missing = false;
  for (var i = 0; i < ids.length; i++) {
    var n = Number(ids[i][0]);
    if (n > max) max = n;
    if (dates[i][0] !== "" && dates[i][0] !== null && !(n > 0)) missing = true;
  }
  if (!missing) return;
  for (var j = 0; j < ids.length; j++) {
    if (
      dates[j][0] !== "" &&
      dates[j][0] !== null &&
      !(Number(ids[j][0]) > 0)
    ) {
      ids[j][0] = ++max;
    }
  }
  tx.getRange(2, C_ID, ids.length, 1).setValues(ids);
}

/* Cached per request in book(). Session.getScriptTimeZone() reads the Apps
   Script PROJECT's timezone (Project Settings), which is a separate setting
   from the SPREADSHEET's own timezone (File > Settings in Sheets) and very
   commonly does not match it - new Apps Script projects often default to
   America/Los_Angeles regardless of where the sheet itself is configured.
   Formatting or constructing a date through the wrong one of these two clocks
   shifts it by a day whenever write and read happen to straddle midnight in
   the mismatched zone. Using the spreadsheet's own declared timezone for BOTH
   the write and read side removes the mismatch entirely. */
var SHEET_TZ = null;

function isoDate(v) {
  if (v instanceof Date) {
    var tz = SHEET_TZ || Session.getScriptTimeZone();
    return Utilities.formatDate(v, tz, "yyyy-MM-dd");
  }
  return String(v || "").slice(0, 10);
}

function toDateObj(s) {
  var str = String(s || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str))
    throw new Error("Date must be YYYY-MM-DD, got: " + s);
  // Utilities.parseDate takes an EXPLICIT timezone, unlike `new Date(y,m,d)`,
  // which is silently anchored to the Apps Script project's own timezone -
  // exactly the setting that can disagree with the spreadsheet's. Parsing
  // against the spreadsheet's declared timezone keeps write and read
  // symmetric, whatever the script project's own setting happens to be.
  var tz = SHEET_TZ || Session.getScriptTimeZone();
  return Utilities.parseDate(str, tz, "yyyy-MM-dd");
}

/* -------------------------------------------------------------- transactions */

function readTransactions(tx) {
  var last = tx.getLastRow();
  if (last < 2) return [];
  var v = tx.getRange(2, 1, last - 1, LAST_COL).getValues();
  var out = [];
  for (var i = 0; i < v.length; i++) {
    var r = v[i];
    if (r[C_DATE - 1] === "" || r[C_DATE - 1] === null) continue; // blank / cleared slot
    out.push({
      id: Number(r[C_ID - 1]) || 0,
      date: isoDate(r[C_DATE - 1]),
      type: String(r[C_TYPE - 1] || "Expense"),
      category: String(r[C_CATEGORY - 1] || ""),
      subcategory: String(r[C_SUBCAT - 1] || ""),
      description: String(r[C_DESC - 1] || ""),
      amount: Number(r[C_AMOUNT - 1]) || 0,
      payment: String(r[C_PAYMENT - 1] || ""),
      account: String(r[C_ACCOUNT - 1] || ""),
      recurring: String(r[C_RECUR - 1] || "No"),
      notes: String(r[C_NOTES - 1] || ""),
      person: String(r[C_PERSON - 1] || ""),
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
    if (col[i][0] === "" || col[i][0] === null) return i + 2;
  }
  return last + 1;
}

/**
 * Return `count` writable row numbers in one column read.
 *
 * The old firstFreeRow() re-read the whole date column for every inserted row,
 * making a bulk import O(n^2) - roughly half a million cell reads for 687 rows.
 */
function freeRows(tx, count) {
  var last = tx.getLastRow();
  var rows = [];
  if (last >= 2) {
    var col = tx.getRange(2, C_DATE, last - 1, 1).getValues();
    for (var i = 0; i < col.length && rows.length < count; i++) {
      if (col[i][0] === "" || col[i][0] === null) rows.push(i + 2);
    }
  }
  var next = Math.max(last + 1, 2);
  while (rows.length < count) rows.push(next++);
  return rows;
}

/**
 * Write many rows with one setValues per contiguous block instead of ~7 API
 * calls per row. Formula rows keep their own Month/Year; plain rows get values.
 */
function writeRowsBatched(tx, slots, values, id0) {
  var maxRow = 0;
  for (var i = 0; i < slots.length; i++)
    if (slots[i] > maxRow) maxRow = slots[i];

  var existing = tx.getLastRow();
  var monthFormulas =
    existing >= 2 ? tx.getRange(2, C_MONTH, existing - 1, 1).getFormulas() : [];

  // Group consecutive target rows so each run becomes a single setValues call.
  var runs = [],
    run = null;
  for (var j = 0; j < slots.length; j++) {
    if (run && slots[j] === run.start + run.items.length) run.items.push(j);
    else {
      if (run) runs.push(run);
      run = { start: slots[j], items: [j] };
    }
  }
  if (run) runs.push(run);

  for (var k = 0; k < runs.length; k++) {
    var r = runs[k];
    var dates = [],
      body = [],
      meta = [],
      my = [],
      needMY = false;
    for (var m = 0; m < r.items.length; m++) {
      var v = values[r.items[m]];
      dates.push([v.date]);
      body.push([
        v.type,
        v.category,
        v.subcategory,
        v.description,
        v.amount,
        v.payment,
        v.account,
        v.recurring,
        v.notes,
      ]);
      meta.push([id0 + r.items[m], v.person]);
      var rowNo = r.start + m;
      var hasFormula =
        rowNo - 2 < monthFormulas.length &&
        String(monthFormulas[rowNo - 2][0] || "") !== "";
      if (hasFormula) my.push(null);
      else {
        my.push([MONTHS[v.date.getMonth()], v.date.getFullYear()]);
        needMY = true;
      }
    }
    tx.getRange(r.start, C_DATE, dates.length, 1)
      .setValues(dates)
      .setNumberFormat("yyyy-mm-dd");
    tx.getRange(r.start, C_TYPE, body.length, 9).setValues(body);
    tx.getRange(r.start, C_AMOUNT, body.length, 1).setNumberFormat(
      '"$"#,##0.00',
    );
    tx.getRange(r.start, C_ID, meta.length, 2).setValues(meta);

    // Month/Year only where the sheet has no formula of its own.
    if (needMY) {
      for (var q = 0; q < my.length; q++) {
        if (my[q]) tx.getRange(r.start + q, C_MONTH, 1, 2).setValues([my[q]]);
      }
    }
  }
}

function validate(rec) {
  var amount = Math.abs(Number(rec.amount) || 0);
  if (!(amount > 0)) throw new Error("Amount must be greater than zero.");
  var type = rec.type;
  if (["Expense", "Income", "Transfer", "Dividends"].indexOf(type) === -1)
    type = "Expense";
  return {
    date: toDateObj(rec.date),
    type: type,
    category: String(rec.category || "Miscellaneous"),
    subcategory: String(rec.subcategory || ""),
    description: String(rec.description || ""),
    amount: Math.round(amount * 100) / 100,
    payment: String(rec.payment || ""),
    account: String(rec.account || ""),
    recurring: rec.recurring === "Yes" ? "Yes" : "No",
    notes: String(rec.notes || ""),
    person:
      ["Ramesh", "Surya", "Joint"].indexOf(rec.person) === -1 ? "" : rec.person,
  };
}

// The original tracker pre-filled rows 2-501 with =TEXT($A,"mmm")/=YEAR($A)
// formulas in Month/Year; every row past that was always written as plain
// values. At current size (1000+ rows) essentially every add/edit today is
// past this boundary, so checking for a formula is unnecessary work for the
// overwhelming majority of calls - the row number alone already answers it.
var FORMULA_BLOCK_LAST_ROW = 501;

function writeRow(tx, row, v, id) {
  // Was up to 9 separate Range API calls per row (2 formula reads, 5+ writes,
  // 2 format calls) for what is structurally one row of data. Google's own
  // guidance is that batching getValues/setValues is the single biggest
  // lever for Apps Script execution time - this collapses the write to one
  // call in the common case (past the formula block) and two in the rare
  // case (an edit inside the original tracker's formula rows), instead of
  // writing each column as its own round trip.
  var hasFormula =
    row <= FORMULA_BLOCK_LAST_ROW &&
    String(tx.getRange(row, C_MONTH).getFormula() || "") !== "";

  if (hasFormula) {
    // Preserve the existing Month/Year formula: write Date alone, then
    // Type-through-Person as one contiguous block, skipping columns B-C.
    tx.getRange(row, C_DATE).setValue(v.date).setNumberFormat("yyyy-mm-dd");
    tx.getRange(row, C_TYPE, 1, LAST_COL - C_TYPE + 1).setValues([
      [
        v.type,
        v.category,
        v.subcategory,
        v.description,
        v.amount,
        v.payment,
        v.account,
        v.recurring,
        v.notes,
        id,
        v.person,
      ],
    ]);
    tx.getRange(row, C_AMOUNT).setNumberFormat('"$"#,##0.00');
  } else {
    // No formula to protect: the entire row (Date through Person) is one
    // contiguous range, so it is one setValues call.
    tx.getRange(row, C_DATE, 1, LAST_COL).setValues([
      [
        v.date,
        MONTHS[v.date.getMonth()],
        v.date.getFullYear(),
        v.type,
        v.category,
        v.subcategory,
        v.description,
        v.amount,
        v.payment,
        v.account,
        v.recurring,
        v.notes,
        id,
        v.person,
      ],
    ]);
    tx.getRange(row, C_DATE).setNumberFormat("yyyy-mm-dd");
    tx.getRange(row, C_AMOUNT).setNumberFormat('"$"#,##0.00');
  }
}

function recOf(v, id) {
  return {
    id: id,
    date: isoDate(v.date),
    type: v.type,
    category: v.category,
    subcategory: v.subcategory,
    description: v.description,
    amount: v.amount,
    payment: v.payment,
    account: v.account,
    recurring: v.recurring,
    notes: v.notes,
    person: v.person,
  };
}

/** Clear rather than delete, so the pre-filled formula block stays intact. */
function clearRow(tx, row) {
  tx.getRange(row, C_DATE).clearContent();
  tx.getRange(row, C_TYPE, 1, C_NOTES - C_TYPE + 1).clearContent();
  tx.getRange(row, C_ID).clearContent();
  tx.getRange(row, C_PERSON).clearContent();
  if (String(tx.getRange(row, C_MONTH).getFormula() || "") === "") {
    tx.getRange(row, C_MONTH, 1, 2).clearContent();
  }
}

/**
 * Clear every data row in one pass.
 *
 * The per-row version cost 5 API calls per row (~3,600 for a full sheet).
 * Apps Script charges per call, not per cell, so two range-wide clears plus a
 * single formula read is ~1,800x cheaper and does exactly the same thing.
 * B and C are cleared only where no formula lives, using one bulk read.
 */
function clearAllRows(tx) {
  var last = tx.getLastRow();
  if (last < 2) return;
  var n = last - 1;

  tx.getRange(2, C_DATE, n, 1).clearContent(); // A
  tx.getRange(2, C_TYPE, n, C_PERSON - C_TYPE + 1).clearContent(); // D..N

  // Only wipe Month/Year on rows that are plain values, never on formula rows.
  var formulas = tx.getRange(2, C_MONTH, n, 1).getFormulas();
  var runStart = -1;
  for (var i = 0; i <= formulas.length; i++) {
    var plain = i < formulas.length && String(formulas[i][0] || "") === "";
    if (plain && runStart === -1) runStart = i;
    if (!plain && runStart !== -1) {
      tx.getRange(runStart + 2, C_MONTH, i - runStart, 2).clearContent();
      runStart = -1;
    }
  }
}

/* ------------------------------------------------------------------ balances */

function balanceSheet(ss) {
  var bs = ss.getSheetByName(BALANCE_SHEET);
  if (!bs) {
    bs = ss.insertSheet(BALANCE_SHEET);
    bs.getRange(1, 1, 1, BAL_HEADERS.length)
      .setValues([BAL_HEADERS])
      .setFontWeight("bold");
    bs.setFrozenRows(1);
    bs.getRange("A:A").setNumberFormat("yyyy-mm-dd");
    bs.getRange("E:E").setNumberFormat('"$"#,##0.00');
  }
  return bs;
}

function readBalances(bs) {
  var last = bs.getLastRow();
  if (last < 2) return [];
  var v = bs.getRange(2, 1, last - 1, BAL_HEADERS.length).getValues();
  var out = [];
  for (var i = 0; i < v.length; i++) {
    if (v[i][0] === "" || v[i][0] === null) continue;
    out.push({
      date: isoDate(v[i][0]),
      account: String(v[i][1] || ""),
      owner: String(v[i][2] || ""),
      kind: String(v[i][3] || "Asset"),
      balance: Number(v[i][4]) || 0,
      notes: String(v[i][5] || ""),
    });
  }
  out.sort(function (a, b) {
    return a.date < b.date ? 1 : a.date > b.date ? -1 : 0;
  });
  return out;
}

/**
 * Replace every snapshot for a given date in one pass. Recording balances is
 * naturally "here is where everything stood on this day", so a re-save of the
 * same date should overwrite rather than pile up duplicate rows.
 */
function writeBalances(bs, date, entries) {
  var last = bs.getLastRow();
  if (last >= 2) {
    var col = bs.getRange(2, 1, last - 1, 1).getValues();
    for (var i = col.length - 1; i >= 0; i--) {
      if (isoDate(col[i][0]) === date) bs.deleteRow(i + 2);
    }
  }
  if (!entries.length) return 0;
  var rows = [];
  for (var j = 0; j < entries.length; j++) {
    var e = entries[j];
    rows.push([
      toDateObj(date),
      String(e.account || ""),
      String(e.owner || ""),
      e.kind === "Liability" ? "Liability" : "Asset",
      Math.round((Number(e.balance) || 0) * 100) / 100,
      String(e.notes || ""),
    ]);
  }
  var start = bs.getLastRow() + 1;
  bs.getRange(start, 1, rows.length, BAL_HEADERS.length).setValues(rows);
  bs.getRange(start, 1, rows.length, 1).setNumberFormat("yyyy-mm-dd");
  bs.getRange(start, 5, rows.length, 1).setNumberFormat('"$"#,##0.00');
  return rows.length;
}

/* --------------------------------------------------------------------- debts */

function debtSheet(ss) {
  var ds = ss.getSheetByName(DEBT_SHEET);
  if (!ds) {
    ds = ss.insertSheet(DEBT_SHEET);
    ds.getRange(1, 1, 1, DEBT_HEADERS.length)
      .setValues([DEBT_HEADERS])
      .setFontWeight("bold");
    ds.setFrozenRows(1);
    ds.getRange("G:G").setNumberFormat("yyyy-mm-dd");
    ds.getRange("H:H").setNumberFormat('"$"#,##0.00');
  }
  return ds;
}

function readDebts(ds) {
  var last = ds.getLastRow();
  if (last < 2) return [];
  var v = ds.getRange(2, 1, last - 1, DEBT_HEADERS.length).getValues();
  var out = [];
  for (var i = 0; i < v.length; i++) {
    if (v[i][0] === "" || v[i][0] === null) continue;
    out.push({
      id: Number(v[i][0]) || 0,
      kind: String(v[i][1] || "Debt"),
      parentId: v[i][2] === "" || v[i][2] === null ? null : Number(v[i][2]),
      counterparty: String(v[i][3] || ""),
      direction: String(v[i][4] || "Owed"),
      description: String(v[i][5] || ""),
      date: isoDate(v[i][6]),
      amount: Number(v[i][7]) || 0,
      owner: String(v[i][8] || ""),
      notes: String(v[i][9] || ""),
    });
  }
  return out;
}

function nextDebtId(ds) {
  var last = ds.getLastRow();
  if (last < 2) return 1;
  var ids = ds.getRange(2, 1, last - 1, 1).getValues();
  var max = 0;
  for (var i = 0; i < ids.length; i++) {
    var n = Number(ids[i][0]);
    if (n > max) max = n;
  }
  return max + 1;
}

function debtRow(r, id) {
  return [
    id,
    r.kind === "Payment" ? "Payment" : "Debt",
    r.parentId === null || r.parentId === undefined ? "" : Number(r.parentId),
    String(r.counterparty || ""),
    r.direction === "Lent" ? "Lent" : "Owed",
    String(r.description || ""),
    toDateObj(r.date),
    Math.round((Math.abs(Number(r.amount)) || 0) * 100) / 100,
    String(r.owner || ""),
    String(r.notes || ""),
  ];
}

function findDebtRow(ds, id) {
  var last = ds.getLastRow();
  if (last < 2) return -1;
  var ids = ds.getRange(2, 1, last - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++)
    if (Number(ids[i][0]) === Number(id)) return i + 2;
  return -1;
}

/* -------------------------------------------------------------------- budget */

function budgetRowIndex(bg) {
  var last = bg.getLastRow();
  var col = bg.getRange(1, 1, last, 1).getValues();
  var idx = {};
  for (var i = 0; i < col.length; i++) {
    var name = String(col[i][0] || "").trim();
    if (
      name &&
      name.indexOf("TOTAL") !== 0 &&
      name !== "Category" &&
      name.indexOf("PLANNED") !== 0
    ) {
      if (!(name in idx)) idx[name] = i + 1;
    }
  }
  return idx;
}

function readBudget(bg) {
  var idx = budgetRowIndex(bg);
  var out = {};
  for (var name in idx) {
    var vals = bg
      .getRange(idx[name], BUDGET_FIRST_MONTH_COL, 1, 12)
      .getValues()[0];
    var row = {};
    for (var m = 1; m <= 12; m++) row[m] = Number(vals[m - 1]) || 0;
    out[name] = row;
  }
  return out;
}

function writeBudget(bg, budget) {
  var idx = budgetRowIndex(bg);
  var written = 0,
    added = [];
  // A category added in the app won't have a row on the Budget tab yet.
  // Append it rather than silently dropping the budget the user just typed.
  for (var name in budget) {
    if (!(name in idx)) {
      var newRow = bg.getLastRow() + 1;
      bg.getRange(newRow, 1).setValue(name);
      idx[name] = newRow;
      added.push(name);
    }
    var line = [];
    for (var m = 1; m <= 12; m++)
      line.push(Number((budget[name] || {})[m]) || 0);
    // Columns C–N only: B (Type) and O (annual formula) are the sheet's own.
    bg.getRange(idx[name], BUDGET_FIRST_MONTH_COL, 1, 12).setValues([line]);
    written++;
  }
  return { written: written, added: added };
}

/* ----------------------------------------------------------------- endpoints */

function doGet(e) {
  try {
    var p = (e && e.parameter) || {};
    var user = requireUser(p.idToken);
    var b = book();
    // Year defaults to the CALENDAR year at request time (the server's own
    // clock), not any client-supplied default - so a brand new session on
    // Jan 1 2027 correctly asks for 2027's budget without the client having
    // to know to send it. A specific year can still be requested explicitly
    // (used when viewing a past year's Dashboard).
    var year = p.year ? Number(p.year) : new Date().getFullYear();
    return ok({
      transactions: readTransactions(b.tx),
      budget: readBudget(budgetSheet(b.ss, year)),
      budgetYear: year,
      balances: readBalances(balanceSheet(b.ss)),
      debts: readDebts(debtSheet(b.ss)),
      sheetName: b.ss.getName(),
      layout: "tracker",
      user: {
        email: user.email,
        name: user.name || "",
        picture: user.picture || "",
      },
    });
  } catch (err) {
    return fail(err.message);
  }
}

function doPost(e) {
  // Auth verification (requireUser, below) makes an EXTERNAL call to Google's
  // tokeninfo endpoint - real network latency, sometimes a second or more,
  // entirely outside this script's control. The lock used to be acquired
  // BEFORE that call, meaning a second, unrelated, perfectly valid request
  // (Surya adding an entry while Ramesh is also adding one) sat blocked
  // waiting out someone else's auth round trip, before either request's
  // actual sheet work had even started. The lock is scoped to what it
  // actually needs to protect - the sheet mutation itself - not the auth
  // check that happens to run first.
  var lock = LockService.getScriptLock();
  try {
    var body = {};
    if (e && e.postData && e.postData.contents)
      body = JSON.parse(e.postData.contents);
    var user = requireUser(body.idToken);

    if (!lock.tryLock(25000))
      return fail("Sheet is busy, try again.", "LOCKED");

    var b = book();
    var tx = b.tx;

    if (body.action === "create") {
      var v = validate(body.record || {});
      var id = nextId(tx);
      var row = firstFreeRow(tx);
      writeRow(tx, row, v, id);
      return ok({ record: recOf(v, id) });
    }

    if (body.action === "bulk") {
      var recs = body.records || [];
      if (!recs.length) return fail("No records supplied.");
      if (recs.length > 2000) return fail("Capped at 2000 rows per request.");

      var validated = [];
      for (var i = 0; i < recs.length; i++) validated.push(validate(recs[i])); // all-or-nothing

      var id0 = nextId(tx);
      // One scan for free slots instead of re-reading the column per row.
      var slots = freeRows(tx, validated.length);
      writeRowsBatched(tx, slots, validated, id0);
      return ok({ inserted: validated.length });
    }

    if (body.action === "update") {
      var ur = findRowById(tx, body.id);
      if (ur === -1)
        return fail("No transaction with id " + body.id, "NOT_FOUND");
      var uv = validate(body.record || {});
      writeRow(tx, ur, uv, Number(body.id));
      return ok({ record: recOf(uv, Number(body.id)) });
    }

    if (body.action === "delete") {
      var dr = findRowById(tx, body.id);
      if (dr === -1)
        return fail("No transaction with id " + body.id, "NOT_FOUND");
      clearRow(tx, dr);
      return ok({ deleted: Number(body.id) });
    }

    if (body.action === "clear") {
      clearAllRows(tx);
      return ok({ cleared: true });
    }

    if (body.action === "importDebts") {
      // Writes every debt and payment in ONE execution instead of one network
      // round trip per row. The earlier per-row loop made 33 sequential POSTs
      // for a 32-payment ledger; anything that interrupted the browser mid-loop
      // (a network blip, a backgrounded tab, Apps Script throttling rapid
      // requests) left the sheet holding whatever had completed so far and
      // silently dropped the rest - with no error, just a wrong total. A batch
      // either fully lands or fully fails; there is no partial state to land in.
      var ds0 = debtSheet(b.ss);
      var recs = body.records || [];
      if (!recs.length) return fail("No records supplied.");
      if (recs.length > 1000) return fail("Capped at 1000 rows per import.");

      var fileToReal = {};
      var id = nextDebtId(ds0);
      for (var i = 0; i < recs.length; i++) {
        if (recs[i].kind !== "Payment") {
          fileToReal[String(recs[i].fileRef)] = id;
          id++;
        }
      }
      var rows = [],
        nDebts = 0,
        nPayments = 0,
        skipped = 0;
      id = nextDebtId(ds0);
      for (var j = 0; j < recs.length; j++) {
        var r = recs[j];
        if (r.kind !== "Payment") {
          rows.push(debtRow(r, id));
          id++;
          nDebts++;
          continue;
        }
        var parentReal = fileToReal[String(r.parentFileRef)];
        if (!parentReal) {
          skipped++;
          continue;
        } // unlinkable payment: skip, don't corrupt
        rows.push(debtRow(Object.assign({}, r, { parentId: parentReal }), id));
        id++;
        nPayments++;
      }
      if (rows.length) {
        ds0
          .getRange(ds0.getLastRow() + 1, 1, rows.length, DEBT_HEADERS.length)
          .setValues(rows);
      }
      return ok({ debts: nDebts, payments: nPayments, skipped: skipped });
    }

    if (body.action === "addDebt") {
      var ds = debtSheet(b.ss);
      var newId = nextDebtId(ds);
      ds.appendRow(debtRow(body.record || {}, newId));
      return ok({ id: newId });
    }

    if (body.action === "updateDebt") {
      var ur = findDebtRow(debtSheet(b.ss), body.id);
      if (ur === -1) return fail("No debt row with id " + body.id, "NOT_FOUND");
      debtSheet(b.ss)
        .getRange(ur, 1, 1, DEBT_HEADERS.length)
        .setValues([debtRow(body.record || {}, Number(body.id))]);
      return ok({ id: Number(body.id) });
    }

    if (body.action === "deleteDebt") {
      var dsx = debtSheet(b.ss);
      var dr2 = findDebtRow(dsx, body.id);
      if (dr2 === -1)
        return fail("No debt row with id " + body.id, "NOT_FOUND");
      // Removing an agreement must remove its repayments too, or they become
      // orphans that still subtract from a debt that no longer exists.
      var all = readDebts(dsx);
      var kids = [];
      for (var q = 0; q < all.length; q++)
        if (all[q].parentId === Number(body.id)) kids.push(all[q].id);
      for (var z = 0; z < kids.length; z++) {
        var kr = findDebtRow(dsx, kids[z]);
        if (kr !== -1) dsx.deleteRow(kr);
      }
      var again = findDebtRow(dsx, body.id);
      if (again !== -1) dsx.deleteRow(again);
      return ok({ deleted: Number(body.id), paymentsRemoved: kids.length });
    }

    if (body.action === "setBalances") {
      var d = isoDate(body.date);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d))
        return fail("Balance date must be YYYY-MM-DD.");
      var n = writeBalances(balanceSheet(b.ss), d, body.entries || []);
      return ok({ written: n, date: d });
    }

    if (body.action === "deleteBalanceDate") {
      var dd = isoDate(body.date);
      writeBalances(balanceSheet(b.ss), dd, []);
      return ok({ deleted: dd });
    }

    if (body.action === "setBudget") {
      var byear = body.year ? Number(body.year) : new Date().getFullYear();
      var res = writeBudget(budgetSheet(b.ss, byear), body.budget || {});
      if (!res.written)
        return fail("No matching categories found on the Budget tab.");
      return ok(res);
    }

    return fail("Unknown action: " + body.action, "BAD_ACTION");
  } catch (err) {
    return fail(err.message);
  } finally {
    try {
      lock.releaseLock();
    } catch (ignored) {}
  }
}

/** Run once from the editor: adds the ID column, back-fills ids, triggers auth. */
function setup() {
  var b = book();
  var rows = readTransactions(b.tx);
  var year = new Date().getFullYear();
  Logger.log(
    'OK. %s transactions, %s budget categories for %s, sheet "%s".',
    rows.length,
    Object.keys(readBudget(budgetSheet(b.ss, year))).length,
    year,
    b.ss.getName(),
  );
}
