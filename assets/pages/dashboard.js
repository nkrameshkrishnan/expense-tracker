/* Dashboard page: KPI cards, income/expense/net charts, category breakdown,
   the category-by-month Sankey diagram, and the top-N/over-budget panels. */
import { MONTHS, currentYear, UNASSIGNED, PERSON_KEY } from "../store.js";
import {
  aggregate,
  money,
  pct,
  usageLevel,
  personBreakdown,
  personSeries,
  categorySeries,
  categoryTotals,
  categoryShare,
} from "../xlsxio.js";
import * as charts from "../charts.js";
import {
  $,
  view,
  esc,
  state,
  scoped,
  personLabel,
  kpi,
  notice,
  YEAR_KEY,
} from "../core.js";
import { go } from "../router.js";
import { countUp, cancelCountUp, isEntering } from "../motion.js";
import { personAvatar } from "../icons.js";

/** Expense card subtitle. Expense is already net of refunds (spendOf), so
    say so whenever refunds were subtracted - otherwise the figure would
    silently disagree with the sum of the purchases listed in Transactions. */
const expenseMeta = (a) =>
  `${a.count} entries` +
  (a.refunds > 0 ? ` \u00b7 ${money(a.refunds)} refunds deducted` : "");

function availableYears() {
  // A backend whose cache exposes allTxYears (every year that actually
  // exists, independent of which years have had their data fetched yet)
  // gets an accurate list even before every year is loaded. Nothing
  // currently populates this for SupabaseStore - it lazy-loads by year the
  // same way the old SheetsStore did, but has no "list distinct years"
  // query wired up yet - so this falls through to scanning state.rows,
  // which is only as complete as whatever years have been fetched so far.
  // LocalStore/MemoryStore never partially load, so scanning state.rows for
  // them is already complete and correct regardless.
  const serverYears = state.store?.cache?.allTxYears;
  const fromData = new Set(
    serverYears?.length
      ? serverYears
      : state.rows
          .map((r) => Number(String(r.date).slice(0, 4)))
          .filter(Boolean),
  );
  fromData.add(currentYear());
  return [...fromData].sort((a, b) => b - a);
}

function periodSelect(value, year) {
  return `
  <label class="f"><span>Year</span><select id="y-sel">
    ${availableYears()
      .map(
        (y) =>
          `<option value="${y}"${y === year ? " selected" : ""}>${y}</option>`,
      )
      .join("")}
  </select></label>
  <label class="f"><span>Period</span><select id="m-sel">
    <option value="0"${value === 0 ? " selected" : ""}>Full year</option>
    ${MONTHS.map((m, i) => `<option value="${i + 1}"${value === i + 1 ? " selected" : ""}>${m}</option>`).join("")}
  </select></label>`;
}

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

/** Sets a KPI/figure's text and, when it is a real number, animates it with
    countUp (which always ends on exactly fmt(n)). Non-numeric states such as
    the em dash are written directly. Targets the inner value element only -
    never the tile itself (the tile has its own CSS entrance). */
