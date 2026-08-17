import { test, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { RDSDataClient } from "@aws-sdk/client-rds-data";
import {
  runInTenantTransaction,
  runProvisioningTransaction,
} from "../src/db.js";

let calls;

beforeEach(() => {
  calls = [];
  mock.method(RDSDataClient.prototype, "send", async (command) => {
    calls.push(command.constructor.name);
    if (command.constructor.name === "BeginTransactionCommand")
      return { transactionId: "tx-1" };
    if (command.constructor.name === "ExecuteStatementCommand")
      return { records: [], columnMetadata: [] };
    return {};
  });
});

afterEach(() => {
  mock.restoreAll();
});

test("runInTenantTransaction sets tenant_id then user_id before calling fn, then commits", async () => {
  const order = [];
  await runInTenantTransaction("tenant-1", "user-1", async () => {
    order.push("fn");
  });
  assert.deepEqual(calls, [
    "BeginTransactionCommand",
    "ExecuteStatementCommand", // set_config app.tenant_id
    "ExecuteStatementCommand", // set_config app.user_id
    "CommitTransactionCommand",
  ]);
  assert.deepEqual(order, ["fn"]);
});

test("runInTenantTransaction rolls back if fn throws", async () => {
  await assert.rejects(
    runInTenantTransaction("tenant-1", "user-1", async () => {
      throw new Error("boom");
    }),
    /boom/,
  );
  assert.ok(calls.includes("RollbackTransactionCommand"));
  assert.ok(!calls.includes("CommitTransactionCommand"));
});

test("runProvisioningTransaction only sets user_id, never tenant_id", async () => {
  await runProvisioningTransaction("user-1", async () => {});
  const executeCalls = calls.filter((c) => c === "ExecuteStatementCommand");
  assert.equal(executeCalls.length, 1); // just the one set_config(app.user_id, ...) call
});
