/* Debt/loan tracking: summary math, the Add/Edit and Record-payment dialogs,
   PDF export, and the "Debts & loans" card list on the Net worth page. */
import { PEOPLE, CURRENCIES, toCad, amountCad } from "../store.js";
import { money, moneyIn, pct } from "../xlsxio.js";
import { CURRENCY_SYMBOL } from "../prefs.js";
import { $, view, esc, state, notice, withBusy, kpi } from "../core.js";
import { go } from "../router.js";
import { renderNetWorth } from "./networth.js";
import { emptyIcon } from "../icons.js";
import { countKpiTiles } from "../motion.js";

let pdfLibsReady = null;
function loadPdfLibs() {
  if (pdfLibsReady) return pdfLibsReady;
  pdfLibsReady = Promise.all([
    import("https://cdn.jsdelivr.net/npm/jspdf@4.2.1/+esm"),
    import("https://cdn.jsdelivr.net/npm/jspdf-autotable@5.0.8/+esm"),
  ]).catch((e) => {
    pdfLibsReady = null;
    throw new Error(
      "Could not load the PDF library. Check your connection and try again.",
    );
  });
  return pdfLibsReady;
}

async function exportDebtPdf(d) {
  const [{ jsPDF }, { autoTable }] = await loadPdfLibs();
  const doc = new jsPDF();
  const money = (n) => moneyIn(n, d.currency); // the debt's own currency
  const headStyles = { fillColor: [31, 41, 55] };

  doc.setFontSize(14);
  doc.text(d.counterparty, 14, 15);
  doc.setFontSize(10);
  doc.setTextColor(107, 118, 132);
  doc.text(
    `${d.direction === "Owed" ? "You owe" : "Owed to you"}${d.settled ? " \u00b7 Settled" : ""}`,
    14,
    21,
  );
  doc.setTextColor(18, 22, 28);

  const summaryRows = [
    ["Direction", d.direction === "Owed" ? "You owe" : "Owed to you"],
  ];
  if (d.debtType) summaryRows.push(["Type", d.debtType]);
  if (d.interestRate != null)
    summaryRows.push(["Interest rate", `${d.interestRate}% p.a.`]);
  summaryRows.push(["Principal", money(d.principal)]);
  summaryRows.push(["Paid", money(d.paid)]);
  summaryRows.push(["Outstanding", money(d.outstanding)]);
  if (d.owner) summaryRows.push(["Whose", d.owner]);
  if (d.description) summaryRows.push(["Description", d.description]);
  if (d.date) summaryRows.push(["Date opened", d.date]);

  autoTable(doc, {
    startY: 26,
    head: [["Field", "Value"]],
    body: summaryRows,
    theme: "grid",
    headStyles,
  });
  let y = doc.lastAutoTable.finalY + 10;

  if (d.receipts?.length) {
    doc.setFontSize(11);
    doc.text(
      `How this debt built up (${money(d.received)} in ${d.receipts.length} item${d.receipts.length === 1 ? "" : "s"})`,
      14,
      y,
    );
    autoTable(doc, {
      startY: y + 4,
      head: [["Date", "Description", "Amount"]],
      body: d.receipts.map((r) => [
        r.date,
        r.description || "",
        money(r.amount),
      ]),
      theme: "grid",
      headStyles,
    });
    y = doc.lastAutoTable.finalY + 10;
  }

  if (d.payments?.length) {
    doc.setFontSize(11);
    doc.text("Payment history", 14, y);
    autoTable(doc, {
      startY: y + 4,
      head: [["Date", "Description", "Amount"]],
      body: d.payments.map((p) => [
        p.date,
        p.description || "",
        money(p.amount),
      ]),
      theme: "grid",
      headStyles,
    });
  }

  // Strip characters a filesystem might choke on (the counterparty is
  // free-text the person typed into the Add-debt form) rather than
  // asserting on them - "Family (event gifts)" becoming "Family event
  // gifts" is a fine filename, refusing to export at all over it is not.
  const safeName =
    d.counterparty
      .replace(/[^\w\- ]+/g, "")
      .trim()
      .replace(/\s+/g, "-") || "debt";
  doc.save(`${safeName}-debt-export.pdf`);
}

/** CAD per 1 unit of the debt's currency: 1 for CAD, otherwise the latest
    stored exchange rate if there is one, falling back to the rate recorded
    on the agreement itself. */
export function debtRateCad(d) {
  const cur = d.currency || "CAD";
  if (cur === "CAD") return 1;
  return Number(state.fxLatest?.[cur]) || Number(d.fxRate) || 1;
}

export function debtSummary(debts) {
  // Only a "Debt" row is its own agreement/card. "Payment" and "Receipt" rows
  // are both children (via parentId) of an agreement, never cards on their own.
  const agreements = debts.filter((d) => d.kind === "Debt");
  return agreements.map((a) => {
    const payments = debts
      .filter(
        (d) => d.kind === "Payment" && Number(d.parentId) === Number(a.id),
      )
      .sort((x, y) => (x.date < y.date ? 1 : -1));
    // Receipts are itemized top-ups to the principal - money actually
    // received/lent in stages instead of (or in addition to) the single
    // amount on the agreement row itself. principal = agreement.amount +
    // sum(receipts), so recording the full history as receipts and leaving
    // the agreement's own amount at 0 works the same as one lump sum.
    const receipts = debts
      .filter(
        (d) => d.kind === "Receipt" && Number(d.parentId) === Number(a.id),
      )
      .sort((x, y) => (x.date < y.date ? 1 : -1));
    const received = receipts.reduce((s, r) => s + Number(r.amount || 0), 0);
    const paid = payments.reduce((s, p) => s + Number(p.amount || 0), 0);
    const principal = Number(a.amount || 0) + received;
    const outstanding = Math.max(0, principal - paid);
    // Everything above is in the debt's OWN currency, so a rupee debt repaid
    // in rupees reaches exactly zero whatever the exchange rate did. CAD
    // figures are for totals and net worth only: today's rate when known,
    // else the rate recorded on the agreement.
    const currency = a.currency || "CAD";
    const rateCad = debtRateCad({ ...a, currency });
    // What was actually received/paid, in CAD at each row's own rate - the
    // basis for cross-checking against Transactions, which are in CAD.
    const paidCadAtRow = payments.reduce(
      (s, p) => s + toCad(p.amount, currency === "CAD" ? 1 : p.fxRate),
      0,
    );
    return {
      ...a,
      currency,
      rateCad,
      principalCad: toCad(principal, rateCad),
      outstandingCad: toCad(outstanding, rateCad),
      paidCad: toCad(paid, rateCad),
      paidCadAtRow,
      payments,
      receipts,
      received,
      paid,
      principal,
      outstanding,
      settled: outstanding < 0.005,
      overpaid: paid - principal > 0.005,
      pct: principal > 0 ? Math.min(paid / principal, 1) : 0,
    };
  });
}

