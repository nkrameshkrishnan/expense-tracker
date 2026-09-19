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

export function renderSpending() {
  const rows = scoped();
  const a = aggregate(rows, state.budget, state.month, state.year);
  const label =
    state.month === 0
      ? `Full year ${state.year}`
      : `${MONTHS[state.month - 1]} ${state.year}`;

  const spendRows = [...a.catRows]
    .filter((r) => r.actual > 0)
    .sort((x, y) => y.actual - x.actual);
  const top6 = spendRows.slice(0, 6);
  const otherTotal = spendRows.slice(6).reduce((sum, r) => sum + r.actual, 0);
  const donutRows =
    otherTotal > 0
      ? [...top6, { category: "Other", actual: otherTotal }]
      : top6;

  // aggregate()'s catRows only tracks the built-in EXPENSE_CATS, so a
  // custom (user-created) expense category is invisible to spendRows above
  // even though Cash Flow's "Expenses" KPI counts it (it sums r.category
  // with no allowlist). Compute the true period expense total the same way
  // cashFlowData does, and fold anything catRows didn't capture into the
  // "Other" bucket so Spending's total agrees with Cash Flow's instead of
  // silently undercounting.
  const periodRows = rows.filter(
    (r) =>
      Number(String(r.date).slice(0, 4)) === state.year &&
      (state.month === 0 || monthOf(r) === state.month),
  );
  const trueExpenseTotal = periodRows
    .filter((r) => r.type === "Expense")
    .reduce((sum, r) => sum + r.amount, 0);
  const catTotal = spendRows.reduce((sum, r) => sum + r.actual, 0);
  const untracked = trueExpenseTotal - catTotal;
  if (untracked > 0) {
    const existingOther = donutRows.find((r) => r.category === "Other");
    if (existingOther) {
      existingOther.actual += untracked;
    } else {
      donutRows.push({ category: "Other", actual: untracked });
    }
  }
  const totalSpend = trueExpenseTotal;
  const topCategory = spendRows[0]?.category || "—";

  view.innerHTML = `
  <div class="head">
    <div><h1>Spending</h1><p class="sub">${esc(personLabel())} &middot; ${esc(label)}</p></div>
    <div class="spacer"></div>${periodSelect(state.month, state.year)}
  </div>

  <div class="kpis">
    ${kpi("Total spend", money(totalSpend), "", "", "sp-total")}
    ${kpi("Top category", esc(topCategory), "", "", "sp-top")}
    ${kpi("Transactions", String(a.count), "", "", "sp-count")}
  </div>

  <div class="eyebrow">By category</div>
  ${
    donutRows.length === 0
      ? `<div class="panel"><div class="empty">No spending recorded for this period yet.</div></div>`
      : `<div class="grid2">
    <div class="panel"><div class="chartbox tall"><canvas id="c-spend-donut"></canvas></div></div>
    <div class="panel"><div class="spend-list">
      ${donutRows
        .map((r, i) => {
          const pctOfTotal = totalSpend > 0 ? (r.actual / totalSpend) * 100 : 0;
          // Rank-based (position in donutRows), matching spendingDonut()'s
          // slice coloring in charts.js - keeps the list's dots/bars visually
          // matched to the donut now that the donut no longer colors by the
          // global categoryColorIndex hash.
          const colorVar =
            r.category === "Other"
              ? "var(--rule-2)"
              : `var(--cat-color-${i % 12})`;
          return `
        <div class="spend-row" data-cat="${esc(r.category)}">
          <span class="spend-dot" style="background:${colorVar}"></span>
          <div class="spend-row-main">
            <div class="spend-row-label"><span>${esc(r.category)}</span><span class="num">${money(r.actual)}</span></div>
            <div class="spend-bar"><div class="spend-bar-fill" style="width:${pctOfTotal.toFixed(1)}%;background:${colorVar}"></div></div>
          </div>
          <span class="muted num">${pctOfTotal.toFixed(0)}%</span>
        </div>`;
        })
        .join("")}
    </div></div>
  </div>`
  }

  <div class="eyebrow">Trend</div>
  <div class="panel">
    <h3>Spend by month</h3>
    <div class="chartbox"><canvas id="c-spend-trend"></canvas></div>
  </div>`;

  $("#m-sel").onchange = (e) => {
    state.month = Number(e.target.value);
    renderSpending();
  };
  $("#y-sel").onchange = async (e) => {
    state.year = Number(e.target.value);
    localStorage.setItem(YEAR_KEY, state.year);
    state.month = 0;
    await state.store.ensureYearLoaded?.(state.year);
    state.rows = await state.store.list();
    renderSpending();
  };

  wireSpendingList(donutRows);

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
  if (donutRows.length > 0) {
    charts.spendingDonut(donutRows, (category) => setActiveSpendRow(category));
  }
  const fullYear = aggregate(rows, state.budget, 0, state.year);
  charts.spendTrend(fullYear.series);
}

/** Two-way donut<->list highlight, both directions funnel through this one
    function so there's a single source of truth for "which category is
    active" instead of two independent code paths that could drift apart. */
function setActiveSpendRow(category) {
  view.querySelectorAll(".spend-row").forEach((el) => {
    el.classList.toggle("active", el.dataset.cat === category);
  });
  const rows = Array.from(view.querySelectorAll(".spend-row"));
  const idx = rows.findIndex((el) => el.dataset.cat === category);
  charts.highlightSlice(idx === -1 ? null : idx);
}

function wireSpendingList(donutRows) {
  view.querySelectorAll(".spend-row").forEach((el) => {
    el.onclick = () => setActiveSpendRow(el.dataset.cat);
    el.onmouseenter = () => {
      if (!el.classList.contains("active")) {
        const idx = donutRows.findIndex((r) => r.category === el.dataset.cat);
        charts.highlightSlice(idx === -1 ? null : idx);
      }
    };
    el.onmouseleave = () => {
      const activeEl = view.querySelector(".spend-row.active");
      const idx = activeEl
        ? donutRows.findIndex((r) => r.category === activeEl.dataset.cat)
        : -1;
      charts.highlightSlice(idx === -1 ? null : idx);
    };
  });
}
