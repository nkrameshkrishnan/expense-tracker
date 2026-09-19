import { MONTHS, UNASSIGNED, PERSON_KEY } from "../store.js";
import {
  $,
  view,
  esc,
  YEAR_KEY,
  state,
  notice,
  scoped,
  personLabel,
  personColorClass,
  kpi,
  periodSelect,
} from "../core.js";
import {
  aggregate,
  money,
  pct,
  personBreakdown,
  personSeries,
} from "../xlsxio.js";
import { cardHoverable, revealStagger, countUp } from "../motion.js";
import { go } from "../router.js";
import * as charts from "../charts.js";

/** Which structural sections would appear affects DOM shape, not just values:
    the dividends panel, the over-budget table, the person-comparison charts,
    the payment "no data" placeholder, and the unattributed note all
    appear/disappear based on data. Two renders can only safely share DOM
    (patch values, update charts in place) when ALL of these agree - anything
    else falls back to the full rebuild, which is the ONLY path that existed
    before this change and remains provably correct for every case. */
function dashboardShape(a, showCompare) {
  return {
    showCompare,
    hasDividends: a.dividends > 0,
    hasOverBudget: a.overBudget.length > 0,
    hasNoPayment: a.byPayment.length === 0,
    hasUnattributed: a.unattributed > 0,
  };
}
function sameShape(x, y) {
  return (
    !!x &&
    !!y &&
    x.showCompare === y.showCompare &&
    x.hasDividends === y.hasDividends &&
    x.hasOverBudget === y.hasOverBudget &&
    x.hasNoPayment === y.hasNoPayment &&
    x.hasUnattributed === y.hasUnattributed
  );
}

export function renderDashboard() {
  const a = aggregate(scoped(), state.budget, state.month, state.year);
  const label =
    state.month === 0
      ? `Full year ${state.year}`
      : `${MONTHS[state.month - 1]} ${state.year}`;
  // Comparison is always computed across everyone, so it stays meaningful
  // even while the rest of the page is filtered to one person.
  const people = personBreakdown(state.rows, state.month, state.year);
  const pSeries = personSeries(state.rows, state.year);
  const showCompare = people.length > 1;
  const shape = dashboardShape(a, showCompare);

  // Fast path only when the LAST thing rendered into #view was a dashboard
  // shell of this exact shape. Anything else (arriving from a different tab,
  // or the shape changing) takes the full rebuild - which is the original,
  // unmodified code path and stays the default whenever there is any doubt.
  const canPatch =
    view.dataset.shell === "dashboard" && sameShape(shape, state._dashShape);
  if (canPatch) updateDashboardValues(a, label, people, pSeries, showCompare);
  else buildDashboardShell(a, label, people, pSeries, showCompare, shape);
  state._dashShape = shape;

  wireDashboard(showCompare);

  if (typeof Chart === "undefined") {
    notice(
      "Charts couldn't load. Everything else on this page still works.",
      "bad",
    );
    return;
  }
  if (showCompare) {
    charts.personSplit(people);
    charts.personByMonth(pSeries, MONTHS);
  }
  charts.incomeVsExpense(a.series);
  charts.netByMonth(a.series);
  charts.trend(a.series);
  charts.paymentSplit(a.byPayment);
  charts.actualVsBudget(a.catRows);
  charts.topFive(a.top5);
  if (a.dividends > 0) charts.dividendsTrend(a.series);
}

/** Selector/click wiring. Reassigning .onchange/.onclick is idempotent, so
    this runs after EITHER path without needing to know which one ran. */
function wireDashboard(showCompare) {
  $("#m-sel").onchange = (e) => {
    state.month = Number(e.target.value);
    renderDashboard();
  };
  $("#y-sel").onchange = async (e) => {
    state.year = Number(e.target.value);
    localStorage.setItem(YEAR_KEY, state.year);
    state.month = 0; // switching years resets to "full year" - a specific
    // month carried over from a different year is confusing
    // Normally a no-op: the background full-history load kicked off at boot
    // has almost always already finished by the time anyone reaches for the
    // year selector. Only genuinely fetches if that year truly is not in
    // memory yet - switching years faster than the background load can win.
    await state.store.ensureYearLoaded?.(state.year);
    state.rows = await state.store.list();
    // Budget is per-year on the sheet, so changing year needs a fresh fetch,
    // not just a re-render of already-cached data.
    state.budget = await state.store.getBudget(state.year);
    renderDashboard();
  };
  view.querySelectorAll("[data-jump]").forEach(
    (el) =>
      (el.onclick = () => {
        const p = el.dataset.jump;
        state.person = state.person === p ? "" : p;
        localStorage.setItem(PERSON_KEY, state.person);
        go("dashboard");
      }),
  );
}

