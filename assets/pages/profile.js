/* Profile page: who you're signed in as, and (Supabase only) who else has
   household access. Reached via the profile popover's "View profile" item
   in core.js's renderProfileMenu(), not a .tabs nav button - so it has no
   data-tab entry and go("profile") never highlights anything in the nav. */
import { getIdTokenEmail } from "../store.js";
import { $, view, esc, state, notice, withBusy } from "../core.js";
import { backendLabel, isRemoteStore, signOut } from "../auth.js";

export function renderProfile() {
  const email = getIdTokenEmail();
  const remote = isRemoteStore(state.store);

  view.innerHTML = `
  <div class="head">
    <div><h1>Profile</h1>
      <p class="sub">${email ? esc(email) : "Not signed in"}</p></div>
    <div class="spacer"></div>
    <button class="btn ghost" id="profile-page-signout">Sign out</button>
  </div>

  <div class="eyebrow">Your account</div>
  <div class="tablewrap"><table><tbody>
    <tr><td>Email</td><td>${email ? esc(email) : "—"}</td></tr>
    <tr><td>Signed in with</td><td>Google</td></tr>
    <tr><td>Data storage</td><td>${esc(backendLabel(state.store))}</td></tr>
  </tbody></table></div>

  <div class="eyebrow">Household access</div>
  ${
    remote
      ? `<div class="panel" id="access-panel">Loading…</div>`
      : `<div class="nw-warn">Household access is managed in Supabase and isn't available while running on
         ${state.store.kind === "memory" ? "session-only" : "browser-only"} storage. Connect under
         <b>Data → Supabase</b> to manage who can sign in.</div>`
  }`;

  $("#profile-page-signout").onclick = signOut;
  if (remote) loadAccessPanel(email);
}

async function loadAccessPanel(myEmail) {
  const panel = $("#access-panel");
  try {
    const emails = await state.store.listAllowedEmails();
    panel.innerHTML = `
      <table><tbody>
        ${emails
          .map(
            (e) => `<tr>
              <td>${esc(e)}${e === myEmail ? ' <span class="tag">you</span>' : ""}</td>
              <td class="n"><button class="rowbtn" data-remove-email="${esc(e)}"
                ${emails.length <= 1 ? `disabled title="Can't remove the last remaining email"` : ""}>✕</button></td>
            </tr>`,
          )
          .join("")}
      </tbody></table>
      <div class="actions" style="margin-top:12px">
        <input id="new-access-email" type="email" placeholder="name@example.com" style="flex:1;min-width:200px">
        <button class="btn" id="add-access-email" type="button">Add</button>
      </div>
      <p class="note" style="margin-top:10px">Anyone added here can sign in with that Google account and see
        every transaction, budget and balance in this household — there's no per-person restriction beyond that.</p>`;

    panel.querySelectorAll("[data-remove-email]").forEach(
      (b) =>
        (b.onclick = async () => {
          const target = b.dataset.removeEmail;
          if (
            !confirm(
              `Remove ${target}? They will no longer be able to sign in.`,
            )
          )
            return;
          const done = await withBusy(`Removing ${target}`, async () => {
            await state.store.removeAllowedEmail(target);
          });
          if (done) {
            notice(`Removed ${target}.`, "ok");
            loadAccessPanel(myEmail);
          }
        }),
    );
    $("#add-access-email").onclick = async () => {
      const input = $("#new-access-email");
      const value = input.value.trim().toLowerCase();
      if (!value || !/^\S+@\S+\.\S+$/.test(value))
        return notice("Enter a valid email address.", "bad");
      const done = await withBusy(`Adding ${value}`, async () => {
        await state.store.addAllowedEmail(value);
      });
      if (done) {
        notice(`Added ${value}.`, "ok");
        loadAccessPanel(myEmail);
      }
    };
    $("#new-access-email").addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        $("#add-access-email").click();
      }
    });
  } catch (err) {
    panel.innerHTML = `<b class="over">${esc(err.message)}</b>`;
  }
}
