import {
  $,
  view,
  esc,
  state,
  withBusy,
  notice,
  personColorClass,
} from "../core.js";
import { money, pct } from "../xlsxio.js";
import { listFor } from "../categories.js";
import { renderNetWorth } from "./networth.js";

/* ---------------------------------------------------------- debts and loans
   A debt is an agreement plus its repayment history. Outstanding is always
   recomputed as principal minus payments, never stored, so the number on
   screen cannot drift away from the payments that produced it.

   Direction is from your side:
     Owed  - you owe them  -> a LIABILITY, reduces net worth
     Lent  - they owe you  -> an ASSET (a receivable), increases net worth

   These sit alongside Transactions, they do not replace them. Sending $200 to
   Varun is a Transfer in Transactions (cash left an account) AND a payment
   here (a balance-sheet position changed). Counting it as an expense in
   Transactions would be the actual error - lending money is not spending it. */
function debtSummary(debts) {
  const agreements = debts.filter((d) => d.kind !== "Payment");
  return agreements.map((a) => {
    const payments = debts
      .filter(
        (d) => d.kind === "Payment" && Number(d.parentId) === Number(a.id),
      )
      .sort((x, y) => (x.date < y.date ? 1 : -1));
    const paid = payments.reduce((s, p) => s + Number(p.amount || 0), 0);
    const principal = Number(a.amount || 0);
    const outstanding = Math.max(0, principal - paid);
    return {
      ...a,
      payments,
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
      .reduce((s, d) => s + d.outstanding, 0),
    receivable: rows
      .filter((d) => d.direction === "Lent")
      .reduce((s, d) => s + d.outstanding, 0),
  };
}

/** Transactions that look like they involve this counterparty. */
function relatedTransactions(counterparty) {
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
            `Delete "${d.counterparty}" (${money(d.principal)})?${extra}\n\nTransactions are not affected.`,
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
}

function debtDialog(existing) {
  const d = existing || {};
  const today = new Date().toISOString().slice(0, 10);
  const known = [
    ...new Set((state.debts || []).map((x) => x.counterparty).filter(Boolean)),
  ];
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
    <label class="f"><span>Principal amount *</span>
      <input type="number" name="amount" step="0.01" min="0.01" value="${d.amount ?? ""}" required placeholder="0.00"></label>
    <label class="f"><span>Whose *</span>
      <input name="owner" value="${esc(d.owner || "")}" list="owner-names" placeholder="e.g. ${esc(listFor("person")[0] || "your name")}" required></label>
    <datalist id="owner-names">${listFor("person")
      .map((p) => `<option>${esc(p)}</option>`)
      .join("")}</datalist>
    <label class="f"><span>Date opened *</span>
      <input type="date" name="date" value="${esc(d.date || today)}" required></label>
    <label class="f wide"><span>Description</span>
      <input name="description" value="${esc(d.description || "")}" placeholder="What was it for?"></label>
    <div class="full">
      <div class="err" id="debt-err"></div>
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
  $("#debt-form").onsubmit = async (ev) => {
    ev.preventDefault();
    const f = Object.fromEntries(new FormData(ev.target));
    if (!(Number(f.amount) > 0))
      return ($("#debt-err").textContent =
        "Principal must be greater than zero.");
    if (!f.counterparty.trim())
      return ($("#debt-err").textContent = "Who is this with?");
    const rec = {
      kind: "Debt",
      parentId: null,
      counterparty: f.counterparty.trim(),
      direction: f.direction,
      description: f.description,
      date: f.date,
      amount: Number(f.amount),
      owner: f.owner,
      notes: "",
    };
    const done = await withBusy(existing ? "Saving" : "Adding", async () => {
      if (existing) await state.store.updateDebt(existing.id, rec);
      else await state.store.addDebt(rec);
      state.debts = await state.store.getDebts();
    });
    if (done) {
      notice(existing ? "Updated." : `Added ${f.counterparty.trim()}.`, "ok");
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
  view.innerHTML = `
  <div class="head">
    <div><h1>Record payment</h1>
      <p class="sub">${esc(d.counterparty)} &middot; ${money(d.outstanding)} outstanding of ${money(d.principal)}</p></div>
    <div class="spacer"></div><button class="btn ghost" id="pay-back">&larr; Back</button>
  </div>
  <form id="pay-form" class="formgrid" autocomplete="off">
    <label class="f"><span>Amount *</span>
      <input type="number" name="amount" step="0.01" min="0.01" value="" required placeholder="0.00" id="pay-amt"></label>
    <label class="f"><span>Date *</span><input type="date" name="date" value="${today}" required></label>
    <label class="f wide"><span>Note</span><input name="description" placeholder="e.g. e-transfer"></label>
    <div class="full">
      <div class="actions" style="margin-bottom:10px">
        <button class="btn ghost" type="button" id="pay-full">Pay full ${money(d.outstanding)}</button>
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
  $("#pay-full").onclick = () => {
    $("#pay-amt").value = d.outstanding.toFixed(2);
  };
  $("#pay-half").onclick = () => {
    $("#pay-amt").value = (d.outstanding / 2).toFixed(2);
  };

  $("#pay-form").onsubmit = async (ev) => {
    ev.preventDefault();
    const f = Object.fromEntries(new FormData(ev.target));
    const amt = Number(f.amount);
    if (!(amt > 0))
      return ($("#pay-err").textContent = "Amount must be greater than zero.");
    if (
      amt - d.outstanding > 0.005 &&
      !confirm(
        `${money(amt)} is more than the ${money(d.outstanding)} outstanding. Record it anyway?`,
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
      amount: amt,
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
          : `${money(left)} still outstanding.`,
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
    .reduce((s, d) => s + d.outstanding, 0);
  const lentTotal = rows
    .filter((d) => d.direction === "Lent" && !d.settled)
    .reduce((s, d) => s + d.outstanding, 0);

  const card = (d) => {
    const rel = relatedTransactions(d.counterparty);
    const relTotal = rel.reduce((s, r) => s + r.amount, 0);
    // If cash moved but no payment was recorded (or vice versa), say so rather
    // than let the two views quietly disagree.
    const mismatch = rel.length > 0 && Math.abs(relTotal - d.paid) > 0.005;
    return `
    <div class="debt-card ${d.settled ? "settled" : ""}" data-debt="${d.id}">
      <div class="debt-head">
        <div>
          <span class="debt-name">${esc(d.counterparty)}</span>
          <span class="tag ${d.direction === "Owed" ? "tag-liab" : ""}">${d.direction === "Owed" ? "You owe" : "Owed to you"}</span>
          ${d.settled ? '<span class="tag debt-settled-tag">Settled</span>' : ""}
          ${d.owner ? `<span class="person-chip ${personColorClass(d.owner)}" data-p="${esc(d.owner)}">${esc(d.owner)}</span>` : ""}
          ${d.description ? `<div class="debt-desc">${esc(d.description)}</div>` : ""}
        </div>
        <div class="debt-amounts">
          <span class="debt-outstanding num ${d.direction === "Owed" ? "tx-over" : "tx-income"}">${money(d.outstanding)}</span>
          <span class="debt-sub">outstanding of ${money(d.principal)}</span>
        </div>
      </div>

      <div class="debt-bar-track"><div class="debt-bar-fill ${d.settled ? "done" : ""}" style="width:${(d.pct * 100).toFixed(1)}%"></div></div>
      <div class="debt-meta">
        <span class="muted">${money(d.paid)} repaid \u00b7 ${(d.pct * 100).toFixed(0)}%</span>
        <span class="muted">${d.payments.length} payment${d.payments.length === 1 ? "" : "s"} \u00b7 opened ${esc(d.date)}</span>
      </div>

      ${
        d.overpaid
          ? `<div class="debt-warn">Payments exceed the principal by
        ${money(d.paid - d.principal)}. Outstanding is floored at zero.</div>`
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
        total ${money(relTotal)}, but ${money(d.paid)} is recorded here.
        ${relTotal > d.paid ? "Some cash movement has no matching payment." : "Some payments have no matching transaction."}</div>`
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
            <td class="n num">${money(p.amount)}</td>
            <td><button class="rowbtn" data-delpay="${p.id}" title="Delete this payment">\u2715</button></td>
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
            <td class="n num">${money(r.amount)}</td>
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
        <button class="rowbtn" data-deldebt="${d.id}" title="Delete this agreement and its payments">\u2715</button>
      </div>
    </div>`;
  };

  return `
  <div class="eyebrow">Debts &amp; loans</div>
  ${
    rows.length
      ? `<div class="debt-summary">
    <div><span class="debt-sum-label">You owe</span><span class="debt-sum-val num tx-over">${money(owedTotal)}</span></div>
    <div><span class="debt-sum-label">Owed to you</span><span class="debt-sum-val num tx-income">${money(lentTotal)}</span></div>
    <div><span class="debt-sum-label">Net position</span><span class="debt-sum-val num ${lentTotal - owedTotal < 0 ? "tx-over" : "tx-income"}">${money(lentTotal - owedTotal)}</span></div>
  </div>`
      : ""
  }

  <div class="debt-list">
    ${
      rows.length
        ? rows.map(card).join("")
        : `<div class="empty">No debts or loans recorded. Use <b>Add debt or loan</b> to track money you owe,
         or money you have lent out.</div>`
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
