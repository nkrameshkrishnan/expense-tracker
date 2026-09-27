/* Data page: connection status, export/import, and person assignment. */
import { PEOPLE, TYPES, UNASSIGNED } from "../store.js";
import { exportWorkbook, importFile, money } from "../xlsxio.js";
import { listFor } from "../categories.js";
import { $, view, esc, state, notice, withBusy, refresh } from "../core.js";
import { go } from "../router.js";
import { backendLabel } from "../auth.js";
import { extractPdfItems, extractPdfText } from "../pdfio.js";
import { parseStatementText } from "../statement-parser.js";
import { parseBankTablePdf } from "../bank-table-parser.js";

/** Rows parsed from a file, waiting for review before anything is written to
    the store - {rows, skipped, reasons, sheet, replaceFirst} or null when
    there's nothing staged. Module-level (not on `state`) because it's
    disposable working data for this page only: it isn't meant to survive a
    real save/reload, and navigating away from Data before confirming should
    simply drop it, same as closing a form without submitting. */
let staging = null;

function stagingRowHtml(r, i) {
  const sel = (list, val) =>
    list
      .map((o) => `<option${o === val ? " selected" : ""}>${esc(o)}</option>`)
      .join("");
  return `
  <tr data-row="${i}">
    <td><input type="date" class="stg-in" data-idx="${i}" data-field="date" value="${esc(r.date)}"></td>
    <td><select class="stg-in" data-idx="${i}" data-field="type">${sel(TYPES, r.type)}</select></td>
    <td><select class="stg-in" data-idx="${i}" data-field="category">${sel(listFor("category"), r.category)}</select></td>
    <td><input type="text" class="stg-in" data-idx="${i}" data-field="subcategory" value="${esc(r.subcategory)}"></td>
    <td><input type="text" class="stg-in stg-wide" data-idx="${i}" data-field="description" value="${esc(r.description)}"></td>
    <td><input type="number" step="0.01" min="0" class="stg-in num" data-idx="${i}" data-field="amount" value="${r.amount}"></td>
    <td><select class="stg-in" data-idx="${i}" data-field="payment"><option value=""${r.payment ? "" : " selected"}>—</option>${sel(listFor("payment"), r.payment)}</select></td>
    <td><select class="stg-in" data-idx="${i}" data-field="account"><option value=""${r.account ? "" : " selected"}>—</option>${sel(listFor("account"), r.account)}</select></td>
    <td><select class="stg-in" data-idx="${i}" data-field="person"><option value=""${r.person ? "" : " selected"}>${esc(UNASSIGNED)}</option>${sel(listFor("person"), r.person)}</select></td>
    <td class="n"><input type="checkbox" data-idx="${i}" data-field="recurring" ${r.recurring === "Yes" ? "checked" : ""}></td>
    <td><button class="rowbtn" data-remove="${i}" title="Remove this row">✕</button></td>
  </tr>`;
}

function stagingPanelHtml() {
  if (!staging) return "";
  const total = staging.rows.reduce((a, r) => a + (Number(r.amount) || 0), 0);
  return `
  <div class="eyebrow">Review import — <span id="stg-count">${staging.rows.length}</span> row${staging.rows.length === 1 ? "" : "s"} from "${esc(staging.sheet)}"</div>
  <div class="panel stack">
    ${
      staging.skipped
        ? `<p class="note">${staging.skipped} row${staging.skipped === 1 ? "" : "s"} skipped while reading (no valid date or amount)${staging.reasons.length ? ": " + esc(staging.reasons.join(", ")) : ""}.</p>`
        : ""
    }
    <p class="note">Nothing is written yet — fix any row here, remove ones you don't want, then confirm. Amounts are always positive; the Type column carries the sign.</p>
    <div class="tablewrap" style="max-height:480px"><table><thead><tr>
      <th>Date</th><th>Type</th><th>Category</th><th>Subcategory</th><th>Description</th>
      <th class="n">Amount</th><th>Payment</th><th>Account</th><th>Person</th><th class="n">Recurring</th><th></th>
    </tr></thead><tbody id="stg-tbody">
      ${staging.rows.map(stagingRowHtml).join("") || `<tr><td colspan="11" class="muted">Every row was removed.</td></tr>`}
    </tbody></table></div>
    <div class="actions">
      <label><input type="checkbox" id="stg-replace" ${staging.replaceFirst ? "checked" : ""}> Replace everything first</label>
      <span class="spacer"></span>
      <span class="muted num" id="stg-total">${staging.rows.length} row${staging.rows.length === 1 ? "" : "s"} · ${money(total)} combined amount</span>
      <button class="btn ghost" id="stg-cancel">Cancel</button>
      <button class="btn" id="stg-confirm" ${staging.rows.length ? "" : "disabled"}>Confirm import</button>
    </div>
  </div>`;
}

