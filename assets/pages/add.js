/* Add/Edit transaction page. */
import { TYPES, MONTHS, currentYear } from "../store.js";
import { money, monthOf } from "../xlsxio.js";
import {
  listFor,
  selectWithNew,
  wireNewOption,
  addCustom,
} from "../categories.js";
import {
  $,
  view,
  esc,
  state,
  scoped,
  notice,
  withBusy,
  refresh,
} from "../core.js";
import { go } from "../router.js";

/** Pill row for the "Whose" field: one button per known person plus a
    "+ New…" pill, mirroring the type-picker's look rather than a dropdown. */
function personPillsHtml(people, selected) {
  return (
    people
      .map(
        (pp) =>
          `<button type="button" class="add-person-btn${pp === selected ? " on" : ""}" data-person="${esc(pp)}"><span class="person-swatch" data-p="${esc(pp)}"></span>${esc(pp)}</button>`,
      )
      .join("") +
    `<button type="button" class="add-person-btn add-person-new" id="person-new-btn">+ New…</button>`
  );
}

export function renderAdd() {
  const e = state.editing;
  const today = new Date().toISOString().slice(0, 10);
  const selType = e?.type || "Expense";
  const selCat = e?.category || "Groceries";
  // Default to whoever is selected in the header, so a run of Surya's receipts
  // does not need the field touched on every entry.
  const people = listFor("person");
  const selPerson =
    e?.person || (people.includes(state.person) ? state.person : "");

  const curMonth = new Date().getMonth() + 1;
  const ctxActual = scoped()
    // Expense only - a transfer into this category is not spending against budget
    .filter(
      (r) =>
        r.type === "Expense" &&
        r.category === selCat &&
        monthOf(r) === curMonth &&
        Number(String(r.date).slice(0, 4)) === currentYear(),
    )
    .reduce((a, r) => a + r.amount, 0);
  const ctxBudget = Number(state.budget[selCat]?.[curMonth]) || 0;
  const ctxOver = ctxBudget > 0 && ctxActual > ctxBudget;
  const recent = scoped()
    .filter((r) => r.category === selCat)
    .slice(0, 5);
  const allSubs = [
    ...new Set(state.rows.map((r) => r.subcategory).filter(Boolean)),
  ];

  const opt = (list, sel, blank) =>
    (blank ? `<option value=""></option>` : "") +
    list
      .map((o) => `<option${o === sel ? " selected" : ""}>${esc(o)}</option>`)
      .join("");

  const dayName = (d) => {
    try {
      return new Date(d + "T12:00:00").toLocaleDateString("en-CA", {
        weekday: "long",
      });
    } catch {
      return "";
    }
  };

  view.innerHTML = `
  <div class="head">
    <div>
      <h1>${e ? "Edit entry" : "Add entry"}</h1>
      <p class="sub">${e ? `Editing #${e.id} \u2014 ${esc(e.category)} ${money(e.amount)}` : "Amount is always positive \u2014 Type carries the sign."}</p>
    </div>
    ${e ? `<div class="spacer"></div><button class="btn ghost" id="cancel">\u2190 Back</button>` : ""}
  </div>

  <div class="add-layout">
    <div class="add-main">

      <div class="add-type-row">
        ${TYPES.map((t) => `<button type="button" class="add-type-btn${t === selType ? " on" : ""}" data-type="${t}">${t}</button>`).join("")}
      </div>

      <form id="f" autocomplete="off">
        <input type="hidden" name="type" id="type-hidden" value="${selType}">
        <input type="hidden" name="person" id="person-hidden" value="${esc(selPerson)}">

        <div class="add-person-row" id="person-pills">
          <span class="add-label" style="margin-right:4px">Whose</span>
          ${personPillsHtml(people, selPerson)}
        </div>

        <div class="add-amount-wrap">
          <span class="add-currency">$</span>
          <input class="add-amount num" type="number" name="amount" step="0.01" min="0.01"
            value="${e?.amount ?? ""}" placeholder="0.00" inputmode="decimal"
            autocomplete="off" id="amount-input">
          <span class="add-currency-code">CAD</span>
        </div>
        <div class="err" id="err"></div>

        <div class="add-primary">
          <div class="add-field">
            <label for="f-date" class="add-label">Date</label>
            <input id="f-date" type="date" name="date" value="${esc(e?.date || today)}" required>
            <span class="add-field-hint muted" id="day-name">${dayName(e?.date || today)}</span>
          </div>
          <div class="add-field">
            <label for="f-cat" class="add-label">Category</label>
            ${selectWithNew("f-cat", "category", selCat)}
            <span class="add-field-hint ${ctxOver ? "over" : "muted"}" id="cat-hint">
              ${
                ctxBudget > 0
                  ? `${MONTHS[curMonth - 1]}: ${money(ctxActual)} of ${money(ctxBudget)}${ctxOver ? " \u2014 over" : ""}`
                  : ctxActual > 0
                    ? `${MONTHS[curMonth - 1]}: ${money(ctxActual)} spent`
                    : "no budget set"
              }
            </span>
          </div>
        </div>

        <div class="add-field add-field-full">
          <label for="f-desc" class="add-label">Description</label>
          <input id="f-desc" name="description" value="${esc(e?.description || "")}"
            placeholder="What was it?" list="subs-dl">
          <datalist id="subs-dl">
            ${[
              ...new Set(
                state.rows
                  .filter((r) => r.category === selCat)
                  .map((r) => r.description)
                  .filter(Boolean),
              ),
            ]
              .map((s) => `<option>${esc(s)}</option>`)
              .join("")}
          </datalist>
        </div>

        <details class="add-details" ${e && (e.subcategory || e.payment || e.account || e.notes) ? "open" : ""}>
          <summary class="add-details-toggle">More details <span class="muted">(subcategory, payment, account, notes)</span></summary>
          <div class="add-secondary">
            <div class="add-field">
              <label for="f-sub" class="add-label">Subcategory</label>
              ${selectWithNew("f-sub", "subcategory", e?.subcategory || "", { blank: true, forCategory: selCat })}
              <span class="add-field-hint muted" id="sub-hint">options for ${esc(selCat)}</span>
            </div>
            <div class="add-field">
              <label for="f-pay" class="add-label">Payment method</label>
              ${selectWithNew("f-pay", "payment", e?.payment || "", { blank: true })}
            </div>
            <div class="add-field">
              <label for="f-acc" class="add-label">Account</label>
              ${selectWithNew("f-acc", "account", e?.account || "", { blank: true })}
            </div>
            <div class="add-field">
              <label for="f-rec" class="add-label">Recurring?</label>
              <select id="f-rec" name="recurring">${opt(["No", "Yes"], e?.recurring || "No")}</select>
            </div>
            <div class="add-field add-field-wide">
              <label for="f-notes" class="add-label">Notes</label>
              <input id="f-notes" name="notes" value="${esc(e?.notes || "")}" placeholder="Anything else\u2026">
            </div>
          </div>
        </details>

        <div class="add-submit-row">
          <button class="btn add-submit" type="submit" id="sub-btn">${e ? "Save changes" : "Add entry"}</button>
          ${
            e
              ? `<button class="btn ghost" type="button" id="cancel2">Cancel</button>`
              : `<button class="btn ghost" type="reset">Clear</button>`
          }
          <span class="add-hint num muted" id="hint"></span>
        </div>
      </form>
    </div>

    <div class="add-context" id="ctx-panel">
      <div class="add-ctx-section">
        <div class="add-ctx-head" id="ctx-cat-name">${esc(selCat)}</div>
        <div class="add-ctx-stats" id="ctx-stats">
          ${
            ctxBudget > 0
              ? `
            <div class="add-ctx-bar-wrap">
              <div class="add-ctx-bar-track">
                <div class="add-ctx-bar-fill ${ctxOver ? "over" : ""}"
                  style="width:${Math.min((ctxActual / ctxBudget) * 100, 100).toFixed(1)}%"></div>
              </div>
            </div>
            <div class="add-ctx-row"><span class="muted">Spent ${MONTHS[curMonth - 1]}</span><span class="num ${ctxOver ? "over" : ""}">${money(ctxActual)}</span></div>
            <div class="add-ctx-row"><span class="muted">Budget</span><span class="num">${money(ctxBudget)}</span></div>
            <div class="add-ctx-row"><span class="muted">Remaining</span><span class="num ${ctxOver ? "over" : "tx-income"}">${money(ctxBudget - ctxActual)}</span></div>`
              : `<p class="muted" style="font-size:12px;margin:0">No budget set. <a href="#budget" id="go-budget" style="color:var(--ink)">Set one \u2192</a></p>`
          }
        </div>
      </div>
      ${
        recent.length
          ? `
      <div class="add-ctx-section">
        <div class="add-ctx-subhead">Recent in this category</div>
        ${recent
          .map(
            (r) => `
          <div class="add-recent-row">
            <div class="add-recent-body">
              <span class="add-recent-desc">${esc(r.description || r.subcategory || "\u2014")}</span>
              <span class="add-recent-date num muted">${esc(r.date)}</span>
            </div>
            <span class="add-recent-amt num">${money(r.amount)}</span>
          </div>`,
          )
          .join("")}
      </div>`
          : ""
      }
    </div>
  </div>`;

  // selectWithNew() builds plain selects; FormData needs name attributes.
  [
    ["f-cat", "category"],
    ["f-sub", "subcategory"],
    ["f-pay", "payment"],
    ["f-acc", "account"],
  ].forEach(([id, name]) => {
    const el = $("#" + id);
    if (el) el.name = name;
  });

  wireNewOption("f-sub", "subcategory");
  wireNewOption("f-pay", "payment");
  wireNewOption("f-acc", "account");
  wirePersonPills();

  view.querySelectorAll(".add-type-btn").forEach((btn) => {
    btn.onclick = () => {
      view
        .querySelectorAll(".add-type-btn")
        .forEach((b) => b.classList.remove("on"));
      btn.classList.add("on");
      $("#type-hidden").value = btn.dataset.type;
    };
  });

  /* Re-renders the "Whose" pill row (used after adding a new person via the
     "+ New" pill, since that changes how many options exist). */
  function renderPersonPills(selected) {
    const wrap = $("#person-pills");
    if (!wrap) return;
    wrap.innerHTML =
      `<span class="add-label" style="margin-right:4px">Whose</span>` +
      personPillsHtml(listFor("person"), selected);
    wirePersonPills();
  }

  function wirePersonPills() {
    view.querySelectorAll(".add-person-btn[data-person]").forEach((btn) => {
      btn.onclick = () => {
        view
          .querySelectorAll(".add-person-btn[data-person]")
          .forEach((b) => b.classList.remove("on"));
        btn.classList.add("on");
        $("#person-hidden").value = btn.dataset.person;
      };
    });
    const newBtn = $("#person-new-btn");
    if (!newBtn) return;
    newBtn.onclick = () => {
      const wrap = document.createElement("span");
      wrap.className = "newopt";
      wrap.innerHTML = `<input class="newopt-input" placeholder="New person…" autocomplete="off">
        <button type="button" class="newopt-ok">Add</button>
        <button type="button" class="newopt-cancel">✕</button>`;
      newBtn.style.display = "none";
      newBtn.after(wrap);
      const input = wrap.querySelector(".newopt-input");
      input.focus();
      const close = (value) => {
        wrap.remove();
        newBtn.style.display = "";
        if (value) {
          addCustom("person", value);
          $("#person-hidden").value = value;
          renderPersonPills(value);
        }
      };
      wrap.querySelector(".newopt-ok").onclick = () =>
        close(input.value.trim());
      wrap.querySelector(".newopt-cancel").onclick = () => close(null);
      input.onkeydown = (ev) => {
        if (ev.key === "Enter") {
          ev.preventDefault();
          close(input.value.trim());
        }
        if (ev.key === "Escape") {
          ev.preventDefault();
          close(null);
        }
      };
    };
  }

  $("#f-date").oninput = (ev) => {
    $("#day-name").textContent = dayName(ev.target.value);
  };

  wireNewOption("f-cat", "category", () => refreshSubOptions());

  /* Subcategories are scoped to the chosen category, so switching category has
     to rebuild that list. Keeps the current value if it still applies. */
  function refreshSubOptions() {
    const cat = $("#f-cat").value;
    const sub = $("#f-sub");
    if (!sub || cat === "__new__") return;
    const keep = sub.value;
    const opts = listFor("subcategory", cat);
    sub.innerHTML =
      '<option value=""></option>' +
      opts
        .map(
          (o) => `<option${o === keep ? " selected" : ""}>${esc(o)}</option>`,
        )
        .join("") +
      (keep && !opts.includes(keep)
        ? `<option selected>${esc(keep)}</option>`
        : "") +
      '<option value="__new__">+ New\u2026</option>';
    sub.name = "subcategory";
    sub.dataset.prev = sub.value;
    wireNewOption("f-sub", "subcategory");
    const hint = $("#sub-hint");
    if (hint)
      hint.textContent = opts.length
        ? `${opts.length} option${opts.length > 1 ? "s" : ""} for ${cat}`
        : `no subcategories yet for ${cat}`;
  }

  $("#f-cat").addEventListener("change", () => {
    const cat = $("#f-cat").value;
    if (cat === "__new__") return;
    const act = scoped()
      .filter(
        (r) =>
          r.type === "Expense" &&
          r.category === cat &&
          monthOf(r) === curMonth &&
          Number(String(r.date).slice(0, 4)) === currentYear(),
      )
      .reduce((a, r) => a + r.amount, 0);
    const bud = Number(state.budget[cat]?.[curMonth]) || 0;
    const over = bud > 0 && act > bud;
    const hint = $("#cat-hint");
    if (hint) {
      hint.textContent =
        bud > 0
          ? `${MONTHS[curMonth - 1]}: ${money(act)} of ${money(bud)}${over ? " — over" : ""}`
          : act > 0
            ? `${MONTHS[curMonth - 1]}: ${money(act)} spent`
            : "no budget set";
      hint.className = `add-field-hint ${over ? "over" : "muted"}`;
    }
    refreshSubOptions();
    const head = $("#ctx-cat-name");
    if (head) head.textContent = cat;
    const stats = $("#ctx-stats");
    if (stats) {
      if (bud > 0) {
        stats.innerHTML = `<div class="add-ctx-bar-wrap"><div class="add-ctx-bar-track"><div class="add-ctx-bar-fill ${over ? "over" : ""}" style="width:${Math.min((act / bud) * 100, 100).toFixed(1)}%"></div></div></div>
          <div class="add-ctx-row"><span class="muted">Spent ${MONTHS[curMonth - 1]}</span><span class="num ${over ? "over" : ""}">${money(act)}</span></div>
          <div class="add-ctx-row"><span class="muted">Budget</span><span class="num">${money(bud)}</span></div>
          <div class="add-ctx-row"><span class="muted">Remaining</span><span class="num ${over ? "over" : "tx-income"}">${money(bud - act)}</span></div>`;
      } else {
        stats.innerHTML = `<p class="muted" style="font-size:12px;margin:0">No budget set. <a href="#budget" id="go-budget" style="color:var(--ink)">Set one \u2192</a></p>`;
        $("#go-budget")?.addEventListener("click", (ev) => {
          ev.preventDefault();
          go("budget");
        });
      }
    }
  });

  refreshSubOptions();

  $("#cancel")?.addEventListener("click", () => {
    state.editing = null;
    go("transactions");
  });
  $("#cancel2")?.addEventListener("click", () => {
    state.editing = null;
    go("transactions");
  });
  $("#go-budget")?.addEventListener("click", (ev) => {
    ev.preventDefault();
    go("budget");
  });

  setTimeout(() => {
    $("#amount-input")?.focus();
  }, 50);

  $("#f").onsubmit = async (ev) => {
    ev.preventDefault();
    const d = Object.fromEntries(new FormData(ev.target));
    const amount = Number(d.amount);
    const errEl = $("#err");
    errEl.textContent = "";

    if (!d.date) {
      errEl.textContent = "Pick a date.";
      return;
    }
    if (!(amount > 0)) {
      errEl.textContent = "Amount must be greater than zero.";
      $("#amount-input").focus();
      return;
    }

    // Every year works correctly now - this is purely an FYI, not a warning,
    // for the one case where it might be surprising: adding a date that
    // falls under a DIFFERENT year than whatever the Dashboard currently has
    // selected means it will not show up on THIS screen without switching
    // the year selector - which was never a bug, that is what "per year"
    // scoping means, but worth a nudge rather than a silent surprise.
    const entryYear = Number(d.date.slice(0, 4));
    const yearNote =
      entryYear !== state.year
        ? ` Switch the year selector to ${entryYear} to see it on the Dashboard.`
        : "";

    const btn = $("#sub-btn");
    btn.disabled = true;

    if (state.editing) {
      const done = await withBusy("Updating", async () => {
        await state.store.update(state.editing.id, { ...d, amount });
        state.editing = null;
        await refresh();
      });
      btn.disabled = false;
      if (done) {
        notice("Entry updated." + yearNote, "ok");
        go("transactions");
      }
    } else {
      const done = await withBusy("Saving", async () => {
        await state.store.add({ ...d, amount });
        await refresh();
      });
      btn.disabled = false;
      if (done) {
        notice(`${money(amount)} saved.` + yearNote, "ok");
        $("#hint").textContent = `${state.rows.length} total`;
        ev.target.reset();
        $("#type-hidden").value = d.type;
        $("#person-hidden").value = d.person;
        view
          .querySelectorAll(".add-type-btn")
          .forEach((b) => b.classList.toggle("on", b.dataset.type === d.type));
        view
          .querySelectorAll(".add-person-btn[data-person]")
          .forEach((b) =>
            b.classList.toggle("on", b.dataset.person === d.person),
          );
        $("#f-date").value = d.date;
        $("#f-cat").value = d.category;
        setTimeout(() => {
          $("#amount-input").focus();
        }, 50);
      }
    }
  };
}

/* ============================================================== TRANSACTIONS */
// Persists across re-renders (filtering, editing, deleting) so collapsing a
// month doesn't spring back open every time the list redraws.
