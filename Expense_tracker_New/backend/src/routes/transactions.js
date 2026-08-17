/* Transaction reads/writes. `execute` is the tenant-scoped helper from
   db.js's runInTenantTransaction — every statement here relies on RLS
   already restricting rows to the caller's tenant, so none of these
   queries filter by tenant_id themselves (same trust boundary the Supabase
   RLS policies established). */

export async function listTransactions(execute, { txYear } = {}) {
  if (txYear === -1) return []; // metadata-only refresh, mirrors Code.gs's txYear:-1 convention
  const where = txYear ? `where date >= :start and date <= :end` : "";
  const params = txYear
    ? { start: `${txYear}-01-01`, end: `${txYear}-12-31` }
    : {};
  return execute.rows(
    `select * from transactions ${where} order by date desc, id desc`,
    params,
  );
}

export async function listTransactionYears(execute) {
  const rows = await execute.rows(
    `select distinct extract(year from date)::int as year from transactions order by year desc`,
  );
  return rows.map((r) => r.year);
}

export async function createTransaction(execute, record) {
  const rows = await execute.rows(
    `insert into transactions
       (date, type, category, subcategory, description, amount, payment, account, recurring, notes, person)
     values
       (:date, :type, :category, :subcategory, :description, :amount, :payment, :account, :recurring, :notes, :person)
     returning *`,
    record,
  );
  return rows[0];
}

export async function updateTransaction(execute, id, record) {
  const rows = await execute.rows(
    `update transactions set
       date = :date, type = :type, category = :category, subcategory = :subcategory,
       description = :description, amount = :amount, payment = :payment,
       account = :account, recurring = :recurring, notes = :notes, person = :person
     where id = :id
     returning *`,
    { ...record, id },
  );
  return rows[0];
}

export async function deleteTransaction(execute, id) {
  await execute(`delete from transactions where id = :id`, { id });
}

export async function clearTransactions(execute) {
  await execute(`delete from transactions`);
}

/** Chunked by the caller (ApiStore mirrors SheetsStore's 1000-row CHUNK) —
    this just inserts whatever slice it's given, one statement per record.
    Fine at MVP volumes; if bulk import ever becomes a bottleneck, batch via
    a single multi-row INSERT instead of looping execute(). */
export async function bulkInsertTransactions(execute, records) {
  let inserted = 0;
  for (const record of records) {
    await createTransaction(execute, record);
    inserted++;
  }
  return inserted;
}
