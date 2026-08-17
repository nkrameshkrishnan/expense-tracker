/* Exercises the REAL functions in src/routes/*.js against a real Postgres
   with the real RLS policies applied - no hand-written INSERT statements,
   no literal tenant_id supplied by the test.

   This file exists because of a specific escaped bug (finding C1): every
   other test seeded its fixture rows with an explicit literal `tenant_id`,
   so nothing ever executed the actual route INSERTs, which supply no
   tenant_id at all. Under FORCE ROW LEVEL SECURITY those inserts failed
   their WITH CHECK on every single business table, and the whole suite
   stayed green. The rule this file encodes: a write path is only covered
   if the covering test calls the exported function that production calls,
   with production-shaped input, inside a tenant-scoped transaction. */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  freshDb,
  withTenant,
  withProvisioning,
  makeExecute,
} from "./pg-harness.js";
import * as tx from "../src/routes/transactions.js";
import * as budget from "../src/routes/budget.js";
import * as balances from "../src/routes/balances.js";
import * as debts from "../src/routes/debts.js";

async function seedTenant(client, name) {
  return withProvisioning(client, "seed-user", async (c) => {
    const { rows } = await c.query(
      `insert into tenants (name) values ($1) returning id`,
      [name],
    );
    return rows[0].id;
  });
}

/** Production-shaped request body: exactly what handler.js hands to
    tx.createTransaction as `payload.record` from the frontend's ApiStore. */
function txRecord(overrides = {}) {
  return {
    date: "2026-03-04",
    type: "Expense",
    category: "Groceries",
    subcategory: "Produce",
    description: "Milk",
    amount: 12.5,
    payment: "Visa",
    account: "Chequing",
    recurring: "No",
    notes: "",
    person: "Ramesh",
    ...overrides,
  };
}

test("createTransaction writes a row stamped with the caller's tenant_id", async () => {
  const client = await freshDb();
  try {
    const tenantId = await seedTenant(client, "Household");
    const row = await withTenant(client, tenantId, "owner-sub", async (c) =>
      tx.createTransaction(makeExecute(c), txRecord()),
    );
    assert.equal(row.tenant_id, tenantId);
    assert.equal(Number(row.amount), 12.5);
    assert.equal(row.category, "Groceries");
  } finally {
    await client.end();
  }
});

test("transactions round-trip: bulk insert, list, years, update, delete, clear", async () => {
  const client = await freshDb();
  try {
    const tenantId = await seedTenant(client, "Household");
    await withTenant(client, tenantId, "owner-sub", async (c) => {
      const execute = makeExecute(c);

      const inserted = await tx.bulkInsertTransactions(execute, [
        txRecord({ date: "2025-06-01", amount: 10 }),
        txRecord({ date: "2026-01-15", amount: 20 }),
      ]);
      assert.equal(inserted, 2);

      const all = await tx.listTransactions(execute, {});
      assert.equal(all.length, 2);
      for (const r of all) assert.equal(r.tenant_id, tenantId);

      // Covers finding I3: this ran `extract(year from date)::int` on every
      // GET /data, and the Data API's named-param parser reads `:int` as an
      // unbound bind param. The harness's execute shim reproduces that.
      const years = await tx.listTransactionYears(execute);
      assert.deepEqual(years, [2026, 2025]);

      const scoped = await tx.listTransactions(execute, { txYear: 2026 });
      assert.equal(scoped.length, 1);
      assert.equal(Number(scoped[0].amount), 20);

      const updated = await tx.updateTransaction(
        execute,
        scoped[0].id,
        txRecord({ date: "2026-01-15", amount: 99.99, description: "Edited" }),
      );
      assert.equal(updated.tenant_id, tenantId);
      assert.equal(updated.description, "Edited");
      assert.equal(Number(updated.amount), 99.99);

      await tx.deleteTransaction(execute, scoped[0].id);
      assert.equal((await tx.listTransactions(execute, {})).length, 1);

      await tx.clearTransactions(execute);
      assert.equal((await tx.listTransactions(execute, {})).length, 0);
    });
  } finally {
    await client.end();
  }
});

