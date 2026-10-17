/* Budget page - per-category monthly targets and actual-vs-budget view. */
import {
  CAT_NAMES,
  EXPENSE_CATS,
  CAT_TYPE,
  MONTHS,
  spendOf,
} from "../store.js";
import { money, pct, monthOf, usageLevel } from "../xlsxio.js";
import { listFor, addCustom, removeCustom, loadCustom } from "../categories.js";
import { $, view, esc, state, notice, withBusy, refresh, confirmDialog } from "../core.js";
import { iconBadge } from "../icons.js";
import { countUp, cancelCountUp, isEntering } from "../motion.js";

export function renderBudget() {
  // Entrance motion (bar grow, count-up) only on a page entrance through
  // go(). Re-renders in place - after Save budget, person switch - stay still.
  const fresh = isEntering();
  // Includes user-created categories, not just the built-in list.
  // Categories that already carry a budget (saved on any device) are listed
  // too, so a category added elsewhere shows up here.
  const budgeted = Object.keys(state.budget || {}).filter((c) =>
    Object.values(state.budget[c] || {}).some((v) => Number(v) > 0),
  );
  // Categories the person deleted from the budget stay hidden (this device)
  // until they add a budget for them again.
  const hidden = loadCustom().hiddenBudget || [];
  const allCats = [...new Set([...listFor("category"), ...budgeted])]
    .filter((c) => !hidden.includes(c))
    .sort((a, b) => a.localeCompare(b));
  const expenseCats = allCats.filter((c) => CAT_TYPE[c] !== "Income");
  const isCustom = (c) => !(c in CAT_TYPE);
  // Budget is deliberately household-level: one ceiling for the two of you.
  // The bars therefore always show combined spend, whoever is selected above.
  const actuals = {};
  for (const c of allCats) {
    actuals[c] = {};
    for (let m = 1; m <= 12; m++) {
      actuals[c][m] = state.rows
        // spendOf() (Expense minus Refund, everything else 0) is essential, not
        // cosmetic. Summing every row's amount made a credit-card payment, a
        // CIBC->Wealthsimple move, or a transfer between Ramesh and Surya all
        // count as spending. That inflated "spent so far" from $69,317 to
        // $480,533 - it was adding $411,216 of money that only ever moved
        // between the household's own accounts.
        .filter(
          (r) =>
            r.category === c &&
            monthOf(r) === m &&
            Number(String(r.date).slice(0, 4)) === state.year,
        )
        .reduce((a, r) => a + spendOf(r), 0);
    }
  }

  // Summary numbers for the header strip
  const totalBudget = expenseCats.reduce((a, c) => {
    return (
      a +
      Object.values(state.budget[c] || {}).reduce(
        (s, v) => s + (Number(v) || 0),
        0,
      )
    );
  }, 0);
  const totalSpent = expenseCats.reduce(
    (a, c) => a + Object.values(actuals[c] || {}).reduce((s, v) => s + v, 0),
    0,
  );
  const budgetedCats = allCats.filter((c) =>
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
    // Same ok / warn / over bands as the Dashboard's Used column.
    const lv = hasBudget ? usageLevel(annualActual / annualBudget) : "";

    return `<div class="bcard" data-cat="${esc(c)}">
      <div class="bcard-head">
        <div class="bcard-name">
          ${iconBadge(c, "category", "sm")}
          ${esc(c)}
        </div>
        <div class="bcard-annual">
          <span class="bcard-total num" data-annual>${hasBudget ? money(annualBudget) : '<span class="muted">—</span>'}</span>
          <span class="bcard-label">/yr</span>
        </div>
        <button type="button" class="rowbtn del bcard-del" data-rmcat="${esc(c)}" title="Delete this category" aria-label="Delete ${esc(c)}">\u2715</button>
      </div>

      ${
        hasActual || hasBudget
          ? `<div class="bcard-bar-wrap">
        <div class="bcard-bar-track">
          <div class="bcard-bar-fill ${isOver ? "over " : ""}${lv ? "use-" + lv : ""}${fresh ? " grow" : ""}" style="width:${(pct * 100).toFixed(1)}%"></div>
        </div>
        <span class="bcard-bar-label num ${isOver ? "over" : lv === "warn" ? "lv-warn" : "muted"}">${hasBudget ? (pct * 100).toFixed(0) + "%" : ""}</span>
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
      <button class="btn ghost" id="b-add-cat">+ Add budget</button>
      <button class="btn ghost" id="b-clear-all">Clear all</button>
      <button class="btn" id="b-save">Save budget</button>
    </div>
  </div>

  <div class="b-summary" id="b-summary">
    <div class="b-sum-item">
      <span class="b-sum-val num" id="b-sum-budget">${money(totalBudget)}</span>
      <span class="b-sum-key">annual expense budget</span>
    </div>
    <div class="b-sum-item">
      <span id="b-sum-spent" class="b-sum-val num ${totalBudget > 0 ? { over: "over", warn: "lv-warn", ok: "" }[usageLevel(totalSpent / totalBudget)] : ""}">${money(totalSpent)}</span>
      <span class="b-sum-key">spent so far ${state.year}</span>
    </div>
    <div class="b-sum-item">
      <span class="b-sum-val num" id="b-sum-cats">${budgetedCats}</span>
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

  if (fresh) {
    countUp($("#b-sum-budget"), totalBudget, money);
    countUp($("#b-sum-spent"), totalSpent, money);
    countUp($("#b-sum-cats"), budgetedCats, (n) => String(Math.round(n)));
  }

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

  // Reads every card's inputs, including edits not saved yet.
  const collect = () => {
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
    return b;
  };

  // add / remove a category (kept on this device; it is shared once it has a
  // saved budget amount)
  $("#b-add-cat").onclick = () => openAddDialog();
  function openAddDialog() {
    const scrim = document.createElement("div");
    scrim.className = "b-scrim";
    scrim.innerHTML = `
    <div class="b-dialog" role="dialog" aria-modal="true" aria-labelledby="b-dlg-title">
      <div class="b-dlg-head">
        <h2 id="b-dlg-title">Add budget</h2>
        <button type="button" class="rowbtn" id="b-dlg-x" aria-label="Close">\u2715</button>
      </div>
      <form id="b-dlg-form" class="formgrid" autocomplete="off">
        <label class="f wide"><span>Category *</span>
          <input id="b-dlg-name" list="b-dlg-cats" placeholder="Pick one or type a new name, e.g. Pets" maxlength="40" required>
          <datalist id="b-dlg-cats">${[
            ...expenseCats.filter(
              (c) => !Object.values(state.budget[c] || {}).some((v) => Number(v) > 0),
            ),
            ...hidden.filter((c) => CAT_TYPE[c] !== "Income"),
          ]
            .map((c) => `<option value="${esc(c)}">`)
            .join("")}</datalist></label>
        <label class="f"><span>Monthly budget *</span>
          <input id="b-dlg-amt" type="number" step="1" min="0" required placeholder="0"></label>
        <div class="full">
          <p class="note" style="margin:0 0 10px">A new name creates a new expense category. Same amount every month; you can change individual months on its card afterwards. Nothing is saved until you click <b>Save budget</b>.</p>
          <div class="err" id="b-dlg-err"></div>
          <div class="actions">
            <button class="btn" type="submit">Add budget</button>
            <button class="btn ghost" type="button" id="b-dlg-cancel">Cancel</button>
          </div>
        </div>
      </form>
    </div>`;
    document.body.appendChild(scrim);
    const close = () => {
      scrim.remove();
      document.removeEventListener("keydown", onKey);
    };
    const onKey = (e) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    scrim.addEventListener("mousedown", (e) => {
      if (e.target === scrim) close();
    });
    scrim.querySelector("#b-dlg-x").onclick = close;
    scrim.querySelector("#b-dlg-cancel").onclick = close;
    scrim.querySelector("#b-dlg-name").focus();
    scrim.querySelector("#b-dlg-form").onsubmit = (ev) => {
      ev.preventDefault();
      const name = scrim.querySelector("#b-dlg-name").value.trim();
      const amt = Number(scrim.querySelector("#b-dlg-amt").value);
      const err = scrim.querySelector("#b-dlg-err");
      if (!name) return (err.textContent = "Enter a category.");
      if (!(amt >= 0)) return (err.textContent = "Enter a monthly amount.");
      const existing = [...allCats, ...hidden].find(
        (c) => c.toLowerCase() === name.toLowerCase(),
      );
      if (existing && CAT_TYPE[existing] === "Income")
        return (err.textContent = "Income categories aren't added here.");
      if (
        existing &&
        Object.values(state.budget[existing] || {}).some((v) => Number(v) > 0)
      )
        return (err.textContent = `${existing} already has a budget - edit its card instead.`);
      const cat = existing || name;
      state.budget = { ...state.budget, ...collect() }; // keep unsaved edits
      if (!existing) addCustom("category", cat);
      removeCustom("hiddenBudget", cat);
      state.budget[cat] = Object.fromEntries(
        Array.from({ length: 12 }, (_, i) => [i + 1, amt]),
      );
      close();
      renderBudget();
      notice(`Added ${cat} - click Save budget to keep it.`, "ok");
    };
  }
  view.querySelectorAll("[data-rmcat]").forEach(
    (b) =>
      (b.onclick = async () => {
        const cat = b.dataset.rmcat;
        if (
          !(await confirmDialog(
            `Delete the "${cat}" budget category? Its budget amounts (all years) are removed and it disappears from this page. Transactions keep their category.`,
          ))
        )
          return;
        const pending = collect(); // keep unsaved edits on the other cards
        const done = await withBusy("Deleting category", async () => {
          await state.store.deleteBudgetCategory?.(cat);
          addCustom("hiddenBudget", cat);
          removeCustom("category", cat);
          await refresh();
        });
        if (done) {
          delete pending[cat];
          state.budget = { ...state.budget, ...pending };
          delete state.budget[cat];
          notice(`Deleted ${cat}.`, "ok");
          renderBudget();
        }
      }),
  );

  // save
  $("#b-save").onclick = async () => {
    const b = collect();
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
  $("#b-clear-all").onclick = async () => {
    if (!(await confirmDialog("Reset every budget amount to zero?"))) return;
    view.querySelectorAll("input[type=number]").forEach((i) => {
      i.value = 0;
    });
    view.querySelectorAll("[data-annual]").forEach((el) => {
      el.innerHTML = '<span class="muted">—</span>';
    });
    // A count-up may still be running on these (page just opened).
    for (const [id, text] of [
      ["#b-sum-budget", money(0)],
      ["#b-sum-spent", money(0)],
      ["#b-sum-cats", "0"],
    ]) {
      const el = $(id);
      cancelCountUp(el);
      el.textContent = text;
    }
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
