/* Fixed/term deposit tracking: the Net Worth page's "Fixed Deposits" tab.
   A fixed deposit is a one-time principal placed with a bank for a fixed
   tenure at a fixed annual rate, maturing to a lump sum - e.g. an Indian
   bank FD. Scoped to INR only for now (see FD_CURRENCY below); this file
   starts with the pure interest math so it can be checked independently of
   any DOM, same split as metals.js's resolvePricePerGram/metalsSummary.
   Rendering/store-wiring (renderFixedDepositsSection/wireFixedDepositsHandlers)
   mirrors renderMetalsSection/wireMetalsHandlers in that same file. */
import { PEOPLE, toCad, getHomeCurrency } from "../store.js";
import { money, moneyIn } from "../xlsxio.js";
import {
  $,
  view,
  esc,
  state,
  kpi,
  notice,
  withBusy,
  confirmDialog,
} from "../core.js";
import { isRemoteStore } from "../auth.js";
import { emptyIcon } from "../icons.js";
import { countKpiTiles, revealOnView } from "../motion.js";

// The feature is scoped to India fixed deposits for now - every deposit is
// entered and displayed in its own currency (never converted in place, same
// reasoning as transactions/balances), so fixedDepositsSummary below can
// safely sum native amounts across deposits without checking each one's
// currency individually. The schema itself isn't limited to INR (fx_rate +
// a CAD/INR/AED check, same shape as balances) - only the UI is, so adding
// another currency later is a UI change, not a migration.
export const FD_CURRENCY = "INR";

const DAY_MS = 86400000;
const yearsBetween = (fromDate, toDate) =>
  Math.max(0, (new Date(toDate) - new Date(fromDate)) / DAY_MS / 365);

export const COMPOUNDING_PERIODS = {
  Simple: 0,
  Annually: 1,
  "Semi-Annually": 2,
  Quarterly: 4,
  Monthly: 12,
};
export const COMPOUNDING_OPTIONS = Object.keys(COMPOUNDING_PERIODS);

/** The standard bank FD formula: simple interest (A = P(1 + rt)) when the
    chosen compounding is "Simple", otherwise compound interest
    (A = P(1 + r/n)^(nt)). Quarterly is the default and most common
    convention for an Indian bank FD, but every bank states its own
    compounding frequency on the certificate - hence the dropdown rather
    than a fixed assumption. */
export function fdValueAt(principal, annualRatePct, compounding, years) {
  const r = (Number(annualRatePct) || 0) / 100;
  const n = COMPOUNDING_PERIODS[compounding] ?? COMPOUNDING_PERIODS.Quarterly;
  if (years <= 0) return principal;
  if (n === 0) return principal * (1 + r * years);
  return principal * Math.pow(1 + r / n, n * years);
}

/** The maturity value a fresh calculation gives - what the "Maturity
    amount" field is pre-filled with, and what fdValueToday() uses whenever
    the person hasn't overridden it by hand (a bank's own certificate can
    round, or apply a slightly different day-count convention, which is
    exactly what the override exists for). */
export function calculatedMaturity(fd) {
  return fdValueAt(
    fd.principal,
    fd.annualRate,
    fd.compounding,
    yearsBetween(fd.startDate, fd.maturityDate),
  );
}

/** What this deposit is worth right now, for the Net Worth total - between
    principal (the day it was opened) and its maturity value (the day it
    matures), not just one or the other. A deposit not yet matured accrues
    toward its maturity value every day; counting it at full maturity value
    today would overstate net worth, and counting it at bare principal would
    understate the interest already earned.

    When the maturity amount was typed by hand (an override - see
    calculatedMaturity's comment above) rather than left to the formula,
    there's no rate/compounding pair left to re-run partway through, so
    progress toward it is a straight-line interpolation between principal
    and that override by elapsed-time fraction instead. Past the maturity
    date, a deposit simply holds its maturity value - it isn't assumed
    withdrawn or renewed; deleting the row is how you record that it's gone. */
