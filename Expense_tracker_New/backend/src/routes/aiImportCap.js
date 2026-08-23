/* The two queries behind the monthly AI-import cap (extract.js, Task 5
   of this feature's plan). Neither takes a tenantId - every column on
   ai_imports has a default (see db/schema.sql), and RLS already scopes
   both queries to whichever tenant the caller's open
   runInTenantTransaction is for, the same way routes/debts.js's
   listDebts(execute) needs no explicit tenant filter either. */

/** Attempts recorded so far in the current calendar month. No reset job
    needed - "this month" is just a WHERE clause against now(). */
export async function countThisMonth(execute) {
  const rows = await execute.rows(
    `select cast(count(*) as int) as count from ai_imports where created_at >= date_trunc('month', now())`,
  );
  return rows[0].count;
}

/** Records one extraction attempt. Only called after Bedrock has actually
    returned a response (see extract.js) - a call that fails before that
    point must not reach here, per this feature's spec (Error handling:
    a failed-before-response call doesn't count against the cap). */
export async function recordAttempt(execute) {
  await execute(`insert into ai_imports default values`);
}