/** Debts feed net worth directly - no manual balance entry needed. */
export function debtNetWorth(debts, owner) {
  const rows = debtSummary(debts).filter((d) => !owner || d.owner === owner);
  return {
    liability: rows
      .filter((d) => d.direction === "Owed")
      .reduce((s, d) => s + d.outstandingCad, 0),
    receivable: rows
      .filter((d) => d.direction === "Lent")
      .reduce((s, d) => s + d.outstandingCad, 0),
  };
}

/** Transactions that look like they involve this counterparty. */
export function relatedTransactions(counterparty) {
  const needle = String(counterparty || "")
    .toLowerCase()
    .trim();
  if (needle.length < 3) return [];
  return state.rows.filter((r) =>
    (r.description + " " + r.subcategory + " " + r.notes)
      .toLowerCase()
      .includes(needle),
  );
}

/** Count-up targets ([kpi key, number, formatter]) recorded by the most
    recent renderDebtSection(). Consumed by animateDebtSection(), which
    renderNetWorth calls only on an entrance (route entry or tab switch) -
    never for in-place re-renders or returning from the add/edit/payment
    dialogs. */
let pendingKpiCount = [];

/** Entrance-only motion for the Debts tab. */
export function animateDebtSection() {
  countKpiTiles(pendingKpiCount);
}