export function fdValueToday(fd, todayStr) {
  const tenureYears = yearsBetween(fd.startDate, fd.maturityDate);
  const elapsed = Math.min(
    Math.max(0, yearsBetween(fd.startDate, todayStr)),
    tenureYears,
  );
  if (fd.maturityAmount != null) {
    const fraction = tenureYears > 0 ? elapsed / tenureYears : 1;
    return fd.principal + (fd.maturityAmount - fd.principal) * fraction;
  }
  return fdValueAt(fd.principal, fd.annualRate, fd.compounding, elapsed);
}

/** Aggregate KPI-tile figures across every deposit - native-currency totals
    (safe to sum directly across deposits only because FD_CURRENCY is fixed
    today - see its comment above) plus the CAD-equivalent the Net Worth
    total actually adds, via each deposit's own fx_rate, same as
    Balances/Transactions. */
export function fixedDepositsSummary(deposits, todayStr) {
  let totalPrincipal = 0,
    totalValueToday = 0,
    totalValueCad = 0;
  for (const fd of deposits) {
    const v = fdValueToday(fd, todayStr);
    totalPrincipal += fd.principal;
    totalValueToday += v;
    totalValueCad += toCad(v, fd.fxRate || 1);
  }
  return {
    totalPrincipal,
    totalValueToday,
    totalValueCad,
    totalInterestEarned: totalValueToday - totalPrincipal,
    count: deposits.length,
  };
}

const fmtTenure = (startDate, maturityDate) => {
  const years = yearsBetween(startDate, maturityDate);
  const totalMonths = Math.round(years * 12);
  const y = Math.floor(totalMonths / 12);
  const m = totalMonths % 12;
  return [y ? `${y}y` : "", m ? `${m}m` : ""].filter(Boolean).join(" ") || "0m";
};

/** "Fixed Deposits" tab on the Net Worth page: 3 KPI tiles, a deposits
    table, and an add-deposit form. Mirrors renderMetalsSection/
    wireMetalsHandlers in metals.js - a returned HTML string plus a separate
    wiring function called once that HTML is actually in the DOM. */
/** Count-up targets from the most recent renderFixedDepositsSection(). */
let pendingTotals = [];

/** Id of the deposit currently loaded into the form for editing, or null
    when the form is adding a new one. Module state, so it survives the
    re-render that follows Edit/Cancel (same as editingLotId in metals.js). */
let editingFdId = null;

const rerenderNetWorth = async () => {
  const { renderNetWorth } = await import("./networth.js");
  renderNetWorth();
};

/** Entrance-only motion for the Fixed Deposits tab (route entry or tab
    switch; never filter/edit re-renders). */
export function animateFixedDepositsSection() {
  countKpiTiles(pendingTotals);
  revealOnView(view.querySelectorAll(".tablewrap"));
}

