/* Data page: connection status, export/import, and destructive actions
   (wipe, reset). */
import { PEOPLE } from "../store.js";
import { exportWorkbook, importFile } from "../xlsxio.js";
import { $, view, esc, state, notice, withBusy, refresh } from "../core.js";
import { go } from "../router.js";
import { backendLabel } from "../auth.js";

export function renderData() {
  const live = state.store.kind === "supabase";

  view.innerHTML = `
  <div class="head"><div><h1>Data</h1><p class="sub">Where your data lives, and how to get it in and out.</p></div></div>

  <div class="eyebrow">Export</div>
  <div class="panel stack">
    <div class="actions">
      <button class="btn" id="xlsx">Download .xlsx</button>
      <button class="btn ghost" id="json">Download .json backup</button>
      <span class="muted">${state.rows.length} transactions</span>
    </div>
    <p class="note">Three sheets — Transactions, Budget, and a Pivot cross-tab of live SUMIFS formulas you can
    use if you open the file in Excel or Google Sheets. No charts: the browser cannot write chart objects into an
    .xlsx. The charts you see on the Dashboard are rendered live from your Supabase data instead.</p>
  </div>

  <div class="eyebrow">Import</div>
  <div class="panel stack">
    <input type="file" id="file" accept=".xlsx,.xls,.csv">
    <div class="actions"><label><input type="checkbox" id="replace"> Replace everything first</label></div>
    <div id="imp" class="note"></div>
    <p class="note">Needs a flat table with at least <code>Date</code> and <code>Amount</code> columns. Rows are
    written to Supabase in batches of 1000.</p>
  </div>

  <div class="eyebrow">People</div>
  <div class="panel stack">
    <p class="note" style="margin:0">${(() => {
      const un = state.rows.filter((r) => !r.person).length;
      return un
        ? `<b>${un} entries have no person set</b> — everything imported before this feature existed. Assign them in one go:`
        : "Every entry has a person assigned.";
    })()}</p>
    ${
      state.rows.filter((r) => !r.person).length
        ? `
    <div class="actions">
      ${PEOPLE.map((pp) => `<button class="btn ghost" data-assign="${pp}">Assign all to ${pp}</button>`).join("")}
    </div>
    <p class="note">This rewrites every unassigned row in Supabase. You can still change individual entries afterwards from Transactions → edit.</p>`
        : ""
    }
  </div>

  <div class="eyebrow">Danger zone</div>
  <div class="panel"><div class="actions">
    <button class="btn danger" id="wipe">Delete every row${live ? " from Supabase" : ""}</button>
    <span class="muted">Export first — this cannot be undone.</span>
  </div></div>`;

  view.querySelectorAll("[data-assign]").forEach(
    (b) =>
      (b.onclick = async () => {
        const who = b.dataset.assign;
        const todo = state.rows.filter((r) => !r.person);
        if (
          !confirm(
            `Assign ${todo.length} unassigned entries to ${who}?\n\nThis updates ${todo.length} rows one at a time and may take a moment.`,
          )
        )
          return;
        const done = await withBusy(
          `Assigning ${todo.length} entries to ${who}`,
          async () => {
            for (const r of todo)
              await state.store.update(r.id, { ...r, person: who });
            await refresh();
          },
        );
        if (done) {
          notice(`${todo.length} entries assigned to ${who}.`, "ok");
          renderData();
        }
      }),
  );

  $("#xlsx").onclick = async () => {
    const done = await withBusy("Preparing your workbook", async () => {
      await exportWorkbook(state.rows, state.budget);
    });
    if (done) notice("Workbook downloaded.", "ok");
  };
  $("#json").onclick = () => {
    const blob = new Blob(
      [
        JSON.stringify(
          { year: state.year, transactions: state.rows, budget: state.budget },
          null,
          2,
        ),
      ],
      { type: "application/json" },
    );
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `ledger-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  $("#file").onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const out = $("#imp");
    out.textContent = "Reading\u2026";
    try {
      const { rows, skipped, reasons, sheet } = await importFile(file);
      if (!rows.length) {
        out.innerHTML = `<b class="over">No usable rows found on "${esc(sheet)}".</b>`;
        return;
      }
      const dest = backendLabel(state.store);
      if (
        !confirm(
          `Import ${rows.length} rows from "${sheet}" into ${dest}?${skipped ? `\n\n${skipped} rows will be skipped (no valid date or amount).` : ""}`,
        )
      ) {
        out.textContent = "Cancelled.";
        return;
      }
      const done = await withBusy(`Writing ${rows.length} rows`, async () => {
        if ($("#replace").checked) await state.store.clear();
        await state.store.bulkAdd(rows, (n, total) => {
          notice(`Writing to the sheet\u2026 ${n} of ${total} rows`);
        });
        await refresh();
      });
      if (done) {
        out.innerHTML = `<b class="under">Imported ${rows.length} rows.</b>${skipped ? ` ${skipped} skipped${reasons.length ? " (e.g. " + esc(reasons.join(", ")) + ")" : ""}.` : ""}`;
        notice(`Imported ${rows.length} transactions.`, "ok");
      }
    } catch (err) {
      out.innerHTML = `<b class="over">${esc(err.message)}</b>`;
    }
  };

  $("#wipe").onclick = async () => {
    const where = backendLabel(state.store);
    if (
      !confirm(
        `Delete all ${state.rows.length} transactions from ${where}?\n\nThis cannot be undone.`,
      )
    )
      return;
    if (!confirm("Really sure? Export a backup first if you have not.")) return;
    const done = await withBusy("Clearing the sheet", async () => {
      await state.store.clear();
      await refresh();
    });
    renderData();
    if (done) notice("All rows deleted.", "ok");
  };
}

/* ==================================================================== router */
