/* Chart.js wrappers. Each call destroys the previous instance on that canvas,
   which is what stops the classic "ghost tooltip from the old chart" bug. */
import { personColorIndex } from "./store.js";

const INK = "#12161c",
  INK3 = "#6b7684",
  RULE = "#ddd5c8";
const TEAL = "#0f766e",
  AMBER = "#b45309",
  RED = "#b3261e",
  BLUE = "#1d4ed8",
  PURPLE = "#7c3aed",
  SAND = "#c6bcab";
const PIE = [TEAL, AMBER, BLUE, RED, PURPLE, "#0891b2", SAND];

const registry = new Map();
const money0 = (v) =>
  "$" + Number(v).toLocaleString("en-CA", { maximumFractionDigits: 0 });

function mount(id, config) {
  const el = document.getElementById(id);
  if (!el) return;
  const existing = registry.get(id);
  // If the canvas element is the SAME DOM node as last time, Chart.js can
  // update its data/options in place - much cheaper than tearing down and
  // rebuilding the whole chart (no re-layout, no new WebGL/2D context, no
  // visual flash). This only ever fires when a caller has deliberately kept
  // the canvas alive across a re-render; if the canvas was recreated (the
  // normal case today, since most pages rebuild via innerHTML), `existing`
  // will be bound to a DETACHED node and this falls through to the original
  // destroy+recreate path, unchanged.
  if (existing && existing.canvas === el) {
    existing.data = config.data;
    existing.options = config.options;
    if (existing.config.type !== config.type)
      existing.config.type = config.type;
    existing.update();
    return;
  }
  existing?.destroy();
  Chart.defaults.font.family = "'JetBrains Mono', ui-monospace, monospace";
  Chart.defaults.font.size = 11;
  Chart.defaults.color = INK3;
  registry.set(id, new Chart(el, config));
}
export function destroyAll() {
  registry.forEach((c) => c.destroy());
  registry.clear();
}

const gridY = {
  grid: { color: RULE, drawTicks: false },
  border: { display: false },
  ticks: { callback: money0 },
};
const gridX = { grid: { display: false }, border: { color: RULE } };
const legendTop = {
  legend: {
    position: "top",
    align: "end",
    labels: { boxWidth: 10, boxHeight: 10, padding: 14 },
  },
};

export function incomeVsExpense(series) {
  mount("c-ie", {
    type: "bar",
    data: {
      labels: series.map((s) => s.month),
      datasets: [
        {
          label: "Income",
          data: series.map((s) => s.income),
          backgroundColor: TEAL,
        },
        {
          label: "Expense",
          data: series.map((s) => s.expense),
          backgroundColor: AMBER,
        },
      ],
    },
    options: {
      maintainAspectRatio: false,
      responsive: true,
      plugins: legendTop,
      scales: { x: gridX, y: gridY },
    },
  });
}

export function netByMonth(series) {
  mount("c-net", {
    type: "bar",
    data: {
      labels: series.map((s) => s.month),
      datasets: [
        {
          label: "Net savings",
          data: series.map((s) => s.net),
          backgroundColor: series.map((s) => (s.net < 0 ? RED : TEAL)),
        },
      ],
    },
    options: {
      maintainAspectRatio: false,
      responsive: true,
      plugins: { legend: { display: false } },
      scales: { x: gridX, y: gridY },
    },
  });
}

export function trend(series) {
  mount("c-trend", {
    type: "line",
    data: {
      labels: series.map((s) => s.month),
      datasets: [
        {
          label: "Actual expense",
          data: series.map((s) => (s.hasData ? s.expense : null)),
          borderColor: INK,
          backgroundColor: INK,
          tension: 0.25,
          spanGaps: true,
          pointRadius: 3,
        },
        {
          label: "Budget ceiling",
          data: series.map((s) => s.budget),
          borderColor: AMBER,
          borderDash: [5, 4],
          pointRadius: 0,
          tension: 0,
        },
      ],
    },
    options: {
      maintainAspectRatio: false,
      responsive: true,
      plugins: legendTop,
      scales: { x: gridX, y: gridY },
    },
  });
}

export function actualVsBudget(catRows) {
  const rows = catRows.filter((r) => r.actual > 0 || r.budget > 0);
  mount("c-cat", {
    type: "bar",
    data: {
      labels: rows.map((r) => r.category),
      datasets: [
        {
          label: "Actual",
          data: rows.map((r) => r.actual),
          backgroundColor: rows.map((r) =>
            r.budget > 0 && r.actual > r.budget ? RED : INK,
          ),
        },
        {
          label: "Budget",
          data: rows.map((r) => r.budget),
          backgroundColor: SAND,
        },
      ],
    },
    options: {
      indexAxis: "y",
      maintainAspectRatio: false,
      responsive: true,
      plugins: legendTop,
      scales: {
        x: { ...gridY },
        y: {
          grid: { display: false },
          border: { color: RULE },
          ticks: { font: { size: 10 } },
        },
      },
    },
  });
}

export function topFive(top5) {
  mount("c-top", {
    type: "bar",
    data: {
      labels: top5.map((t) => t.category),
      datasets: [{ data: top5.map((t) => t.actual), backgroundColor: INK }],
    },
    options: {
      maintainAspectRatio: false,
      responsive: true,
      plugins: { legend: { display: false } },
      scales: { x: { ...gridX, ticks: { font: { size: 10 } } }, y: gridY },
    },
  });
}

