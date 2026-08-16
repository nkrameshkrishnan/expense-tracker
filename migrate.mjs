#!/usr/bin/env node
/* Migrates a Ledger XLSX export (Transactions, Budget, Debts, Balances
   sheets, same shape produced by the app's own "Download .xlsx" button
   under Data, or a full workbook export) into Supabase/Postgres.

   Usage:
     node migrate.mjs <path-to-export.xlsx> --db-url=postgres://... [--dry-run]
     node migrate.mjs <path-to-export.xlsx> --db-url=... --only=budget,debts

   Runs entirely against a Postgres connection string (works against a real
   Supabase project's connection string, or a local instance for testing) -
   no supabase-js needed for the migration itself, since this is a one-time
   bulk load, not the app's runtime path. Targets the table shapes in
   supabase/schema.sql - verified column-by-column against a real export
   before this was written. Apply that file (Supabase Dashboard -> SQL
   Editor, or `supabase db execute`) before running this.

   RECONCILIATION IS NOT OPTIONAL. This script refuses to report success
   unless every one of these matches exactly between the source XLSX and
   what actually landed in Postgres:
     - total row count (per section)
     - sum of Amount, grouped by Type (transactions) / Kind (debts, balances)
     - for Budget: each category's Jan-Dec sum against the sheet's own
       Annual Total column, BEFORE anything is written
     - for Debts: every payment row's parent link resolves to a real debt
       row after Postgres reassigns ids (see migrateDebts)
   This mirrors the exact discipline used throughout this project's Sheets
   work (the debt-import batch-verification, the $480,533 budget bug caught
   by a totals mismatch, etc.) - a migration that "ran without errors" is
   not the same claim as "the money adds up", and only the second one is
   good enough to actually cut over on.

   Each of the four sections (transactions/budget/debts/balances) is
   independent, with its own "already has rows" guard that SKIPS that
   section rather than aborting the whole run - so re-running this after
   one section is already migrated still lets the others go through. */

import XLSX from "xlsx";
import pg from "pg";

const args = process.argv.slice(2);
const filePath = args.find((a) => !a.startsWith("--"));
const dbUrl = (args.find((a) => a.startsWith("--db-url=")) || "")
  .split("=")
  .slice(1)
  .join("=");
const dryRun = args.includes("--dry-run");
const ALL_SECTIONS = ["transactions", "budget", "debts", "balances"];
const onlyArg = (args.find((a) => a.startsWith("--only=")) || "").slice(7);
// --budget-only / --transactions-only kept as shorthands for the two
// sections people actually need standalone most often (a fresh Sheets
// endpoint usually already has transactions; Budget/Debts/Balances are the
// ones that tend to get backfilled separately afterward).
const sections = onlyArg
  ? onlyArg.split(",").map((s) => s.trim())
  : args.includes("--budget-only")
    ? ["budget"]
    : args.includes("--transactions-only")
      ? ["transactions"]
      : ALL_SECTIONS;
const run = (name) => sections.includes(name);

if (!filePath || !dbUrl) {
  console.error(
    "Usage: node migrate.mjs <export.xlsx> --db-url=postgres://... [--dry-run] [--only=transactions,budget,debts,balances]",
  );
  process.exit(1);
}