/** The full rebuild - identical markup/logic to the original renderDashboard,
    now with stable ids on every value the fast path needs to patch later. */
function buildDashboardShell(a, label, people, pSeries, showCompare) {
  view.innerHTML = `
  <div class="head">
    <div><h1>Dashboard</h1><p class="sub" id="dash-sub">${esc(personLabel())} &middot; ${esc(label)} &middot; ${a.count} transactions</p></div>
    <div class="spacer"></div>${periodSelect(state.month, state.year)}
  </div>

  <div class="kpis">
    ${kpi("Income", money(a.income), a.income === 0 ? "no income recorded" : "", "", "income")}
    ${kpi("Expense", money(a.expense), `${a.count} entries`, "", "expense")}
    ${kpi("Net", money(a.net), a.net < 0 ? "spending exceeds income" : "", a.net < 0 ? "neg" : "pos", "net")}
    ${kpi("Savings rate", a.income > 0 ? pct(a.savingsRate) : "—", a.income > 0 ? "" : "needs income data", "", "savings")}
    ${kpi(
      "Budget used",
      a.expenseBudget > 0 ? pct(a.budgetUsed) : "—",
      a.expenseBudget > 0
        ? state.person
          ? `of ${money(a.expenseBudget)} household`
          : `of ${money(a.expenseBudget)}`
        : "no budget set",
      a.budgetUsed > 1 ? "neg" : "",
      "budgetused",
    )}
    ${kpi("Avg / day", money(a.avgDaily), state.month === 0 ? `over ${state.year % 4 === 0 && (state.year % 100 !== 0 || state.year % 400 === 0) ? 366 : 365} days` : `over ${new Date(state.year, state.month, 0).getDate()} days`, "", "avgday")}
  </div>

  ${
    a.dividends > 0
      ? `
  <div class="eyebrow">Dividends &mdash; <span id="dash-div-label">${label}</span></div>
  <div class="div-panel">
    <div class="div-kpi">
      <span class="div-kpi-label">Total this period</span>
      <span class="div-kpi-val num" id="dash-div-total">${money(a.dividends)}</span>
      <span class="div-kpi-note">Tracked separately &mdash; not counted as Income, not counted as spending.</span>
    </div>
    <div class="div-chart"><canvas id="c-dividends"></canvas></div>
  </div>`
      : ""
  }

  ${
    a.overBudget.length
      ? `<div class="eyebrow">Over budget &mdash; <span id="dash-ob-label">${label}</span></div>
  <div class="tablewrap"><table><thead><tr><th>Category</th><th class="n">Actual</th><th class="n">Budget</th><th class="n">Over by</th><th class="n">Used</th></tr></thead><tbody id="overbudget-tbody">
    ${overBudgetRows(a)}
  </tbody></table></div>`
      : ""
  }

  ${
    showCompare
      ? `
  <div class="eyebrow">Who spent what &mdash; <span id="dash-who-label">${esc(label)}</span></div>
  <div class="person-cards" id="person-cards">
    ${personCards(people)}
  </div>`
      : ""
  }

  <div class="eyebrow">Charts</div>
  <div class="grid2">
    ${
      showCompare
        ? `
    <div class="panel"><h3>Spend split by person &mdash; <span id="dash-split-label">${esc(label)}</span></h3><div class="chartbox"><canvas id="c-person-split"></canvas></div></div>
    <div class="panel"><h3>Monthly spend by person</h3><div class="chartbox"><canvas id="c-person-month"></canvas></div></div>`
        : ""
    }
    <div class="panel"><h3>Income vs expense by month</h3><div class="chartbox"><canvas id="c-ie"></canvas></div></div>
    <div class="panel"><h3>Net savings by month</h3><div class="chartbox"><canvas id="c-net"></canvas></div></div>
    <div class="panel"><h3>Expense vs budget ceiling</h3><div class="chartbox"><canvas id="c-trend"></canvas></div></div>
    <div class="panel"><h3>Payment method split &mdash; <span id="dash-pay-label">${esc(label)}</span></h3><div class="chartbox"><canvas id="c-pay"></canvas>
      ${a.byPayment.length === 0 ? `<p class="note" style="position:absolute;inset:0;display:grid;place-content:center;text-align:center">No payment methods recorded.<br>Fill the Payment field when adding entries.</p>` : ""}</div>
      ${a.unattributed > 0 ? `<p class="note" id="dash-unattr-note">${money(a.unattributed)} has no payment method set, so it is excluded here.</p>` : ""}</div>
    <div class="panel"><h3>Actual vs budget by category &mdash; <span id="dash-cat-label">${esc(label)}</span></h3><div class="chartbox tall"><canvas id="c-cat"></canvas></div></div>
    <div class="panel"><h3>Top 5 spend categories &mdash; <span id="dash-top-label">${esc(label)}</span></h3><div class="chartbox tall"><canvas id="c-top"></canvas></div></div>
  </div>

  <div class="eyebrow">Category detail &mdash; <span id="dash-catdetail-label">${esc(label)}</span></div>
  <div class="tablewrap"><table><thead><tr><th>Category</th><th class="n">Actual</th><th class="n">Budget</th><th class="n">Variance</th><th class="n">Used</th></tr></thead><tbody id="catdetail-tbody">
    ${catDetailRows(a)}
  </tbody></table></div>`;
  view.dataset.shell = "dashboard";

  view.querySelectorAll(".kpi, .panel").forEach(cardHoverable);
  const kpiEls = view.querySelectorAll(".kpi");
  const panelEls = view.querySelectorAll(".panel");
  revealStagger(kpiEls);
  const kpiFinish = 0.35 + Math.max(0, kpiEls.length - 1) * 0.04; // duration + stagger tail, matches revealStagger's defaults
  revealStagger(panelEls, { delay: kpiFinish });
  state._dashLastAgg = a;
}

