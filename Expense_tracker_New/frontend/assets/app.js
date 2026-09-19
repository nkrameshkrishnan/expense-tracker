import {
  CAT_NAMES,
  PAYMENTS,
  ACCOUNTS,
  currentYear,
  PERSON_KEY,
  getIdToken,
  setIdToken,
  CURRENCIES,
} from "./store.js";
import {
  $,
  view,
  esc,
  YEAR_KEY,
  state,
  withBusy,
  notice,
  refresh,
  switchActiveTenant,
  personColorClass,
  periodSelect,
} from "./core.js";
import { viewTransition } from "./motion.js";
import { aggregate, money, pct, exportWorkbook, importFile } from "./xlsxio.js";
import { removeCustom, listFor } from "./categories.js";
import * as charts from "./charts.js";
import {
  planCopy,
  formatPlanAmount,
  formatPlanPeriod,
  planSeatsLabel,
  planFeatureList,
  ensurePlans,
  markPlanGateSeen,
} from "./tenant.js";
import {
  showGate,
  signOut,
  consumeAuthRedirect,
  revealApp,
  isRemoteStore,
  boot,
} from "./auth.js";
import { renderDashboard } from "./pages/dashboard.js";
import { renderCashFlow } from "./pages/cashflow.js";
import { renderSpending } from "./pages/spending.js";
import { renderAdd } from "./pages/add.js";
import { renderTransactions } from "./pages/transactions.js";
import { renderBudget } from "./pages/budget.js";
import { renderNetWorth } from "./pages/networth.js";