const TYPES = ["Expense", "Income", "Transfer", "Dividends"];
const MONTHS = [
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

/* Excel/Sheets serial date -> ISO "YYYY-MM-DD". Real exports mix formats:
   Transactions in this workbook already stores dates as "2026-01-01"
   strings, while Debts/Balances store raw serial numbers (with a fractional
   time-of-day component that never crosses a day boundary in UTC, so
   truncating to 10 chars after conversion is always safe here). Handles
   both by branching on typeof. */
function toISODate(raw) {
  if (typeof raw === "number")
    return new Date(Math.round((raw - 25569) * 86400 * 1000))
      .toISOString()
      .slice(0, 10);
  return String(raw).slice(0, 10);
}

function money(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function reportMismatch(label, source, dest) {
  console.error(
    `  MISMATCH — ${label}: source=${JSON.stringify(source)} db=${JSON.stringify(dest)}`,
  );
}

async function chunkedInsert(client, table, cols, rows, { returning } = {}) {
  const CHUNK = 500;
  const returned = [];
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const values = chunk
      .map(
        (r, ri) =>
          `(${cols.map((_, ci) => `$${ri * cols.length + ci + 1}`).join(",")})`,
      )
      .join(",");
    const params = chunk.flatMap((r) => cols.map((c) => r[c]));
    const sql = `INSERT INTO ${table} (${cols.join(",")}) VALUES ${values}${
      returning ? ` RETURNING ${returning}` : ""
    }`;
    const res = await client.query(sql, params);
    if (returning) returned.push(...res.rows.map((r) => r[returning]));
    process.stderr.write(
      `  inserted ${Math.min(i + CHUNK, rows.length)}/${rows.length}\r`,
    );
  }
  process.stderr.write("\n");
  return returned;
}

/* ------------------------------------------------------------ Transactions */

function readTransactionRows(wb) {
  const sheet = wb.Sheets["Transactions"] || wb.Sheets[wb.SheetNames[0]];
  const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false });
  const header = aoa[0].map((h) =>
    String(h || "")
      .trim()
      .toLowerCase(),
  );
  // Exact match first (was the only strategy - broke against the real
  // export, which has "Amount (CAD)" not "Amount", "Payment Method" not
  // "Payment", "Recurring?" not "Recurring"). Falls back to a prefix match
  // so header variants like these still resolve correctly, instead of
  // either throwing on a required column or - more dangerously - silently
  // leaving an OPTIONAL column like payment/recurring blank for every row
  // with no error at all.
  const col = (name) => {
    const exact = header.indexOf(name);
    if (exact >= 0) return exact;
    return header.findIndex((h) => h.startsWith(name));
  };
  const idx = {
    date: col("date"),
    type: col("type"),
    category: col("category"),
    subcategory: col("subcategory"),
    description: col("description"),
    amount: col("amount"),
    payment: col("payment"),
    account: col("account"),
    recurring: col("recurring"),
    notes: col("notes"),
    person: col("person"),
  };
  if (idx.date < 0 || idx.type < 0 || idx.category < 0 || idx.amount < 0)
    throw new Error(
      "Export is missing required columns (Date/Type/Category/Amount) - is this the right sheet?",
    );

  const rows = [];
  for (let r = 1; r < aoa.length; r++) {
    const row = aoa[r];
    if (!row || row[idx.date] == null || row[idx.date] === "") continue;
    let type = String(row[idx.type] || "Expense").trim();
    if (!TYPES.includes(type)) type = "Expense";
    rows.push({
      date: toISODate(row[idx.date]),
      type,
      category:
        String(row[idx.category] || "Miscellaneous").trim() || "Miscellaneous",
      subcategory:
        idx.subcategory >= 0 ? String(row[idx.subcategory] || "") : "",
      description:
        idx.description >= 0 ? String(row[idx.description] || "") : "",
      amount: Math.abs(money(row[idx.amount])),
      payment: idx.payment >= 0 ? String(row[idx.payment] || "") : "",
      account: idx.account >= 0 ? String(row[idx.account] || "") : "",
      recurring: idx.recurring >= 0 ? String(row[idx.recurring] || "No") : "No",
      notes: idx.notes >= 0 ? String(row[idx.notes] || "") : "",
      person: idx.person >= 0 ? String(row[idx.person] || "") : "",
    });
  }
  return rows;
}

function summarizeTransactions(rows) {
  const byType = {};
  for (const t of TYPES) byType[t] = { count: 0, sum: 0 };
  for (const r of rows) {
    byType[r.type].count++;
    byType[r.type].sum += r.amount;
  }
  for (const t of TYPES) byType[t].sum = money(byType[t].sum);
  return { total: rows.length, byType };
}

