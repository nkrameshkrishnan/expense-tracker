/* Regression coverage for finding I5: routes/*.js passed the raw client
   request body straight into SQL bind params — no amount coercion, no type
   allow-listing, no date handling.

   The policy under test (stated in full in src/validate.js): COERCE where
   the caller's intent is unambiguous, REJECT where it is not. So these
   tests come in two shapes, and which shape applies to which field is the
   thing being pinned down:

     - coerced:  negative amount, unknown type, blank category, unknown
                 balance kind, a timestamp where a date was expected
     - rejected: missing/malformed date, non-numeric amount, a blank
                 balance account, a non-array bulk payload

   Everything that touches the database drives the REAL exported route
   functions inside a real tenant-scoped transaction, following the rule
   routes-write.test.js established for finding C1: a write path is only
   covered if the covering test calls the function production calls. */

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
import { FEATURES } from "../src/plans.js";
import {
  ValidationError,
  money,
  isoDate,
  validateTransaction,
} from "../src/validate.js";

async function seedTenant(client, name) {
  return withProvisioning(client, "seed-user", async (c) => {
    const { rows } = await c.query(
      `insert into tenants (name) values ($1) returning id`,
      [name],
    );
    return rows[0].id;
  });
}

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

/* ------------------------------------------------- unit: the rules alone */

test("money(): coerces sign and cents, rejects garbage", () => {
  // Amount is a magnitude; type/kind/direction carries the sign.
  assert.equal(money(-42.5), 42.5);
  assert.equal(money("12.345"), 12.35); // rounded to cents
  assert.equal(money(""), 0); // "unset" is unambiguous
  assert.equal(money(null), 0);
  assert.equal(money(undefined), 0);

  // Divergence from the client-side reference's `Number(x) || 0`, which
  // would silently store 0 and lose the user's data.
  assert.throws(() => money("abc"), ValidationError);
  assert.throws(() => money(NaN), ValidationError);
  assert.throws(() => money(Infinity), ValidationError);
  assert.throws(() => money({}), ValidationError);
  assert.throws(() => money(1e15), ValidationError); // exceeds numeric(12,2)
});

test("isoDate(): truncates to YYYY-MM-DD, rejects unusable values", () => {
  assert.equal(isoDate("2026-03-04"), "2026-03-04");
  assert.equal(isoDate("2026-03-04T18:22:00.000Z"), "2026-03-04"); // slice(0,10)

  assert.throws(() => isoDate(undefined), ValidationError);
  assert.throws(() => isoDate(""), ValidationError);
  assert.throws(() => isoDate("not-a-date"), ValidationError);
  assert.throws(() => isoDate("04/03/2026"), ValidationError);
  // Right shape, not a real day — would otherwise reach Postgres as a 500.
  assert.throws(() => isoDate("2026-02-31"), ValidationError);

  // Optional-date fields (debts.date is nullable in db/schema.sql).
  assert.equal(isoDate("", "date", { required: false }), null);
});

test("validateTransaction() strips keys that are not real columns", () => {
  // An attacker-supplied tenant_id must not reach a bind param and race
  // the schema default that finding C1 introduced.
  const clean = validateTransaction(
    txRecord({ tenant_id: "00000000-0000-0000-0000-000000000000", id: 999 }),
  );
  assert.equal(clean.tenant_id, undefined);
  assert.equal(clean.id, undefined);
});

/* --------------------------------- integration: the real write functions */

test("createTransaction stores a well-formed record exactly as given", async () => {
  const client = await freshDb();
  try {
    const tenantId = await seedTenant(client, "Household");
    // notes overridden to a non-empty value deliberately - the fixture's
    // default "" can't distinguish "round-tripped" from "silently dropped
    // and defaulted", which is exactly how this field went missing before.
    const row = await withTenant(client, tenantId, "owner-sub", (c) =>
      tx.createTransaction(
        makeExecute(c),
        txRecord({ notes: "MY IMPORTANT NOTE" }),
      ),
    );
    assert.equal(row.tenant_id, tenantId);
    // Every field round-trips untouched — validation must not "helpfully"
    // rewrite good input.
    assert.equal(row.date.toISOString().slice(0, 10), "2026-03-04");
    assert.equal(row.type, "Expense");
    assert.equal(row.category, "Groceries");
    assert.equal(row.subcategory, "Produce");
    assert.equal(row.description, "Milk");
    assert.equal(Number(row.amount), 12.5);
    assert.equal(row.payment, "Visa");
    assert.equal(row.account, "Chequing");
    assert.equal(row.recurring, "No");
    assert.equal(row.notes, "MY IMPORTANT NOTE");
    assert.equal(row.person, "Ramesh");
  } finally {
    await client.end();
  }
});

test("createTransaction rejects a malformed record instead of storing it", async () => {
  const client = await freshDb();
  try {
    const tenantId = await seedTenant(client, "Household");
    await withTenant(client, tenantId, "owner-sub", async (c) => {
      const execute = makeExecute(c);

      // Missing date: no defensible default, so this is a hard reject.
      await assert.rejects(
        () => tx.createTransaction(execute, txRecord({ date: undefined })),
        (err) =>
          err instanceof ValidationError &&
          /date is required/i.test(err.message),
      );

      await assert.rejects(
        () => tx.createTransaction(execute, txRecord({ date: "03-04-2026" })),
        ValidationError,
      );

      // Non-numeric amount: would previously have stored 0 silently.
      await assert.rejects(
        () => tx.createTransaction(execute, txRecord({ amount: "twelve" })),
        ValidationError,
      );

      await assert.rejects(
        () => tx.createTransaction(execute, undefined),
        ValidationError,
      );

      await assert.rejects(
        () => tx.bulkInsertTransactions(execute, "not-an-array"),
        ValidationError,
      );
    });

    // Nothing above may have left a row behind.
    const rows = await withTenant(client, tenantId, "owner-sub", (c) =>
      tx.listTransactions(makeExecute(c), {}, FEATURES.family),
    );
    assert.equal(rows.length, 0);
  } finally {
    await client.end();
  }
});

