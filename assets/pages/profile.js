/* Profile page: who you're signed in as, and (Supabase only) who else has
   household access. Reached via the profile popover's "View profile" item
   in core.js's renderProfileMenu(), not a .tabs nav button - so it has no
   data-tab entry and go("profile") never highlights anything in the nav. */
import {
  getIdTokenEmail,
  getIdTokenClaims,
  CURRENCIES,
  getHomeCurrency,
  setHomeCurrency,
  getTheme,
  setTheme,
  setDisplayRate,
} from "../store.js";
import { CURRENCY_LABEL, CURRENCY_SYMBOL, CURRENCY_FLAG } from "../prefs.js";
import { $, view, esc, state, notice, withBusy, updateBrandCurrency } from "../core.js";
import { isRemoteStore, signOut } from "../auth.js";
import { themeIcon } from "../icons.js";

const THEME_OPTIONS = [
  ["system", "System", "Match this device's setting"],
  ["light", "Light", ""],
  ["dark", "Dark", ""],
];

// Always renders the `.ob-option-symbol` slot, even when a row has no visual
// of its own, so a list with none (there's no such row any more, but keeps
// this robust) still reserves the same width as one that does - without
// this, option labels in a visual-less list started flush against the card
// edge while ones with a flag/icon started ~52px in, and two side-by-side
// panels would read as misaligned even though they're meant to look like a
// matched pair. `symbolHtml` is pre-rendered markup (a flag emoji + small
// currency symbol, or an inline SVG icon) rather than a single character,
// since both callers below now need more than one glyph in that slot.
function optionsHtml(items, selected, dataAttr) {
  return `<div class="ob-options" role="radiogroup">
    ${items
      .map(
        ({ value, label, hint, symbolHtml = "" }) => `
      <button type="button" class="ob-option${value === selected ? " selected" : ""}"
        role="radio" aria-checked="${value === selected}" data-${dataAttr}="${value}">
        <span class="ob-option-symbol">${symbolHtml}</span>
        <span class="ob-option-text"><b>${label}</b>${hint ? `<br><span class="muted">${hint}</span>` : ""}</span>
      </button>`,
      )
      .join("")}
  </div>`;
}

/** The currency option's icon: a country flag (the recognizable "which
    country" cue) with the currency's own symbol underneath, when that
    symbol is an actual glyph ($, ₹) rather than just the currency code
    again - AED has no distinct symbol (CURRENCY_SYMBOL.AED is literally
    "AED "), and showing "AED" twice in the same row (once as the flag's
    caption, once as the row's own bold title) would be redundant rather
    than informative. */
function currencySymbolHtml(code) {
  const flag = CURRENCY_FLAG[code] || "";
  const sym = (CURRENCY_SYMBOL[code] || "").trim();
  const showSym = sym && sym !== code;
  return `<span class="ob-flag">${flag}</span>${showSym ? `<span class="ob-currency-sym">${esc(sym)}</span>` : ""}`;
}

// Two side-by-side panels (the same .grid2/.panel/.stack primitives every
// other settings-style panel on the site already uses - see dashboard.js's
// chart panels) rather than one tall merged box: each preference gets its
// own framed card with a real heading, so "pick a currency" and "pick a
// theme" read as two distinct choices instead of one long scrolling list
// with plain-text sub-labels standing in for headings.
function renderPreferencesPanel() {
  const currencyItems = CURRENCIES.map((c) => ({
    value: c,
    label: c,
    hint: CURRENCY_LABEL[c] || "",
    symbolHtml: currencySymbolHtml(c),
  }));
  const themeItems = THEME_OPTIONS.map(([value, label, hint]) => ({
    value,
    label,
    hint,
    symbolHtml: themeIcon(value),
  }));
  return `
  <div class="eyebrow">Preferences</div>
  <div class="grid2">
    <div class="panel">
      <div class="stack">
        <div>
          <h3>Primary currency</h3>
          <p class="note">Dashboard, budget and net worth totals are shown in this currency.</p>
        </div>
        ${optionsHtml(currencyItems, getHomeCurrency(), "currency")}
      </div>
    </div>
    <div class="panel">
      <div class="stack">
        <div>
          <h3>Appearance</h3>
          <p class="note">Pick a theme, or follow this device's setting.</p>
        </div>
        ${optionsHtml(themeItems, getTheme(), "theme-choice")}
      </div>
    </div>
  </div>`;
}

async function loadDisplayRateIfNeeded(code) {
  if (code === "CAD") return;
  try {
    const today = new Date().toISOString().slice(0, 10);
    const rate = await state.store.getExchangeRate?.(today, code);
    if (rate?.rateToCad) setDisplayRate(code, rate.rateToCad);
  } catch {
    // Same graceful fallback as auth.js's own lookup - money() just keeps
    // showing CAD when no rate is available.
  }
}

async function savePreferences(homeCurrency, theme) {
  const email = getIdTokenEmail();
  setHomeCurrency(homeCurrency);
  setTheme(theme);
  await loadDisplayRateIfNeeded(homeCurrency);
  updateBrandCurrency();
  if (isRemoteStore(state.store) && email) {
    const done = await withBusy("Saving preferences", async () => {
      await state.store.saveUserSettings(email, { homeCurrency, theme });
    });
    if (!done) return;
  }
  notice("Preferences saved.", "ok");
  renderProfile(); // re-render so the selected option/theme reflect immediately
}