async function fetchTransactionsDbSummary(client) {
  const { rows } = await client.query(
    `SELECT type, count(*)::int AS count, coalesce(sum(amount),0)::numeric(14,2) AS sum FROM transactions GROUP BY type`,
  );
  const byType = {};
  for (const t of TYPES) byType[t] = { count: 0, sum: 0 };
  let total = 0;
  for (const r of rows) {
    byType[r.type] = { count: r.count, sum: Number(r.sum) };
    total += r.count;
  }
  return { total, byType };
}

async function migrateTransactions(client, wb) {
  console.log("\n=== Transactions ===");
  const sourceRows = readTransactionRows(wb);
  const sourceSummary = summarizeTransactions(sourceRows);
  console.log(`Parsed ${sourceSummary.total} rows from the export.`);
  for (const t of TYPES)
    console.log(
      `  ${t}: ${sourceSummary.byType[t].count} rows, $${sourceSummary.byType[t].sum.toFixed(2)}`,
    );

  if (dryRun)
    return console.log(
      "--dry-run: parsed and summarized only, nothing written.",
    );

  const { rows: existing } = await client.query(
    "SELECT count(*)::int AS c FROM transactions",
  );
  if (existing[0].c > 0)
    return console.log(
      `Skipping: transactions already has ${existing[0].c} row(s). This script does not deduplicate.`,
    );

  console.log("Inserting into Postgres...");
  const cols = [
    "date",
    "type",
    "category",
    "subcategory",
    "description",
    "amount",
    "payment",
    "account",
    "recurring",
    "notes",
    "person",
  ];
  await chunkedInsert(client, "transactions", cols, sourceRows);

  console.log("Reconciling against what actually landed in the database...");
  const dbSummary = await fetchTransactionsDbSummary(client);
  let allMatch = true;
  if (dbSummary.total !== sourceSummary.total) {
    reportMismatch("total row count", sourceSummary.total, dbSummary.total);
    allMatch = false;
  }
  for (const t of TYPES) {
    const s = sourceSummary.byType[t],
      d = dbSummary.byType[t];
    if (s.count !== d.count) {
      reportMismatch(`${t} row count`, s.count, d.count);
      allMatch = false;
    }
    if (Math.abs(s.sum - d.sum) > 0.01) {
      reportMismatch(`${t} sum`, s.sum, d.sum);
      allMatch = false;
    }
  }
  if (!allMatch) {
    console.error(
      "RECONCILIATION FAILED for transactions. Do NOT cut the app over yet.",
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    "RECONCILED: transactions row counts and type-sums match exactly.",
  );
}

/* ------------------------------------------------------------------ Budget */

// Matches the legacy plain "Budget" tab (implicitly 2026, per README) as well
// as "Budget 2026", "Budget 2027", etc.
function findBudgetSheets(wb) {
  const found = [];
  for (const name of wb.SheetNames) {
    const m = /^Budget(?:\s+(\d{4}))?$/i.exec(name.trim());
    if (m) found.push({ sheetName: name, year: m[1] ? Number(m[1]) : 2026 });
  }
  return found;
}

/* The header row is NOT always row 0. In a real export, "Budget 2027" has
   the header ("Category","Type","Jan",...) as its very first row, but
   "Budget 2026" has two title/instruction rows above it ("MONTHLY BUDGET
   PLAN - 2026 (CAD)", "Blue cells are yours to edit...") first - the same
   workbook, two different layouts. Scans for the row whose first cell is
   literally "Category" instead of assuming a fixed position. */
function findHeaderRowIndex(aoa) {
  for (let i = 0; i < Math.min(aoa.length, 10); i++) {
    if (
      String(aoa[i]?.[0] || "")
        .trim()
        .toLowerCase() === "category"
    )
      return i;
  }
  return -1;
}

/* Wide format in Sheets (Category, Type, Jan..Dec, Annual Total) has to
   become long format for Postgres (year, category, month, amount) - this is
   exactly why a raw CSV export of the Budget tab cannot be imported directly
   through Supabase's Table Editor (its columns will never match a table
   shaped this differently), which is what prompted writing this in the
   first place instead of a one-off hand reshape. */
function readBudgetRows(wb, sheetName, year) {
  const sheet = wb.Sheets[sheetName];
  const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false });
  const headerRow = findHeaderRowIndex(aoa);
  if (headerRow < 0)
    throw new Error(
      `"${sheetName}": could not find a "Category" header row in the first 10 rows.`,
    );
  const header = aoa[headerRow].map((h) => String(h || "").trim());
  const col = (name) =>
    header.findIndex((h) => h.toLowerCase() === name.toLowerCase());
  const catIdx = col("Category");
  const annualIdx =
    col("Annual Total") >= 0 ? col("Annual Total") : col("Annual");
  const monthIdx = MONTHS.map((m) => col(m));
  if (catIdx < 0 || monthIdx.some((i) => i < 0))
    throw new Error(
      `"${sheetName}" is missing required columns (Category, Jan..Dec) - is this really a Budget tab?`,
    );

  const rows = [];
  for (let r = headerRow + 1; r < aoa.length; r++) {
    const row = aoa[r];
    const category = row?.[catIdx];
    if (!category || String(category).trim() === "") continue;
    const catName = String(category).trim();

    let monthSum = 0;
    const monthAmounts = MONTHS.map((_, mi) => {
      const amount = money(row[monthIdx[mi]]);
      monthSum += amount;
      return amount;
    });
    monthSum = money(monthSum);

    // Cross-check against the sheet's OWN Annual Total for this category,
    // before this row is ever trusted enough to write anywhere - a mismatch
    // here means the column mapping above is wrong, not a migration bug.
    if (annualIdx >= 0 && row[annualIdx] != null && row[annualIdx] !== "") {
      const annual = money(row[annualIdx]);
      if (Math.abs(annual - monthSum) > 0.01)
        throw new Error(
          `"${sheetName}" row for "${catName}": Jan-Dec sums to $${monthSum.toFixed(2)} but Annual Total says $${annual.toFixed(2)} - refusing to guess which is right.`,
        );
    }

    // Zero means "not budgeted" throughout this app (assets/store.js
    // emptyBudget(), SupabaseStore.setBudget()) - a zero month is the
    // ABSENCE of a row, not a zero-value row, so this only inserts nonzero
    // months to match exactly what the app itself would have written.
    monthAmounts.forEach((amount, mi) => {
      if (amount) rows.push({ year, category: catName, month: mi + 1, amount });
    });
  }
  return rows;
}

