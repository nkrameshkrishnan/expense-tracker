/* Custom category/payment/account/subcategory options - the "+ New..."
   escape hatch on every dropdown that isn't a fixed list. Used by Add,
   Transactions, Budget, and Net worth. */
import { CAT_NAMES, PAYMENTS, ACCOUNTS, CUSTOM_KEY } from "./store.js";
import { $, esc, state } from "./core.js";

export function loadCustom() {
  try {
    return JSON.parse(localStorage.getItem(CUSTOM_KEY)) || {};
  } catch {
    return {};
  }
}
export function addCustom(kind, value) {
  const v = String(value || "").trim();
  if (!v) return "";
  const c = loadCustom();
  c[kind] = [...new Set([...(c[kind] || []), v])];
  localStorage.setItem(CUSTOM_KEY, JSON.stringify(c));
  return v;
}
export function removeCustom(kind, value) {
  const c = loadCustom();
  c[kind] = (c[kind] || []).filter((x) => x !== value);
  localStorage.setItem(CUSTOM_KEY, JSON.stringify(c));
}
const BUILTIN = {
  category: CAT_NAMES,
  payment: PAYMENTS,
  account: ACCOUNTS,
  subcategory: [],
  // No built-ins: a tenant's household/team member names cannot be known
  // in advance (this app is multi-tenant), so this list starts empty and
  // grows purely from listFor()'s other two sources - values already in
  // your data, and anything added via "+ New".
  person: [],
};

/** Merged, de-duplicated, sorted option list for a dropdown. */
export function listFor(kind, forCategory) {
  const custom = loadCustom()[kind] || [];
  let fromData;
  if (kind === "subcategory") {
    // Subcategories are scoped to their category - "Hydro" belongs under
    // Rent / Housing, not under Groceries.
    const pool = forCategory
      ? state.rows.filter((r) => r.category === forCategory)
      : state.rows;
    fromData = pool.map((r) => r.subcategory);
  } else {
    fromData = state.rows.map((r) => r[kind]);
  }
  return [
    ...new Set([
      ...(BUILTIN[kind] || []),
      ...fromData.filter(Boolean),
      ...custom,
    ]),
  ]
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
}

/** <select> with every known option plus a "+ New" escape hatch. */
export function selectWithNew(
  id,
  kind,
  selected,
  { blank = false, forCategory = null } = {},
) {
  const opts = listFor(kind, forCategory);
  return `<select id="${id}" data-kind="${esc(kind)}">
    ${blank ? '<option value=""></option>' : ""}
    ${opts.map((o) => `<option${o === selected ? " selected" : ""}>${esc(o)}</option>`).join("")}
    ${selected && !opts.includes(selected) ? `<option selected>${esc(selected)}</option>` : ""}
    <option value="__new__">+ New…</option>
  </select>`;
}

/** Turns "+ New" into an inline text field rather than a browser prompt. */
export function wireNewOption(selectId, kind, onAdded) {
  const sel = $("#" + selectId);
  if (!sel) return;
  sel.dataset.prev = sel.value;
  sel.onchange = () => {
    if (sel.value !== "__new__") {
      sel.dataset.prev = sel.value;
      onAdded?.(sel.value);
      return;
    }
    const prev = sel.dataset.prev || "";
    const wrap = document.createElement("span");
    wrap.className = "newopt";
    wrap.innerHTML = `<input class="newopt-input" placeholder="New ${esc(kind)}…" autocomplete="off">
      <button type="button" class="newopt-ok">Add</button>
      <button type="button" class="newopt-cancel">✕</button>`;
    sel.style.display = "none";
    sel.after(wrap);
    const input = wrap.querySelector(".newopt-input");
    input.focus();
    const close = (value) => {
      wrap.remove();
      sel.style.display = "";
      if (value) {
        addCustom(kind, value);
        const o = document.createElement("option");
        o.textContent = value;
        sel.insertBefore(o, sel.querySelector('option[value="__new__"]'));
        sel.value = value;
      } else {
        sel.value = prev;
      }
      sel.dataset.prev = sel.value;
      onAdded?.(sel.value);
    };
    wrap.querySelector(".newopt-ok").onclick = () => close(input.value.trim());
    wrap.querySelector(".newopt-cancel").onclick = () => close(null);
    input.onkeydown = (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        close(input.value.trim());
      }
      if (e.key === "Escape") {
        e.preventDefault();
        close(null);
      }
    };
  };
}
