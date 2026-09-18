import { emptyBudget } from "../store-helpers.js";

/* -------------------------------------------------------------- disconnected
   Placeholder used only when there is no working connection to a Ledger
   account — never a storage tier a user should knowingly be "on". This is a
   multi-tenant SaaS: every session must be connected to a real account, so
   nothing here ever persists (no IndexedDB, no localStorage cache of rows).
   Reads return empty so the app can still render its own shell instead of
   crashing outright; writes throw, so every action correctly surfaces "not
   connected" through the same withBusy()/notice() path every other store
   error already goes through, rather than silently accepting a change that
   was never actually saved anywhere. */
function notConnected() {
  throw new Error(
    "Not connected to your Ledger account — reconnect to make changes.",
  );
}
export class DisconnectedStore {
  constructor() {
    this.kind = "disconnected";
  }
  async ensureYearLoaded() {}
  async ensureAllYearsLoaded() {}
  async list() {
    return [];
  }
  async add() {
    notConnected();
  }
  async bulkAdd() {
    notConnected();
  }
  async update() {
    notConnected();
  }
  async remove() {
    notConnected();
  }
  async clear() {
    notConnected();
  }
  async getBudget() {
    return emptyBudget();
  }
  async setBudget() {
    notConnected();
  }
  async setCurrency() {
    notConnected();
  }
  async getBalances() {
    return [];
  }
  async getDebts() {
    return [];
  }
  async addDebt() {
    notConnected();
  }
  async updateDebt() {
    notConnected();
  }
  async deleteDebt() {
    notConnected();
  }
  async importDebts() {
    notConnected();
  }
  async setBalances() {
    notConnected();
  }
  async deleteBalanceDate() {
    notConnected();
  }
  async isEmpty() {
    return true;
  }
  // A read, not a write - fails open with an empty list (rather than
  // notConnected()'s throw), so the Billing/plan-gate pages still render
  // their shell instead of erroring out. There is no static fallback list
  // any more (see app.js's PLAN_COPY, which only has display copy, not
  // plan existence) - an empty result means those pages show "plans
  // unavailable" rather than a stale-but-plausible-looking price.
  async getPlans() {
    return [];
  }
  async extractTransactions() {
    notConnected();
  }
  async getUploadUrl() {
    notConnected();
  }
  async uploadToS3() {
    notConnected();
  }
  async getScanStatus() {
    notConnected();
  }
}