/** Fast path: same shape as last render, so every section that exists now
    existed before too. Patch text/tables/charts in place - no innerHTML
    rebuild, no canvas recreation, no visual flash. */
function updateDashboardValues(a, label, people, pSeries, showCompare) {
  const sub = $("#dash-sub");
  if (sub)
    sub.textContent = `${personLabel()} · ${label} · ${a.count} transactions`;

  const prev = state._dashLastAgg;

  const setKpiMeta = (key, m) => {
    const mEl = $(`#kpi-${key}-m`);
    if (mEl) mEl.textContent = m;
  };
  const setKpiNumber = (key, from, to, fmt) => {
    const vEl = $(`#kpi-${key}-v`);
    if (!vEl) return;
    if (from === undefined || from === null) {
      vEl.textContent = fmt(to);
      return;
    }
    countUp(vEl, from, to, fmt);
  };
  const setKpiText = (key, text) => {
    const vEl = $(`#kpi-${key}-v`);
    if (vEl) vEl.textContent = text;
  };

  setKpiNumber("income", prev?.income, a.income, money);
  setKpiMeta("income", a.income === 0 ? "no income recorded" : "");

  setKpiNumber("expense", prev?.expense, a.expense, money);
  setKpiMeta("expense", `${a.count} entries`);

  const netEl = $("#kpi-net");
  if (netEl)
    netEl.className = `kpi card-hoverable ${a.net < 0 ? "neg" : "pos"}`;
  setKpiNumber("net", prev?.net, a.net, money);
  setKpiMeta("net", a.net < 0 ? "spending exceeds income" : "");

  if (a.income > 0 && prev?.income > 0) {
    setKpiNumber("savings", prev.savingsRate, a.savingsRate, pct);
  } else {
    setKpiText("savings", a.income > 0 ? pct(a.savingsRate) : "—");
  }
  setKpiMeta("savings", a.income > 0 ? "" : "needs income data");

  const budEl = $("#kpi-budgetused");
  if (budEl)
    budEl.className = `kpi card-hoverable ${a.budgetUsed > 1 ? "neg" : ""}`;
  if (a.expenseBudget > 0 && prev?.expenseBudget > 0) {
    setKpiNumber("budgetused", prev.budgetUsed, a.budgetUsed, pct);
  } else {
    setKpiText("budgetused", a.expenseBudget > 0 ? pct(a.budgetUsed) : "—");
  }
  setKpiMeta(
    "budgetused",
    a.expenseBudget > 0
      ? state.person
        ? `of ${money(a.expenseBudget)} household`
        : `of ${money(a.expenseBudget)}`
      : "no budget set",
  );

  setKpiNumber("avgday", prev?.avgDaily, a.avgDaily, money);
  setKpiMeta(
    "avgday",
    state.month === 0
      ? `over ${state.year % 4 === 0 && (state.year % 100 !== 0 || state.year % 400 === 0) ? 366 : 365} days`
      : `over ${new Date(state.year, state.month, 0).getDate()} days`,
  );

  state._dashLastAgg = a;

  if (a.dividends > 0) {
    const t = $("#dash-div-total");
    if (t) t.textContent = money(a.dividends);
    const l = $("#dash-div-label");
    if (l) l.textContent = label;
  }
  if (a.overBudget.length) {
    const tb = $("#overbudget-tbody");
    if (tb) tb.innerHTML = overBudgetRows(a);
    const l = $("#dash-ob-label");
    if (l) l.textContent = label;
  }
  if (showCompare) {
    const pc = $("#person-cards");
    if (pc) pc.innerHTML = personCards(people);
    const l = $("#dash-who-label");
    if (l) l.textContent = esc(label);
    const l2 = $("#dash-split-label");
    if (l2) l2.textContent = esc(label);
  }
  if (a.unattributed > 0) {
    const n = $("#dash-unattr-note");
    if (n)
      n.textContent = `${money(a.unattributed)} has no payment method set, so it is excluded here.`;
  }
  [
    "dash-pay-label",
    "dash-cat-label",
    "dash-top-label",
    "dash-catdetail-label",
  ].forEach((id) => {
    const el = $("#" + id);
    if (el) el.textContent = esc(label);
  });
  const catTb = $("#catdetail-tbody");
  if (catTb) catTb.innerHTML = catDetailRows(a);
}

