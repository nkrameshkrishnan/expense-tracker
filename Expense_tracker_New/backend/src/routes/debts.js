import { validateDebt, ValidationError } from "../validate.js";

/** parent_id is a bigint FK to debts(id). Null means "this row is the debt
    itself"; set means "this row is a payment against that debt". Validated
    rather than passed through because it is client-supplied on the addDebt
    action. RLS still guarantees the referenced row belongs to the caller's
    tenant — a cross-tenant parent_id fails the FK, since the FK can only
    see rows the policy exposes. */
function parentId(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0)
    throw new ValidationError(`parentId must be an id, got "${value}".`);
  return n;
}

export async function listDebts(execute) {
  return execute.rows(
    `select * from debts order by date desc nulls last, id desc`,
  );
}

export async function addDebt(execute, record) {
  // Finding I5: was passing the raw body through with only `Number(x) || 0`
  // on amount, so a garbage amount stored as 0 and a malformed date hit
  // Postgres as an opaque 500.
  const clean = validateDebt(record);
  const rows = await execute.rows(
    `insert into debts (parent_id, kind, name, amount, date, notes)
     values (:parentId, :kind, :name, :amount, :date, :notes)
     returning id`,
    { parentId: parentId(record.parentId), ...clean },
  );
  return rows[0].id;
}

export async function updateDebt(execute, id, record) {
  const clean = validateDebt(record);
  await execute(
    `update debts set
       parent_id = :parentId, kind = :kind, name = :name,
       amount = :amount, date = :date, notes = :notes
     where id = :id`,
    { id, parentId: parentId(record.parentId), ...clean },
  );
}

export async function deleteDebt(execute, id) {
  // debts.parent_id is ON DELETE CASCADE (see db/schema.sql) — deleting a
  // debt correctly removes its payments too, no separate cleanup query.
  await execute(`delete from debts where id = :id`, { id });
}

/** fileRef/parentFileRef are import-time-only identifiers from the source
    file (xlsxio.js's debt import), never persisted — same remapping
    SupabaseStore/LocalStore do client-side; here it happens server-side
    since ids are assigned by the database, not the caller. */
export async function importDebts(execute, records) {
  if (!Array.isArray(records))
    throw new ValidationError("records must be an array.");
  const fileToReal = {};
  let debts = 0,
    payments = 0,
    skipped = 0;

  for (const r of records) {
    if (r.kind === "Payment") continue;
    const id = await addDebt(execute, { ...r, parentId: null });
    fileToReal[String(r.fileRef)] = id;
    debts++;
  }
  for (const r of records) {
    if (r.kind !== "Payment") continue;
    const parentId = fileToReal[String(r.parentFileRef)];
    if (!parentId) {
      skipped++;
      continue;
    }
    await addDebt(execute, { ...r, parentId });
    payments++;
  }
  return { debts, payments, skipped };
}