function summarizeBudget(rows) {
  const byYear = {};
  for (const r of rows) {
    byYear[r.year] ||= { count: 0, sum: 0 };
    byYear[r.year].count++;
    byYear[r.year].sum += r.amount;
  }
  for (const y of Object.keys(byYear)) byYear[y].sum = money(byYear[y].sum);
  return { total: rows.length, byYear };
}

async function fetchBudgetDbSummary(client, years) {
  const { rows } = await client.query(
    `SELECT year, count(*)::int AS count, coalesce(sum(amount),0)::numeric(14,2) AS sum FROM budget WHERE year = ANY($1::int[]) GROUP BY year`,
    [years],
  );
  const byYear = {};
  for (const y of years) byYear[y] = { count: 0, sum: 0 };
  let total = 0;
  for (const r of rows) {
    byYear[r.year] = { count: r.count, sum: Number(r.sum) };
    total += r.count;
  }
  return { total, byYear };
}

async function migrateBudget(client, wb) {
  console.log("\n=== Budget ===");
  const sheets = findBudgetSheets(wb);
  if (!sheets.length)
    return console.log(
      'No Budget/"Budget <year>" sheet found in this export - skipping.',
    );

  let sourceRows = [];
  for (const { sheetName, year } of sheets) {
    console.log(`Reading "${sheetName}" as budget year ${year}...`);
    sourceRows = sourceRows.concat(readBudgetRows(wb, sheetName, year));
  }
  const sourceSummary = summarizeBudget(sourceRows);
  console.log(
    `Parsed ${sourceSummary.total} budgeted (year, category, month) rows.`,
  );
  for (const y of Object.keys(sourceSummary.byYear))
    console.log(
      `  ${y}: ${sourceSummary.byYear[y].count} rows, $${sourceSummary.byYear[y].sum.toFixed(2)}`,
    );

  if (dryRun)
    return console.log(
      "--dry-run: parsed and summarized only, nothing written.",
    );

  const years = sheets.map((s) => s.year);
  const { rows: existing } = await client.query(
    "SELECT year, count(*)::int AS c FROM budget WHERE year = ANY($1::int[]) GROUP BY year",
    [years],
  );
  const alreadyPopulated = existing.filter((r) => r.c > 0);
  if (alreadyPopulated.length)
    return console.log(
      `Skipping: budget already has rows for year(s) ${alreadyPopulated.map((r) => r.year).join(", ")}.`,
    );

  console.log("Inserting into Postgres...");
  await chunkedInsert(
    client,
    "budget",
    ["year", "category", "month", "amount"],
    sourceRows,
  );

  console.log("Reconciling against what actually landed in the database...");
  const dbSummary = await fetchBudgetDbSummary(client, years);
  let allMatch = true;
  if (dbSummary.total !== sourceSummary.total) {
    reportMismatch("total row count", sourceSummary.total, dbSummary.total);
    allMatch = false;
  }
  for (const y of years) {
    const s = sourceSummary.byYear[y] || { count: 0, sum: 0 },
      d = dbSummary.byYear[y];
    if (s.count !== d.count) {
      reportMismatch(`${y} row count`, s.count, d.count);
      allMatch = false;
    }
    if (Math.abs(s.sum - d.sum) > 0.01) {
      reportMismatch(`${y} sum`, s.sum, d.sum);
      allMatch = false;
    }
  }
  if (!allMatch) {
    console.error(
      "RECONCILIATION FAILED for budget. Do NOT cut the app over yet.",
    );
    process.exitCode = 1;
    return;
  }
  console.log("RECONCILED: budget row counts and year-sums match exactly.");
}