function overBudgetRows(a) {
  return a.overBudget
    .map(
      (r) =>
        `<tr><td>${esc(r.category)}</td><td class="n num">${money(r.actual)}</td><td class="n num">${money(r.budget)}</td><td class="n num over">${money(-r.variance)}</td><td class="n num over">${pct(r.used)}</td></tr>`,
    )
    .join("");
}
function personCards(people) {
  return people
    .map(
      (b) => `
      <div class="person-card${state.person === (b.person === UNASSIGNED ? UNASSIGNED : b.person) ? " on" : ""}" data-jump="${esc(b.person)}">
        <div class="person-card-head">
          <span class="person-swatch ${personColorClass(b.person)}" data-p="${esc(b.person)}"></span>
          <span class="person-card-name">${esc(b.person)}</span>
        </div>
        <div class="person-card-val num">${money(b.expense)}</div>
        <div class="person-card-bar"><div class="person-card-fill ${personColorClass(b.person)}" data-p="${esc(b.person)}" style="width:${(b.share * 100).toFixed(1)}%"></div></div>
        <div class="person-card-meta">
          <span class="muted">${pct(b.share)} of spend</span>
          ${b.income > 0 ? `<span class="tx-income num">+${money(b.income)}</span>` : `<span class="muted num">${b.count} entries</span>`}
        </div>
      </div>`,
    )
    .join("");
}
function catDetailRows(a) {
  return (
    a.catRows
      .filter((r) => r.actual > 0 || r.budget > 0)
      .map(
        (r) => `<tr>
      <td>${esc(r.category)}</td><td class="n num">${money(r.actual)}</td><td class="n num">${money(r.budget)}</td>
      <td class="n num ${r.variance < 0 ? "over" : "under"}">${money(r.variance)}</td>
      <td class="n num ${r.used > 1 ? "over" : ""}">${r.budget > 0 ? pct(r.used) : "—"}</td></tr>`,
      )
      .join("") ||
    '<tr><td colspan="5" class="muted">Nothing recorded yet.</td></tr>'
  );
}
