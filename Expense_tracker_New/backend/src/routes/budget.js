export async function getBudgetRows(execute, year) {
  return execute.rows(`select * from budget where year = :year`, { year });
}

/** Mirrors SupabaseStore.setBudget: upsert one row per non-zero
    category/month cell. Zero means "not budgeted" (see CLAUDE.md's data
    model note), so zero cells are deleted rather than stored as 0 —
    keeps "Budget Used" calculations correct without every reader needing
    to know that convention too. */
export async function setBudgetRows(execute, year, budget) {
  await execute(`delete from budget where year = :year`, { year });
  for (const category of Object.keys(budget)) {
    for (let month = 1; month <= 12; month++) {
      const amount = Number(budget[category][month]) || 0;
      if (!amount) continue;
      await execute(
        `insert into budget (year, category, month, amount)
         values (:year, :category, :month, :amount)`,
        { year, category, month, amount },
      );
    }
  }
}
