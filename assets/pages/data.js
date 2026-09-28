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
import { findDuplicates } from "../dedupe.js";

/** Rows parsed from a file, waiting for review before anything is written to
    the store - {rows, skipped, reasons, sheet, replaceFirst} or null when
    there's nothing staged. Module-level (not on `state`) because it's
    disposable working data for this page only: it isn't meant to survive a
    real save/reload, and navigating away from Data before confirming should
    simply drop it, same as closing a form without submitting. */
let staging = null;

/* ------------------------------------------------------ duplicate flags
   Each staged row carries two private fields, both dropped by normalise()
   before anything is written:
     _dup   the findDuplicates() verdict for this row, or null
     _skip  true = leave this row out of the import
   plus _pinned once the person ticks/unticks a row by hand, so recomputing
   the flags after an edit never overrides a choice they made. */

/** Default for an unpinned row: skip only a row that is exactly already
    stored. "Likely" matches and repeats inside the file stay included -
    those are often real purchases, and silently dropping money is worse
    than a visible flag the person can act on. */
const defaultSkip = (d) => !!d && d.kind === "exact" && d.source === "stored";

function markDuplicates() {
  if (!staging) return;
  const flags = findDuplicates(staging.rows, state.rows);
  staging.rows.forEach((r, i) => {
    r._dup = flags[i];
    if (!r._pinned) r._skip = defaultSkip(flags[i]);
  });
}

/** Rows that will actually be written. "Replace everything first" wipes the
    store, so comparing against it is meaningless - every row goes in. */
const rowsToImport = () =>
  staging.replaceFirst ? staging.rows : staging.rows.filter((r) => !r._skip);

function flagHtml(r) {
  const d = r._dup;
  if (!d || staging.replaceFirst) return "";
  const m = d.match;
  const label =
    d.source === "file"
      ? `<span class="stg-flag stg-flag-file">Repeated in file</span>`
      : d.kind === "exact"
        ? `<span class="stg-flag stg-flag-exact">Already in Ledger</span>`
        : `<span class="stg-flag stg-flag-likely">Possible duplicate</span>`;
  const where =
    d.source === "file"
      ? `Same as row ${d.index + 1} above`
      : `${m.date} · ${m.type} · ${m.description || "(no description)"} · ${money(m.amount)}${m.person ? " · " + m.person : ""}`;
  return `${label}<span class="stg-match" title="${esc(where)}">${esc(where)}</span>`;
}

function dupSummaryHtml() {
  if (staging.replaceFirst) return "";
  const rows = staging.rows;
  const exact = rows.filter((r) => r._dup?.kind === "exact").length;
  const likely = rows.filter(
    (r) => r._dup?.kind === "likely" && r._dup.source === "stored",
  ).length;
  const repeats = rows.filter((r) => r._dup?.source === "file").length;
  if (!exact && !likely && !repeats)
    return `<p class="note">No duplicates found — none of these rows are already in Ledger.</p>`;
  const parts = [];
  if (exact)
    parts.push(
      `<b>${exact} already in Ledger</b> (same date, amount and description) — unticked, so they won't be imported again`,
    );
  if (likely)
    parts.push(
      `<b>${likely} possible duplicate${likely === 1 ? "" : "s"}</b> (same amount within 3 days) — still ticked; untick any that are the same transaction`,
    );
  if (repeats)
    parts.push(
      `<b>${repeats} repeated inside this file</b> — still ticked, since two identical purchases on one day are usually real`,
    );
  return `<p class="note" id="stg-dups">${parts.join(". ")}.
    <button class="btn ghost" id="stg-skip-flagged" style="padding:2px 10px;font-size:12px">Untick all flagged</button>
    <button class="btn ghost" id="stg-include-all" style="padding:2px 10px;font-size:12px">Tick all</button></p>`;
}