/* ------------------------------------------------------------------ plans
   Pure display copy, keyed by plan id - label and blurb are the only
   per-plan facts that can't come from the backend, since they're
   marketing text, not business logic. Everything that determines what a
   plan actually DOES or COSTS (seat cap, features, price) comes from
   state.plans (getPlans(), see ensurePlans below) - this app keeps no
   independent list of which tiers exist, so a tier added or removed on
   the server just works here without a matching edit. Personal-finance
   app, not a team tool - Family is deliberately the top tier; there is no
   unlimited-seat "Business" plan. A plan id with no entry here (a new
   tier added server-side before its copy is written) still renders, with
   a generic fallback label/blurb - see planCopy() below. The signup gate
   (renderPlanGate) and the Billing tab (renderBilling) deliberately do
   not share markup/CSS: the gate is a one-time, full-viewport decision
   (bigger cards, its own visual weight), while Billing is a page you
   return to, sitting alongside this app's other panels - collapsing them
   into one component would make whichever one changes next drag the
   other along with it. They DO share the small data helpers below
   (planCopy/planFeatureList/planSeatsLabel/formatPlanAmount/
   formatPlanPeriod) - those are pure derivation, not markup, so sharing
   them carries none of that risk. */

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
function debtNetWorth(debts, owner) {
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

function wireDebtHandlers() {
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
function renderDebtSection(scopeOwner) {
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

/* ====================================================================== DATA */
function renderData() {
  // Derived here, at render time, rather than once in refresh() - state.plans
  // only populates lazily via ensurePlans() (see below), which resolves
  // AFTER the first refresh() of a fresh session has already run. Caching
  // these onto state.tenant inside refresh() would freeze aiImportAllowed at
  // its plans-not-loaded-yet value (false) forever, since nothing calls
  // refresh() again just because ensurePlans() resolved - only this
  // function's own ensurePlans() re-render would run, and it needs the
  // recompute to actually see the update. Recomputing on every render is
  // cheap (a short array lookup) and keeps state.tenant.aiImportAllowed
  // truthful for the template below, same as renderBilling/renderPlanGate
  // deriving straight from state.plans rather than trusting a cached copy.
  if (state.tenant) {
    state.tenant.aiImportAllowed = !!state.plans?.find(
      (p) => p.id === state.tenant.plan,
    )?.features?.aiImport;
    // Must match AI_IMPORT_MONTHLY_CAP in backend/src/plans.js - not sent
    // over the wire today, so this is a second, manually-synced copy.
    // Low-risk (display only, the real enforcement is server-side), but
    // worth revisiting if backend/src/plans.js's value ever changes.
    state.tenant.aiImportsRemaining =
      state.tenant.aiImportsUsedThisMonth != null
        ? Math.max(0, 20 - state.tenant.aiImportsUsedThisMonth)
        : null;
  }
  const live = state.store.kind === "api";
  const members = state.members || [];
  const invites = state.invites || [];
  const tenants = state.tenants || [];
  const myRole = state.role || "member";
  const canManageInvites = myRole === "owner" || myRole === "admin";

  view.innerHTML = `
  <div class="head"><div><h1>Data</h1><p class="sub">Where your data lives, and how to get it in and out.</p></div></div>

  <div class="eyebrow">Export</div>
  <div class="panel stack">
    <div class="actions">
      <button class="btn" id="xlsx">Download .xlsx</button>
      <button class="btn ghost" id="json">Download .json backup</button>
      <span class="muted">${state.rows.length} transactions</span>
    </div>
    <p class="note">Three sheets \u2014 Transactions, Budget, and a Pivot cross-tab. No charts: the browser cannot
    write chart objects into an .xlsx. The charts you see on the Dashboard are rendered live from the same data
    instead.</p>
  </div>

  <div class="eyebrow">Import</div>
  <div class="panel stack">
    <input type="file" id="file" accept=".xlsx,.xls,.csv">
    <div class="actions"><label><input type="checkbox" id="replace"> Replace everything first</label></div>
    <div id="imp" class="note"></div>
    <p class="note">Needs a flat table with at least <code>Date</code> and <code>Amount</code> columns. Large
    files are uploaded automatically in the background, a little at a time.</p>
  </div>

  <div class="eyebrow">AI Import</div>
  <div class="panel stack">
    ${
      !state.plans
        ? `<p class="note" style="margin:0">Checking your plan…</p>`
        : !state.tenant?.aiImportAllowed
          ? `<p class="note" style="margin:0">Upload a bank or credit-card statement (CSV or PDF) and let AI read it for you — <b>available on the Pro and Family plans.</b> <a href="#billing" data-goto-billing>Upgrade from Billing</a>.</p>`
          : (state.tenant?.aiImportsRemaining ?? Infinity) <= 0
            ? `<p class="note" style="margin:0">You've used all your AI imports for this month. It resets at the start of next month.</p>`
            : `
    <input type="file" id="ai-file" accept=".csv,.pdf">
    <p class="note" style="margin:0">Upload a real bank or credit-card statement — AI reads it and maps it into your categories. You review everything before anything is saved. ${esc(String(state.tenant?.aiImportsRemaining ?? ""))} import${state.tenant?.aiImportsRemaining === 1 ? "" : "s"} left this month.</p>
    <div id="ai-review"></div>`
    }
  </div>

  <div class="eyebrow">People</div>
  <div class="panel stack">
    <p class="note" style="margin:0">${(() => {
      const un = state.rows.filter((r) => !r.person).length;
      return un
        ? `<b>${un} entries have no person set</b> \u2014 everything imported before this feature existed. Assign them in one go:`
        : "Every entry has a person assigned.";
    })()}</p>
    ${
      state.rows.filter((r) => !r.person).length
        ? `
    <div class="actions">
      ${listFor("person")
        .map(
          (pp) =>
            `<button class="btn ghost" data-assign="${esc(pp)}">Assign all to ${esc(pp)}</button>`,
        )
        .join("")}
    </div>
    <p class="note">This rewrites every unassigned row. You can still change individual entries afterwards from Transactions \u2192 edit.</p>`
        : ""
    }
  </div>

  <div class="eyebrow">Household</div>
  <div class="panel stack">
    <p class="note" style="margin:0">Your role: <b>${esc(myRole)}</b>. ${members.length} member${members.length === 1 ? "" : "s"}.</p>
    <ul class="stack" style="margin:0;padding-left:1.2em">
      ${members.map((m) => `<li>${esc(m.email)} — ${esc(m.role)}</li>`).join("")}
    </ul>
    ${
      // Visible to any member belonging to more than one household, regardless
      // of role - unlike the invite controls just below, which stay owner/
      // admin-only. Most accounts belong to exactly one tenant and never see
      // this at all.
      tenants.length > 1
        ? `
    <div class="stack" style="max-width:420px">
      <label class="f"><span>Active household</span>
        <select id="tenant-switcher">
          ${tenants
            .map(
              // No active tenant set means no X-Active-Tenant header is
              // sent, so the server acts as the JWT's own default tenant -
              // and nothing is marked selected here, leaving the browser to
              // show the FIRST option. Those two agree because
              // listMyTenants orders by created_at ascending, the default
              // tenant is the one created at signup, and every membership
              // insert path can only append a later row (no leave-tenant or
              // remove-member action exists anywhere in this codebase). So
              // tenants[0] is provably the JWT's default today - but that
              // is an emergent property of the current insert paths, not an
              // enforced guarantee, and would need re-verifying if leaving
              // or removing a member is ever added.
              (t) =>
                `<option value="${esc(t.tenant_id)}"${t.tenant_id === state.store.getActiveTenant?.() ? " selected" : ""}>${esc(t.name)} (${esc(t.role)})</option>`,
            )
            .join("")}
        </select>
      </label>
    </div>`
        : ""
    }
    ${
      canManageInvites
        ? `
    <div class="stack" style="max-width:420px">
      <label class="f"><span>Invite by email</span>
        <input id="invite-email" type="email" placeholder="name@example.com"></label>
      <div class="actions"><button class="btn" id="send-invite">Send invite</button></div>
    </div>
    ${
      invites.length
        ? `<p class="note" style="margin:0">Pending invites:</p>
    <ul class="stack" style="margin:0;padding-left:1.2em">
      ${invites
        .map(
          (inv) => `<li>${esc(inv.email)}
            <button class="btn ghost" data-copy-invite="${esc(inv.token)}">Copy link</button>
            <button class="btn ghost" data-revoke-invite="${esc(inv.token)}">Revoke</button></li>`,
        )
        .join("")}
    </ul>`
        : ""
    }`
        : ""
    }
  </div>

  <div class="eyebrow">Danger zone</div>
  <div class="panel"><div class="actions">
    <button class="btn danger" id="wipe">Delete every row${live ? " from the server" : ""}</button>
    <span class="muted">Export first \u2014 this cannot be undone.</span>
  </div></div>`;

  $("#tenant-switcher")?.addEventListener("change", (e) => {
    switchActiveTenant(e.target.value);
  });

  $("#send-invite")?.addEventListener("click", async () => {
    const email = $("#invite-email").value.trim();
    if (!email) return notice("Enter an email address.", "bad");
    const done = await withBusy("Sending invite", async () => {
      await state.store.createInvite(email, "member");
      await refresh();
    });
    if (done) {
      notice(`Invited ${email}.`, "ok");
      renderData();
    }
  });

  view.querySelectorAll("[data-copy-invite]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const token = btn.dataset.copyInvite;
      const link = `${location.origin}${location.pathname}#invite=${token}`;
      await navigator.clipboard.writeText(link);
      notice("Invite link copied.", "ok");
    });
  });

  view.querySelectorAll("[data-revoke-invite]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const token = btn.dataset.revokeInvite;
      const done = await withBusy("Revoking invite", async () => {
        await state.store.revokeInvite(token);
        await refresh();
      });
      if (done) {
        notice("Invite revoked.", "ok");
        renderData();
      }
    });
  });

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
      if (!isRemoteStore(state.store)) {
        out.innerHTML =
          '<b class="over">Not connected to your Ledger account — reconnect before importing.</b>';
        return;
      }
      const replacing = $("#replace").checked;
      if (
        !confirm(
          `Import ${rows.length} rows from "${sheet}" into your Ledger account?${skipped ? `\n\n${skipped} rows will be skipped (no valid date or amount).` : ""}${
            replacing
              ? `\n\n"Replace everything first" is checked: every existing transaction will be deleted before the import.${hiddenHistoryWarning()}`
              : ""
          }`,
        )
      ) {
        out.textContent = "Cancelled.";
        return;
      }
      const done = await withBusy(`Writing ${rows.length} rows`, async () => {
        if (replacing) await state.store.clear(); // the same flag the confirmation above described
        await state.store.bulkAdd(rows, (n, total) => {
          notice(`Saving\u2026 ${n} of ${total} rows`);
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

  view.querySelector("[data-goto-billing]")?.addEventListener("click", (e) => {
    e.preventDefault();
    go("billing");
  });

  $("#ai-file")?.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reviewEl = $("#ai-review");
    const fileType = file.name.toLowerCase().endsWith(".pdf") ? "pdf" : "csv";
    // Matches backend/src/extract.js's MAX_FILE_BYTES - reject an oversized
    // file instantly instead of paying for a full upload round trip (the
    // file goes straight to S3, not through a Lambda request body) only to
    // have the server reject it once it's already there.
    const MAX_FILE_BYTES = 4 * 1024 * 1024;
    if (file.size > MAX_FILE_BYTES) {
      reviewEl.innerHTML = `<b class="over">File is too large (max ${MAX_FILE_BYTES / 1024 / 1024}MB).</b>`;
      return;
    }
    reviewEl.innerHTML = `<p class="note">Uploading your statement…</p>`;

    try {
      const { transactions, skipped } = await state.store.extractTransactions(
        file.name,
        fileType,
        file,
        CAT_NAMES,
      );
      renderAiReviewTable(reviewEl, transactions, skipped);
    } catch (err) {
      reviewEl.innerHTML = `<b class="over">${esc(err.message)}</b>`;
    }
  });

  $("#wipe").onclick = async () => {
    if (!isRemoteStore(state.store))
      return notice(
        "Not connected to your Ledger account — reconnect before deleting anything.",
        "bad",
      );
    if (
      !confirm(
        `Delete all ${state.rows.length} transactions from your Ledger account?\n\nThis cannot be undone.${hiddenHistoryWarning()}`,
      )
    )
      return;
    if (!confirm("Really sure? Export a backup first if you have not.")) return;
    const done = await withBusy("Deleting your transactions", async () => {
      await state.store.clear();
      await refresh();
    });
    renderData();
    if (done) notice("All rows deleted.", "ok");
  };

  // First render shows "Checking your plan…" above; once the fetch
  // resolves, silently re-render with the real aiImportAllowed value - but
  // only if Data is still the tab on screen (the user may have already
  // navigated away by the time it resolves).
  ensurePlans(() => {
    if (state.tab === "data") renderData();
  });
}

/** Renders the read-only, checkbox-driven review table for AI-extracted
    transactions - see this feature's spec, Architecture §7. No inline
    editing (Non-goals): anything wrong here gets fixed after import via
    the normal Transactions edit flow, same as any other imported row. */
function renderAiReviewTable(reviewEl, transactions, skipped) {
  if (transactions.length === 0) {
    reviewEl.innerHTML = `<p class="note">No transactions found in this file.${skipped ? ` (${skipped} row${skipped === 1 ? "" : "s"} couldn't be read reliably.)` : ""}</p>`;
    return;
  }

  reviewEl.innerHTML = `
    ${skipped ? `<p class="note" style="margin:0 0 8px">${skipped} row${skipped === 1 ? "" : "s"} couldn't be read reliably and ${skipped === 1 ? "isn't" : "aren't"} shown below.</p>` : ""}
    <table class="ai-review-table">
      <thead><tr><th></th><th>Date</th><th>Type</th><th>Category</th><th>Description</th><th>Amount</th></tr></thead>
      <tbody>
        ${transactions
          .map(
            (t, i) => `
        <tr class="${t.confidence === "low" ? "ai-low-confidence" : ""}">
          <td><input type="checkbox" class="ai-row-check" data-idx="${i}" checked></td>
          <td>${esc(t.date)}</td>
          <td>${esc(t.type)}</td>
          <td>${esc(t.category)}${t.confidence === "low" ? ' <span class="ai-flag" title="Low confidence — double-check this row">⚠</span>' : ""}</td>
          <td>${esc(t.description)}</td>
          <td class="num">${esc(money(t.amount))}</td>
        </tr>`,
          )
          .join("")}
      </tbody>
    </table>
    <div class="actions" style="margin-top:10px">
      <button class="btn" id="ai-import-selected">Import selected</button>
    </div>`;

  reviewEl.querySelector("#ai-import-selected").onclick = async () => {
    const checked = [...reviewEl.querySelectorAll(".ai-row-check:checked")].map(
      (cb) => transactions[Number(cb.dataset.idx)],
    );
    if (!checked.length) return notice("Select at least one row.", "bad");
    const done = await withBusy(
      `Importing ${checked.length} transactions`,
      async () => {
        await state.store.bulkAdd(checked);
        await refresh();
      },
    );
    if (done) {
      notice(`Imported ${checked.length} transactions.`, "ok");
      reviewEl.innerHTML = "";
      renderData();
    }
  };
}

/** The household's plan, status and payment actions - its own top-level page
    rather than a section of Data, since it is where an owner actually goes
    to make a billing decision, not incidental to "where your data lives".
    Deliberately does not share markup with renderPlanGate: that overlay is
    a one-time, full-viewport decision shown once at signup, this is a page
    you come back to and sits visually among this app's other panels. */
function renderBilling() {
  const tenant = state.tenant || { plan: "free", status: "active" };
  const myRole = state.role || "member";
  // Billing is owner-only (the backend enforces the same rule on both
  // billing actions) - a narrower rule than canManageInvites, since an
  // admin can invite people but cannot spend the household's money.
  const canManageBilling = myRole === "owner";
  // Checkout can only CREATE a subscription. Once one exists, changing or
  // cancelling it belongs to the Customer Portal - showing "Choose <other
  // plan>" here would start a second, separately-billed subscription
  // (routes/billing.js rejects it server-side too).
  const hasSubscription = tenant.plan !== "free";
  const showDowngradeBanner =
    tenant.plan === "free" && !!tenant.hasStripeCustomer;
  const plans = state.plans || [];
  const planMeta = plans.find((p) => p.id === tenant.plan);
  const currentLabel = planCopy(tenant.plan).label;
  const statusLabel =
    tenant.status === "past_due"
      ? "Payment failed"
      : showDowngradeBanner
        ? "Back on Free"
        : "Active";
  const statusClass =
    tenant.status === "past_due" ? "bad" : showDowngradeBanner ? "warn" : "ok";

  view.innerHTML = `
  <div class="head"><div><h1>Billing</h1><p class="sub">This household's plan, seats and payment details.</p></div></div>

  <div class="eyebrow">Current plan</div>
  <div class="panel billing-current">
    <div class="billing-current-top">
      <div>
        <div class="billing-current-plan">${esc(currentLabel)}</div>
        <div class="muted">${
          planMeta
            ? `${esc(planSeatsLabel(planMeta.seatCap))} &middot; <span class="num">${esc(formatPlanAmount(planMeta))}</span>${esc(formatPlanPeriod(planMeta))}`
            : esc(state.plans ? "Plan details unavailable" : "Loading…")
        }</div>
      </div>
      <span class="status-pill ${statusClass}">${esc(statusLabel)}</span>
    </div>
    ${
      tenant.status === "past_due"
        ? `<p class="note" style="margin-top:12px">Your last payment failed. Update your card in the billing portal before the grace period ends to keep full access.</p>`
        : ""
    }
    ${
      showDowngradeBanner
        ? `<p class="note" style="margin-top:12px">Your subscription was canceled after a failed payment — you're on the Free plan.${canManageBilling ? ' <button class="btn ghost" id="resubscribe">Resubscribe</button>' : ""}</p>`
        : ""
    }
    ${
      canManageBilling
        ? ""
        : '<p class="note" style="margin-top:12px">Only the household owner can change the plan or manage payment details.</p>'
    }
  </div>

  <div class="eyebrow">Plans</div>
  ${
    !state.plans
      ? `<p class="note">Loading plans…</p>`
      : plans.length === 0
        ? `<p class="note">Plans are temporarily unavailable. Try reconnecting from the banner above, then reload.</p>`
        : `<div class="billing-plan-grid">
    ${plans
      .map((p) => {
        const isCurrent = p.id === tenant.plan;
        const copy = planCopy(p.id);
        return `
      <div class="billing-plan-card${isCurrent ? " current" : ""}${copy.recommended && !isCurrent ? " recommended" : ""}">
        ${copy.recommended && !isCurrent ? '<div class="billing-plan-tag">Most households</div>' : ""}
        <div class="billing-plan-name">${esc(copy.label)}</div>
        <div class="billing-plan-price"><span class="num">${esc(formatPlanAmount(p))}</span><span class="muted">${esc(formatPlanPeriod(p))}</span></div>
        <div class="muted" style="margin:2px 0 10px">${esc(planSeatsLabel(p.seatCap))}</div>
        <p class="note" style="margin:0 0 10px">${esc(copy.blurb)}</p>
        <ul class="billing-plan-features">
          ${planFeatureList(p.features)
            .map((f) => `<li>${esc(f)}</li>`)
            .join("")}
        </ul>
        ${
          isCurrent
            ? '<span class="billing-plan-current-tag">Current plan</span>'
            : !canManageBilling || hasSubscription || !p.priceId
              ? ""
              : `<button class="btn ghost" data-upgrade-plan="${esc(p.priceId)}">Choose ${esc(copy.label)}</button>`
        }
      </div>`;
      })
      .join("")}
  </div>`
  }

  ${
    hasSubscription && canManageBilling
      ? `<div class="eyebrow">Manage</div>
  <div class="panel stack">
    <p class="note" style="margin:0">Switching plans, updating your card and cancelling all happen in the Stripe billing portal — starting a second checkout here would bill you twice.</p>
    <div class="actions"><button class="btn ghost" id="manage-billing">Manage billing</button></div>
  </div>`
      : ""
  }`;

  view.querySelectorAll("[data-upgrade-plan]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const base = location.origin + location.pathname;
      const done = await withBusy("Starting checkout", async () => {
        const { url } = await state.store.createCheckoutSession(
          btn.dataset.upgradePlan,
          `${base}#billing`,
          `${base}#billing`,
        );
        location.href = url;
      });
      if (!done) notice("Could not start checkout.", "bad");
    });
  });

  $("#manage-billing")?.addEventListener("click", async () => {
    const returnUrl = location.origin + location.pathname;
    const done = await withBusy("Opening billing portal", async () => {
      const { url } = await state.store.createPortalSession(returnUrl);
      location.href = url;
    });
    if (!done) notice("Could not open billing portal.", "bad");
  });

  $("#resubscribe")?.addEventListener("click", () => {
    // Re-renders this same page's plan cards - resubscribing is just
    // choosing a plan again, no separate flow needed.
    renderBilling();
  });

  // First render shows "Loading plans…" above; once the fetch resolves,
  // silently re-render with the real list - but only if Billing is still
  // the tab on screen (the user may have already navigated away by the
  // time it resolves).
  ensurePlans(() => {
    if (state.tab === "billing") renderBilling();
  });
}

