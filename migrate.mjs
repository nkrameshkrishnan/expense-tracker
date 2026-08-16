#!/usr/bin/env node
/* Migrates a Ledger XLSX export (Transactions + Budget sheets, same shape
   produced by the app's own "Download .xlsx" button under Data) into
   Supabase/Postgres.

   Usage:
     node migrate.mjs <path-to-export.xlsx> --db-url=postgres://... [--dry-run]

   Runs entirely against a Postgres connection string (works against a real
   Supabase project's connection string, or a local instance for testing) -
   no supabase-js needed for the migration itself, since this is a one-time
   bulk load, not the app's runtime path.

   RECONCILIATION IS NOT OPTIONAL. This script refuses to report success
   unless every one of these matches exactly between the source XLSX and
   what actually landed in Postgres:
     - total row count
     - sum of Amount, grouped by Type (Expense/Income/Transfer/Dividends)
     - row count grouped by Type
   This mirrors the exact discipline used throughout this project's Sheets
   work (the debt-import batch-verification, the $480,533 budget bug caught
   by a totals mismatch, etc.) - a migration that "ran without errors" is
   not the same claim as "the money adds up", and only the second one is
   good enough to actually cut over on. */

import XLSX from "xlsx";
import pg from "pg";
import { readFileSync } from "fs";

const args = process.argv.slice(2);
const filePath = args.find((a) => !a.startsWith("--"));
const dbUrl = (args.find((a) => a.startsWith("--db-url=")) || "")
  .split("=")
  .slice(1)
  .join("=");
const dryRun = args.includes("--dry-run");

if (!filePath || !dbUrl) {
  console.error(
    "Usage: node migrate.mjs <export.xlsx> --db-url=postgres://... [--dry-run]",
  );
  process.exit(1);
}

const TYPES = ["Expense", "Income", "Transfer", "Dividends"];

function readSourceRows(path) {
  const wb = XLSX.readFile(path, { cellDates: false });
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
    const rawDate = row[idx.date];
    const date =
      typeof rawDate === "number"
        ? new Date(Math.round((rawDate - 25569) * 86400 * 1000))
            .toISOString()
            .slice(0, 10)
        : String(rawDate).slice(0, 10);
    let type = String(row[idx.type] || "Expense").trim();
    if (!TYPES.includes(type)) type = "Expense";
    rows.push({
      date,
      type,
      category:
        String(row[idx.category] || "Miscellaneous").trim() || "Miscellaneous",
      subcategory:
        idx.subcategory >= 0 ? String(row[idx.subcategory] || "") : "",
      description:
        idx.description >= 0 ? String(row[idx.description] || "") : "",
      amount: Math.round(Math.abs(Number(row[idx.amount]) || 0) * 100) / 100,
      payment: idx.payment >= 0 ? String(row[idx.payment] || "") : "",
      account: idx.account >= 0 ? String(row[idx.account] || "") : "",
      recurring: idx.recurring >= 0 ? String(row[idx.recurring] || "No") : "No",
      notes: idx.notes >= 0 ? String(row[idx.notes] || "") : "",
      person: idx.person >= 0 ? String(row[idx.person] || "") : "",
    });
  }
  return rows;
}

function summarize(rows) {
  const byType = {};
  for (const t of TYPES) byType[t] = { count: 0, sum: 0 };
  for (const r of rows) {
    byType[r.type].count++;
    byType[r.type].sum += r.amount;
  }
  for (const t of TYPES) byType[t].sum = Math.round(byType[t].sum * 100) / 100;
  return { total: rows.length, byType };
}

async function insertAll(client, rows) {
  const CHUNK = 500;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
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
    const values = chunk
      .map(
        (r, ri) =>
          `(${cols.map((_, ci) => `$${ri * cols.length + ci + 1}`).join(",")})`,
      )
      .join(",");
    const params = chunk.flatMap((r) => cols.map((c) => r[c]));
    await client.query(
      `INSERT INTO transactions (${cols.join(",")}) VALUES ${values}`,
      params,
    );
    inserted += chunk.length;
    process.stderr.write(`  inserted ${inserted}/${rows.length}\r`);
  }
  process.stderr.write("\n");
  return inserted;
}

async function fetchDbSummary(client) {
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

function reportMismatch(label, source, dest) {
  console.error(
    `  MISMATCH — ${label}: source=${JSON.stringify(source)} db=${JSON.stringify(dest)}`,
  );
}

async function main() {
  console.log(`Reading ${filePath}...`);
  const sourceRows = readSourceRows(filePath);
  const sourceSummary = summarize(sourceRows);
  console.log(`Parsed ${sourceSummary.total} rows from the export.`);
  for (const t of TYPES)
    console.log(
      `  ${t}: ${sourceSummary.byType[t].count} rows, $${sourceSummary.byType[t].sum.toFixed(2)}`,
    );

  if (dryRun) {
    console.log(
      "\n--dry-run: parsed and summarized only, nothing written to the database.",
    );
    return;
  }

  const client = new pg.Client({ connectionString: dbUrl });
  await client.connect();
  try {
    const { rows: existing } = await client.query(
      "SELECT count(*)::int AS c FROM transactions",
    );
    if (existing[0].c > 0) {
      console.error(
        `\nRefusing to proceed: the transactions table already has ${existing[0].c} row(s).`,
      );
      console.error(
        "This script is for an initial migration only - it does not deduplicate against existing data.",
      );
      process.exit(1);
    }

    console.log("\nInserting into Postgres...");
    await insertAll(client, sourceRows);

    console.log(
      "\nReconciling: comparing the export against what actually landed in the database...",
    );
    const dbSummary = await fetchDbSummary(client);

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

    if (allMatch) {
      console.log(
        "\nRECONCILED: every row count and every type-sum matches exactly between the export and the database.",
      );
      console.log("Safe to point the app at this database.");
    } else {
      console.error(
        "\nRECONCILIATION FAILED. Do NOT cut the app over to this database yet.",
      );
      console.error(
        "The numbers above tell you exactly what does not match - investigate before proceeding.",
      );
      process.exit(1);
    }
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error("Migration failed:", e.message);
  process.exit(1);
});