/* ------------------------------------------------------------------- Debts */

const DEBT_KINDS = ["Debt", "Payment"];

function readDebtRows(wb) {
  const sheet = wb.Sheets["Debts"];
  if (!sheet) return null;
  const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false });
  const header = aoa[0].map((h) =>
    String(h || "")
      .trim()
      .toLowerCase(),
  );
  const col = (name) => header.indexOf(name.toLowerCase());
  const idx = {
    id: col("ID"),
    kind: col("Kind"),
    parentId: col("ParentID"),
    counterparty: col("Counterparty"),
    direction: col("Direction"),
    description: col("Description"),
    date: col("Date"),
    amount: col("Amount"),
    owner: col("Owner"),
    notes: col("Notes"),
  };
  if (
    idx.id < 0 ||
    idx.kind < 0 ||
    idx.counterparty < 0 ||
    idx.date < 0 ||
    idx.amount < 0
  )
    throw new Error(
      '"Debts" is missing required columns (ID/Kind/Counterparty/Date/Amount).',
    );

  const rows = [];
  for (let r = 1; r < aoa.length; r++) {
    const row = aoa[r];
    if (!row || row[idx.id] == null || row[idx.id] === "") continue;
    let kind = String(row[idx.kind] || "Debt").trim();
    if (!DEBT_KINDS.includes(kind)) kind = "Debt";
    // 0 in the source means "no parent" (a root Debt row), not a literal
    // reference to some row with id 0 - Postgres identity columns start at
    // 1, so leaving this as 0 would violate the parent_id FK outright.
    const sourceParentId = Number(row[idx.parentId]) || 0;
    rows.push({
      sourceId: Number(row[idx.id]),
      sourceParentId: sourceParentId > 0 ? sourceParentId : null,
      kind,
      counterparty: String(row[idx.counterparty] || "").trim(),
      direction:
        DEBT_KINDS.includes(kind) &&
        ["Owed", "Lent"].includes(row[idx.direction])
          ? row[idx.direction]
          : "Owed",
      description:
        idx.description >= 0 ? String(row[idx.description] || "") : "",
      date: toISODate(row[idx.date]),
      amount: Math.abs(money(row[idx.amount])),
      owner: idx.owner >= 0 ? String(row[idx.owner] || "") : "",
      notes: idx.notes >= 0 ? String(row[idx.notes] || "") : "",
    });
  }
  return rows;
}