test("createTransaction coerces recoverable input rather than rejecting it", async () => {
  const client = await freshDb();
  try {
    const tenantId = await seedTenant(client, "Household");
    const row = await withTenant(client, tenantId, "owner-sub", (c) =>
      tx.createTransaction(
        makeExecute(c),
        txRecord({
          amount: -99.994, // magnitude + rounded to cents
          type: "Refund", // not in TYPES
          category: "   ", // blank after trimming
          recurring: "maybe", // anything but "Yes"
          date: "2026-03-04T23:59:59Z", // full timestamp
        }),
      ),
    );
    assert.equal(Number(row.amount), 99.99);
    assert.equal(row.type, "Expense");
    assert.equal(row.category, "Miscellaneous");
    assert.equal(row.recurring, "No");
    assert.equal(row.date.toISOString().slice(0, 10), "2026-03-04");
  } finally {
    await client.end();
  }
});

test("a rejected bulk import leaves no partial rows behind", async () => {
  const client = await freshDb();
  try {
    const tenantId = await seedTenant(client, "Household");

    // The bad record is second, so the first has already been inserted
    // when validation throws — the surrounding transaction must undo it.
    await assert.rejects(
      () =>
        withTenant(client, tenantId, "owner-sub", (c) =>
          tx.bulkInsertTransactions(makeExecute(c), [
            txRecord({ description: "good" }),
            txRecord({ description: "bad", date: "" }),
          ]),
        ),
      ValidationError,
    );

    const rows = await withTenant(client, tenantId, "owner-sub", (c) =>
      tx.listTransactions(makeExecute(c), {}, FEATURES.family),
    );
    assert.equal(rows.length, 0, "a half-imported file must not survive");
  } finally {
    await client.end();
  }
});

test("setBudgetRows validates the year before deleting anything", async () => {
  const client = await freshDb();
  try {
    const tenantId = await seedTenant(client, "Household");
    await withTenant(client, tenantId, "owner-sub", async (c) => {
      const execute = makeExecute(c);
      await budget.setBudgetRows(execute, 2026, { Groceries: { 1: 500 } });

      await assert.rejects(
        () => budget.setBudgetRows(execute, "not-a-year", { X: { 1: 5 } }),
        ValidationError,
      );
      await assert.rejects(
        () => budget.setBudgetRows(execute, 2026, { X: { 1: "abc" } }),
        ValidationError,
      );

      // The existing data survives BOTH bad calls. The bad-year call never
      // reaches a statement at all; the bad-amount call has a valid year
      // (2026) and so would have deleted this very row had validation run
      // per-cell instead of over the whole payload first.
      const rows = await budget.getBudgetRows(execute, 2026);
      assert.equal(rows.length, 1);
      assert.equal(Number(rows[0].amount), 500);
    });
  } finally {
    await client.end();
  }
});

test("setBalances coerces amounts and kinds, rejects a blank account", async () => {
  const client = await freshDb();
  try {
    const tenantId = await seedTenant(client, "Household");
    await withTenant(client, tenantId, "owner-sub", async (c) => {
      const execute = makeExecute(c);

      await balances.setBalances(execute, "2026-02-28", [
        { account: "Visa", amount: -250.555, owner: "Joint", kind: "Bogus" },
      ]);
      const rows = await balances.listBalances(execute, FEATURES.family);
      assert.equal(rows.length, 1);
      assert.equal(Number(rows[0].amount), 250.56); // abs + cents
      assert.equal(rows[0].kind, "Asset"); // unknown kind falls back

      // account is `not null` and half the primary key — a blank one makes
      // a row the UI can never edit or delete, so it is rejected.
      await assert.rejects(
        () =>
          balances.setBalances(execute, "2026-03-31", [
            { account: "  ", amount: 5 },
          ]),
        ValidationError,
      );
      await assert.rejects(
        () => balances.setBalances(execute, "nope", [{ account: "A" }]),
        ValidationError,
      );
      await assert.rejects(
        () => balances.deleteBalanceDate(execute, "nope"),
        ValidationError,
      );
    });
  } finally {
    await client.end();
  }
});

test("addDebt coerces amount, keeps a null date, rejects a bad one", async () => {
  const client = await freshDb();
  try {
    const tenantId = await seedTenant(client, "Household");
    await withTenant(client, tenantId, "owner-sub", async (c) => {
      const execute = makeExecute(c);

      // debts.date is nullable, so an absent date is allowed here — unlike
      // transactions.date, which is `not null`.
      const id = await debts.addDebt(execute, {
        kind: "Debt",
        name: "Car loan",
        amount: -5000.004,
      });
      const [row] = await debts.listDebts(execute);
      assert.equal(row.id, id);
      assert.equal(Number(row.amount), 5000);
      assert.equal(row.date, null);

      await assert.rejects(
        () => debts.addDebt(execute, { name: "X", amount: "lots" }),
        ValidationError,
      );
      await assert.rejects(
        () => debts.addDebt(execute, { name: "X", date: "2026-13-01" }),
        ValidationError,
      );
      await assert.rejects(
        () => debts.addDebt(execute, { name: "X", parentId: "abc" }),
        ValidationError,
      );
      await assert.rejects(
        () => debts.importDebts(execute, "not-an-array"),
        ValidationError,
      );
    });
  } finally {
    await client.end();
  }
});
