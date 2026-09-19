import { CURRENCIES, getIdToken } from "../store.js";
import { $, view, esc, state, withBusy, refresh } from "../core.js";
import { signOut } from "../auth.js";

/** The signed-in individual's own account: identity, role, and sign-out.
    Distinct from Data's Household panel (which manages OTHER members and
    invites) and from Billing (tenant-wide money) - this is the one page
    that's about you specifically, not the household. Only shows real
    fields the backend actually returns (email, role) - no display name or
    avatar exists anywhere in this app's auth (see auth.js/handler.js). */
export function renderProfile() {
  const signedIn = !!getIdToken();
  const email = state.userEmail || state.store.user?.email || "";
  const myRole = state.role || "member";
  const roleInfo =
    {
      owner:
        "Full access — can manage billing, invite or remove members, and use every feature.",
      admin: "Can invite members. Billing stays with the owner.",
      member:
        "Can add and edit transactions, budget and net worth. Inviting and billing stay with the owner or admins.",
    }[myRole] || "";
  const members = state.members || [];
  const tenants = state.tenants || [];

  view.innerHTML = `
  <div class="head"><div><h1>Profile</h1><p class="sub">Your account in this ledger.</p></div></div>

  <div class="eyebrow">Account</div>
  <div class="panel stack">
    ${
      signedIn
        ? `
    <p class="note" style="margin:0">Signed in as <b>${esc(email || "unknown")}</b>.</p>
    <p class="note" style="margin:0">Your role: <b>${esc(myRole)}</b>. ${esc(roleInfo)}</p>
    <p class="note" style="margin:0">Sign-in is Google-only — there's no separate Ledger password to set or reset.</p>`
        : `<p class="note" style="margin:0">Not signed in to a Ledger account.</p>`
    }
  </div>

  ${
    signedIn
      ? `
  <div class="eyebrow">Currency</div>
  <div class="panel stack">
    <label>Display currency
      <select id="profile-currency">
        ${CURRENCIES.map(
          (c) =>
            `<option value="${esc(c)}"${c === (state.tenant?.currency || "CAD") ? " selected" : ""}>${esc(c)}</option>`,
        ).join("")}
      </select>
    </label>
    <p class="note" style="margin:0">Changes how amounts are formatted everywhere in this household's ledger. Every amount already entered keeps its original number — only the currency label changes, nothing is converted.</p>
  </div>`
      : ""
  }

  ${
    signedIn
      ? `
  <div class="eyebrow">Household</div>
  <div class="panel stack">
    <p class="note" style="margin:0">${members.length} member${members.length === 1 ? "" : "s"} in this household.${tenants.length > 1 ? ` You belong to ${tenants.length} households.` : ""}</p>
    <p class="note" style="margin:0">Manage members, invites${tenants.length > 1 ? " and switch households" : ""} from Data &rarr; Household.</p>
  </div>

  <div class="eyebrow">Session</div>
  <div class="panel"><div class="actions">
    <button class="btn ghost" id="profile-signout">Sign out</button>
  </div></div>`
      : ""
  }`;

  $("#profile-currency")?.addEventListener("change", async (e) => {
    const currency = e.target.value;
    await withBusy(`Switching to ${currency}`, async () => {
      await state.store.setCurrency(currency);
      await refresh();
    });
    renderProfile();
  });
  $("#profile-signout")?.addEventListener("click", signOut);
}