function summarizeDebts(rows) {
  const byKind = {};
  for (const k of DEBT_KINDS) byKind[k] = { count: 0, sum: 0 };
  for (const r of rows) {
    byKind[r.kind].count++;
    byKind[r.kind].sum += r.amount;
  }
  for (const k of DEBT_KINDS) byKind[k].sum = money(byKind[k].sum);
  const linked = rows.filter((r) => r.sourceParentId != null).length;
  return { total: rows.length, byKind, linked };
}

async function fetchDebtsDbSummary(client) {
  const { rows } = await client.query(
    `SELECT kind, count(*)::int AS count, coalesce(sum(amount),0)::numeric(14,2) AS sum FROM debts GROUP BY kind`,
  );
  const byKind = {};
  for (const k of DEBT_KINDS) byKind[k] = { count: 0, sum: 0 };
  let total = 0;
  for (const r of rows) {
    byKind[r.kind] = { count: r.count, sum: Number(r.sum) };
    total += r.count;
  }
  const { rows: linkedRows } = await client.query(
    "SELECT count(*)::int AS c FROM debts WHERE parent_id IS NOT NULL",
  );
  return { total, byKind, linked: linkedRows[0].c };
}

/* Postgres assigns NEW ids on insert that will not match the source
   sheet's own ID column, so ParentID links can't be written in the same
   INSERT. Two passes: (1) insert every row with parent_id left null,
   capturing sourceId -> newId via RETURNING id in the same order the rows
   were given (guaranteed for a plain multi-row VALUES insert with no
   triggers on a fresh table); (2) UPDATE parent_id for every row that had a
   sourceParentId, using that mapping. */
