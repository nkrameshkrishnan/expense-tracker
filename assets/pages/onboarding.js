/* First-run "customize your app" step: shown once per account (Supabase) or
   once per browser (local/memory storage - see hasOnboarded()/markOnboarded()
   in prefs.js) right after a successful sign-in, before the real app ever
   appears. Two short steps - primary currency, then appearance - rather than
   one combined form, so each choice gets its own explanation and the whole
   thing reads as "a couple of quick questions" rather than a settings form.
   Renders into the same #gate element showGate() uses (auth.js never reveals
   the app header/nav until this calls back via onFinish), reusing its
   .gate-card/.gate-mark/.gate-title styling so it looks like a continuation
   of sign-in, not a different product. */
import { CURRENCIES } from "../store.js";
import {
  CURRENCY_LABEL,
  CURRENCY_SYMBOL,
  CURRENCY_FLAG,
  getTheme,
  setTheme,
} from "../prefs.js";
import { themeIcon } from "../icons.js";

/** Same reasoning as profile.js's currencySymbolHtml(): a flag for "which
    country", plus the currency's own symbol underneath when it's an actual
    glyph rather than just the code again (AED has none - CURRENCY_SYMBOL.AED
    is literally "AED ", which would just repeat the row's own bold title). */
function currencySymbolHtml(code) {
  const flag = CURRENCY_FLAG[code] || "";
  const sym = (CURRENCY_SYMBOL[code] || "").trim();
  const showSym = sym && sym !== code;
  return `<span class="ob-flag">${flag}</span>${showSym ? `<span class="ob-currency-sym">${sym}</span>` : ""}`;
}

const THEME_OPTIONS = [
  ["system", "System", "Match this device's setting"],
  ["light", "Light", ""],
  ["dark", "Dark", ""],
];

/** `onFinish(homeCurrency, theme)` is called once, after the second step's
    "Finish" button - auth.js supplies it, and is the only thing that knows
    how to persist the choice (Supabase vs. local) and continue booting. */
export function renderOnboarding({ onFinish }) {
  const gate = document.getElementById("gate");
  gate.classList.remove("gate-landing");
  gate.hidden = false;

  let currency = "CAD";
  let theme = getTheme();

  function stepShell(stepLabel, heading, sub, body, actionsHtml) {
    gate.innerHTML = `
      <div class="gate-card ob-card">
        <div class="gate-mark">&#8214;</div>
        <h1 class="gate-title">Ledger</h1>
        <p class="ob-step-label">${stepLabel}</p>
        <h2 class="ob-heading">${heading}</h2>
        <p class="gate-sub">${sub}</p>
        ${body}
        ${actionsHtml}
      </div>`;
  }

  function renderStep1() {
    const body = `
      <div class="ob-options" role="radiogroup" aria-label="Primary currency">
        ${CURRENCIES.map(
          (c) => `
          <button type="button" class="ob-option${c === currency ? " selected" : ""}"
            role="radio" aria-checked="${c === currency}" data-currency="${c}">
            <span class="ob-option-symbol">${currencySymbolHtml(c)}</span>
            <span class="ob-option-text"><b>${c}</b><br><span class="muted">${CURRENCY_LABEL[c] || ""}</span></span>
          </button>`,
        ).join("")}
      </div>`;
    const actions = `<button type="button" class="btn" id="ob-next" style="width:100%;margin-top:16px">Continue</button>`;
    stepShell(
      "Step 1 of 2",
      "Choose your primary currency",
      "Dashboard, budget and net worth totals will be shown in this currency — you can change it anytime from Profile.",
      body,
      actions,
    );
    gate.querySelectorAll("[data-currency]").forEach((btn) => {
      btn.onclick = () => {
        currency = btn.dataset.currency;
        renderStep1();
      };
    });
    document.getElementById("ob-next").onclick = renderStep2;
  }

  function renderStep2() {
    const body = `
      <div class="ob-options" role="radiogroup" aria-label="Appearance">
        ${THEME_OPTIONS.map(
          ([value, label, hint]) => `
          <button type="button" class="ob-option${value === theme ? " selected" : ""}"
            role="radio" aria-checked="${value === theme}" data-theme-choice="${value}">
            <span class="ob-option-symbol">${themeIcon(value)}</span>
            <span class="ob-option-text"><b>${label}</b>${hint ? `<br><span class="muted">${hint}</span>` : ""}</span>
          </button>`,
        ).join("")}
      </div>`;
    const actions = `
      <div class="ob-actions">
        <button type="button" class="btn ghost" id="ob-back">Back</button>
        <button type="button" class="btn" id="ob-finish">Finish</button>
      </div>`;
    stepShell(
      "Step 2 of 2",
      "Choose your appearance",
      "Pick a theme, or follow this device's setting — you can change this anytime from Profile.",
      body,
      actions,
    );
    gate.querySelectorAll("[data-theme-choice]").forEach((btn) => {
      btn.onclick = () => {
        theme = btn.dataset.themeChoice;
        setTheme(theme); // live preview - see it change immediately, not just on Finish
        renderStep2();
      };
    });
    document.getElementById("ob-back").onclick = renderStep1;
    document.getElementById("ob-finish").onclick = () =>
      onFinish(currency, theme);
  }

  renderStep1();
}
