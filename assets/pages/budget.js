/* Budget page - per-category monthly targets and actual-vs-budget view. */
import { CAT_NAMES, EXPENSE_CATS, CAT_TYPE, MONTHS } from "../store.js";
import { money, pct, monthOf } from "../xlsxio.js";
import { listFor } from "../categories.js";
import { $, view, esc, state, notice, withBusy, refresh } from "../core.js";

export function renderBudget() {
  // Includes user-created categories, not just the built-in list.
  const allCats = listFor("category");
  // Budget is deliberately household-level: one ceiling for the two of you.
  // The bars therefore always show combined spend, whoever is selected above.
  const actuals = {};
  for (const c of listFor("category")) {
    actuals[c] = {};
    for (let m = 1; m <= 12; m++) {
      actuals[c][m] = state.rows
        // type === 'Expense' is essential, not cosmetic. Without it a credit-card
        // payment, a CIBC->Wealthsimple move, or a transfer between Ramesh and
        // Surya all counted as spending. That inflated "spent so far" from
        // $69,317 to $480,533 - it was adding $411,216 of money that only ever
        // moved between the household's own accounts.
        .filter(
          (r) =>
            r.type === "Expense" &&
            r.category === c &&
            monthOf(r) === m &&
            Number(String(r.date).slice(0, 4)) === state.year,
        )
        .reduce((a, r) => a + r.amount, 0);
    }
  }

  // Summary numbers for the header strip
  const totalBudget = EXPENSE_CATS.reduce((a, c) => {
    return (
      a +
      Object.values(state.budget[c] || {}).reduce(
        (s, v) => s + (Number(v) || 0),
        0,
      )
    );
  }, 0);
  const totalSpent = EXPENSE_CATS.reduce(
    (a, c) => a + Object.values(actuals[c] || {}).reduce((s, v) => s + v, 0),
    0,
  );
  const budgetedCats = CAT_NAMES.filter((c) =>
    Object.values(state.budget[c] || {}).some((v) => Number(v) > 0),
  ).length;

  const renderCard = (c) => {
    const type = CAT_TYPE[c];
    const vals = Array.from(
      { length: 12 },
      (_, i) => Number(state.budget[c]?.[i + 1]) || 0,
    );
    const uniform = vals.every((v) => v === vals[0]);
    const annualBudget = vals.reduce((a, v) => a + v, 0);
    const annualActual = Object.values(actuals[c]).reduce((a, v) => a + v, 0);
    const isOver = annualBudget > 0 && annualActual > annualBudget;
    const pct = annualBudget > 0 ? Math.min(annualActual / annualBudget, 1) : 0;
    const hasBudget = annualBudget > 0;
    const hasActual = annualActual > 0;

    return `<div class="bcard" data-cat="${esc(c)}">
      <div class="bcard-head">
        <div class="bcard-name">
          <span class="bcard-dot ${type === "Income" ? "income" : ""}"></span>
          ${esc(c)}
        </div>
        <div class="bcard-annual">
          <span class="bcard-total num" data-annual>${hasBudget ? money(annualBudget) : '<span class="muted">—</span>'}</span>
          <span class="bcard-label">/yr</span>
        </div>
      </div>

      ${
        hasActual || hasBudget
          ? `<div class="bcard-bar-wrap">
        <div class="bcard-bar-track">
          <div class="bcard-bar-fill ${isOver ? "over" : ""}" style="width:${(pct * 100).toFixed(1)}%"></div>
        </div>
        <span class="bcard-bar-label num ${isOver ? "over" : "muted"}">${hasBudget ? (pct * 100).toFixed(0) + "%" : ""}</span>
      </div>
      <div class="bcard-context">
        ${hasActual ? `<span class="num muted" style="font-size:11px">spent ${money(annualActual)}</span>` : '<span class="muted" style="font-size:11px">no spend yet</span>'}
      </div>`
          : `<div style="height:8px"></div>`
      }

      <div class="bcard-mode">
        <label class="bcard-toggle">
          <input type="checkbox" class="uniform-check" ${uniform ? "checked" : ""}>
          <span>Same every month</span>
        </label>
      </div>

      <div class="bcard-uniform" style="${uniform ? "" : "display:none"}">
        <div class="bcard-uniform-row">
          <span class="bcard-uniform-label">Monthly</span>
          <input class="num bcard-flat-input" type="number" step="1" min="0"
            data-flat value="${vals[0]}" placeholder="0">
          <span class="bcard-uniform-label muted">× 12</span>
        </div>
      </div>

      <div class="bcard-months" style="${uniform ? "display:none" : ""}">
        ${MONTHS.map((m, i) => {
          const a = actuals[c][i + 1];
          const b = vals[i];
          const mo = b > 0 && a > b;
          return `<div class="bmonth">
            <span class="bmonth-label">${m}</span>
            <input class="num bmonth-input ${mo ? "over" : ""}" type="number" step="1" min="0"
              data-m="${i + 1}" value="${b}" placeholder="0">
            ${a > 0 ? `<span class="bmonth-actual num ${mo ? "over" : "muted"}">${money(a)}</span>` : '<span class="bmonth-actual"></span>'}
          </div>`;
        }).join("")}
      </div>
    </div>`;
  };

  view.innerHTML = `
  <div class="head">
    <div><h1>Budget</h1><p class="sub">One shared household ceiling per category. Bars show <b>combined</b> spend for both of you, regardless of who is selected above. Zero means "not budgeted".</p></div>
    <div class="spacer"></div>
    <div class="actions">
      <button class="btn ghost" id="b-clear-all">Clear all</button>
      <button class="btn" id="b-save">Save budget</button>
    </div>
  </div>

  <div class="b-summary">
    <div class="b-sum-item">
      <span class="b-sum-val num">${money(totalBudget)}</span>
      <span class="b-sum-key">annual expense budget</span>
    </div>
    <div class="b-sum-item">
      <span class="b-sum-val num ${totalSpent > totalBudget && totalBudget > 0 ? "over" : ""}">${money(totalSpent)}</span>
      <span class="b-sum-key">spent so far ${state.year}</span>
    </div>
    <div class="b-sum-item">
      <span class="b-sum-val num">${budgetedCats}</span>
      <span class="b-sum-key">categories budgeted</span>
    </div>
  </div>

  <div class="eyebrow">Income</div>
  <div class="bcards">
    ${allCats
      .filter((c) => CAT_TYPE[c] === "Income")
      .map(renderCard)
      .join("")}
  </div>

  <div class="eyebrow">Expenses</div>
  <div class="bcards">
    ${allCats
      .filter((c) => CAT_TYPE[c] !== "Income")
      .map(renderCard)
      .join("")}
  </div>

  <p class="note" style="margin-top:18px">Bar shows actual spend vs this year's budget. Red = over. Nothing saves until you click <b>Save budget</b>.</p>`;

  // --- wire up each card
  view.querySelectorAll(".bcard").forEach((card) => {
    const cat = card.dataset.cat;

    const getAnnual = () => {
      const uniformEl = card.querySelector(".bcard-flat-input");
      if (!card.querySelector(".bcard-uniform-row").parentElement.hidden) {
        const v = Number(uniformEl?.value) || 0;
        return v * 12;
      }
      return [...card.querySelectorAll("[data-m]")].reduce(
        (a, i) => a + (Number(i.value) || 0),
        0,
      );
    };

    const updateAnnual = () => {
      const a = getAnnual();
      card.querySelector("[data-annual]").innerHTML =
        a > 0 ? money(a) : '<span class="muted">—</span>';
    };

    // toggle uniform ↔ monthly
    card.querySelector(".uniform-check").onchange = (e) => {
      const uniformDiv = card.querySelector(".bcard-uniform");
      const monthsDiv = card.querySelector(".bcard-months");
      const isUniform = e.target.checked;
      uniformDiv.style.display = isUniform ? "" : "none";
      monthsDiv.style.display = isUniform ? "none" : "";
      if (isUniform) {
        // sync flat input to first month value
        const first = Number(card.querySelector('[data-m="1"]')?.value) || 0;
        card.querySelector(".bcard-flat-input").value = first;
      } else {
        // spread flat value to all months
        const flat =
          Number(card.querySelector(".bcard-flat-input")?.value) || 0;
        card.querySelectorAll("[data-m]").forEach((i) => {
          i.value = flat;
        });
      }
      updateAnnual();
    };

    // flat input changes
    card
      .querySelector(".bcard-flat-input")
      ?.addEventListener("input", updateAnnual);

    // monthly inputs
    card.querySelectorAll("[data-m]").forEach((inp) =>
      inp.addEventListener("input", () => {
        updateAnnual();
        // colour the input red if actual > budget for that month
        const m = Number(inp.dataset.m);
        const b = Number(inp.value) || 0;
        const a = actuals[cat][m] || 0;
        inp.classList.toggle("over", b > 0 && a > b);
      }),
    );

    updateAnnual();
  });

  // save
  $("#b-save").onclick = async () => {
    const b = {};
    view.querySelectorAll(".bcard").forEach((card) => {
      const c = card.dataset.cat;
      b[c] = {};
      const isUniform = card.querySelector(".uniform-check").checked;
      if (isUniform) {
        const flat =
          Number(card.querySelector(".bcard-flat-input")?.value) || 0;
        for (let m = 1; m <= 12; m++) b[c][m] = flat;
      } else {
        card.querySelectorAll("[data-m]").forEach((i) => {
          b[c][Number(i.dataset.m)] = Number(i.value) || 0;
        });
      }
    });
    const done = await withBusy("Saving the budget", async () => {
      await state.store.setBudget(b, state.year);
      await refresh();
    });
    if (done) {
      notice("Budget saved.", "ok");
      renderBudget();
    }
  };

  // clear all
  $("#b-clear-all").onclick = () => {
    if (!confirm("Reset every budget amount to zero?")) return;
    view.querySelectorAll("input[type=number]").forEach((i) => {
      i.value = 0;
    });
    view.querySelectorAll("[data-annual]").forEach((el) => {
      el.innerHTML = '<span class="muted">—</span>';
    });
    view.querySelectorAll(".b-sum-val").forEach((el, i) => {
      if (i < 2) el.textContent = money(0);
    });
    view.querySelector(".b-sum-item:nth-child(3) .b-sum-val").textContent = "0";
  };
}

/* ================================================================= NET WORTH */
/* Balances are snapshots, not movements. Nothing here feeds Income, Expense or
   Budget - a TFSA balance already contains the contributions recorded as
   Transfers, so counting both would double them. */

/* No balance seeding from a bundled file, deliberately. An earlier version
   shipped data/seed-balances.json containing real account balances - in a
   PUBLIC repo, which is the same mistake that put 687 transactions on
   raw.githubusercontent.com. Balances arrive one of two ways now: typed into
   Record balances, or imported from a file you choose at runtime. Neither
   touches the repository. */

/** Every account available on the Net worth tab.
    Built-ins + anything already in your saved balances + anything you add here.
    Deriving from saved balances matters: an account imported from a CSV shows
    up without needing to be registered anywhere. */