async function migrateDebts(client, wb) {
  console.log("\n=== Debts ===");
  const sourceRows = readDebtRows(wb);
  if (!sourceRows)
    return console.log('No "Debts" sheet found in this export - skipping.');
  const sourceSummary = summarizeDebts(sourceRows);
  console.log(
    `Parsed ${sourceSummary.total} debt/payment rows (${sourceSummary.linked} with a parent link).`,
  );
  for (const k of DEBT_KINDS)
    console.log(
      `  ${k}: ${sourceSummary.byKind[k].count} rows, $${sourceSummary.byKind[k].sum.toFixed(2)}`,
    );

  if (dryRun)
    return console.log(
      "--dry-run: parsed and summarized only, nothing written.",
    );

  const { rows: existing } = await client.query(
    "SELECT count(*)::int AS c FROM debts",
  );
  if (existing[0].c > 0)
    return console.log(
      `Skipping: debts already has ${existing[0].c} row(s). This script does not deduplicate.`,
    );

  console.log("Inserting into Postgres (pass 1: rows, no parent links yet)...");
  const cols = [
    "kind",
    "counterparty",
    "direction",
    "description",
    "date",
    "amount",
    "owner",
    "notes",
  ];
  const newIds = await chunkedInsert(client, "debts", cols, sourceRows, {
    returning: "id",
  });
  const idMap = new Map(sourceRows.map((r, i) => [r.sourceId, newIds[i]]));

  const toLink = sourceRows.filter((r) => r.sourceParentId != null);
  console.log(
    `Inserting into Postgres (pass 2: linking ${toLink.length} payment row(s) to their debt)...`,
  );
  for (const r of toLink) {
    const childId = idMap.get(r.sourceId);
    const parentId = idMap.get(r.sourceParentId);
    if (!parentId) {
      console.error(
        `  Could not resolve parent for source ID ${r.sourceId} (ParentID ${r.sourceParentId} not found among inserted rows).`,
      );
      process.exitCode = 1;
      continue;
    }
    await client.query("UPDATE debts SET parent_id = $1 WHERE id = $2", [
      parentId,
      childId,
    ]);
  }

  console.log("Reconciling against what actually landed in the database...");
  const dbSummary = await fetchDebtsDbSummary(client);
  let allMatch = true;
  if (dbSummary.total !== sourceSummary.total) {
    reportMismatch("total row count", sourceSummary.total, dbSummary.total);
    allMatch = false;
  }
  for (const k of DEBT_KINDS) {
    const s = sourceSummary.byKind[k],
      d = dbSummary.byKind[k];
    if (s.count !== d.count) {
      reportMismatch(`${k} row count`, s.count, d.count);
      allMatch = false;
    }
    if (Math.abs(s.sum - d.sum) > 0.01) {
      reportMismatch(`${k} sum`, s.sum, d.sum);
      allMatch = false;
    }
  }
  if (dbSummary.linked !== sourceSummary.linked) {
    reportMismatch(
      "rows with a resolved parent link",
      sourceSummary.linked,
      dbSummary.linked,
    );
    allMatch = false;
  }
  if (!allMatch || process.exitCode) {
    console.error(
      "RECONCILIATION FAILED for debts. Do NOT cut the app over yet.",
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    "RECONCILED: debts row counts, kind-sums, and parent links all match exactly.",
  );
}

/* ---------------------------------------------------------------- Balances */

const BALANCE_KINDS = ["Asset", "Liability"];

function readBalanceRows(wb) {
  const sheet = wb.Sheets["Balances"];
  if (!sheet) return null;
  const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false });
  const header = aoa[0].map((h) =>
    String(h || "")
      .trim()
      .toLowerCase(),
  );
  const col = (name) => header.indexOf(name.toLowerCase());
  const idx = {
    date: col("Date"),
    account: col("Account"),
    owner: col("Owner"),
    kind: col("Kind"),
    balance: col("Balance"),
    notes: col("Notes"),
  };
  if (idx.date < 0 || idx.account < 0 || idx.kind < 0 || idx.balance < 0)
    throw new Error(
      '"Balances" is missing required columns (Date/Account/Kind/Balance).',
    );

  const rows = [];
  const seen = new Set();
  for (let r = 1; r < aoa.length; r++) {
    const row = aoa[r];
    if (!row || row[idx.date] == null || !row[idx.account]) continue;
    const date = toISODate(row[idx.date]);
    const account = String(row[idx.account]).trim();
    // (date, account) is the table's primary key - a duplicate here would
    // fail the whole batch outright, so this is caught with a clear message
    // up front rather than as an opaque Postgres constraint-violation error
    // partway through the insert.
    const key = `${date}|${account}`;
    if (seen.has(key))
      throw new Error(
        `"Balances" has more than one row for ${account} on ${date} - the (date, account) primary key would reject this.`,
      );
    seen.add(key);
    let kind = String(row[idx.kind] || "").trim();
    if (!BALANCE_KINDS.includes(kind)) kind = "Asset";
    rows.push({
      date,
      account,
      owner: idx.owner >= 0 ? String(row[idx.owner] || "") : "",
      kind,
      balance: money(row[idx.balance]),
      notes: idx.notes >= 0 ? String(row[idx.notes] || "") : "",
    });
  }
  return rows;
}

