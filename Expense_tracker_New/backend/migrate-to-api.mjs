#!/usr/bin/env node
/* One-time migration: pulls all data from the ORIGINAL repo's Google
   Sheets backend (Code.gs) and pushes it into the new API as tenant #1.

   Usage:
     node migrate-to-api.mjs \
       --source-endpoint=<original Sheets Apps Script /exec URL> \
       --api-endpoint=<new API base URL> \
       --id-token=<a valid Cognito ID token for the target tenant's owner>

   Run this AFTER the owner has signed up once through the new frontend
   (so a tenant + owner tenant_users row already exist) — this script does
   not create tenants itself, it only writes transactions/budget/balances/
   debts into whichever tenant the given id-token belongs to. */

import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    "source-endpoint": { type: "string" },
    "api-endpoint": { type: "string" },
    "id-token": { type: "string" },
  },
});

for (const required of ["source-endpoint", "api-endpoint", "id-token"]) {
  if (!args[required]) {
    console.error(`Missing --${required}`);
    process.exit(1);
  }
}

async function fetchSourceData() {
  const url = `${args["source-endpoint"]}?idToken=${encodeURIComponent(args["id-token"])}`;
  const res = await fetch(url);
  if (!res.ok)
    throw new Error(`Source Sheets endpoint responded ${res.status}`);
  return res.json();
}

async function postToApi(action, body) {
  const res = await fetch(`${args["api-endpoint"]}/data`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${args["id-token"]}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ action, ...body }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`${action} failed: ${data.error}`);
  return data;
}

async function main() {
  console.log("Fetching source data...");
  const source = await fetchSourceData();
  console.log(`Fetched ${source.transactions?.length || 0} transactions.`);

  if (source.transactions?.length) {
    const CHUNK = 500;
    for (let i = 0; i < source.transactions.length; i += CHUNK) {
      const chunk = source.transactions.slice(i, i + CHUNK);
      const { inserted } = await postToApi("bulk", { records: chunk });
      console.log(`Inserted ${inserted} (batch ${i / CHUNK + 1}).`);
    }
  }

  if (source.budget) {
    await postToApi("setBudget", {
      budget: source.budget,
      year: source.budgetYear || new Date().getFullYear(),
    });
    console.log("Budget migrated.");
  }

  if (source.balances?.length) {
    const byDate = {};
    for (const b of source.balances) (byDate[b.date] ||= []).push(b);
    for (const [date, entries] of Object.entries(byDate))
      await postToApi("setBalances", { date, entries });
    console.log(
      `Balances migrated (${Object.keys(byDate).length} snapshot dates).`,
    );
  }

  if (source.debts?.length) {
    const { debts, payments, skipped } = await postToApi("importDebts", {
      records: source.debts,
    });
    console.log(
      `Debts migrated: ${debts} debts, ${payments} payments, ${skipped} skipped.`,
    );
  }

  console.log("Migration complete.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