export function wireDebtHandlers() {
  const reload = async () => {
    state.debts = await state.store.getDebts();
    renderNetWorth();
  };

  $("#debt-add")?.addEventListener("click", () => debtDialog(null));

  $("#debt-import")?.addEventListener("change", async (ev) => {
    const file = ev.target.files[0];
    if (!file) return;
    const out = $("#debt-import-out");
    try {
      const text = await file.text();
      let recs;
      if (file.name.toLowerCase().endsWith(".json")) recs = JSON.parse(text);
      else {
        const lines = text.trim().split(/\r?\n/);
        // quoted fields matter here: notes carry commas
        const split = (l) => {
          const o = [];
          let cur = "",
            q = false;
          for (const ch of l) {
            if (ch === '"') q = !q;
            else if (ch === "," && !q) {
              o.push(cur);
              cur = "";
            } else cur += ch;
          }
          o.push(cur);
          return o.map((x) => x.trim());
        };
        const head = split(lines[0]).map((h) => h.toLowerCase());
        recs = lines
          .slice(1)
          .filter(Boolean)
          .map((l) => {
            const c = split(l);
            const g = (k) =>
              head.indexOf(k) === -1 ? "" : (c[head.indexOf(k)] ?? "").trim();
            return {
              kind: g("kind"),
              parentId: g("parentid"),
              counterparty: g("counterparty"),
              direction: g("direction"),
              description: g("description"),
              date: g("date"),
              amount: Number(String(g("amount")).replace(/[$,\s]/g, "")),
              owner: g("owner"),
              notes: g("notes"),
              currency: g("currency").toUpperCase(),
              fxRate: Number(g("fxrate")) || 0,
            };
          });
      }
      const debts = recs.filter(
        (r) =>
          r.kind !== "Payment" &&
          /^\d{4}-\d{2}-\d{2}$/.test(r.date) &&
          r.amount > 0,
      );
      const pays = recs.filter(
        (r) =>
          r.kind === "Payment" &&
          /^\d{4}-\d{2}-\d{2}$/.test(r.date) &&
          r.amount > 0,
      );
      if (!debts.length) {
        out.innerHTML =
          '<b class="over">No debt rows found. Need a row with kind=Debt.</b>';
        return;
      }
      const principal = debts.reduce((a, r) => a + r.amount, 0),
        repaid = pays.reduce((a, r) => a + r.amount, 0);
      if (
        !confirm(
          `Import ${debts.length} agreement(s) and ${pays.length} payment(s)?\n\n` +
            `Principal ${money(principal)}\nRepaid ${money(repaid)}\n` +
            `Outstanding ${money(Math.max(0, principal - repaid))}`,
        )
      ) {
        out.textContent = "Cancelled.";
        return;
      }

      // Every debt and payment goes in ONE request, not one per row. A prior
      // version looped addDebt() per row - 33 sequential network calls for a
      // 32-payment ledger - and anything that interrupted the loop partway
      // (a network blip, a backgrounded tab) left the sheet holding whichever
      // rows had already landed and silently dropped the rest, with the wrong
      // total showing and no error. A single batch either fully lands or fully
      // fails; there is no partial state to land in.
      debts.forEach((d, i) => {
        d.fileRef = String(i + 1);
      });
      pays.forEach((p) => {
        p.parentFileRef = String(p.parentId || "1");
      });
      // Optional currency/fxrate columns. Missing or unknown -> CAD at 1;
      // a foreign debt without a rate is rejected rather than guessed;
      // payments inherit their agreement's currency and rate.
      for (const d of debts) {
        if (!CURRENCIES.includes(d.currency)) d.currency = "CAD";
        if (d.currency === "CAD") d.fxRate = 1;
        else if (!(d.fxRate > 0)) {
          out.innerHTML = `<b class="over">${esc(d.counterparty)}: ${d.currency} debt needs an fxrate column (CAD per 1 ${d.currency}).</b>`;
          return;
        }
      }
      for (const p of pays) {
        const parent = debts[Number(p.parentFileRef) - 1] || debts[0];
        p.currency = parent.currency;
        if (!(p.fxRate > 0)) p.fxRate = parent.fxRate;
      }
      const batch = [
        ...debts.map((d) => ({ ...d, kind: "Debt" })),
        ...pays.map((p) => ({ ...p, kind: "Payment" })),
      ];

      const done = await withBusy(
        `Importing ${recs.length} rows in one batch`,
        async () => {
          const res = await state.store.importDebts(batch);
          state.debts = await state.store.getDebts();
          return res;
        },
      );
      if (done) {
        notice(
          `Imported ${debts.length} agreement(s), ${pays.length} payment(s) in a single write.`,
          "ok",
        );
        renderNetWorth();
      }
    } catch (err) {
      out.innerHTML = `<b class="over">${esc(err.message)}</b>`;
    }
  });
  view
    .querySelectorAll("[data-editdebt]")
    .forEach(
      (b) =>
        (b.onclick = () =>
          debtDialog(
            (state.debts || []).find(
              (d) => Number(d.id) === Number(b.dataset.editdebt),
            ),
          )),
    );

  view
    .querySelectorAll("[data-pay]")
    .forEach((b) => (b.onclick = () => paymentDialog(Number(b.dataset.pay))));

  view.querySelectorAll("[data-pdfdebt]").forEach(
    (b) =>
      (b.onclick = async () => {
        const d = debtSummary(state.debts || []).find(
          (x) => Number(x.id) === Number(b.dataset.pdfdebt),
        );
        if (!d) return;
        if (await withBusy("Building PDF", () => exportDebtPdf(d))) {
          notice(`Exported ${d.counterparty}.`, "ok");
        }
      }),
  );

  // Repair path for the sequential-import bug: a debt whose payments sum to
  // less than what its own notes/description implies is very likely a partial
  // import from before batching existed. Surface a one-click fix rather than
  // making the person work out what happened themselves.
  view.querySelectorAll("[data-fixpartial]").forEach(
    (b) =>
      (b.onclick = async () => {
        const id = Number(b.dataset.fixpartial);
        const d = debtSummary(state.debts || []).find((x) => x.id === id);
        if (!d) return;
        if (
          !confirm(
            `Delete "${d.counterparty}" and its ${d.payments.length} payment(s), so you can ` +
              `re-import the full ledger cleanly?\n\nThis cannot be undone.`,
          )
        )
          return;
        if (
          await withBusy("Removing the partial import", async () => {
            await state.store.deleteDebt(id);
          })
        ) {
          state.debts = await state.store.getDebts();
          notice("Removed. Re-import your ledger file now.", "ok");
          renderNetWorth();
        }
      }),
  );

  view.querySelectorAll("[data-deldebt]").forEach(
    (b) =>
      (b.onclick = async () => {
        const d = debtSummary(state.debts || []).find(
          (x) => Number(x.id) === Number(b.dataset.deldebt),
        );
        if (!d) return;
        const extra = d.payments.length
          ? `\n\nIts ${d.payments.length} recorded payment(s) will be deleted too.`
          : "";
        if (
          !confirm(
            `Delete "${d.counterparty}" (${moneyIn(d.principal, d.currency)})?${extra}\n\nTransactions are not affected.`,
          )
        )
          return;
        if (
          await withBusy("Deleting", async () => {
            await state.store.deleteDebt(d.id);
          })
        ) {
          await reload();
          notice("Deleted.", "ok");
        }
      }),
  );

  view.querySelectorAll("[data-delpay]").forEach(
    (b) =>
      (b.onclick = async () => {
        if (
          !confirm(
            "Delete this payment? The outstanding balance will go back up.",
          )
        )
          return;
        if (
          await withBusy("Deleting payment", async () => {
            await state.store.deleteDebt(Number(b.dataset.delpay));
          })
        ) {
          await reload();
          notice("Payment removed.", "ok");
        }
      }),
  );

  view
    .querySelectorAll("[data-editchild]")
    .forEach((b) => (b.onclick = () => childDialog(Number(b.dataset.editchild))));

  view.querySelectorAll("[data-delreceipt]").forEach(
    (b) =>
      (b.onclick = async () => {
        if (
          !confirm(
            "Delete this item? The principal and outstanding balance will go down.",
          )
        )
          return;
        if (
          await withBusy("Deleting item", async () => {
            await state.store.deleteDebt(Number(b.dataset.delreceipt));
          })
        ) {
          await reload();
          notice("Item removed.", "ok");
        }
      }),
  );
}