export function renderData() {
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
    <input type="file" id="file" accept=".xlsx,.xls,.csv,.pdf">
    <div id="imp" class="note"></div>
    <p class="note">Spreadsheets need a flat table with at least <code>Date</code> and <code>Amount</code> columns.
    A PDF statement is scanned line by line for a date-then-amount pattern — no AI, nothing leaves your browser —
    so Category, Payment, Account, and Person come back blank for you to fill in below. Picking a file only reads
    and previews it below — nothing is written until you confirm.</p>
  </div>

  ${stagingPanelHtml()}

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
  </div>`;

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
    const isPdf = /\.pdf$/i.test(file.name);
    out.textContent = isPdf ? "Reading PDF\u2026" : "Reading\u2026";
    try {
      if (isPdf) {
        // Try the column-aware table parser first - it only matches a PDF
        // that has an actual labelled header row (DATE/TRANSACTIONS/DEBIT/
        // CREDIT..., or TRANSACTION DATE/DETAILS/AMOUNT - the shape a bank's
        // own "print this page" export uses), and falls through to the
        // simpler line-based parser for anything else (a real statement
        // that puts one transaction on one line, with no such header).
        const pdfPages = await extractPdfItems(file);
        const tableResult = parseBankTablePdf(pdfPages);
        let rows, skipped, reasons;
        if (tableResult) {
          ({ rows, skipped, reasons } = tableResult);
        } else {
          const text = await extractPdfText(file);
          ({ rows, skipped, reasons } = parseStatementText(text));
        }
        if (!rows.length) {
          out.innerHTML = `<b class="over">No date-and-amount rows recognised in "${esc(file.name)}".</b>`;
          return;
        }
        out.textContent = "";
        staging = {
          rows,
          skipped,
          reasons,
          sheet: file.name,
          replaceFirst: false,
        };
      } else {
        const { rows, skipped, reasons, sheet } = await importFile(file);
        if (!rows.length) {
          out.innerHTML = `<b class="over">No usable rows found on "${esc(sheet)}".</b>`;
          return;
        }
        out.textContent = "";
        staging = { rows, skipped, reasons, sheet, replaceFirst: false };
      }
      renderData();
    } catch (err) {
      out.innerHTML = `<b class="over">${esc(err.message)}</b>`;
    }
  };

  wireStaging();
}

/** Wires the review table's per-cell inputs, row-remove buttons, and the
    Confirm/Cancel actions. Called after every renderData() - a no-op when
    nothing is staged, since none of these elements exist in that markup. */
function wireStaging() {
  if (!staging) return;

  view.querySelectorAll("#stg-tbody [data-field]").forEach((el) => {
    const evt =
      el.tagName === "SELECT" || el.type === "checkbox" ? "change" : "input";
    el.addEventListener(evt, () => {
      const r = staging.rows[Number(el.dataset.idx)];
      const f = el.dataset.field;
      if (f === "recurring") r.recurring = el.checked ? "Yes" : "No";
      else if (f === "amount")
        r.amount = Math.round((Number(el.value) || 0) * 100) / 100;
      else r[f] = el.value;
      const total = $("#stg-total");
      if (total) {
        const sum = staging.rows.reduce(
          (a, x) => a + (Number(x.amount) || 0),
          0,
        );
        total.textContent = `${staging.rows.length} row${staging.rows.length === 1 ? "" : "s"} \u00b7 ${money(sum)} combined amount`;
      }
    });
  });

  view.querySelectorAll("[data-remove]").forEach(
    (b) =>
      (b.onclick = () => {
        staging.rows.splice(Number(b.dataset.remove), 1);
        renderData();
      }),
  );

  $("#stg-replace").onchange = (e) => {
    staging.replaceFirst = e.target.checked;
  };

  $("#stg-cancel").onclick = () => {
    staging = null;
    $("#file").value = "";
    renderData();
  };

  $("#stg-confirm").onclick = async () => {
    if (!staging.rows.length) return;
    const dest = backendLabel(state.store);
    const replaceFirst = staging.replaceFirst;
    if (
      !confirm(
        `Import ${staging.rows.length} rows into ${dest}?` +
          (replaceFirst
            ? "\n\nThis will first delete every existing row."
            : ""),
      )
    )
      return;
    const rowsToWrite = staging.rows;
    const done = await withBusy(
      `Writing ${rowsToWrite.length} rows`,
      async () => {
        if (replaceFirst) await state.store.clear();
        await state.store.bulkAdd(rowsToWrite, (n, total) => {
          notice(`Writing to the sheet\u2026 ${n} of ${total} rows`);
        });
        await refresh();
      },
    );
    // Only clear the review on success - withBusy already showed an error
    // notice on failure, and keeping the staged rows means a network hiccup
    // doesn't cost the edits already made in the review table.
    if (done) {
      staging = null;
      $("#file").value = "";
      notice(`Imported ${rowsToWrite.length} transactions.`, "ok");
    }
    renderData();
  };
}

/* ==================================================================== router */
