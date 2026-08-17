import { test, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { SESClient } from "@aws-sdk/client-ses";
import { sendPastDueEmail, sendDowngradedEmail } from "../src/notify.js";

process.env.SES_FROM_ADDRESS = "billing@ledger.example.com";

let calls;
beforeEach(() => {
  calls = [];
  mock.method(SESClient.prototype, "send", async (command) => {
    calls.push(command.input);
    return {};
  });
});
afterEach(() => mock.restoreAll());

test("sendPastDueEmail sends to the given address from SES_FROM_ADDRESS", async () => {
  await sendPastDueEmail("owner@example.com");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].Destination.ToAddresses, ["owner@example.com"]);
  assert.equal(calls[0].Source, "billing@ledger.example.com");
  assert.match(calls[0].Message.Subject.Data, /payment failed/i);
});

test("sendDowngradedEmail sends to the given address", async () => {
  await sendDowngradedEmail("owner@example.com");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].Destination.ToAddresses, ["owner@example.com"]);
  assert.match(calls[0].Message.Subject.Data, /free plan/i);
});
