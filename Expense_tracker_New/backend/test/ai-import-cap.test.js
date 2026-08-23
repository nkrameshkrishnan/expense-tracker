import { test } from "node:test";
import assert from "node:assert/strict";
import {
  freshDb,
  withProvisioning,
  withTenant,
  makeExecute,
} from "./pg-harness.js";
import { countThisMonth, recordAttempt } from "../src/routes/aiImportCap.js";

async function seedTenant(client, name) {
  return withProvisioning(client, "seed-user", async (c) => {
    const { rows } = await c.query(
      `insert into tenants (name) values ($1) returning id`,
      [name],
    );
    return rows[0].id;
  });
}

test("countThisMonth is 0 for a tenant with no attempts", async () => {
  const client = await freshDb();
  try {
    const tenantId = await seedTenant(client, "Household");
    const count = await withTenant(client, tenantId, "owner-sub", (c) =>
      countThisMonth(makeExecute(c)),
    );
    assert.equal(count, 0);
  } finally {
    await client.end();
  }
});

test("recordAttempt increments the count", async () => {
  const client = await freshDb();
  try {
    const tenantId = await seedTenant(client, "Household");
    await withTenant(client, tenantId, "owner-sub", (c) =>
      recordAttempt(makeExecute(c)),
    );
    await withTenant(client, tenantId, "owner-sub", (c) =>
      recordAttempt(makeExecute(c)),
    );
    const count = await withTenant(client, tenantId, "owner-sub", (c) =>
      countThisMonth(makeExecute(c)),
    );
    assert.equal(count, 2);
  } finally {
    await client.end();
  }
});

test("countThisMonth excludes attempts from a previous month", async () => {
  const client = await freshDb();
  try {
    const tenantId = await seedTenant(client, "Household");
    // Insert a backdated row directly - recordAttempt always uses now(),
    // so this is the only way to put a "last month" row in place.
    await withTenant(client, tenantId, "owner-sub", (c) =>
      c.query(
        `insert into ai_imports (tenant_id, created_at) values ($1, now() - interval '40 days')`,
        [tenantId],
      ),
    );
    const count = await withTenant(client, tenantId, "owner-sub", (c) =>
      countThisMonth(makeExecute(c)),
    );
    assert.equal(count, 0);
  } finally {
    await client.end();
  }
});

test("counts are isolated per tenant (RLS)", async () => {
  const client = await freshDb();
  try {
    const tenantA = await seedTenant(client, "Household A");
    const tenantB = await seedTenant(client, "Household B");
    await withTenant(client, tenantA, "owner-a", (c) =>
      recordAttempt(makeExecute(c)),
    );
    await withTenant(client, tenantA, "owner-a", (c) =>
      recordAttempt(makeExecute(c)),
    );
    await withTenant(client, tenantB, "owner-b", (c) =>
      recordAttempt(makeExecute(c)),
    );

    const countA = await withTenant(client, tenantA, "owner-a", (c) =>
      countThisMonth(makeExecute(c)),
    );
    const countB = await withTenant(client, tenantB, "owner-b", (c) =>
      countThisMonth(makeExecute(c)),
    );
    assert.equal(countA, 2);
    assert.equal(countB, 1);
  } finally {
    await client.end();
  }
});
