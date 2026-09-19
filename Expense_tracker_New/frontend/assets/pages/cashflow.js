import { MONTHS } from "../store.js";
import {
  $,
  view,
  esc,
  YEAR_KEY,
  state,
  notice,
  scoped,
  personLabel,
  kpi,
  periodSelect,
} from "../core.js";
import { aggregate, money, monthOf } from "../xlsxio.js";
import { cardHoverable, revealStagger } from "../motion.js";
import * as charts from "../charts.js";

/** Cash Flow tab's own data shaping — deliberately NOT built on the shared
    aggregate() (xlsxio.js), since that function's contract (catRows keyed
    to the fixed EXPENSE_CATS list, a single income total with no
    per-category breakdown) is exactly what every other tab already
    depends on unchanged. Income-by-category has no other consumer today,
    so it's computed locally here instead of growing aggregate()'s return
    shape for one caller. */
function cashFlowData(rows, month, year) {
  const inScope = rows.filter(
    (r) =>
      Number(String(r.date).slice(0, 4)) === year &&
      (month === 0 || monthOf(r) === month),
  );
  const sumBy = (type) => {
    const byCategory = {};
    for (const r of inScope.filter((r) => r.type === type)) {
      byCategory[r.category] = (byCategory[r.category] || 0) + r.amount;
    }
    return byCategory;
  };
  const incomeByCat = sumBy("Income");
  const expenseByCat = sumBy("Expense");
  const income = Object.values(incomeByCat).reduce((a, v) => a + v, 0);
  const expense = Object.values(expenseByCat).reduce((a, v) => a + v, 0);
  const net = income - expense;

  const flows = [];
  for (const [cat, amt] of Object.entries(incomeByCat)) {
    if (amt > 0) flows.push({ from: cat, to: "Income", flow: amt });
  }
  const expenseEntries = Object.entries(expenseByCat)
    .filter(([, amt]) => amt > 0)
    .sort((a, b) => b[1] - a[1]);
  const top = expenseEntries.slice(0, 8);
  const rest = expenseEntries.slice(8);
  for (const [cat, amt] of top)
    flows.push({ from: "Income", to: cat, flow: amt });
  const otherTotal = rest.reduce((a, [, amt]) => a + amt, 0);
  // Namespaced so a real user category named "Savings" or "Other" can't
  // collide with these synthetic node labels (see cashFlowData's guard
  // below for the remaining "Income" self-loop case).
  if (otherTotal > 0)
    flows.push({ from: "Income", to: "Other expenses", flow: otherTotal });
  if (net > 0) flows.push({ from: "Income", to: "→ Savings", flow: net });

  // A user-entered category can legitimately be used for both an Income-type
  // and an Expense-type row in the same period (the Add form doesn't filter
  // the category select by type), producing both {from:X,to:"Income"} and
  // {from:"Income",to:X} - a cycle the Sankey library can't render. A
  // category literally named "Income" produces a direct self-loop. Drop any
  // flow whose from/to are identical rather than let either crash the chart.
  const dedupedFlows = flows.filter((f) => f.from !== f.to);

  return {
    income,
    expense,
    net,
    flows: dedupedFlows,
    hasData: dedupedFlows.length > 0,
  };
}

export function renderCashFlow() {
  const rows = scoped();
  const cf = cashFlowData(rows, state.month, state.year);
  const label =
    state.month === 0
      ? `Full year ${state.year}`
      : `${MONTHS[state.month - 1]} ${state.year}`;

  view.innerHTML = `
  <div class="head">
    <div><h1>Cash Flow</h1><p class="sub">${esc(personLabel())} &middot; ${esc(label)}</p></div>
    <div class="spacer"></div>${periodSelect(state.month, state.year)}
  </div>

  <div class="kpis">
    ${kpi("Income", money(cf.income), "", "", "cf-income")}
    ${kpi("Expenses", money(cf.expense), "", "", "cf-expense")}
    ${kpi("Net", money(cf.net), cf.net < 0 ? "spending exceeds income" : "", cf.net < 0 ? "neg" : "pos", "cf-net")}
  </div>

  <div class="eyebrow">Flow</div>
  <div class="panel">
    ${cf.hasData ? `<div class="chartbox tall"><canvas id="c-cashflow"></canvas></div>` : `<div class="empty">No income or expenses recorded for this period yet.</div>`}
  </div>

  <div class="eyebrow">Trend</div>
  <div class="panel">
    <h3>Net by month</h3>
    <div class="chartbox"><canvas id="c-net-trend"></canvas></div>
  </div>`;

  $("#m-sel").onchange = (e) => {
    state.month = Number(e.target.value);
    renderCashFlow();
  };
  $("#y-sel").onchange = async (e) => {
    state.year = Number(e.target.value);
    localStorage.setItem(YEAR_KEY, state.year);
    state.month = 0;
    await state.store.ensureYearLoaded?.(state.year);
    state.rows = await state.store.list();
    renderCashFlow();
  };

  view.querySelectorAll(".kpi, .panel").forEach(cardHoverable);
  revealStagger(view.querySelectorAll(".kpi"));
  revealStagger(view.querySelectorAll(".panel"), { delay: 0.35 });

  if (typeof Chart === "undefined") {
    notice(
      "Charts couldn't load. Everything else on this page still works.",
      "bad",
    );
    return;
  }
  if (cf.hasData) {
    try {
      charts.cashFlow(cf.flows);
    } catch (err) {
      console.error("Cash Flow Sankey failed to render:", err);
      const flowPanel = $("#c-cashflow")?.closest(".panel");
      if (flowPanel) {
        flowPanel.innerHTML = `<div class="empty">No income or expenses recorded for this period yet.</div>`;
      }
    }
  }
  const a = aggregate(rows, state.budget, 0, state.year);
  charts.netTrendLine(a.series);
}
