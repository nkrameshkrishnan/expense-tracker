/* Transaction reads/writes. `execute` is the tenant-scoped helper from
   db.js's runInTenantTransaction — every statement here relies on RLS
   already restricting rows to the caller's tenant, so none of these
   queries filter by tenant_id themselves (same trust boundary the Supabase
   RLS policies established). */

import { validateTransaction, ValidationError } from "../validate.js";

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
  // cast(... as int) rather than `::int`: the second colon of `::` is
  // indistinguishable from a `:name` bind param to the RDS Data API's
  // named-parameter parser, which then fails the statement with an unbound
  // parameter. Same reason routes/tenants.js's createInvite avoids `::uuid`.
  // This one runs on every GET /data, so it is on the hottest path there is.
  const rows = await execute.rows(
    `select distinct cast(extract(year from date) as int) as year from transactions order by year desc`,
  );
  return rows.map((r) => r.year);
}

export async function createTransaction(execute, record) {
  // Finding I5: `record` is the raw JSON request body. Validated here, at
  // the single point every create path funnels through (handler.js's
  // "create" action AND bulkInsertTransactions below), rather than in
  // handler.js — so there is no way to add a caller later that skips it.
  // validateTransaction also returns a fresh object holding only real
  // columns, so an extra `tenant_id` key in the body cannot reach a bind
  // param and race the schema default.
  const clean = validateTransaction(record);
  const rows = await execute.rows(
    `insert into transactions
       (date, type, category, subcategory, description, amount, payment, account, recurring, notes, person)
     values
       (:date, :type, :category, :subcategory, :description, :amount, :payment, :account, :recurring, :notes, :person)
     returning *`,
    clean,
  );
  return rows[0];
}

export async function updateTransaction(execute, id, record) {
  // Same validation as create: an update rewrites every column, so it has
  // exactly the same exposure to a malformed body.
  const clean = validateTransaction(record);
  const rows = await execute.rows(
    `update transactions set
       date = :date, type = :type, category = :category, subcategory = :subcategory,
       description = :description, amount = :amount, payment = :payment,
       account = :account, recurring = :recurring, notes = :notes, person = :person
     where id = :id
     returning *`,
    { ...clean, id },
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
  // Guarded so a non-array body fails with this message rather than
  // "records is not iterable" from the for..of below. Per-record
  // validation happens inside createTransaction; because the whole action
  // runs in one transaction (db.js's runInTenantTransaction), one bad
  // record rolls the entire batch back rather than importing half a file.
  if (!Array.isArray(records))
    throw new ValidationError("records must be an array.");
  let inserted = 0;
  for (const record of records) {
    await createTransaction(execute, record);
    inserted++;
  }
  return inserted;
}
