export async function listBalances(execute) {
  return execute.rows(`select * from balances order by date desc`);
}

export async function setBalances(execute, date, entries) {
  await execute(`delete from balances where date = :date`, { date });
  for (const entry of entries) {
    await execute(
      `insert into balances (date, account, amount, owner, kind)
       values (:date, :account, :amount, :owner, :kind)`,
      {
        date,
        account: entry.account,
        amount: Number(entry.amount) || 0,
        owner: entry.owner || "",
        kind: entry.kind || "Asset",
      },
    );
  }
}

export async function deleteBalanceDate(execute, date) {
  await execute(`delete from balances where date = :date`, { date });
}