export function renderFixedDepositsSection(scopeOwner) {
  if (!isRemoteStore(state.store)) {
    return `
    <div class="eyebrow">Fixed deposits</div>
    <div class="nw-warn">
      <b>Not connected to Supabase.</b> Fixed deposit tracking needs a
      Supabase backend. Connect under <b>Data &rarr; Supabase</b> to use
      this section.
    </div>`;
  }

  const today = new Date().toISOString().slice(0, 10);
  const deposits = (state.fixedDeposits || []).filter(
    (d) => !scopeOwner || d.owner === scopeOwner,
  );
  const summary = fixedDepositsSummary(deposits, today);
  const editing = deposits.find((d) => d.id === editingFdId) || null;
  if (!editing) editingFdId = null;
  const sel = (cond) => (cond ? " selected" : "");
  const val = (v) => (v == null ? "" : ` value="${esc(String(v))}"`);

  const fdMoney = (n) => moneyIn(n, FD_CURRENCY);
  pendingTotals = [
    ["fd-principal", summary.totalPrincipal, fdMoney],
    ["fd-value", summary.totalValueToday, fdMoney],
    [
      "fd-interest",
      summary.totalInterestEarned,
      (n) => (n >= 0 ? "+" : "") + fdMoney(n),
    ],
  ];
  const tiles = `<div class="kpis">
    ${kpi("Principal", moneyIn(summary.totalPrincipal, FD_CURRENCY), `${deposits.length} deposit${deposits.length === 1 ? "" : "s"}`, "", "fd-principal")}
    ${kpi("Value today", moneyIn(summary.totalValueToday, FD_CURRENCY), `≈ ${money(summary.totalValueCad)} ${getHomeCurrency()}`, "", "fd-value")}
    ${kpi(
      "Interest earned",
      (summary.totalInterestEarned >= 0 ? "+" : "") +
        moneyIn(summary.totalInterestEarned, FD_CURRENCY),
      "so far",
      summary.totalInterestEarned < 0 ? "neg" : "pos",
      "fd-interest",
    )}
  </div>`;

  const rows = deposits
    .map((fd) => {
      const valueToday = fdValueToday(fd, today);
      const maturity = fd.maturityAmount ?? calculatedMaturity(fd);
      const matured = today >= fd.maturityDate;
      return `<tr>
        <td>${esc(fd.institution)}${fd.maturityAmount != null ? ' <span class="tag" title="Maturity amount entered by hand, not calculated">override</span>' : ""}</td>
        <td><span class="person-chip" data-p="${esc(fd.owner)}">${esc(fd.owner)}</span></td>
        <td class="n num">${moneyIn(fd.principal, FD_CURRENCY)}</td>
        <td class="n num">${fd.annualRate}%</td>
        <td>${esc(fd.compounding)}</td>
        <td class="num">${esc(fd.startDate)} → ${esc(fd.maturityDate)}<br><span class="muted" style="font-size:10.5px">${fmtTenure(fd.startDate, fd.maturityDate)}</span></td>
        <td class="n num">${moneyIn(maturity, FD_CURRENCY)}</td>
        <td class="n num"><span class="tag${matured ? "" : ""}">${matured ? "Matured" : "Active"}</span><br>${moneyIn(valueToday, FD_CURRENCY)}</td>
        <td class="nowrap"><button class="rowbtn" data-editfd="${fd.id}" title="Edit this deposit">Edit</button>
          <button class="rowbtn" data-delfd="${fd.id}" title="Delete this deposit">✕</button></td>
      </tr>`;
    })
    .join("");

  return `
  <div class="eyebrow">Fixed deposits</div>
  ${tiles}
  ${
    deposits.length
      ? `<div class="tablewrap"><table><thead><tr>
      <th>Institution</th><th>Owner</th><th class="n">Principal</th><th class="n">Rate</th>
      <th>Compounding</th><th>Term</th><th class="n">Maturity value</th><th class="n">Value today</th><th></th>
    </tr></thead><tbody>${rows}</tbody></table></div>`
      : `<div class="empty">${emptyIcon()}<span>No fixed deposits recorded. Add one below.</span></div>`
  }

  <div class="panel" style="margin-top:12px">
    <form id="fd-add-form" class="nw-add-row" autocomplete="off">
      <label class="f"><span>Institution</span>
        <input type="text" name="institution" placeholder="e.g. HDFC Bank" required${val(editing?.institution)}></label>
      <label class="f"><span>Principal (${FD_CURRENCY})</span>
        <input type="number" name="principal" id="fd-principal" step="0.01" min="0.01" required placeholder="e.g. 100000"${val(editing?.principal)}></label>
      <label class="f"><span>Annual rate (%)</span>
        <input type="number" name="annualRate" id="fd-rate" step="0.01" min="0" required placeholder="e.g. 7.25"${val(editing?.annualRate)}></label>
      <label class="f"><span>Compounding</span>
        <select name="compounding" id="fd-compounding">
          ${COMPOUNDING_OPTIONS.map((c) => `<option${sel(c === (editing ? editing.compounding : "Quarterly"))}>${c}</option>`).join("")}
        </select></label>
      <label class="f"><span>Start date</span>
        <input type="date" name="startDate" id="fd-start" value="${editing ? esc(editing.startDate) : today}" required></label>
      <label class="f"><span>Maturity date</span>
        <input type="date" name="maturityDate" id="fd-maturity-date" required${val(editing?.maturityDate)}></label>
      <label class="f"><span>Maturity amount (override)</span>
        <input type="number" name="maturityAmount" id="fd-maturity-amount" step="0.01" min="0" placeholder="auto-calculated"${val(editing?.maturityAmount)}></label>
      <label class="f"><span>Owner</span>
        <select name="owner">${PEOPLE.map((p) => `<option${sel(editing && editing.owner === p)}>${esc(p)}</option>`).join("")}</select></label>
      <label class="f"><span>Exchange rate (${FD_CURRENCY} → ${getHomeCurrency()})</span>
        <input type="number" name="fxRate" id="fd-fxrate" step="any" min="0.000001" required placeholder="1 ${FD_CURRENCY} = ? ${getHomeCurrency()}" inputmode="decimal"${val(editing?.fxRate)}></label>
      <button class="btn" type="submit">${editing ? "Save changes" : "Add deposit"}</button>
      ${editing ? '<button class="btn ghost" type="button" id="fd-cancel-edit">Cancel</button>' : ""}
    </form>
    ${editing ? `<p class="note" style="margin:8px 0 0"><b>Editing the ${esc(editing.institution)} deposit.</b></p>` : ""}
    <p class="note" id="fd-fx-hint" style="margin:8px 0 0"></p>
    <p class="note" id="fd-calc-hint" style="margin:8px 0 0"></p>
    <div class="err" id="fd-err"></div>
  </div>
  <p class="note">Value today is calculated from principal, rate, compounding and elapsed time
    (or interpolated toward your override, if you entered one) &mdash; it is not a live bank
    balance, so treat it as an estimate rather than an exact statement figure.</p>`;
}

