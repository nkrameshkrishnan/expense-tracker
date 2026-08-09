/* Chart.js wrappers. Each call destroys the previous instance on that canvas,
   which is what stops the classic "ghost tooltip from the old chart" bug. */
const INK = '#12161c', INK3 = '#6b7684', RULE = '#ddd5c8';
const TEAL = '#0f766e', AMBER = '#b45309', RED = '#b3261e', BLUE = '#1d4ed8', SAND = '#c6bcab';
const PIE = [TEAL, AMBER, BLUE, RED, '#7c3aed', '#0891b2', SAND];

const registry = new Map();
const money0 = v => '$' + Number(v).toLocaleString('en-CA', { maximumFractionDigits: 0 });

function mount(id, config) {
  const el = document.getElementById(id);
  if (!el) return;
  registry.get(id)?.destroy();
  Chart.defaults.font.family = "'JetBrains Mono', ui-monospace, monospace";
  Chart.defaults.font.size = 11;
  Chart.defaults.color = INK3;
  registry.set(id, new Chart(el, config));
}
export function destroyAll() { registry.forEach(c => c.destroy()); registry.clear(); }

const gridY = { grid: { color: RULE, drawTicks: false }, border: { display: false }, ticks: { callback: money0 } };
const gridX = { grid: { display: false }, border: { color: RULE } };
const legendTop = { legend: { position: 'top', align: 'end', labels: { boxWidth: 10, boxHeight: 10, padding: 14 } } };

export function incomeVsExpense(series) {
  mount('c-ie', {
    type: 'bar',
    data: {
      labels: series.map(s => s.month),
      datasets: [
        { label: 'Income', data: series.map(s => s.income), backgroundColor: TEAL },
        { label: 'Expense', data: series.map(s => s.expense), backgroundColor: AMBER },
      ],
    },
    options: { maintainAspectRatio: false, responsive: true, plugins: legendTop, scales: { x: gridX, y: gridY } },
  });
}

export function netByMonth(series) {
  mount('c-net', {
    type: 'bar',
    data: {
      labels: series.map(s => s.month),
      datasets: [{
        label: 'Net savings', data: series.map(s => s.net),
        backgroundColor: series.map(s => (s.net < 0 ? RED : TEAL)),
      }],
    },
    options: { maintainAspectRatio: false, responsive: true, plugins: { legend: { display: false } }, scales: { x: gridX, y: gridY } },
  });
}

export function trend(series) {
  mount('c-trend', {
    type: 'line',
    data: {
      labels: series.map(s => s.month),
      datasets: [
        { label: 'Actual expense', data: series.map(s => (s.hasData ? s.expense : null)), borderColor: INK, backgroundColor: INK, tension: 0.25, spanGaps: true, pointRadius: 3 },
        { label: 'Budget ceiling', data: series.map(s => s.budget), borderColor: AMBER, borderDash: [5, 4], pointRadius: 0, tension: 0 },
      ],
    },
    options: { maintainAspectRatio: false, responsive: true, plugins: legendTop, scales: { x: gridX, y: gridY } },
  });
}

export function actualVsBudget(catRows) {
  const rows = catRows.filter(r => r.actual > 0 || r.budget > 0);
  mount('c-cat', {
    type: 'bar',
    data: {
      labels: rows.map(r => r.category),
      datasets: [
        { label: 'Actual', data: rows.map(r => r.actual), backgroundColor: rows.map(r => (r.budget > 0 && r.actual > r.budget ? RED : INK)) },
        { label: 'Budget', data: rows.map(r => r.budget), backgroundColor: SAND },
      ],
    },
    options: {
      indexAxis: 'y', maintainAspectRatio: false, responsive: true, plugins: legendTop,
      scales: { x: { ...gridY }, y: { grid: { display: false }, border: { color: RULE }, ticks: { font: { size: 10 } } } },
    },
  });
}

export function topFive(top5) {
  mount('c-top', {
    type: 'bar',
    data: { labels: top5.map(t => t.category), datasets: [{ data: top5.map(t => t.actual), backgroundColor: INK }] },
    options: {
      maintainAspectRatio: false, responsive: true, plugins: { legend: { display: false } },
      scales: { x: { ...gridX, ticks: { font: { size: 10 } } }, y: gridY },
    },
  });
}

export function paymentSplit(byPayment) {
  mount('c-pay', {
    type: 'doughnut',
    data: { labels: byPayment.map(p => p.method), datasets: [{ data: byPayment.map(p => p.amount), backgroundColor: PIE, borderColor: '#fff', borderWidth: 2 }] },
    options: { maintainAspectRatio: false, responsive: true, cutout: '55%', plugins: { legend: { position: 'right', labels: { boxWidth: 10, boxHeight: 10, padding: 10 } } } },
  });
}
