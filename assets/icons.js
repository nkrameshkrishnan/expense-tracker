/* Small inline-SVG icon set for categories, accounts and people - no icon
   font or CDN dependency, so the app keeps working offline. Icons are
   intentionally plain geometric line marks (Feather/Lucide-style), never
   illustrations, per the app's "no decorative chrome" visual language.

   Each icon is a 24x24 viewBox, stroke="currentColor", fill="none" - colour
   and size are entirely controlled by the wrapping .icon-badge element, so
   one <svg> works on any background. */

const svg = (inner) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;

// Local escape (icons.js is imported very low in the dependency graph, so it
// avoids importing core.js's esc() purely to dodge any chance of a cycle) -
// category/account/person names can be user-created via "+ New", so this
// still needs to be real HTML-escaping, not just quote-stripping.
const escAttr = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

/** Category icon paths, keyed by the exact CATEGORIES name in constants.js.
    A handful of categories share a shape where no distinct metaphor reads
    better at 16px (e.g. the three Wealthsimple investment accounts below
    all share one "briefcase") - that's fine, colour still tells them apart. */
const CATEGORY_ICONS = {
  Salary: svg(
    '<circle cx="12" cy="12" r="8"/><path d="M12 8v8M9.5 10a2 2 0 0 1 2-1.5h1a2 2 0 0 1 0 4h-1a2 2 0 0 0 0 4h1a2 2 0 0 0 2-1.5"/>',
  ),
  Dividends: svg(
    '<polyline points="3 17 9 11 13 15 21 7"/><polyline points="15 7 21 7 21 13"/>',
  ),
  "Other Income": svg(
    '<circle cx="12" cy="12" r="8"/><line x1="12" y1="9" x2="12" y2="15"/><line x1="9" y1="12" x2="15" y2="12"/>',
  ),
  "Rent / Housing": svg(
    '<path d="M4 11 12 4l8 7"/><path d="M6 10v10h12V10"/><path d="M10 20v-6h4v6"/>',
  ),
  Groceries: svg(
    '<circle cx="9" cy="20" r="1"/><circle cx="18" cy="20" r="1"/><path d="M3 4h2l2.3 12.4a2 2 0 0 0 2 1.6h7.1a2 2 0 0 0 2-1.6L20 8H6.2"/>',
  ),
  Utilities: svg('<polygon points="13 2 4 14 11 14 9 22 20 10 13 10"/>'),
  "Internet & Phone": svg(
    '<rect x="7" y="2" width="10" height="20" rx="2"/><line x1="11" y1="18" x2="13" y2="18"/>',
  ),
  Transport: svg(
    '<path d="M4 16l1.5-5A2 2 0 0 1 7.4 9.5h9.2A2 2 0 0 1 18.5 11L20 16"/><rect x="2.5" y="16" width="19" height="4" rx="1"/><circle cx="7.5" cy="20" r="1.3"/><circle cx="16.5" cy="20" r="1.3"/>',
  ),
  Gas: svg(
    '<rect x="4" y="4" width="10" height="16" rx="1"/><line x1="4" y1="10" x2="14" y2="10"/><path d="M14 8h2a2 2 0 0 1 2 2v5.5a1.3 1.3 0 0 0 2.6 0V10l-2-2"/>',
  ),
  "Dining Out": svg(
    '<path d="M6 2v8a2 2 0 0 0 4 0V2M8 10v12"/><path d="M16 2c-1.7 0-3 2-3 5s1.3 4 3 4v11"/>',
  ),
  "Health & Fitness": svg(
    '<path d="M12 20.5s-7-4.3-9.2-8.6A4.8 4.8 0 0 1 12 6.8a4.8 4.8 0 0 1 9.2 5.1C19 16.2 12 20.5 12 20.5z"/>',
  ),
  Insurance: svg(
    '<path d="M12 2.5 19.5 6v5.5c0 5-3.2 8-7.5 10-4.3-2-7.5-5-7.5-10V6z"/>',
  ),
  Shopping: svg(
    '<path d="M6.5 7h11l-1 13h-9z"/><path d="M9 7V5.5a3 3 0 0 1 6 0V7"/>',
  ),
  Entertainment: svg(
    '<circle cx="12" cy="12" r="9"/><polygon points="10 8 16.5 12 10 16"/>',
  ),
  Subscriptions: svg(
    '<polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>',
  ),
  Travel: svg(
    '<line x1="21.5" y1="2.5" x2="11" y2="13"/><polygon points="21.5 2.5 14.5 21.5 11 13 2.5 9.5 21.5 2.5"/>',
  ),
  Education: svg(
    '<path d="M4 19V4.5A1.5 1.5 0 0 1 5.5 3H19v17H6.5A1.5 1.5 0 0 0 5 21.5"/><path d="M5 19.5A1.5 1.5 0 0 1 6.5 18H19"/>',
  ),
  "Gifts & Donations": svg(
    '<rect x="3" y="8" width="18" height="13" rx="1"/><path d="M12 8v13M3 12h18"/><path d="M12 8C10.5 8 9 7 9 5.5A2.5 2.5 0 0 1 11.5 3C13 3 14 5 14 8"/><path d="M12 8c1.5 0 3-1 3-2.5A2.5 2.5 0 0 0 12.5 3C11 3 10 5 10 8"/>',
  ),
  "Personal Care": svg(
    '<circle cx="12" cy="8" r="4"/><path d="M4 21v-1a8 8 0 0 1 16 0v1"/>',
  ),
  "Savings & Investments": svg(
    '<line x1="5" y1="20" x2="5" y2="14"/><line x1="12" y1="20" x2="12" y2="8"/><line x1="19" y1="20" x2="19" y2="4"/>',
  ),
  Miscellaneous: svg(
    '<circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/>',
  ),
};