export function wireFixedDepositsHandlers() {
  const reload = async () => {
    state.fixedDeposits = (await state.store.listFixedDeposits?.()) || [];
    const { renderNetWorth } = await import("./networth.js");
    renderNetWorth();
  };

  // Live calculator: as soon as there's enough to compute a maturity value
  // (principal + rate + both dates), show what will actually get saved if
  // the override field is left blank - the same "catch it before you
  // submit" reasoning as metals.js's purchase-price hint.
  const updateCalcHint = () => {
    const hint = $("#fd-calc-hint");
    if (!hint) return;
    const principal = Number($("#fd-principal")?.value);
    const annualRate = Number($("#fd-rate")?.value);
    const compounding = $("#fd-compounding")?.value;
    const startDate = $("#fd-start")?.value;
    const maturityDate = $("#fd-maturity-date")?.value;
    if (
      !(principal > 0) ||
      !startDate ||
      !maturityDate ||
      maturityDate <= startDate
    ) {
      hint.textContent = "";
      return;
    }
    const calculated = calculatedMaturity({
      principal,
      annualRate,
      compounding,
      startDate,
      maturityDate,
    });
    const override = $("#fd-maturity-amount")?.value;
    hint.textContent = override
      ? `Calculated maturity would be ${moneyIn(calculated, FD_CURRENCY)} over ${fmtTenure(startDate, maturityDate)} — your override (${moneyIn(Number(override), FD_CURRENCY)}) will be used instead.`
      : `= ${moneyIn(calculated, FD_CURRENCY)} at maturity, over ${fmtTenure(startDate, maturityDate)}`;
  };
  [
    "fd-principal",
    "fd-rate",
    "fd-compounding",
    "fd-start",
    "fd-maturity-date",
    "fd-maturity-amount",
  ].forEach((id) => {
    const el = $("#" + id);
    el?.addEventListener("input", updateCalcHint);
    el?.addEventListener("change", updateCalcHint);
  });

  // Same auto-fill-but-never-clobber-a-typed-value pattern as the Add
  // page's lookupRate() - only present on SupabaseStore (exchange_rates has
  // no LocalStore/MemoryStore equivalent, and this whole section is
  // Supabase-only already), so a missing getExchangeRate is simply a no-op
  // here and the required rate field stays empty until it's typed. There is
  // deliberately no default of 1: a silent wrong rate would skew the CAD
  // total on Net Worth. While editing, the saved rate is left alone until
  // the start date is changed.
  (async () => {
    const startInput = $("#fd-start");
    const fxInput = $("#fd-fxrate");
    const hint = $("#fd-fx-hint");
    if (!startInput || !fxInput) return;
    fxInput.addEventListener("input", () => {
      delete fxInput.dataset.auto; // the person is typing their own value now
    });
    // A previously auto-filled rate belongs to the old date; drop it rather
    // than leave a rate that no longer matches. A typed value is kept.
    const dropAuto = () => {
      if (fxInput.dataset.auto === "1") {
        fxInput.value = "";
        delete fxInput.dataset.auto;
      }
    };
    const lookup = async () => {
      const date = startInput.value;
      try {
        const found = await state.store.getExchangeRate?.(date, FD_CURRENCY);
        if (found) {
          const filled = !fxInput.value || fxInput.dataset.auto === "1";
          if (filled) {
            fxInput.value = found.rateToCad;
            fxInput.dataset.auto = "1";
          }
          hint.textContent = !filled
            ? `stored rate for ${found.date} is ${found.rateToCad} — kept the rate you entered`
            : found.date === date
              ? `auto-filled from ${date}'s rate — edit if your statement shows a different one`
              : `auto-filled from ${found.date}'s rate (closest available) — edit if your statement shows a different one`;
        } else if (state.store.getExchangeRate) {
          dropAuto();
          hint.textContent =
            "no stored rate yet for this date — enter the rate";
        }
      } catch {
        dropAuto();
        hint.textContent = "couldn't look up a rate — enter it by hand";
      }
    };
    startInput.addEventListener("change", lookup);
    if (!editingFdId) await lookup();
  })();

  $("#fd-add-form")?.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const f = Object.fromEntries(new FormData(ev.target));
    const errEl = $("#fd-err");
    errEl.textContent = "";
    const principal = Number(f.principal);
    const annualRate = Number(f.annualRate);
    if (!(principal > 0)) {
      errEl.textContent = "Principal must be greater than zero.";
      return;
    }
    if (!(annualRate >= 0)) {
      errEl.textContent = "Enter the annual interest rate.";
      return;
    }
    if (!f.startDate || !f.maturityDate || f.maturityDate <= f.startDate) {
      errEl.textContent = "Maturity date must be after the start date.";
      return;
    }
    const fxRate = Number(f.fxRate);
    if (!(fxRate > 0) || !Number.isFinite(fxRate)) {
      errEl.textContent = "Enter the INR → CAD exchange rate.";
      return;
    }
    const record = {
      institution: f.institution.trim(),
      principal,
      currency: FD_CURRENCY,
      annualRate,
      compounding: f.compounding,
      startDate: f.startDate,
      maturityDate: f.maturityDate,
      maturityAmount: f.maturityAmount ? Number(f.maturityAmount) : null,
      fxRate,
      owner: f.owner,
    };
    const wasEditing = editingFdId;
    const done = await withBusy(
      wasEditing ? "Saving deposit" : "Adding deposit",
      async () => {
        if (wasEditing)
          await state.store.updateFixedDeposit(wasEditing, record);
        else await state.store.addFixedDeposit({ ...record, notes: "" });
      },
    );
    if (done) {
      editingFdId = null;
      await reload();
      notice(
        wasEditing
          ? "Deposit updated."
          : `Added ${f.institution} fixed deposit.`,
        "ok",
      );
    }
  });

  view.querySelectorAll("[data-editfd]").forEach(
    (b) =>
      (b.onclick = async () => {
        editingFdId = Number(b.dataset.editfd);
        await rerenderNetWorth();
        $("#fd-add-form")?.scrollIntoView({ block: "center" });
      }),
  );
  $("#fd-cancel-edit")?.addEventListener("click", async () => {
    editingFdId = null;
    await rerenderNetWorth();
  });

  view.querySelectorAll("[data-delfd]").forEach(
    (b) =>
      (b.onclick = async () => {
        if (!(await confirmDialog("Delete this fixed deposit?"))) return;
        const done = await withBusy("Deleting deposit", async () => {
          await state.store.deleteFixedDeposit(Number(b.dataset.delfd));
        });
        if (done) {
          await reload();
          notice("Deposit deleted.", "ok");
        }
      }),
  );
}