test("setBudgetRows writes rows stamped with the caller's tenant_id", async () => {
  const client = await freshDb();
  try {
    const tenantId = await seedTenant(client, "Household");
    await withTenant(client, tenantId, "owner-sub", async (c) => {
      const execute = makeExecute(c);
      await budget.setBudgetRows(execute, 2026, {
        Groceries: { 1: 500, 2: 0, 3: 250.25 }, // 0 means "not budgeted" - skipped
      });
      const rows = await budget.getBudgetRows(execute, 2026);
      assert.equal(rows.length, 2);
      for (const r of rows) assert.equal(r.tenant_id, tenantId);
      const byMonth = Object.fromEntries(
        rows.map((r) => [r.month, Number(r.amount)]),
      );
      assert.deepEqual(byMonth, { 1: 500, 3: 250.25 });
    });
  } finally {
    await client.end();
  }
});

test("setBalances writes rows stamped with the caller's tenant_id", async () => {
  const client = await freshDb();
  try {
    const tenantId = await seedTenant(client, "Household");
    await withTenant(client, tenantId, "owner-sub", async (c) => {
      const execute = makeExecute(c);
      await balances.setBalances(execute, "2026-02-28", [
        { account: "Chequing", amount: 1000, owner: "Ramesh", kind: "Asset" },
        { account: "Visa", amount: 250.5, owner: "Joint", kind: "Liability" },
      ]);
      const rows = await balances.listBalances(execute);
      assert.equal(rows.length, 2);
      for (const r of rows) assert.equal(r.tenant_id, tenantId);

      await balances.deleteBalanceDate(execute, "2026-02-28");
      assert.equal((await balances.listBalances(execute)).length, 0);
    });
  } finally {
    await client.end();
  }
});

test("addDebt/importDebts write rows stamped with the caller's tenant_id", async () => {
  const client = await freshDb();
  try {
    const tenantId = await seedTenant(client, "Household");
    await withTenant(client, tenantId, "owner-sub", async (c) => {
      const execute = makeExecute(c);

      const id = await debts.addDebt(execute, {
        kind: "Debt",
        name: "Car loan",
        amount: 5000,
        date: "2026-01-01",
        notes: "",
      });
      assert.ok(id);

      await debts.updateDebt(execute, id, {
        kind: "Debt",
        name: "Car loan (refi)",
        amount: 4500,
        date: "2026-01-01",
        notes: "refinanced",
      });

      const summary = await debts.importDebts(execute, [
        {
          fileRef: 1,
          kind: "Debt",
          name: "Line of credit",
          amount: 900,
          date: "2026-02-01",
        },
        {
          parentFileRef: 1,
          kind: "Payment",
          name: "LOC payment",
          amount: 100,
          date: "2026-03-01",
        },
        {
          parentFileRef: 99,
          kind: "Payment",
          name: "Orphan",
          amount: 5,
          date: "2026-03-01",
        },
      ]);
      assert.deepEqual(summary, { debts: 1, payments: 1, skipped: 1 });

      const rows = await debts.listDebts(execute);
      assert.equal(rows.length, 3);
      for (const r of rows) assert.equal(r.tenant_id, tenantId);
      assert.ok(rows.some((r) => r.name === "Car loan (refi)"));

      await debts.deleteDebt(execute, id);
      assert.equal((await debts.listDebts(execute)).length, 2);
    });
  } finally {
    await client.end();
  }
});

test("route writes land in the calling tenant only, never another one", async () => {
  const client = await freshDb();
  try {
    const tenantA = await seedTenant(client, "Household A");
    const tenantB = await seedTenant(client, "Household B");

    await withTenant(client, tenantA, "a-sub", async (c) =>
      tx.createTransaction(makeExecute(c), txRecord({ description: "A row" })),
    );
    await withTenant(client, tenantB, "b-sub", async (c) =>
      tx.createTransaction(makeExecute(c), txRecord({ description: "B row" })),
    );

    const seenByA = await withTenant(client, tenantA, "a-sub", async (c) =>
      tx.listTransactions(makeExecute(c), {}),
    );
    assert.equal(seenByA.length, 1);
    assert.equal(seenByA[0].description, "A row");
    assert.equal(seenByA[0].tenant_id, tenantA);

    // Belt and braces: read past RLS as the table owner would see it if the
    // default had stamped the wrong tenant.
    const seenByB = await withTenant(client, tenantB, "b-sub", async (c) =>
      tx.listTransactions(makeExecute(c), {}),
    );
    assert.equal(seenByB.length, 1);
    assert.equal(seenByB[0].description, "B row");
    assert.equal(seenByB[0].tenant_id, tenantB);
  } finally {
    await client.end();
  }
});