/** Edit one payment or one "how this debt built up" item. */
function childDialog(id) {
  const row = (state.debts || []).find((x) => Number(x.id) === Number(id));
  if (!row) return;
  const parent = debtSummary(state.debts || []).find(
    (x) => Number(x.id) === Number(row.parentId),
  );
  const cur = row.currency || parent?.currency || "CAD";
  const isPay = row.kind === "Payment";
  const label = isPay ? "payment" : "item";
  view.innerHTML = `
  <div class="head">
    <div><h1>Edit ${label}</h1>
      <p class="sub">${esc(row.counterparty)} &middot; amounts in ${esc(cur)}</p></div>
    <div class="spacer"></div><button class="btn ghost" id="ch-back">&larr; Back</button>
  </div>
  <form id="ch-form" class="formgrid" autocomplete="off">
    <label class="f"><span>Amount (${esc(cur)}) *</span>
      <input type="number" name="amount" step="0.01" min="0.01" required value="${row.amount}"></label>
    <label class="f"><span>Date *</span><input type="date" name="date" required value="${esc(row.date)}"></label>
    ${
      cur !== "CAD"
        ? `<label class="f"><span>1 ${esc(cur)} = ? CAD *</span>
      <input type="number" name="fxRate" step="0.000001" min="0.000001" required value="${row.fxRate ?? ""}"></label>`
        : ""
    }
    <label class="f wide"><span>${isPay ? "Note" : "Description"}</span>
      <input name="description" value="${esc(row.description || "")}"></label>
    ${
      isPay && row.paidCurrency && row.paidAmount != null
        ? `<p class="note full">Paid as ${moneyIn(row.paidAmount, row.paidCurrency)}; that is kept as recorded.</p>`
        : ""
    }
    <div class="full">
      <div class="err" id="ch-err"></div>
      <div class="actions">
        <button class="btn" type="submit">Save changes</button>
        <button class="btn ghost" type="button" id="ch-cancel">Cancel</button>
      </div>
    </div>
  </form>`;
  $("#ch-back").onclick = () => renderNetWorth();
  $("#ch-cancel").onclick = () => renderNetWorth();
  $("#ch-form").onsubmit = async (ev) => {
    ev.preventDefault();
    const f = Object.fromEntries(new FormData(ev.target));
    if (!(Number(f.amount) > 0))
      return ($("#ch-err").textContent = "Amount must be greater than zero.");
    if (cur !== "CAD" && !(Number(f.fxRate) > 0))
      return ($("#ch-err").textContent = `Enter the rate: 1 ${cur} = ? CAD.`);
    const rec = {
      ...row,
      amount: Number(f.amount),
      date: f.date,
      description: f.description,
      currency: cur,
      fxRate: cur === "CAD" ? 1 : Number(f.fxRate),
    };
    const done = await withBusy("Saving", async () => {
      await state.store.updateDebt(row.id, rec);
      state.debts = await state.store.getDebts();
    });
    if (done) {
      notice("Updated.", "ok");
      renderNetWorth();
    }
  };
}

/** Looks up the stored CAD rate for `cur` on `date` and fills `input` unless
    the person has typed their own value (dataset.auto tracks that). */
async function fillRate(cur, date, input, hint) {
  if (!input || cur === "CAD") return;
  try {
    const found = await state.store.getExchangeRate?.(date, cur);
    if (found) {
      if (!input.value || input.dataset.auto === "1") {
        input.value = found.rateToCad;
        input.dataset.auto = "1";
      }
      if (hint)
        hint.textContent =
          found.date === date
            ? "auto-filled - edit if your statement differs"
            : `auto-filled from ${found.date} (closest available) - edit if your statement differs`;
    } else if (hint) {
      hint.textContent = "no stored rate for this date - enter it";
    }
  } catch {
    if (hint) hint.textContent = "couldn't look up a rate - enter it";
  }
}

function currencyOptions(sel) {
  return CURRENCIES.map(
    (c) => `<option value="${c}"${c === sel ? " selected" : ""}>${c}</option>`,
  ).join("");
}