/** The signed-in individual's own account: identity, role, and sign-out.
    Distinct from Data's Household panel (which manages OTHER members and
    invites) and from Billing (tenant-wide money) - this is the one page
    that's about you specifically, not the household. Only shows real
    fields the backend actually returns (email, role) - no display name or
    avatar exists anywhere in this app's auth (see auth.js/handler.js). */
function renderProfile() {
  const signedIn = !!getIdToken();
  const email = state.userEmail || state.store.user?.email || "";
  const myRole = state.role || "member";
  const roleInfo =
    {
      owner:
        "Full access — can manage billing, invite or remove members, and use every feature.",
      admin: "Can invite members. Billing stays with the owner.",
      member:
        "Can add and edit transactions, budget and net worth. Inviting and billing stay with the owner or admins.",
    }[myRole] || "";
  const members = state.members || [];
  const tenants = state.tenants || [];

  view.innerHTML = `
  <div class="head"><div><h1>Profile</h1><p class="sub">Your account in this ledger.</p></div></div>

  <div class="eyebrow">Account</div>
  <div class="panel stack">
    ${
      signedIn
        ? `
    <p class="note" style="margin:0">Signed in as <b>${esc(email || "unknown")}</b>.</p>
    <p class="note" style="margin:0">Your role: <b>${esc(myRole)}</b>. ${esc(roleInfo)}</p>
    <p class="note" style="margin:0">Sign-in is Google-only — there's no separate Ledger password to set or reset.</p>`
        : `<p class="note" style="margin:0">Not signed in to a Ledger account.</p>`
    }
  </div>

  ${
    signedIn
      ? `
  <div class="eyebrow">Currency</div>
  <div class="panel stack">
    <label>Display currency
      <select id="profile-currency">
        ${CURRENCIES.map(
          (c) =>
            `<option value="${esc(c)}"${c === (state.tenant?.currency || "CAD") ? " selected" : ""}>${esc(c)}</option>`,
        ).join("")}
      </select>
    </label>
    <p class="note" style="margin:0">Changes how amounts are formatted everywhere in this household's ledger. Every amount already entered keeps its original number — only the currency label changes, nothing is converted.</p>
  </div>`
      : ""
  }

  ${
    signedIn
      ? `
  <div class="eyebrow">Household</div>
  <div class="panel stack">
    <p class="note" style="margin:0">${members.length} member${members.length === 1 ? "" : "s"} in this household.${tenants.length > 1 ? ` You belong to ${tenants.length} households.` : ""}</p>
    <p class="note" style="margin:0">Manage members, invites${tenants.length > 1 ? " and switch households" : ""} from Data &rarr; Household.</p>
  </div>

  <div class="eyebrow">Session</div>
  <div class="panel"><div class="actions">
    <button class="btn ghost" id="profile-signout">Sign out</button>
  </div></div>`
      : ""
  }`;

  $("#profile-currency")?.addEventListener("change", async (e) => {
    const currency = e.target.value;
    await withBusy(`Switching to ${currency}`, async () => {
      await state.store.setCurrency(currency);
      await refresh();
    });
    renderProfile();
  });
  $("#profile-signout")?.addEventListener("click", signOut);
}

/* ==================================================================== router */
const VIEWS = {
  dashboard: renderDashboard,
  cashflow: renderCashFlow,
  spending: renderSpending,
  add: renderAdd,
  transactions: renderTransactions,
  budget: renderBudget,
  networth: renderNetWorth,
  data: renderData,
  billing: renderBilling,
  profile: renderProfile,
};

function go(tab) {
  state.tab = tab;
  charts.destroyAll();
  // dataset.shell lives on the #view ELEMENT, not its children - reassigning
  // innerHTML for a DIFFERENT page never clears it on its own. Without this,
  // Dashboard -> Transactions -> Dashboard could find the stale flag still
  // set, wrongly take the fast patch path against Transactions' leftover
  // markup, and silently show nothing new at all. Only renderDashboard()'s
  // OWN direct calls (from its year/month selectors, which bypass go()
  // entirely) should ever see this flag intact.
  delete view.dataset.shell;
  document
    .querySelectorAll("#tabs button")
    .forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
  location.hash = tab;
  viewTransition(() => {
    (VIEWS[tab] || renderDashboard)();
    window.scrollTo(0, 0);
  });
}

document.querySelectorAll("#tabs button").forEach(
  (b) =>
    (b.onclick = () => {
      if (b.dataset.tab !== "add") state.editing = null;
      go(b.dataset.tab);
    }),
);

// A tenant that downgraded to Free still HAS its older transactions on the
// server - the Free plan's 12-month window only hides them from what the
// API returns (see backend/src/plans.js's FEATURES.historyMonths). The
// destructive flows below, though, clear the table server-side with no date
// filter at all, so they delete those hidden rows too, and neither the
// "Delete all N transactions" count nor the import's "Replace everything
// first" wording would otherwise account for them. Only a tenant that has
// been through checkout (hasStripeCustomer) can have rows outside the
// window, so the warning is scoped to exactly that case rather than shown
// to every Free user.
const hiddenHistoryWarning = () =>
  state.tenant?.plan === "free" && state.tenant?.hasStripeCustomer
    ? "\n\nWARNING: your account is on the Free plan, which only shows the last 12 months. Older transactions that are currently hidden from you will ALSO be permanently deleted, and they are not in the counts above or in an export taken now."
    : "";

(async function main() {
  // XLSX is deliberately excluded - it's loaded on demand by xlsxio.js when
  // Export/Import is actually clicked, not before. Waiting for it here would
  // reintroduce the exact 930KB blocking cost this change removes.
  const ready = () => typeof Chart !== "undefined";
  if (!ready())
    await new Promise((r) =>
      window.addEventListener("load", r, { once: true }),
    );

  // A redirect back from Cognito's Hosted UI carries the id_token in the URL
  // fragment - consume it before deciding whether the gate needs showing, so
  // a just-completed sign-in doesn't get shown the gate again.
  consumeAuthRedirect();

  // Sign-in is always required — this is multi-tenant SaaS with no
  // local/offline mode to fall back to (see store.js), so an unauthenticated
  // session has nothing to show. If Cognito itself isn't configured for this
  // deployment, showGate() renders that as its own clear error rather than a
  // broken sign-in button.
  if (!getIdToken()) {
    showGate();
    return;
  }

  try {
    await boot();
  } catch (e) {
    if (e?.auth || /sign in|not permitted/i.test(e?.message || "")) {
      setIdToken("");
      showGate(e.message);
    } else {
      revealApp();
      throw e;
    }
  }
})();
