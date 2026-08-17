export async function listDebts(execute) {
  return execute.rows(
    `select * from debts order by date desc nulls last, id desc`,
  );
}

export async function addDebt(execute, record) {
  const rows = await execute.rows(
    `insert into debts (parent_id, kind, name, amount, date, notes)
     values (:parentId, :kind, :name, :amount, :date, :notes)
     returning id`,
    {
      parentId: record.parentId ?? null,
      kind: record.kind || "Debt",
      name: record.name || "",
      amount: Number(record.amount) || 0,
      date: record.date || null,
      notes: record.notes || "",
    },
  );
  return rows[0].id;
}

export async function updateDebt(execute, id, record) {
  await execute(
    `update debts set
       parent_id = :parentId, kind = :kind, name = :name,
       amount = :amount, date = :date, notes = :notes
     where id = :id`,
    {
      id,
      parentId: record.parentId ?? null,
      kind: record.kind || "Debt",
      name: record.name || "",
      amount: Number(record.amount) || 0,
      date: record.date || null,
      notes: record.notes || "",
    },
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