function debtDialog(existing) {
  const d = existing || {};
  const today = new Date().toISOString().slice(0, 10);
  const known = [
    ...new Set((state.debts || []).map((x) => x.counterparty).filter(Boolean)),
  ];
  const DEBT_TYPES = [
    "Family",
    "Auto Loan",
    "Mortgage",
    "Personal Loan",
    "Credit Card",
    "Student Loan",
    "Other",
  ];
  const curSel = d.currency || "CAD";
  const locked =
    !!existing &&
    (state.debts || []).some((x) => Number(x.parentId) === Number(existing.id));
  view.innerHTML = `
  <div class="head">
    <div><h1>${existing ? "Edit" : "Add"} debt or loan</h1>
      <p class="sub">Records a balance-sheet position. It does not create a transaction.</p></div>
    <div class="spacer"></div><button class="btn ghost" id="debt-back">&larr; Back</button>
  </div>
  <form id="debt-form" class="formgrid" autocomplete="off">
    <label class="f"><span>Who *</span>
      <input name="counterparty" value="${esc(d.counterparty || "")}" list="debt-names" placeholder="e.g. Varun" required></label>
    <datalist id="debt-names">${known.map((k) => `<option>${esc(k)}</option>`).join("")}</datalist>
    <label class="f"><span>Direction *</span>
      <select name="direction">
        <option value="Lent"${d.direction === "Lent" ? " selected" : ""}>They owe me (I lent money)</option>
        <option value="Owed"${d.direction === "Owed" ? " selected" : ""}>I owe them</option>
      </select></label>
    <label class="f"><span>Type</span>
      <select name="debtType">
        <option value=""${!d.debtType ? " selected" : ""}>&mdash; Not set &mdash;</option>
        ${DEBT_TYPES.map(
          (t) =>
            `<option value="${t}"${d.debtType === t ? " selected" : ""}>${t}</option>`,
        ).join("")}
      </select></label>
    <label class="f"><span>Currency *</span>
      <select name="currency" id="debt-cur"${locked ? " disabled" : ""}>${currencyOptions(curSel)}</select>
      ${locked ? `<small class="muted">Locked - this debt already has payments or items.</small>` : ""}</label>
    <label class="f"><span>Principal amount *</span>
      <input type="number" name="amount" id="debt-amt" step="0.01" min="0.01" value="${d.amount ?? ""}" required placeholder="0.00"></label>
    <label class="f" id="debt-fx-row"${curSel === "CAD" ? ' style="display:none"' : ""}><span id="debt-fx-label">1 ${esc(curSel)} = ? CAD *</span>
      <input type="number" name="fxRate" id="debt-fx" step="0.000001" min="0.000001" value="${curSel === "CAD" ? "" : esc(String(d.fxRate ?? ""))}" placeholder="rate to CAD" inputmode="decimal">
      <small class="muted" id="debt-fx-hint"></small> <small id="debt-fx-prev"></small></label>
    <label class="f"><span>Interest rate (% p.a., optional)</span>
      <input type="number" name="interestRate" step="0.01" min="0" value="${d.interestRate ?? ""}" placeholder="e.g. 5.5"></label>
    <label class="f"><span>Whose *</span>
      <select name="owner">${PEOPLE.map((p) => `<option${(d.owner || "Ramesh") === p ? " selected" : ""}>${esc(p)}</option>`).join("")}</select></label>
    <label class="f"><span>Date opened *</span>
      <input type="date" name="date" value="${esc(d.date || today)}" required></label>
    <label class="f wide"><span>Description</span>
      <input name="description" value="${esc(d.description || "")}" placeholder="What was it for?"></label>
    <div class="full">
      <div class="err" id="debt-err"></div>
      ${
        existing
          ? ""
          : `<p class="note" id="debt-merge-note" style="display:none">A <b>Family</b> debt (or one at <b>0% interest</b>) merges into your existing Family debt as an itemized entry under "How this debt built up" instead of starting a new card - uncheck below to add it as its own card anyway. If the currency differs, the amount is converted into the existing debt's currency (CAD) at the rate you enter.
              <label style="display:block;margin-top:6px"><input type="checkbox" id="debt-merge-toggle" checked> Add as an item under the existing Family debt</label></p>`
      }
      <div class="actions">
        <button class="btn" type="submit">${existing ? "Save changes" : "Add"}</button>
        <button class="btn ghost" type="button" id="debt-cancel">Cancel</button>
      </div>
    </div>
  </form>
  <p class="note">Money you <b>lend</b> becomes an asset (they owe you). Money you <b>owe</b> becomes a
    liability. Either way it updates net worth, and record repayments against it as they happen.</p>`;

  $("#debt-back").onclick = () => renderNetWorth();
  $("#debt-cancel").onclick = () => renderNetWorth();

  const fxIn = $("#debt-fx");
  const curNow = () => $("#debt-cur").value;
  const fxPrev = () => {
    const c = curNow();
    const a = Number($("#debt-amt").value) || 0;
    const r = Number(fxIn.value) || 0;
    $("#debt-fx-prev").textContent =
      c !== "CAD" && a && r ? `\u2248 ${money(toCad(a, r))}` : "";
  };
  const dateIn = () => document.querySelector('#debt-form [name="date"]').value;
  $("#debt-cur").addEventListener("change", () => {
    const c = curNow();
    $("#debt-fx-row").style.display = c === "CAD" ? "none" : "";
    $("#debt-fx-label").textContent = `1 ${c} = ? CAD *`;
    fxIn.value = "";
    delete fxIn.dataset.auto;
    $("#debt-fx-hint").textContent = "";
    if (c !== "CAD") fillRate(c, dateIn(), fxIn, $("#debt-fx-hint")).then(fxPrev);
    fxPrev();
    if (typeof updateMergeNote === "function") updateMergeNote();
  });
  fxIn.addEventListener("input", () => {
    delete fxIn.dataset.auto;
    fxPrev();
  });
  $("#debt-amt").addEventListener("input", fxPrev);
  document
    .querySelector('#debt-form [name="date"]')
    .addEventListener("change", () => {
      if (curNow() !== "CAD")
        fillRate(curNow(), dateIn(), fxIn, $("#debt-fx-hint")).then(fxPrev);
    });
  if (!existing && curNow() !== "CAD") fillRate(curNow(), dateIn(), fxIn, $("#debt-fx-hint")).then(fxPrev);
  fxPrev();

  // Existing "Family" agreement (if any) to potentially merge new entries
  // into. Only meaningful when adding fresh - editing an existing row never
  // re-routes it elsewhere.
  const familyAgreement = existing
    ? null
    : debtSummary(state.debts || []).find((a) => a.debtType === "Family");

  const updateMergeNote = () => {
    const toggle = $("#debt-merge-toggle");
    if (!toggle) return;
    const f = Object.fromEntries(new FormData($("#debt-form")));
    const wouldMerge =
      familyAgreement &&
      (f.debtType === "Family" || Number(f.interestRate) === 0);
    $("#debt-merge-note").style.display = wouldMerge ? "block" : "none";
  };
  if (!existing) {
    $("#debt-form").addEventListener("input", updateMergeNote);
    updateMergeNote();
  }

  $("#debt-form").onsubmit = async (ev) => {
    ev.preventDefault();
    const f = Object.fromEntries(new FormData(ev.target));
    f.currency = curNow();
    if (!(Number(f.amount) > 0))
      return ($("#debt-err").textContent =
        "Principal must be greater than zero.");
    if (f.currency !== "CAD" && !(Number(f.fxRate) > 0))
      return ($("#debt-err").textContent = `Enter the rate: 1 ${f.currency} = ? CAD.`);
    if (!f.counterparty.trim())
      return ($("#debt-err").textContent = "Who is this with?");
    if (f.interestRate !== "" && Number(f.interestRate) < 0)
      return ($("#debt-err").textContent = "Interest rate can't be negative.");

    // Family debts (and anything explicitly 0% interest, which is how
    // informal family-style loans tend to be recorded) fold into the
    // existing Family agreement as an itemized "Receipt" rather than
    // spawning a new top-level card, as long as the merge checkbox is
    // still ticked and there's an existing Family debt to fold into.
    const fxRate = f.currency === "CAD" ? 1 : Number(f.fxRate);
    const wantsMerge =
      !existing &&
      familyAgreement &&
      (f.debtType === "Family" || Number(f.interestRate) === 0) &&
      $("#debt-merge-toggle")?.checked;

    // A merged item lands in the existing agreement's currency (CAD for the
    // Family debt): convert at the rate entered, and keep the original
    // amount in the description so nothing is lost.
    const pCur = wantsMerge ? familyAgreement.currency || "CAD" : f.currency;
    const pRate = wantsMerge ? debtRateCad(familyAgreement) : fxRate;
    const mergedAmt =
      wantsMerge && pCur !== f.currency
        ? Math.round(((Number(f.amount) * fxRate) / pRate) * 100) / 100
        : Number(f.amount);
    const origNote =
      wantsMerge && pCur !== f.currency
        ? ` (${moneyIn(Number(f.amount), f.currency)} @ ${fxRate})`
        : "";
    const rec = wantsMerge
      ? {
          kind: "Receipt",
          parentId: familyAgreement.id,
          counterparty: familyAgreement.counterparty,
          direction: familyAgreement.direction,
          description: (f.description || f.counterparty.trim()) + origNote,
          date: f.date,
          amount: mergedAmt,
          currency: pCur,
          fxRate: pRate,
          owner: f.owner,
          notes: "",
        }
      : {
          kind: "Debt",
          parentId: null,
          counterparty: f.counterparty.trim(),
          direction: f.direction,
          description: f.description,
          date: f.date,
          amount: Number(f.amount),
          currency: f.currency,
          fxRate,
          interestRate: f.interestRate === "" ? null : Number(f.interestRate),
          debtType: f.debtType || null,
          owner: f.owner,
          notes: "",
        };
    const done = await withBusy(existing ? "Saving" : "Adding", async () => {
      if (existing) await state.store.updateDebt(existing.id, rec);
      else await state.store.addDebt(rec);
      state.debts = await state.store.getDebts();
    });
    if (done) {
      notice(
        existing
          ? "Updated."
          : wantsMerge
            ? `Added to ${familyAgreement.counterparty}.`
            : `Added ${f.counterparty.trim()}.`,
        "ok",
      );
      renderNetWorth();
    }
  };
}