function wirePreferences() {
  $("#view")
    .querySelectorAll("[data-currency]")
    .forEach((btn) => {
      btn.onclick = () => savePreferences(btn.dataset.currency, getTheme());
    });
  $("#view")
    .querySelectorAll("[data-theme-choice]")
    .forEach((btn) => {
      btn.onclick = () =>
        savePreferences(getHomeCurrency(), btn.dataset.themeChoice);
    });
}

// Best-effort only: Google's locale claim is a language/region preference
// the account has set, not a verified country - shown as a courtesy, not a
// fact to build any logic on.
function countryFromLocale(locale) {
  const region = locale?.split(/[-_]/)[1];
  if (!region) return "";
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(
      region.toUpperCase(),
    );
  } catch {
    return region.toUpperCase();
  }
}

// list/add/removeAllowedEmail surface raw Postgres/PostgREST error text
// (e.g. "Could not find the function public.list_allowed_emails ... in the
// schema cache" when supabase/schema.sql's RPCs haven't been applied yet) -
// not something a household member should have to interpret. Every call
// into them goes through this so what reaches the screen is always
// something a person can actually act on.
async function accessCall(fn) {
  try {
    return await fn();
  } catch {
    throw new Error(
      "Couldn't load household access right now — the Supabase project may be missing its latest database setup.",
    );
  }
}

export function renderProfile() {
  const email = getIdTokenEmail();
  const claims = getIdTokenClaims();
  const country = countryFromLocale(claims.locale);
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
    <tr><td>First name</td><td>${claims.given_name ? esc(claims.given_name) : "—"}</td></tr>
    <tr><td>Last name</td><td>${claims.family_name ? esc(claims.family_name) : "—"}</td></tr>
    <tr><td>Country</td><td>${country ? esc(country) : "Not shared by Google Sign-In"}</td></tr>
    <tr><td>Signed in with</td><td>Google</td></tr>
  </tbody></table></div>
  <p class="note">See <a href="terms.html" target="_blank" rel="noopener">Terms &amp; Privacy</a>
    for what Google profile information this app collects and why.</p>

  ${renderPreferencesPanel()}

  <div class="eyebrow">Household access</div>
  ${
    remote
      ? `<div class="panel" id="access-panel">Loading…</div>`
      : `<div class="nw-warn">Household access is managed in Supabase and isn't available while running on
         ${state.store.kind === "memory" ? "session-only" : "browser-only"} storage. Connect under
         <b>Data → Supabase</b> to manage who can sign in.</div>`
  }`;

  $("#profile-page-signout").onclick = signOut;
  wirePreferences();
  if (remote) loadAccessPanel(email);
}

// `rows` is [{email, is_primary}] since list_allowed_emails() started
// returning that shape (see schema.sql) - only the primary household member
// can add or remove anyone, and the primary's own row can never be
// removed, by anyone, including itself. The server (add_allowed_email/
// remove_allowed_email) is what actually enforces this; hiding/disabling
// the controls here is just so a non-primary member sees why, instead of
// clicking something that's just going to come back as an error.
async function loadAccessPanel(myEmail) {
  const panel = $("#access-panel");
  try {
    const rows = await accessCall(() => state.store.listAllowedEmails());
    const iAmPrimary = !!rows.find((r) => r.email === myEmail)?.is_primary;
    const primaryEmail = rows.find((r) => r.is_primary)?.email;

    panel.innerHTML = `
      <table><tbody>
        ${rows
          .map((r) => {
            const tags = [
              r.is_primary ? '<span class="tag">primary</span>' : "",
              r.email === myEmail ? '<span class="tag">you</span>' : "",
            ]
              .filter(Boolean)
              .join(" ");
            const canRemove = iAmPrimary && !r.is_primary;
            const removeTitle = r.is_primary
              ? "The primary household member can't be removed"
              : !iAmPrimary
                ? `Only ${esc(primaryEmail || "the primary member")} can remove household members`
                : "";
            return `<tr>
              <td>${esc(r.email)}${tags ? " " + tags : ""}</td>
              <td class="n"><button class="rowbtn" data-remove-email="${esc(r.email)}"
                ${canRemove ? "" : `disabled title="${removeTitle}"`}>✕</button></td>
            </tr>`;
          })
          .join("")}
      </tbody></table>
      ${
        iAmPrimary
          ? `<div class="actions" style="margin-top:12px">
               <input id="new-access-email" type="email" placeholder="name@example.com" style="flex:1;min-width:200px">
               <button class="btn" id="add-access-email" type="button">Add</button>
             </div>`
          : `<p class="note" style="margin-top:12px">Only <b>${esc(primaryEmail || "the primary member")}</b> can add or remove household members.</p>`
      }
      <p class="note" style="margin-top:10px">Anyone added here can sign in with that Google account and see
        every transaction, budget and balance in this household — there's no per-person restriction beyond that.</p>`;

    panel.querySelectorAll("[data-remove-email]:not([disabled])").forEach(
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
            await accessCall(() => state.store.removeAllowedEmail(target));
          });
          if (done) {
            notice(`Removed ${target}.`, "ok");
            loadAccessPanel(myEmail);
          }
        }),
    );
    if (iAmPrimary) {
      $("#add-access-email").onclick = async () => {
        const input = $("#new-access-email");
        const value = input.value.trim().toLowerCase();
        if (!value || !/^\S+@\S+\.\S+$/.test(value))
          return notice("Enter a valid email address.", "bad");
        const done = await withBusy(`Adding ${value}`, async () => {
          await accessCall(() => state.store.addAllowedEmail(value));
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
    }
  } catch (err) {
    panel.innerHTML = `<b class="over">${esc(err.message)}</b>`;
  }
}
