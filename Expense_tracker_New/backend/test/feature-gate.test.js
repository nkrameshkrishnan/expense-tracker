import { test } from "node:test";
import assert from "node:assert/strict";
import { freshDb, withProvisioning, withTenant, makeExecute } from "./pg-harness.js";
import { listBalances } from "../src/routes/balances.js";
import { listTransactions, listTransactionYears } from "../src/routes/transactions.js";
import { FEATURES } from "../src/plans.js";

async function seedTenantWithData(client, plan) {
  return withProvisioning(client, "seed-user", async (c) => {
    const { rows } = await c.query(`insert into tenants (name, plan) values ($1, $2) returning id`, ["Household", plan]);
    const tenantId = rows[0].id;
    return tenantId;
  });
}

test("getBalances returns nothing for Free tier, even if rows exist", async () => {
  const client = await freshDb();
  try {
    const tenantId = await seedTenantWithData(client, "free");
    await withTenant(client, tenantId, "owner-sub", async (c) => {
      await c.query(`insert into balances (tenant_id, date, account, amount) values ($1, '2026-01-01', 'Chequing', 1000)`, [tenantId]);
    });

    const result = await withTenant(client, tenantId, "owner-sub", (c) =>
      listBalances(makeExecute(c), FEATURES.free),
    );
    assert.deepEqual(result, []);
  } finally {
    await client.end();
  }
});

test("getBalances returns real data for Pro tier", async () => {
  const client = await freshDb();
  try {
    const tenantId = await seedTenantWithData(client, "pro");
    await withTenant(client, tenantId, "owner-sub", async (c) => {
      await c.query(`insert into balances (tenant_id, date, account, amount) values ($1, '2026-01-01', 'Chequing', 1000)`, [tenantId]);
    });

    const result = await withTenant(client, tenantId, "owner-sub", (c) =>
      listBalances(makeExecute(c), FEATURES.pro),
    );
    assert.equal(result.length, 1);
  } finally {
    await client.end();
  }
});

test("listTransactions excludes rows older than 12 months for Free tier", async () => {
  const client = await freshDb();
  try {
    const tenantId = await seedTenantWithData(client, "free");
    const oldDate = new Date();
    oldDate.setFullYear(oldDate.getFullYear() - 2);
    const oldDateStr = oldDate.toISOString().slice(0, 10);
    await withTenant(client, tenantId, "owner-sub", async (c) => {
      await c.query(
        `insert into transactions (tenant_id, date, amount) values ($1, $2, 10), ($1, current_date, 20)`,
        [tenantId, oldDateStr],
      );
    });

    const result = await withTenant(client, tenantId, "owner-sub", (c) =>
      listTransactions(makeExecute(c), {}, FEATURES.free),
    );
    assert.equal(result.length, 1);
    assert.equal(Number(result[0].amount), 20);
  } finally {
    await client.end();
  }
});

test("listTransactionYears only offers years within the Free tier's window", async () => {
  const client = await freshDb();
  try {
    const tenantId = await seedTenantWithData(client, "free");
    const currentYear = new Date().getFullYear();
    await withTenant(client, tenantId, "owner-sub", async (c) => {
      await c.query(
        `insert into transactions (tenant_id, date, amount) values ($1, $2, 10), ($1, $3, 20)`,
        [tenantId, `${currentYear - 5}-01-01`, `${currentYear}-01-01`],
      );
    });

    const years = await withTenant(client, tenantId, "owner-sub", (c) =>
      listTransactionYears(makeExecute(c), FEATURES.free),
    );
    assert.deepEqual(years, [currentYear]);
  } finally {
    await client.end();
  }
});