function paymentDialog(debtId) {
  const d = debtSummary(state.debts || []).find(
    (x) => Number(x.id) === Number(debtId),
  );
  if (!d) return;
  const today = new Date().toISOString().slice(0, 10);
  const dc = d.currency; // the debt's own currency
  const fm = (n) => moneyIn(n, dc);
  view.innerHTML = `
  <div class="head">
    <div><h1>Record payment</h1>
      <p class="sub">${esc(d.counterparty)} &middot; ${fm(d.outstanding)} outstanding of ${fm(d.principal)}</p></div>
    <div class="spacer"></div><button class="btn ghost" id="pay-back">&larr; Back</button>
  </div>
  <form id="pay-form" class="formgrid" autocomplete="off">
    <label class="f"><span>Paid in *</span>
      <select name="paidCurrency" id="pay-cur">${currencyOptions(dc)}</select></label>
    <label class="f"><span>Amount paid *</span>
      <input type="number" name="paid" step="0.01" min="0.01" required placeholder="0.00" id="pay-paid"></label>
    <label class="f"><span>Date *</span><input type="date" name="date" value="${today}" required id="pay-date"></label>
    <label class="f" id="pay-fx1-row"><span id="pay-fx1-label"></span>
      <input type="number" id="pay-fx1" step="0.000001" min="0.000001" placeholder="rate to CAD" inputmode="decimal">
      <small class="muted" id="pay-fx1-hint"></small></label>
    <label class="f" id="pay-fx2-row" style="display:none"><span id="pay-fx2-label"></span>
      <input type="number" id="pay-fx2" step="0.000001" min="0.000001" placeholder="rate to CAD" inputmode="decimal">
      <small class="muted" id="pay-fx2-hint"></small></label>
    <label class="f" id="pay-applied-row" style="display:none"><span>Counts toward the debt (${esc(dc)}) *</span>
      <input type="number" id="pay-applied" step="0.01" min="0.01" placeholder="0.00">
      <small class="muted">Calculated from the rates above - edit it if your bank's actual rate differs.</small></label>
    <label class="f wide"><span>Note</span><input name="description" placeholder="e.g. e-transfer"></label>
    <div class="full">
      <div class="actions" style="margin-bottom:10px">
        <button class="btn ghost" type="button" id="pay-full">Pay full ${fm(d.outstanding)}</button>
        <button class="btn ghost" type="button" id="pay-half">Half</button>
      </div>
      <div class="err" id="pay-err"></div>
      <div class="actions">
        <button class="btn" type="submit">Record payment</button>
        <button class="btn ghost" type="button" id="pay-cancel">Cancel</button>
      </div>
    </div>
  </form>
  <p class="note">This reduces the outstanding balance and appears in the payment history.
    It does <b>not</b> create a transaction &mdash; if the cash movement also needs recording,
    add it under <b>Add</b> as a <b>Transfer</b> so it does not count as spending.</p>`;

  $("#pay-back").onclick = () => renderNetWorth();
  $("#pay-cancel").onclick = () => renderNetWorth();

  const pc = () => $("#pay-cur").value;
  const cross = () => pc() !== dc;
  const num = (id) => Number($(id).value) || 0;
  // CAD per unit of the debt currency / of the paid currency
  const debtFx = () => (dc === "CAD" ? 1 : cross() ? num("#pay-fx2") : num("#pay-fx1"));
  const paidFx = () => (pc() === "CAD" ? 1 : num("#pay-fx1"));
  const applied = () =>
    cross() ? num("#pay-applied") : num("#pay-paid");

  let appliedEdited = false;
  const recalc = () => {
    if (!cross() || appliedEdited) return;
    const pf = paidFx();
    const df = debtFx();
    const paid = num("#pay-paid");
    $("#pay-applied").value =
      paid && pf && df ? ((paid * pf) / df).toFixed(2) : "";
  };
  const layout = () => {
    const p = pc();
    $("#pay-fx1-row").style.display = p === "CAD" ? "none" : "";
    $("#pay-fx1-label").textContent = `1 ${p} = ? CAD *`;
    const needFx2 = cross() && dc !== "CAD";
    $("#pay-fx2-row").style.display = needFx2 ? "" : "none";
    $("#pay-fx2-label").textContent = `1 ${dc} = ? CAD *`;
    $("#pay-applied-row").style.display = cross() ? "" : "none";
  };
  const lookups = () => {
    const date = $("#pay-date").value || today;
    if (pc() !== "CAD") fillRate(pc(), date, $("#pay-fx1"), $("#pay-fx1-hint")).then(recalc);
    if (cross() && dc !== "CAD") fillRate(dc, date, $("#pay-fx2"), $("#pay-fx2-hint")).then(recalc);
  };
  $("#pay-cur").addEventListener("change", () => {
    for (const id of ["#pay-fx1", "#pay-fx2"]) {
      $(id).value = "";
      delete $(id).dataset.auto;
    }
    appliedEdited = false;
    layout();
    lookups();
    recalc();
  });
  for (const id of ["#pay-fx1", "#pay-fx2"])
    $(id).addEventListener("input", () => {
      delete $(id).dataset.auto;
      recalc();
    });
  $("#pay-paid").addEventListener("input", recalc);
  $("#pay-applied").addEventListener("input", () => (appliedEdited = true));
  $("#pay-date").addEventListener("change", lookups);
  layout();
  lookups();

  const setApplied = (v) => {
    appliedEdited = false;
    if (!cross()) {
      $("#pay-paid").value = v.toFixed(2);
    } else {
      const pf = paidFx();
      const df = debtFx();
      if (pf && df) $("#pay-paid").value = ((v * df) / pf).toFixed(2);
      $("#pay-applied").value = v.toFixed(2);
      appliedEdited = true;
    }
  };
  $("#pay-full").onclick = () => setApplied(d.outstanding);
  $("#pay-half").onclick = () => setApplied(d.outstanding / 2);

  $("#pay-form").onsubmit = async (ev) => {
    ev.preventDefault();
    const f = Object.fromEntries(new FormData(ev.target));
    const paid = Number(f.paid);
    if (!(paid > 0))
      return ($("#pay-err").textContent = "Amount must be greater than zero.");
    if (pc() !== "CAD" && !(paidFx() > 0))
      return ($("#pay-err").textContent = `Enter the rate: 1 ${pc()} = ? CAD.`);
    if (cross() && dc !== "CAD" && !(debtFx() > 0))
      return ($("#pay-err").textContent = `Enter the rate: 1 ${dc} = ? CAD.`);
    const amt = applied();
    if (!(amt > 0))
      return ($("#pay-err").textContent =
        "Enter how much this counts toward the debt.");
    if (
      amt - d.outstanding > 0.005 &&
      !confirm(
        `${fm(amt)} is more than the ${fm(d.outstanding)} outstanding. Record it anyway?`,
      )
    )
      return;
    const rec = {
      kind: "Payment",
      parentId: d.id,
      counterparty: d.counterparty,
      direction: d.direction,
      description: f.description,
      date: f.date,
      amount: Math.round(amt * 100) / 100,
      currency: dc,
      fxRate: dc === "CAD" ? 1 : debtFx(),
      paidCurrency: cross() ? pc() : null,
      paidAmount: cross() ? paid : null,
      owner: d.owner,
      notes: "",
    };
    const done = await withBusy("Recording payment", async () => {
      await state.store.addDebt(rec);
      state.debts = await state.store.getDebts();
    });
    if (done) {
      const left = Math.max(0, d.outstanding - amt);
      notice(
        left < 0.005
          ? `${d.counterparty} fully settled.`
          : `${fm(left)} still outstanding.`,
        "ok",
      );
      renderNetWorth();
    }
  };
}