function stagingRowHtml(r, i) {
  const sel = (list, val) =>
    list
      .map((o) => `<option${o === val ? " selected" : ""}>${esc(o)}</option>`)
      .join("");
  return `
  <tr data-row="${i}"${r._skip && !staging.replaceFirst ? ' class="stg-skip"' : ""}>
    <td class="n stg-flagcell"><input type="checkbox" data-include="${i}" title="Import this row" ${r._skip && !staging.replaceFirst ? "" : "checked"} ${staging.replaceFirst ? "disabled" : ""}></td>
    <td class="stg-flagcell" data-flag="${i}">${flagHtml(r)}</td>
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
  const going = rowsToImport();
  const total = going.reduce((a, r) => a + (Number(r.amount) || 0), 0);
  return `
  <div class="eyebrow">Review import — <span id="stg-count">${staging.rows.length}</span> row${staging.rows.length === 1 ? "" : "s"} from "${esc(staging.sheet)}"</div>
  <div class="panel stack">
    ${
      staging.skipped
        ? `<p class="note">${staging.skipped} row${staging.skipped === 1 ? "" : "s"} skipped while reading (no valid date or amount)${staging.reasons.length ? ": " + esc(staging.reasons.join(", ")) : ""}.</p>`
        : ""
    }
    <p class="note">Nothing is written yet — fix any row here, remove ones you don't want, then confirm. Amounts are always positive; the Type column carries the sign.</p>
    ${dupSummaryHtml()}
    <div class="tablewrap" style="max-height:480px"><table><thead><tr>
      <th class="n">Import</th><th>Duplicate check</th><th>Date</th><th>Type</th><th>Category</th><th>Subcategory</th><th>Description</th>
      <th class="n">Amount</th><th>Payment</th><th>Account</th><th>Person</th><th class="n">Recurring</th><th></th>
    </tr></thead><tbody id="stg-tbody">
      ${staging.rows.map(stagingRowHtml).join("") || `<tr><td colspan="13" class="muted">Every row was removed.</td></tr>`}
    </tbody></table></div>
    <div class="actions">
      <label><input type="checkbox" id="stg-replace" ${staging.replaceFirst ? "checked" : ""}> Replace everything first</label>
      <span class="spacer"></span>
      <span class="muted num" id="stg-total">${totalText(going, total)}</span>
      <button class="btn ghost" id="stg-cancel">Cancel</button>
      <button class="btn" id="stg-confirm" ${going.length ? "" : "disabled"}>Confirm import</button>
    </div>
  </div>`;
}

function totalText(going, total) {
  const skipped = staging.rows.length - going.length;
  return `${going.length} row${going.length === 1 ? "" : "s"} to import · ${money(total)} combined amount${skipped ? ` · ${skipped} skipped` : ""}`;
}

/** Compare the staged rows against the WHOLE store, not just the years the
    app has loaded so far (boot fetches the current year first and history in
    the background) - a statement from last December has to be checked
    against last December. */
async function stage(next) {
  await state.store.ensureAllYearsLoaded?.();
  state.rows = await state.store.list();
  staging = next;
  markDuplicates();
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
        out.textContent = "Checking for duplicates\u2026";
        await stage({
          rows,
          skipped,
          reasons,
          sheet: file.name,
          replaceFirst: false,
        });
        out.textContent = "";
      } else {
        const { rows, skipped, reasons, sheet } = await importFile(file);
        if (!rows.length) {
          out.innerHTML = `<b class="over">No usable rows found on "${esc(sheet)}".</b>`;
          return;
        }
        out.textContent = "Checking for duplicates\u2026";
        await stage({ rows, skipped, reasons, sheet, replaceFirst: false });
        out.textContent = "";
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
      if (MATCH_FIELDS.has(f)) {
        markDuplicates();
        paintFlags();
      } else paintTotals();
    });
  });

  view.querySelectorAll("[data-include]").forEach((cb) =>
    cb.addEventListener("change", () => {
      const r = staging.rows[Number(cb.dataset.include)];
      r._skip = !cb.checked;
      r._pinned = true;
      paintFlags();
    }),
  );

  const sf = $("#stg-skip-flagged");
  if (sf) sf.onclick = () => bulkSet(true);
  const ia = $("#stg-include-all");
  if (ia) ia.onclick = () => bulkSet(false);

  view.querySelectorAll("[data-remove]").forEach(
    (b) =>
      (b.onclick = () => {
        staging.rows.splice(Number(b.dataset.remove), 1);
        renderData();
      }),
  );

  $("#stg-replace").onchange = (e) => {
    staging.replaceFirst = e.target.checked;
    renderData(); // flags and the Import column only apply when appending
  };

  $("#stg-cancel").onclick = () => {
    staging = null;
    $("#file").value = "";
    renderData();
  };

  $("#stg-confirm").onclick = async () => {
    const rowsToWrite = rowsToImport();
    if (!rowsToWrite.length) return;
    const dest = backendLabel(state.store);
    const replaceFirst = staging.replaceFirst;
    const skipped = staging.rows.length - rowsToWrite.length;
    if (
      !confirm(
        `Import ${rowsToWrite.length} rows into ${dest}?` +
          (skipped
            ? `\n\n${skipped} row${skipped === 1 ? "" : "s"} marked as duplicate${skipped === 1 ? "" : "s"} will be left out.`
            : "") +
          (replaceFirst
            ? "\n\nThis will first delete every existing row."
            : ""),
      )
    )
      return;
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

/** Fields the duplicate check compares - editing one re-runs the check. */
const MATCH_FIELDS = new Set(["date", "amount", "description", "account", "person"]);

/** Patch the flag cells, Import ticks and totals in place after an edit,
    instead of re-rendering the table - a full render would throw away the
    focus and cursor position of whatever cell is being typed in. */
function paintFlags() {
  staging.rows.forEach((r, i) => {
    const skip = r._skip && !staging.replaceFirst;
    const tr = view.querySelector(`#stg-tbody tr[data-row="${i}"]`);
    if (!tr) return;
    tr.classList.toggle("stg-skip", !!skip);
    const cb = tr.querySelector("[data-include]");
    if (cb) cb.checked = !skip;
    const cell = tr.querySelector("[data-flag]");
    if (cell) cell.innerHTML = flagHtml(r);
  });
  const summary = $("#stg-dups");
  if (summary) {
    const tmp = document.createElement("div");
    tmp.innerHTML = dupSummaryHtml();
    const fresh = tmp.firstElementChild;
    if (fresh?.id === "stg-dups") {
      summary.innerHTML = fresh.innerHTML;
      const sf = $("#stg-skip-flagged");
      if (sf) sf.onclick = () => bulkSet(true);
      const ia = $("#stg-include-all");
      if (ia) ia.onclick = () => bulkSet(false);
    } else if (fresh) summary.replaceWith(fresh);
  }
  paintTotals();
}

function bulkSet(skipFlagged) {
  staging.rows.forEach((r) => {
    r._skip = skipFlagged ? !!r._dup : false;
    r._pinned = true;
  });
  renderData();
}

function paintTotals() {
  const going = rowsToImport();
  const total = $("#stg-total");
  if (total)
    total.textContent = totalText(
      going,
      going.reduce((a, x) => a + (Number(x.amount) || 0), 0),
    );
  const btn = $("#stg-confirm");
  if (btn) btn.disabled = !going.length;
}

/* ==================================================================== router */
