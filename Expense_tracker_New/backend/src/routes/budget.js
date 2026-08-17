import {
  money,
  text,
  validateYear,
  ValidationError,
} from "../validate.js";

export async function getBudgetRows(execute, year) {
  return execute.rows(`select * from budget where year = :year`, { year });
}

/** Mirrors SupabaseStore.setBudget: upsert one row per non-zero
    category/month cell. Zero means "not budgeted" (see CLAUDE.md's data
    model note), so zero cells are deleted rather than stored as 0 —
    keeps "Budget Used" calculations correct without every reader needing
    to know that convention too. */
export async function setBudgetRows(execute, year, budget) {
  // Finding I5: `year` and `budget` come straight off the request body.
  //
  // The ENTIRE payload is validated before the delete, not as each cell is
  // written. This function replaces a whole year, so validating mid-loop
  // would mean a bad amount in, say, December wipes the year and only then
  // throws — destructive on the strength of input that was never checked.
  // (The action does run inside one transaction and would roll back, but
  // "check everything, then mutate" is the property worth having here
  // rather than relying on the caller's transaction to undo the damage.)
  // Same shape as balances.js's setBalances.
  const cleanYear = validateYear(year);
  if (!budget || typeof budget !== "object" || Array.isArray(budget))
    throw new ValidationError("budget must be an object of categories.");

  const cells = [];
  for (const category of Object.keys(budget)) {
    const name = text(category, "category").trim();
    if (!name) throw new ValidationError("A budget category cannot be blank.");
    const months = budget[category];
    if (!months || typeof months !== "object" || Array.isArray(months))
      throw new ValidationError(`budget.${name} must be an object of months.`);
    for (let month = 1; month <= 12; month++) {
      // money() rather than the previous `Number(x) || 0`: rounds to cents
      // and rejects garbage instead of silently budgeting 0. Zero still
      // means "not budgeted" and is skipped, as before.
      const amount = money(months[month], `budget.${name}.${month}`);
      if (!amount) continue;
      cells.push({ year: cleanYear, category: name, month, amount });
    }
  }

  await execute(`delete from budget where year = :year`, { year: cleanYear });
  for (const cell of cells) {
    await execute(
      `insert into budget (year, category, month, amount)
       values (:year, :category, :month, :amount)`,
      cell,
    );
  }
}