/** Debts & loans section: one card per agreement, with repayment history. */
export function renderDebtSection(scopeOwner) {
  const rows = debtSummary(state.debts || [])
    .filter((d) => !scopeOwner || d.owner === scopeOwner)
    .sort((a, b) =>
      a.settled === b.settled
        ? b.outstanding - a.outstanding
        : a.settled
          ? 1
          : -1,
    );

  const owedTotal = rows
    .filter((d) => d.direction === "Owed" && !d.settled)
    .reduce((s, d) => s + d.outstandingCad, 0);
  const lentTotal = rows
    .filter((d) => d.direction === "Lent" && !d.settled)
    .reduce((s, d) => s + d.outstandingCad, 0);

  const card = (d) => {
    const rel = relatedTransactions(d.counterparty);
    const relTotal = rel.reduce((s, r) => s + amountCad(r), 0);
    // If cash moved but no payment was recorded (or vice versa), say so rather
    // than let the two views quietly disagree. Compared in CAD (transactions
    // are CAD-valued) using each payment's own rate.
    const paidCadCmp = d.paidCadAtRow;
    const mismatch = rel.length > 0 && Math.abs(relTotal - paidCadCmp) > 0.005;
    const foreign = d.currency !== "CAD";
    const fm = (n) => moneyIn(n, d.currency); // the debt's own currency
    return `
    <div class="debt-card ${d.settled ? "settled" : ""}" data-debt="${d.id}">
      <div class="debt-head">
        <div>
          <span class="debt-name">${esc(d.counterparty)}</span>
          <span class="tag ${d.direction === "Owed" ? "tag-liab" : ""}">${d.direction === "Owed" ? "You owe" : "Owed to you"}</span>
          ${d.settled ? '<span class="tag debt-settled-tag">Settled</span>' : ""}
          ${d.debtType ? `<span class="tag">${esc(d.debtType)}</span>` : ""}
          ${d.interestRate != null ? `<span class="tag">${d.interestRate}% p.a.</span>` : ""}
          ${d.owner ? `<span class="person-chip" data-p="${esc(d.owner)}">${esc(d.owner)}</span>` : ""}
          ${d.description ? `<div class="debt-desc">${esc(d.description)}</div>` : ""}
        </div>
        <div class="debt-amounts">
          <span class="debt-outstanding num ${d.direction === "Owed" ? "tx-over" : "tx-income"}">${fm(d.outstanding)}</span>
          <span class="debt-sub">outstanding of ${fm(d.principal)}</span>
          ${foreign ? `<span class="debt-sub">\u2248 ${money(d.outstandingCad)} at ${d.rateCad.toFixed(4)} CAD/${esc(d.currency)}</span>` : ""}
        </div>
      </div>

      <div class="debt-bar-track"><div class="debt-bar-fill ${d.settled ? "done" : ""}" style="width:${(d.pct * 100).toFixed(1)}%"></div></div>
      <div class="debt-meta">
        <span class="muted">${fm(d.paid)} repaid \u00b7 ${(d.pct * 100).toFixed(0)}%</span>
        <span class="muted">${d.payments.length} payment${d.payments.length === 1 ? "" : "s"} \u00b7 opened ${esc(d.date)}</span>
      </div>

      ${
        d.overpaid
          ? `<div class="debt-warn">Payments exceed the principal by
        ${fm(d.paid - d.principal)}. Outstanding is floored at zero.</div>`
          : ""
      }
      ${
        d.notes &&
        /\$[\d,]+\.\d{2}/.test(d.notes) &&
        d.payments.length > 0 &&
        d.payments.length < 20
          ? `<div class="debt-warn">This looks like it might be a partial import from before batch import
           existed \u2014 only ${d.payments.length} payment(s) are recorded. If you imported a longer
           ledger and expected more, <button class="rowbtn" style="display:inline" data-fixpartial="${d.id}">remove this and re-import</button>.</div>`
          : ""
      }
      ${
        mismatch
          ? `<div class="debt-warn">Transactions mentioning &ldquo;${esc(d.counterparty)}&rdquo;
        total ${money(relTotal)}, but ${money(paidCadCmp)} is recorded here.
        ${relTotal > paidCadCmp ? "Some cash movement has no matching payment." : "Some payments have no matching transaction."}</div>`
          : ""
      }

      ${
        d.receipts.length
          ? `<details class="debt-history">
        <summary>How this debt built up (${fm(d.received)} in ${d.receipts.length} item${d.receipts.length === 1 ? "" : "s"})</summary>
        <table class="debt-table"><tbody>
          ${d.receipts
            .map(
              (r) => `<tr>
            <td class="num">${esc(r.date)}</td>
            <td>${esc(r.description) || '<span class="muted">\u2014</span>'}</td>
            <td class="n num">${fm(r.amount)}</td>
            <td><button class="rowbtn" data-editchild="${r.id}" title="Edit this item">\u270E</button>
              <button class="rowbtn" data-delreceipt="${r.id}" title="Delete this item">\u2715</button></td>
          </tr>`,
            )
            .join("")}
        </tbody></table>
      </details>`
          : ""
      }

      ${
        d.payments.length
          ? `<details class="debt-history">
        <summary>Payment history</summary>
        <table class="debt-table"><tbody>
          ${d.payments
            .map(
              (p) => `<tr>
            <td class="num">${esc(p.date)}</td>
            <td>${esc(p.description) || '<span class="muted">\u2014</span>'}</td>
            <td class="n num">${fm(p.amount)}${p.paidCurrency && p.paidAmount != null ? ` <span class="muted">(paid ${moneyIn(p.paidAmount, p.paidCurrency)})</span>` : ""}</td>
            <td><button class="rowbtn" data-editchild="${p.id}" title="Edit this payment">\u270E</button>
              <button class="rowbtn" data-delpay="${p.id}" title="Delete this payment">\u2715</button></td>
          </tr>`,
            )
            .join("")}
        </tbody></table>
      </details>`
          : ""
      }

      ${
        rel.length
          ? `<details class="debt-history">
        <summary>${rel.length} matching transaction${rel.length === 1 ? "" : "s"} (${money(relTotal)})</summary>
        <table class="debt-table"><tbody>
          ${rel
            .slice(0, 10)
            .map(
              (r) => `<tr>
            <td class="num">${esc(r.date)}</td>
            <td>${esc(r.description).slice(0, 44)}</td>
            <td><span class="tag">${esc(r.type)}</span></td>
            <td class="n num">${moneyIn(r.amount, r.currency)}</td>
          </tr>`,
            )
            .join("")}
        </tbody></table>
        <p class="note" style="margin:8px 0 0">These come from your Transactions tab. They are shown for
          cross-checking only &mdash; recording a payment here does not create or alter a transaction.</p>
      </details>`
          : ""
      }

      <div class="debt-actions">
        <button class="btn ghost debt-pay" data-pay="${d.id}">Record payment</button>
        <button class="btn ghost" data-editdebt="${d.id}">Edit</button>
        <button class="btn ghost" data-pdfdebt="${d.id}">Export PDF</button>
        <button class="rowbtn" data-deldebt="${d.id}" title="Delete this agreement and its payments">\u2715</button>
      </div>
    </div>`;
  };

  pendingKpiCount = rows.length
    ? [
        ["debt-owed", owedTotal, money],
        ["debt-lent", lentTotal, money],
        ["debt-net", lentTotal - owedTotal, money],
      ]
    : [];

  return `
  <div class="eyebrow">Debts &amp; loans</div>
  ${
    rows.length
      ? `<div class="kpis">
    ${kpi("You owe", money(owedTotal), owedTotal > 0 ? "outstanding" : "nothing owed", owedTotal > 0 ? "neg" : "", "debt-owed")}
    ${kpi("Owed to you", money(lentTotal), lentTotal > 0 ? "outstanding" : "nothing lent", lentTotal > 0 ? "pos" : "", "debt-lent")}
    ${kpi(
      "Net position",
      money(lentTotal - owedTotal),
      "",
      lentTotal - owedTotal < 0 ? "neg" : "pos",
      "debt-net",
    )}
  </div>`
      : ""
  }

  <div class="debt-list">
    ${
      rows.length
        ? rows.map(card).join("")
        : `<div class="empty">${emptyIcon()}<span>No debts or loans recorded. Use <b>Add debt or loan</b> to track money you owe,
         or money you have lent out.</span></div>`
    }
  </div>

  <div class="actions" style="margin:12px 0 8px">
    <button class="btn" id="debt-add">Add debt or loan</button>
    <label class="btn ghost nw-import-btn" for="debt-import">Import ledger\u2026</label>
    <input type="file" id="debt-import" accept=".csv,.json" hidden>
    <span class="muted">Outstanding balances flow into the net-worth totals above automatically.</span>
  </div>
  <div id="debt-import-out" class="note" style="margin:0 0 24px"></div>`;
}

/** Enter every account's balance for one date. Grouped, running total, carry-forward. */
