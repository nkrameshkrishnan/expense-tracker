/* Small helpers used by the store classes and elsewhere. */

import { CAT_NAMES, TYPES } from "./constants.js";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function emptyBudget() {
  const b = {};
  for (const c of CAT_NAMES) {
    b[c] = {};
    for (let m = 1; m <= 12; m++) b[c][m] = 0;
  }
  return b;
}

export function normalise(r) {
  const amount = Math.abs(Number(r.amount) || 0);
  let type = r.type || r.typ || "Expense";
  if (!TYPES.includes(type)) type = "Expense";
  const raw = r.category || r.cat;
  return {
    id: Number(r.id) || 0,
    date: String(r.date || "").slice(0, 10),
    type,
    category: String(raw || "").trim() || "Miscellaneous",
    subcategory: r.subcategory || r.sub || "",
    description: r.description || r.desc || "",
    amount: Math.round(amount * 100) / 100,
    payment: r.payment || "",
    account: r.account || "",
    recurring: r.recurring === "Yes" || r.recur === "Yes" ? "Yes" : "No",
    notes: r.notes || r.note || "",
    // Free text, matching the backend's own validate.js - this used to be
    // allow-listed against a fixed 3-name PEOPLE constant, which silently
    // discarded any other tenant's real person value back to "" on every
    // read.
    person: String(r.person || "").trim(),
  };
}
