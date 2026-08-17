import { test } from "node:test";
import assert from "node:assert/strict";
import { assertManagesInvites } from "../src/handler.js";

test("throws for a member", () => {
  assert.throws(() => assertManagesInvites({ role: "member" }));
});
test("throws for no membership at all", () => {
  assert.throws(() => assertManagesInvites(null));
});
test("does not throw for an owner", () => {
  assert.doesNotThrow(() => assertManagesInvites({ role: "owner" }));
});
test("does not throw for an admin", () => {
  assert.doesNotThrow(() => assertManagesInvites({ role: "admin" }));
});
