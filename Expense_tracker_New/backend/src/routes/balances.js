import { isoDate, validateBalanceEntry, ValidationError } from "../validate.js";

export async function listBalances(execute, features) {
  if (!features.netWorth) return [];
  return execute.rows(`select * from balances order by date desc`);
}

export async function setBalances(execute, date, entries) {
  // Finding I5: both arguments are raw request-body values. Everything is
  // validated UP FRONT, before the delete — this replaces a whole date's
  // balances, so validating mid-loop would mean the failure happens after
  // the date has already been wiped. (The action does run inside one
  // transaction and would roll back, but failing before any statement runs
  // keeps the error about the input rather than about whatever SQL the
  // half-applied state hit.)
  const cleanDate = isoDate(date, "date");
  if (!Array.isArray(entries))
    throw new ValidationError("entries must be an array.");
  const clean = entries.map(validateBalanceEntry);

  await execute(`delete from balances where date = :date`, {
    date: cleanDate,
  });
  for (const entry of clean) {
    await execute(
      `insert into balances (date, account, amount, owner, kind)
       values (:date, :account, :amount, :owner, :kind)`,
      { date: cleanDate, ...entry },
    );
  }
}

export async function deleteBalanceDate(execute, date) {
  await execute(`delete from balances where date = :date`, {
    date: isoDate(date, "date"),
  });
}
