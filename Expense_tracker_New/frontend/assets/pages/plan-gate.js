import { $, state, esc } from "../core.js";
import {
  ensurePlans,
  markPlanGateSeen,
  planCopy,
  formatPlanAmount,
  formatPlanPeriod,
  planSeatsLabel,
  planFeatureList,
} from "../tenant.js";

/** Full-viewport plan picker, shown once between sign-in and the real app
    for a brand-new household's owner - same overlay mechanics as
    showGate() (boot-loading hidden, header stays hidden until a choice is
    made, so there is no flash of an unstyled/unpaid Dashboard first).
    onFree runs when "Continue with Free" is chosen; choosing a paid tier
    redirects straight to Stripe Checkout and never returns here - a
    successful or cancelled checkout both land back on the Billing tab, same
    as every other "Choose <plan>" button in this app (see renderBilling). */
export function renderPlanGate(onFree) {
  const bootOverlay = $("#boot-loading");
  if (bootOverlay) bootOverlay.hidden = true;
  const gate = $("#plan-gate");
  gate.hidden = false;
  const plans = state.plans || [];
  gate.innerHTML = `
    <div class="plan-gate-card">
      <div class="plan-gate-mark">&#8214;</div>
      <div class="eyebrow">Choose your plan</div>
      <h1 class="plan-gate-title">How many people will use this ledger?</h1>
      <p class="plan-gate-sub">Pick a starting plan for this household. Nothing here is permanent — change or cancel it anytime from the Billing tab.</p>
      <div class="plan-grid">
        ${
          !state.plans
            ? `<p class="plan-gate-note">Loading plans…</p>`
            : plans.length === 0
              ? `<p class="plan-gate-note">Plans are temporarily unavailable. Try reconnecting from the banner above, then reload.</p>`
              : plans
                  .map((p) => {
                    const copy = planCopy(p.id);
                    return `
        <div class="plan-card${copy.recommended ? " recommended" : ""}">
          ${copy.recommended ? '<div class="plan-badge">Most households</div>' : ""}
          <div class="plan-name">${esc(copy.label)}</div>
          <div class="plan-price"><span class="plan-amount">${esc(formatPlanAmount(p))}</span><span class="plan-period">${esc(formatPlanPeriod(p))}</span></div>
          <div class="plan-seats">${esc(planSeatsLabel(p.seatCap))}</div>
          <p class="plan-blurb">${esc(copy.blurb)}</p>
          <ul class="plan-features">
            ${planFeatureList(p.features)
              .map((f) => `<li>${esc(f)}</li>`)
              .join("")}
          </ul>
          <button class="btn ${p.id === "free" ? "ghost" : ""} plan-cta" data-plan-id="${esc(p.id)}" data-price-id="${esc(p.priceId || "")}">
            ${p.id === "free" ? "Continue with Free" : `Choose ${esc(copy.label)}`}
          </button>
        </div>`;
                  })
                  .join("")
        }
      </div>
      <p class="plan-gate-error" id="plan-gate-error" hidden></p>
      <p class="plan-gate-note">Only the owner sets this. Anyone you invite later joins under whichever plan is active when they accept.</p>
    </div>`;

  // notice()'s #banner sits in normal document flow, behind this overlay's
  // z-index - a checkout failure reported through it would be invisible
  // while the gate is up, so errors are shown inline in the card instead.
  const errEl = $("#plan-gate-error");
  gate.querySelectorAll(".plan-cta").forEach((btn) => {
    btn.addEventListener("click", async () => {
      errEl.hidden = true;
      if (btn.dataset.planId === "free") {
        markPlanGateSeen();
        gate.hidden = true;
        onFree();
        return;
      }
      btn.disabled = true;
      try {
        const base = location.origin + location.pathname;
        const { url } = await state.store.createCheckoutSession(
          btn.dataset.priceId,
          `${base}#billing`,
          `${base}#billing`,
        );
        markPlanGateSeen();
        location.href = url;
      } catch (e) {
        btn.disabled = false;
        errEl.textContent = `Could not start checkout: ${e.message}`;
        errEl.hidden = false;
      }
    });
  });

  // First render shows "Loading plans…" above; once the fetch resolves,
  // silently re-render with the real list - but only if this gate is
  // still the thing on screen (the owner may have already picked a plan
  // and moved on by the time it resolves).
  ensurePlans(() => {
    if (!gate.hidden) renderPlanGate(onFree);
  });
}
