import { test } from "node:test";
import assert from "node:assert/strict";
import { freshDb, withTenant, withProvisioning } from "./pg-harness.js";

async function seedTenant(client, name) {
  return withProvisioning(client, "seed-user", async (c) => {
    const { rows } = await c.query(
      `insert into tenants (name) values ($1) returning id`,
      [name],
    );
    return rows[0].id;
  });
}

test("a tenant cannot see another tenant's transactions", async () => {
  const client = await freshDb();
  try {
    const tenantA = await seedTenant(client, "Household A");
    const tenantB = await seedTenant(client, "Household B");

    await withTenant(client, tenantA, "a-user", async (c) => {
      await c.query(
        `insert into transactions (tenant_id, date, amount) values ($1, '2026-01-01', 100)`,
        [tenantA],
      );
    });
    await withTenant(client, tenantB, "b-user", async (c) => {
      await c.query(
        `insert into transactions (tenant_id, date, amount) values ($1, '2026-01-01', 200)`,
        [tenantB],
      );
    });

    const seenByA = await withTenant(client, tenantA, "a-user", async (c) => {
      const { rows } = await c.query(`select amount from transactions`);
      return rows;
    });
    assert.equal(seenByA.length, 1);
    assert.equal(Number(seenByA[0].amount), 100);
  } finally {
    await client.end();
  }
});

test("a tenant cannot insert a row tagged with a different tenant_id", async () => {
  const client = await freshDb();
  try {
    const tenantA = await seedTenant(client, "Household C");
    const tenantB = await seedTenant(client, "Household D");
    await assert.rejects(
      withTenant(client, tenantA, "a-user", async (c) => {
        await c.query(
          `insert into transactions (tenant_id, date, amount) values ($1, '2026-01-01', 50)`,
          [tenantB],
        );
      }),
      /row-level security/,
    );
  } finally {
    await client.end();
  }
});

test("no session context at all sees zero rows across every business table", async () => {
  const client = await freshDb();
  try {
    const tenantA = await seedTenant(client, "Household E");
    await withTenant(client, tenantA, "a-user", async (c) => {
      await c.query(
        `insert into transactions (tenant_id, date, amount) values ($1, '2026-01-01', 10)`,
        [tenantA],
      );
      await c.query(
        `insert into budget (tenant_id, year, category, month, amount) values ($1, 2026, 'Groceries', 1, 500)`,
        [tenantA],
      );
      await c.query(
        `insert into balances (tenant_id, date, account, amount) values ($1, '2026-01-01', 'Chequing', 1000)`,
        [tenantA],
      );
      await c.query(
        `insert into debts (tenant_id, name, amount) values ($1, 'Car loan', 5000)`,
        [tenantA],
      );
    });
    for (const table of ["transactions", "budget", "balances", "debts"]) {
      const { rows } = await client.query(`select * from ${table}`);
      assert.equal(
        rows.length,
        0,
        `${table} should be invisible with no session context set`,
      );
    }
  } finally {
    await client.end();
  }
});