function summarizeBalances(rows) {
  const byKind = {};
  for (const k of BALANCE_KINDS) byKind[k] = { count: 0, sum: 0 };
  for (const r of rows) {
    byKind[r.kind].count++;
    byKind[r.kind].sum += r.balance;
  }
  for (const k of BALANCE_KINDS) byKind[k].sum = money(byKind[k].sum);
  return { total: rows.length, byKind };
}

async function fetchBalancesDbSummary(client) {
  const { rows } = await client.query(
    `SELECT kind, count(*)::int AS count, coalesce(sum(balance),0)::numeric(14,2) AS sum FROM balances GROUP BY kind`,
  );
  const byKind = {};
  for (const k of BALANCE_KINDS) byKind[k] = { count: 0, sum: 0 };
  let total = 0;
  for (const r of rows) {
    byKind[r.kind] = { count: r.count, sum: Number(r.sum) };
    total += r.count;
  }
  return { total, byKind };
}

async function migrateBalances(client, wb) {
  console.log("\n=== Balances ===");
  const sourceRows = readBalanceRows(wb);
  if (!sourceRows)
    return console.log('No "Balances" sheet found in this export - skipping.');
  const sourceSummary = summarizeBalances(sourceRows);
  console.log(`Parsed ${sourceSummary.total} balance snapshot rows.`);
  for (const k of BALANCE_KINDS)
    console.log(
      `  ${k}: ${sourceSummary.byKind[k].count} rows, $${sourceSummary.byKind[k].sum.toFixed(2)}`,
    );

  if (dryRun)
    return console.log(
      "--dry-run: parsed and summarized only, nothing written.",
    );

  const { rows: existing } = await client.query(
    "SELECT count(*)::int AS c FROM balances",
  );
  if (existing[0].c > 0)
    return console.log(
      `Skipping: balances already has ${existing[0].c} row(s). This script does not deduplicate.`,
    );

  console.log("Inserting into Postgres...");
  await chunkedInsert(
    client,
    "balances",
    ["date", "account", "owner", "kind", "balance", "notes"],
    sourceRows,
  );

  console.log("Reconciling against what actually landed in the database...");
  const dbSummary = await fetchBalancesDbSummary(client);
  let allMatch = true;
  if (dbSummary.total !== sourceSummary.total) {
    reportMismatch("total row count", sourceSummary.total, dbSummary.total);
    allMatch = false;
  }
  for (const k of BALANCE_KINDS) {
    const s = sourceSummary.byKind[k],
      d = dbSummary.byKind[k];
    if (s.count !== d.count) {
      reportMismatch(`${k} row count`, s.count, d.count);
      allMatch = false;
    }
    if (Math.abs(s.sum - d.sum) > 0.01) {
      reportMismatch(`${k} sum`, s.sum, d.sum);
      allMatch = false;
    }
  }
  if (!allMatch) {
    console.error(
      "RECONCILIATION FAILED for balances. Do NOT cut the app over yet.",
    );
    process.exitCode = 1;
    return;
  }
  console.log("RECONCILED: balances row counts and kind-sums match exactly.");
}

/* ---------------------------------------------------------------------- main */

async function main() {
  console.log(`Reading ${filePath}...`);
  const wb = XLSX.readFile(filePath, { cellDates: false });

  const client = dryRun ? null : new pg.Client({ connectionString: dbUrl });
  if (client) await client.connect();
  try {
    if (run("transactions")) await migrateTransactions(client, wb);
    if (run("budget")) await migrateBudget(client, wb);
    if (run("debts")) await migrateDebts(client, wb);
    if (run("balances")) await migrateBalances(client, wb);
  } finally {
    if (client) await client.end();
  }

  if (process.exitCode) {
    console.error(
      "\nOne or more sections failed reconciliation - see MISMATCH lines above.",
    );
  } else if (!dryRun) {
    console.log("\nAll attempted sections reconciled successfully.");
  }
}

main().catch((e) => {
  console.error("Migration failed:", e.message);
  process.exit(1);
});