const GENERIC_CATEGORY_ICON = CATEGORY_ICONS.Miscellaneous;

export function categoryIcon(name) {
  return CATEGORY_ICONS[name] || GENERIC_CATEGORY_ICON;
}

/** Account icon paths. Grouped by what the account actually is (a chequing
    account, a card, an investment wrapper) rather than one icon per literal
    name, so adding a custom account later just falls back sensibly. */
const BANK_ICON = svg(
  '<path d="M3 10l9-6 9 6"/><path d="M5 10v9h14v-9"/><line x1="9" y1="14" x2="9" y2="19"/><line x1="15" y1="14" x2="15" y2="19"/>',
);
const CARD_ICON = svg(
  '<rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/>',
);
const INVESTMENT_ICON = svg(
  '<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>',
);
const LOCK_ICON = svg(
  '<rect x="3" y="11" width="18" height="10" rx="1"/><circle cx="12" cy="16" r="1.3"/><path d="M7 11V7.5a5 5 0 0 1 10 0V11"/>',
);
const WALLET_ICON = svg(
  '<path d="M20 12V7H5.5a2.5 2.5 0 0 1 0-5H18v4"/><path d="M3 6v13a2 2 0 0 0 2 2h16v-6"/><path d="M17.5 12a2 2 0 0 0 0 4H22v-4z"/>',
);

export function accountIcon(name) {
  if (/chequing/i.test(name)) return BANK_ICON;
  if (/visa|mastercard|amex/i.test(name)) return CARD_ICON;
  if (/tfsa|rrsp|non-registered|wealthsimple/i.test(name))
    return INVESTMENT_ICON;
  if (/savings/i.test(name)) return LOCK_ICON;
  if (/cash/i.test(name)) return WALLET_ICON;
  return BANK_ICON;
}

/** Deterministic badge colour per category/account name, drawn from the
    fixed 12-swatch palette already defined as --cat-color-0..11 in
    styles.css. Same hashing approach as charts.js's hashColor, but snapped
    to this small fixed set instead of an arbitrary hue so every icon badge
    matches the app's existing category-colour language. */
export function swatchVar(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return `var(--cat-color-${h % 12})`;
}

/** A coloured icon badge for a category or account name - the <span> the
    pages below actually render. kind picks the icon set; size is a CSS
    class ("sm" | "md"), default "sm". */
export function iconBadge(name, kind = "category", size = "sm") {
  const icon = kind === "account" ? accountIcon(name) : categoryIcon(name);
  return `<span class="icon-badge icon-badge-${size}" style="--badge-color:${swatchVar(name)}" title="${escAttr(name)}">${icon}</span>`;
}

/** Initials avatar for a person (Family/Ramesh/Surya/Unassigned/custom),
    reusing the same colour-per-person system as .person-swatch/.person-chip
    (see styles.css) via the shared [data-p] attribute selector instead of
    duplicating the colour choice here. */
export function personAvatar(person, size = "sm") {
  const label = person || "Family";
  const initial = label === "Unassigned" ? "?" : label[0]?.toUpperCase() || "?";
  return `<span class="avatar avatar-${size}" data-p="${escAttr(label)}">${escAttr(initial)}</span>`;
}

/** Shared empty-state mark: a plain geometric tray, never a cartoon mascot -
    see the anti-slop skill. One icon for every "nothing here yet" block in
    the app, wrapped so .empty can lay it out above the message text. */
const EMPTY_TRAY_ICON = svg(
  '<path d="M4 14 6.5 5h11L20 14"/><path d="M4 14h4.5a1 1 0 0 1 .9.6l.7 1.4a1 1 0 0 0 .9.6h2a1 1 0 0 0 .9-.6l.7-1.4a1 1 0 0 1 .9-.6H20"/><path d="M4 14v5a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5"/>',
);

export function emptyIcon() {
  return `<span class="empty-icon">${EMPTY_TRAY_ICON}</span>`;
}