function setValue(el, n, fmt, animate) {
  if (!el) return;
  cancelCountUp(el); // a stale onUpdate must never overwrite what we write now
  if (n === null) {
    delete el.dataset.countTo;
    el.textContent = fmt(null);
  } else if (animate) countUp(el, n, fmt);
  else {
    el.dataset.countTo = String(n);
    el.textContent = fmt(n);
  }
}
const DASH = "\u2014";
/** [numeric value or null, formatter] for each KPI, shared by both paths. */
function kpiValues(a) {
  return {
    income: [a.income, money],
    expense: [a.expense, money],
    net: [a.net, money],
    savings: [
      a.income > 0 ? a.savingsRate : null,
      (n) => (n === null ? DASH : pct(n)),
    ],
    budgetused: [
      a.expenseBudget > 0 ? a.budgetUsed : null,
      (n) => (n === null ? DASH : pct(n)),
    ],
    avgday: [a.avgDaily, money],
    avgweek: [a.avgWeekly, money],
    avgmonth: [a.avgMonthly, money],
  };
}
function animateKpis(a, animate) {
  for (const [key, [n, fmt]] of Object.entries(kpiValues(a)))
    setValue($(`#kpi-${key}-v`), n, fmt, animate);
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
  const catSeries = categorySeries(state.rows, state.catMonthYear);
  const showCompare = people.length > 1;
  const shape = dashboardShape(a, showCompare);

  // Fast path only when the LAST thing rendered into #view was a dashboard
  // shell of this exact shape. Anything else (arriving from a different tab,
  // or the shape changing) takes the full rebuild - which is the original,
  // unmodified code path and stays the default whenever there is any doubt.
  const canPatch =
    view.dataset.shell === "dashboard" && sameShape(shape, state._dashShape);
  // Count-up runs ONLY on a page entrance through go() (isEntering()) that
  // builds the shell. Selector/person changes - including ones that change
  // the shape and so take the full rebuild - write final text directly
  // (never animate filters). The tile entrance itself is the CSS card
  // stagger in styles.css (#view.is-entering), so tiles enter once.
  if (canPatch) updateDashboardValues(a, label, people, pSeries, showCompare);
  else buildDashboardShell(a, label, people, pSeries, showCompare, shape);
  const animate = !canPatch && isEntering();
  animateKpis(a, animate);
  if (a.dividends > 0)
    setValue($("#dash-div-total"), a.dividends, money, animate);
  state._dashShape = shape;

  wireDashboard(showCompare);

  if (typeof Chart === "undefined") {
    notice(
      "Chart.js did not load, so charts are unavailable. Everything else works.",
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
  charts.topFive(a.top5, a.expense);
  charts.categoryShare(catShareModel(), MONTHS);
  charts.categoryByMonth(
    catSeries,
    MONTHS,
    state.catMonthHighlight,
    state.catMonthOrientation,
  );
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

  // "Category spend by month" panel's own year/filter/orientation controls -
  // deliberately separate state from #y-sel/#m-sel above, and re-renders
  // only this one chart rather than the whole dashboard.
  const refreshCategoryMonthChart = () => {
    const label = $("#dash-catmonth-label");
    if (label) label.textContent = state.catMonthYear;
    charts.categoryByMonth(
      categorySeries(state.rows, state.catMonthYear),
      MONTHS,
      state.catMonthHighlight,
      state.catMonthOrientation,
    );
  };
  $("#cm-y-sel").onchange = async (e) => {
    state.catMonthYear = Number(e.target.value);
    // state.rows only holds years fetched so far (boot loads the current
    // year first, others lazily in the background) - same guard as #y-sel,
    // otherwise picking a not-yet-loaded year would silently draw an
    // all-zero chart instead of that year's real data.
    await state.store.ensureYearLoaded?.(state.catMonthYear);
    state.rows = await state.store.list();
    refreshCategoryMonthChart();
  };
  $("#cm-m-sel").onchange = (e) => {
    state.catMonthHighlight = Number(e.target.value);
    refreshCategoryMonthChart();
  };
  $("#cm-o-sel").onchange = (e) => {
    state.catMonthOrientation = e.target.value;
    refreshCategoryMonthChart();
  };

  // "Spend by category" table's own year/month filter - same independence
  // rationale as the "Category spend by month" controls above.
  const refreshCatSpendTable = () => {
    const tb = $("#catspend-tbody");
    if (tb) tb.innerHTML = catSpendRows();
  };
  $("#cs-y-sel").onchange = async (e) => {
    state.catSpendYear = Number(e.target.value);
    await state.store.ensureYearLoaded?.(state.catSpendYear);
    state.rows = await state.store.list();
    refreshCatSpendTable();
  };
  $("#cs-m-sel").onchange = (e) => {
    state.catSpendMonth = Number(e.target.value);
    refreshCatSpendTable();
  };

  // "Category share of spend" panel's own year selector.
  $("#csh-y-sel").onchange = async (e) => {
    state.catShareYear = Number(e.target.value);
    await state.store.ensureYearLoaded?.(state.catShareYear);
    state.rows = await state.store.list();
    refreshCatShare(true);
  };

  view.querySelectorAll("[data-jump]").forEach(
    (el) =>
      (el.onclick = () => {
        const p = el.dataset.jump;
        state.person = state.person === p ? "" : p;
        localStorage.setItem(PERSON_KEY, state.person);
        go("dashboard", { animate: false }); // a filter, not a navigation
      }),
  );
}

/** The full rebuild - identical markup/logic to the original renderDashboard,
    now with stable ids on every value the fast path needs to patch later. */
function buildDashboardShell(a, label, people, pSeries, showCompare) {
  const csm = catShareModel();
  view.innerHTML = `
  <div class="head">
    <div><h1>Dashboard</h1><p class="sub" id="dash-sub">${esc(personLabel())} &middot; ${esc(label)} &middot; ${a.count} transactions</p></div>
    <div class="spacer"></div>${periodSelect(state.month, state.year)}
  </div>

  <div class="kpis">
    ${kpi("Income", money(a.income), a.income === 0 ? "no income recorded" : "", "k-income", "income")}
    ${kpi("Expense", money(a.expense), expenseMeta(a), "k-expense", "expense")}
    ${kpi("Net", money(a.net), a.net < 0 ? "spending exceeds income" : "", a.net < 0 ? "neg" : "pos", "net")}
    ${kpi("Savings rate", a.income > 0 ? pct(a.savingsRate) : "\u2014", a.income > 0 ? "" : "needs income data", "", "savings")}
    ${kpi(
      "Budget used",
      a.expenseBudget > 0 ? pct(a.budgetUsed) : "\u2014",
      a.expenseBudget > 0
        ? state.person
          ? `of ${money(a.expenseBudget)} household`
          : `of ${money(a.expenseBudget)}`
        : "no budget set",
      budgetKpiClass(a),
      "budgetused",
    )}
    ${kpi("Avg / day", money(a.avgDaily), label, "", "avgday")}
    ${kpi("Avg / week", money(a.avgWeekly), label, "", "avgweek")}
    ${kpi("Avg / month", money(a.avgMonthly), label, "", "avgmonth")}
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
    <div class="panel">
      <div class="panel-head">
        <h3>Spend by category</h3>
        <div class="panel-controls">
          <select id="cs-y-sel" title="Year">
            ${availableYears()
              .map(
                (y) =>
                  `<option value="${y}"${y === state.catSpendYear ? " selected" : ""}>${y}</option>`,
              )
              .join("")}
          </select>
          <select id="cs-m-sel" title="Month">
            <option value="0"${state.catSpendMonth === 0 ? " selected" : ""}>Full year</option>
            ${MONTHS.map(
              (m, i) =>
                `<option value="${i + 1}"${state.catSpendMonth === i + 1 ? " selected" : ""}>${m}</option>`,
            ).join("")}
          </select>
        </div>
      </div>
      <div class="tablewrap"><table><thead><tr><th>Category</th><th class="n">Spent</th><th class="n">% of total</th></tr></thead><tbody id="catspend-tbody">
        ${catSpendRows()}
      </tbody></table></div>
    </div>
    <div class="panel"><h3>Actual vs budget by category &mdash; <span id="dash-cat-label">${esc(label)}</span></h3><div class="chartbox tall"><canvas id="c-cat"></canvas></div></div>
    <div class="panel"><h3>Top 5 spend categories &mdash; <span id="dash-top-label">${esc(label)}</span></h3><div class="chartbox tall"><canvas id="c-top"></canvas></div></div>
    <div class="panel wide">
      <div class="panel-head">
        <h3>Category share of spend &mdash; <span id="dash-catshare-label">${state.catShareYear}</span></h3>
        <div class="panel-controls">
          <select id="csh-y-sel" title="Year">
            ${availableYears()
              .map(
                (y) =>
                  `<option value="${y}"${y === state.catShareYear ? " selected" : ""}>${y}</option>`,
              )
              .join("")}
          </select>
        </div>
      </div>
      <div class="chartbox tall"><canvas id="c-cat-share" role="img" aria-label="${esc(catShareSummary(csm))}"></canvas></div>
      <p class="note" id="catshare-note">${catShareNote(csm)}</p>
      <h4 class="share-title">Share of spend by category</h4>
      <div class="tablewrap" id="catshare-wrap">${catShareTable(csm)}</div>
    </div>
    <div class="panel wide">
      <div class="panel-head">
        <h3>Category spend by month &mdash; <span id="dash-catmonth-label">${state.catMonthYear}</span></h3>
        <div class="panel-controls">
          <select id="cm-y-sel" title="Year">
            ${availableYears()
              .map(
                (y) =>
                  `<option value="${y}"${y === state.catMonthYear ? " selected" : ""}>${y}</option>`,
              )
              .join("")}
          </select>
          <select id="cm-m-sel" title="Filter to month">
            <option value="0"${state.catMonthHighlight === 0 ? " selected" : ""}>All months</option>
            ${MONTHS.map(
              (m, i) =>
                `<option value="${i + 1}"${state.catMonthHighlight === i + 1 ? " selected" : ""}>${m}</option>`,
            ).join("")}
          </select>
          <select id="cm-o-sel" title="Orientation">
            <option value="horizontal"${state.catMonthOrientation === "horizontal" ? " selected" : ""}>Horizontal</option>
            <option value="vertical"${state.catMonthOrientation === "vertical" ? " selected" : ""}>Vertical</option>
          </select>
        </div>
      </div>
      <div class="chartbox sankey"><canvas id="c-cat-month"></canvas></div>
    </div>
  </div>

  <div class="eyebrow">Category detail &mdash; <span id="dash-catdetail-label">${esc(label)}</span></div>
  <div class="tablewrap"><table><thead><tr><th>Category</th><th class="n">Actual</th><th class="n">Budget</th><th class="n">Variance</th><th class="n">Used</th></tr></thead><tbody id="catdetail-tbody">
    ${catDetailRows(a)}
  </tbody></table></div>`;
  view.dataset.shell = "dashboard";
}

/** Fast path: same shape as last render, so every section that exists now
    existed before too. Patch text/tables/charts in place - no innerHTML
    rebuild, no canvas recreation, no visual flash. */
function updateDashboardValues(a, label, people, pSeries, showCompare) {
  const sub = $("#dash-sub");
  if (sub)
    sub.textContent = `${personLabel()} \u00b7 ${label} \u00b7 ${a.count} transactions`;

  const setKpi = (key, v, m) => {
    const vEl = $(`#kpi-${key}-v`),
      mEl = $(`#kpi-${key}-m`);
    // The value itself is written (count-up animated only on a full build) by animateKpis().
    if (mEl) mEl.textContent = m;
  };
  setKpi("income", money(a.income), a.income === 0 ? "no income recorded" : "");
  setKpi("expense", money(a.expense), expenseMeta(a));
  const netEl = $("#kpi-net");
  if (netEl)
    netEl.className = `kpi card-hoverable ${a.net < 0 ? "neg" : "pos"}`;
  setKpi("net", money(a.net), a.net < 0 ? "spending exceeds income" : "");
  setKpi(
    "savings",
    a.income > 0 ? pct(a.savingsRate) : "\u2014",
    a.income > 0 ? "" : "needs income data",
  );
  const budEl = $("#kpi-budgetused");
  if (budEl) budEl.className = `kpi card-hoverable ${budgetKpiClass(a)}`;
  setKpi(
    "budgetused",
    a.expenseBudget > 0 ? pct(a.budgetUsed) : "\u2014",
    a.expenseBudget > 0
      ? state.person
        ? `of ${money(a.expenseBudget)} household`
        : `of ${money(a.expenseBudget)}`
      : "no budget set",
  );
  setKpi("avgday", money(a.avgDaily), label);
  setKpi("avgweek", money(a.avgWeekly), label);
  setKpi("avgmonth", money(a.avgMonthly), label);

  if (a.dividends > 0) {
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
  // "Spend by category" table is NOT refreshed here - it has its own
  // year/month filter (state.catSpendYear/catSpendMonth) independent of the
  // page-wide period this function is reacting to; only its own selectors
  // (wired in wireDashboard) or a full rebuild touch it.
  const cm = $("#dash-catmonth-label");
  if (cm) cm.textContent = state.catMonthYear;
  // The person switch scopes this panel too, so it follows it (its chart is
  // redrawn by renderDashboard right after this).
  refreshCatShare(false);
}

/** Category name with its colour dot - the same assignment the Actual vs
    budget / Top 5 charts use for this period (charts.budgetCategoryColors). */
const catCell = (colors, category) =>
  `<td><span class="cname"><span class="cdot" style="background:${colors.get(category)?.css ?? "var(--ink-3)"}"></span><span>${esc(category)}</span></span></td>`;
/** "Used" cell: a thin bar in the usage-band colour (ok / warn / over) and the
    % figure; the figure is red/bold when over, so the band is not colour-only. */
const usedCell = (r) => {
  if (!(r.budget > 0)) return `<td class="n num">\u2014</td>`;
  const lv = usageLevel(r.used);
  const txt = lv === "over" ? " over" : lv === "warn" ? " lv-warn" : "";
  return `<td class="n num${txt}"><span class="sharecell"><span class="sharebar"><span class="use-${lv}" style="width:${(Math.min(r.used, 1) * 100).toFixed(1)}%"></span></span>${pct(r.used)}</span></td>`;
};
/** KPI tile class for Budget used: red over 100%, ochre 80-100%. */
const budgetKpiClass = (a) =>
  a.expenseBudget > 0 && usageLevel(a.budgetUsed) !== "ok"
    ? usageLevel(a.budgetUsed) === "over"
      ? "neg"
      : "lv-warn"
    : "";
function overBudgetRows(a) {
  const colors = charts.budgetCategoryColors(a.catRows);
  return a.overBudget
    .map(
      (r) =>
        `<tr>${catCell(colors, r.category)}<td class="n num">${money(r.actual)}</td><td class="n num">${money(r.budget)}</td><td class="n num over"><span class="gl" aria-hidden="true">\u25b2</span>${money(-r.variance)}</td>${usedCell(r)}</tr>`,
    )
    .join("");
}
function personCards(people) {
  return people
    .map(
      (b) => `
      <div class="person-card${state.person === (b.person === UNASSIGNED ? UNASSIGNED : b.person) ? " on" : ""}" data-jump="${esc(b.person)}">
        <div class="person-card-head">
          ${personAvatar(b.person, "sm")}
          <span class="person-card-name">${esc(b.person)}</span>
        </div>
        <div class="person-card-val num">${money(b.expense)}</div>
        <div class="person-card-bar"><div class="person-card-fill" data-p="${esc(b.person)}" style="width:${(b.share * 100).toFixed(1)}%"></div></div>
        <div class="person-card-meta">
          <span class="muted">${pct(b.share)} of spend</span>
          ${b.income > 0 ? `<span class="tx-income num">+${money(b.income)}</span>` : `<span class="muted num">${b.count} entries</span>`}
        </div>
      </div>`,
    )
    .join("");
}
/** Model for the "Category share of spend" panel: same person scope as the
    neighbouring panels, its own year. */
function catShareModel() {
  return categoryShare(categorySeries(scoped(), state.catShareYear));
}
const pct1 = (v) => (v === null ? DASH : (v * 100).toFixed(1) + "%");
function catShareNote(m) {
  const parts = [
    `Each column is 100% of that month's spend (Year = the whole year), net of refunds. Transfers, income and dividends are not spend.`,
  ];
  if (m.merged)
    parts.push(
      `The top 8 categories by yearly spend are shown; the other ${m.merged} are merged into Other.`,
    );
  if (m.clamped) parts.push(`Refund-heavy categories are shown as 0%.`);
  return parts.join(" ");
}
function catShareSummary(m) {
  if (m.rows.length === 0)
    return `Category share of spend for ${state.catShareYear}: no spend recorded.`;
  const top = m.rows[0];
  return `100% stacked column chart of each category's share of spend by month for ${state.catShareYear}. Largest for the year: ${top.category}, ${pct1(top.shares[12])}. Full figures are in the table below.`;
}
/** Heat-map table: one row per category (+ Other), Jan..Dec | Year. Cell
    tint scales 8%-40% of the category colour with the share (50%+ = max). */
function catShareTable(m) {
  const head = `<thead><tr><th scope="col">Category</th>${MONTHS.map((x) => `<th scope="col" class="n">${x}</th>`).join("")}<th scope="col" class="n">Year</th></tr></thead>`;
  if (m.rows.length === 0)
    return `<table class="share-tbl">${head}<tbody><tr><td colspan="14" class="muted">Nothing recorded yet.</td></tr></tbody></table>`;
  const colors = charts.distinctCategoryColors(
    m.rows.filter((r) => !r.other).map((r) => r.category),
  );
  const body = m.rows
    .map((r) => {
      const col = r.other ? "var(--ink-3)" : colors.get(r.category).css;
      const cells = r.shares
        .map((v, i) => {
          const tint = !(v > 0)
            ? ""
            : ` style="background:color-mix(in srgb, ${col} ${Math.round(8 + 32 * Math.min(v / 0.5, 1))}%, transparent)"`;
          return `<td class="n num${i === 12 ? " share-year" : ""}"${tint}>${pct1(v)}</td>`;
        })
        .join("");
      return `<tr><th scope="row"><span class="share-dot" style="background:${col}"></span>${esc(r.category)}</th>${cells}</tr>`;
    })
    .join("");
  const total = m.totals
    .map(
      (t, i) =>
        `<td class="n num${i === 12 ? " share-year" : ""}">${t > 0 ? "100.0%" : DASH}</td>`,
    )
    .join("");
  return `<table class="share-tbl">${head}<tbody>${body}<tr class="tbl-total"><th scope="row">Total</th>${total}</tr></tbody></table>`;
}
/** Re-renders the panel in place (no rebuild, no animation). `withChart` is
    false when the caller redraws the chart itself right afterwards. */
function refreshCatShare(withChart) {
  const m = catShareModel();
  const wrap = $("#catshare-wrap");
  if (wrap) wrap.innerHTML = catShareTable(m);
  const note = $("#catshare-note");
  if (note) note.textContent = catShareNote(m);
  const lab = $("#dash-catshare-label");
  if (lab) lab.textContent = state.catShareYear;
  const cv = $("#c-cat-share");
  if (cv) cv.setAttribute("aria-label", catShareSummary(m));
  if (withChart && typeof Chart !== "undefined")
    charts.categoryShare(m, MONTHS);
}

/** Plain "spend under each category" table, sorted highest first, for the
    panel's own year/month filter (state.catSpendYear/catSpendMonth) rather
    than the page-wide period - unlike catDetailRows below this ignores
    budget entirely, so an unbudgeted category with real spend still shows
    up. Still respects the person filter, same as every other panel. */
function catSpendRows() {
  const rows = categoryTotals(
    scoped(),
    state.catSpendMonth,
    state.catSpendYear,
  );
  if (rows.length === 0)
    return '<tr><td colspan="3" class="muted">Nothing recorded yet.</td></tr>';
  const total = rows.reduce((a, r) => a + r.actual, 0);
  const colors = charts.distinctCategoryColors(rows.map((r) => r.category));
  // Share of the NET total (the Total row), so the column sums to 100%. A
  // zero/negative total has no meaningful split, so it shows a dash.
  const shareCell = (r) => {
    if (total <= 0) return `<td class="n num muted">${DASH}</td>`;
    const s = r.actual / total;
    return `<td class="n num${r.actual < 0 ? " under" : ""}"><span class="sharecell"><span class="sharebar"><span style="width:${(Math.max(0, Math.min(s, 1)) * 100).toFixed(1)}%;background:${colors.get(r.category).css}"></span></span>${pct1(s)}</span></td>`;
  };
  const body = rows
    .map(
      // A negative total (refunds outweighing that category's purchases
      // this period) gets the same "under" styling catDetailRows uses for
      // under-budget - it's money back, not overspend.
      (r) =>
        `<tr><td>${esc(r.category)}</td><td class="n num${r.actual < 0 ? " under" : ""}">${money(r.actual)}</td>${shareCell(r)}</tr>`,
    )
    .join("");
  // Sums to the same net figure the Transactions page shows for this same
  // period, now that categoryTotals() keeps negative (refund-heavy)
  // categories instead of dropping them - see the fix that added this check.
  return (
    body +
    `<tr class="tbl-total"><td>Total</td><td class="n num${total < 0 ? " under" : ""}">${money(total)}</td><td class="n num">${total > 0 ? "100.0%" : DASH}</td></tr>`
  );
}
function catDetailRows(a) {
  const colors = charts.budgetCategoryColors(a.catRows);
  // Variance: red up-triangle when over budget, teal down-triangle when under;
  // an unbudgeted category (budget 0) is neither, matching the charts.
  const varianceCell = (r) =>
    r.budget > 0 && r.variance < 0
      ? `<td class="n num over"><span class="gl" aria-hidden="true">\u25b2</span>${money(r.variance)}</td>`
      : r.budget > 0 && r.variance > 0
        ? `<td class="n num under"><span class="gl" aria-hidden="true">\u25bc</span>${money(r.variance)}</td>`
        : `<td class="n num${r.budget > 0 ? "" : " muted"}">${money(r.variance)}</td>`;
  return (
    a.catRows
      .filter((r) => r.actual > 0 || r.budget > 0)
      .map(
        (r) => `<tr>
      ${catCell(colors, r.category)}<td class="n num">${money(r.actual)}</td><td class="n num">${money(r.budget)}</td>
      ${varianceCell(r)}
      ${usedCell(r)}</tr>`,
      )
      .join("") ||
    '<tr><td colspan="5" class="muted">Nothing recorded yet.</td></tr>'
  );
}