export function paymentSplit(byPayment) {
  mount("c-pay", {
    type: "doughnut",
    data: {
      labels: byPayment.map((p) => p.method),
      datasets: [
        {
          data: byPayment.map((p) => p.amount),
          backgroundColor: PIE,
          borderColor: "#fff",
          borderWidth: 2,
        },
      ],
    },
    options: {
      maintainAspectRatio: false,
      responsive: true,
      cutout: "55%",
      plugins: {
        legend: {
          position: "right",
          labels: { boxWidth: 10, boxHeight: 10, padding: 10 },
        },
      },
    },
  });
}

/* ---- person comparison ---------------------------------------------------- */
// PERSON_PALETTE mirrors store.js's PERSON_PALETTE_SIZE (5 colours) so
// personColorIndex(name) always resolves to a real entry here - a tenant's
// household member names are not known in advance, so colour is assigned
// by a stable hash of the name rather than a lookup table of specific
// names. "Unassigned" is deliberately not hashed into the palette: it is a
// state, not a person, and gets the same neutral SAND it always has.
const PERSON_PALETTE = [TEAL, AMBER, BLUE, RED, PURPLE];
const colorFor = (p) =>
  p && p !== "Unassigned"
    ? PERSON_PALETTE[personColorIndex(p) % PERSON_PALETTE.length]
    : SAND;

export function personSplit(breakdown) {
  mount("c-person-split", {
    type: "doughnut",
    data: {
      labels: breakdown.map((b) => b.person),
      datasets: [
        {
          data: breakdown.map((b) => b.expense),
          backgroundColor: breakdown.map((b) => colorFor(b.person)),
          borderColor: "#fff",
          borderWidth: 2,
        },
      ],
    },
    options: {
      maintainAspectRatio: false,
      responsive: true,
      cutout: "55%",
      plugins: {
        legend: {
          position: "right",
          labels: { boxWidth: 10, boxHeight: 10, padding: 10 },
        },
      },
    },
  });
}

export function personByMonth(series, months) {
  mount("c-person-month", {
    type: "bar",
    data: {
      labels: months,
      datasets: series.map((s) => ({
        label: s.person,
        data: s.data,
        backgroundColor: colorFor(s.person),
      })),
    },
    options: {
      maintainAspectRatio: false,
      responsive: true,
      plugins: legendTop,
      scales: {
        x: { ...gridX, stacked: false },
        y: { ...gridY, stacked: false },
      },
    },
  });
}

export function personVsBudget(rows) {
  mount("c-person-cat", {
    type: "bar",
    data: {
      labels: rows.map((r) => r.category),
      datasets: rows[0]
        ? Object.keys(rows[0].byPerson).map((p) => ({
            label: p,
            data: rows.map((r) => r.byPerson[p] || 0),
            backgroundColor: colorFor(p),
          }))
        : [],
    },
    options: {
      indexAxis: "y",
      maintainAspectRatio: false,
      responsive: true,
      plugins: legendTop,
      scales: {
        x: { ...gridY, stacked: true },
        y: {
          grid: { display: false },
          border: { color: RULE },
          stacked: true,
          ticks: { font: { size: 10 } },
        },
      },
    },
  });
}

/* ---- net worth ------------------------------------------------------------ */
export function netWorthTrend(series) {
  mount("c-nw-trend", {
    type: "line",
    data: {
      labels: series.map((s) => s.date),
      datasets: [
        {
          label: "Net worth",
          data: series.map((s) => s.net),
          borderColor: INK,
          backgroundColor: INK,
          tension: 0.25,
          pointRadius: 4,
        },
        {
          label: "Assets",
          data: series.map((s) => s.assets),
          borderColor: TEAL,
          borderDash: [5, 4],
          pointRadius: 0,
        },
        {
          label: "Liabilities",
          data: series.map((s) => s.liabs),
          borderColor: RED,
          borderDash: [5, 4],
          pointRadius: 0,
        },
      ],
    },
    options: {
      maintainAspectRatio: false,
      responsive: true,
      plugins: legendTop,
      scales: { x: gridX, y: gridY },
    },
  });
}

export function assetSplit(assets) {
  const rows = assets
    .filter((a) => Number(a.balance) > 0)
    .sort((a, b) => b.balance - a.balance);
  mount("c-nw-split", {
    type: "doughnut",
    data: {
      labels: rows.map((a) => a.account),
      datasets: [
        {
          data: rows.map((a) => Number(a.balance)),
          backgroundColor: PIE,
          borderColor: "#fff",
          borderWidth: 2,
        },
      ],
    },
    options: {
      maintainAspectRatio: false,
      responsive: true,
      cutout: "55%",
      plugins: {
        legend: {
          position: "right",
          labels: {
            boxWidth: 10,
            boxHeight: 10,
            padding: 8,
            font: { size: 10 },
          },
        },
      },
    },
  });
}

export function dividendsTrend(series) {
  mount("c-dividends", {
    type: "bar",
    data: {
      labels: series.map((s) => s.month),
      datasets: [
        {
          label: "Dividends",
          data: series.map((s) => s.dividends || 0),
          backgroundColor: AMBER,
        },
      ],
    },
    options: {
      maintainAspectRatio: false,
      responsive: true,
      plugins: { legend: { display: false } },
      scales: { x: gridX, y: gridY },
    },
  });
}
