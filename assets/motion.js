/* Motion helpers (Framer Motion DOM, vendored in ./vendor/framer-motion-dom.js).
   Every helper is a safe no-op when the user prefers reduced motion or the
   vendored module failed to load, and is safe to call repeatedly. Nothing
   here is required for the app to work: content is always left in its final,
   visible state (never stuck at opacity 0). This is the ONLY module that
   imports the vendored file. */

let fm = null; // { animate, stagger, inView } once loaded
// Started at import time so the module is normally ready before the first
// page render. A call made before it resolves simply skips its animation.
const ready = import("./vendor/framer-motion-dom.js")
  .then((m) => (fm = m))
  .catch(() => null);
/** Resolves true once the vendored module has loaded, false if it failed.
    Never rejects. For callers outside the router (the landing page) that
    schedule an entrance only once motion is actually available. */
export const motionReady = ready.then(() => !!fm);

const entering = new WeakMap(); // el -> entrance animation controls
const counting = new WeakMap(); // el -> count-up animation controls

const DURATION = 0.22; // spec: 150-220ms
const EASE = [0.16, 1, 0.3, 1];

/* ---- page-entrance intent ----
   ONE shared flag for "this render is a page entrance". router.js's go()
   runs the page's render function through runEntrance(): animate=true for a
   nav-tab/route entry, false for a person switch or any other reload of the
   same page. Every render NOT wrapped that way - filter/selector changes,
   saves, returning from a form or dialog, background data reloads - sees
   false. Page modules ask isEntering() instead of guessing from leftover DOM
   whether they were "freshly built". */
let pageEntering = false;
let enterClassTimer = 0;

export function isEntering() {
  return pageEntering;
}

/** Runs render() with isEntering() reporting `animate`. When animating, also
    puts .is-entering on host for the CSS card entrance in styles.css, and
    takes it off again once that entrance (<=140ms delay + 200ms) is over so
    later in-place re-renders (filters, search) never replay it. */
export function runEntrance(host, animate, render) {
  clearTimeout(enterClassTimer);
  if (host) host.classList.toggle("is-entering", !!animate);
  pageEntering = !!animate;
  try {
    render();
  } finally {
    pageEntering = false;
  }
  if (host && animate)
    enterClassTimer = setTimeout(
      () => host.classList.remove("is-entering"),
      450,
    );
}

export function reducedMotion() {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

const canAnimate = () => !!fm && !reducedMotion();

function toList(els, root = document) {
  if (!els) return [];
  if (typeof els === "string") return [...root.querySelectorAll(els)];
  return [...els].filter((e) => e && e.nodeType === 1);
}

function settle(el) {
  el.style.removeProperty("opacity");
  el.style.removeProperty("transform");
  delete el.dataset.motion;
  entering.delete(el);
}

function enter(el, delaySec) {
  if (el.dataset.motion) return; // already animating in this render
  el.dataset.motion = "1";
  try {
    const c = fm.animate(
      el,
      { opacity: [0, 1], transform: ["translateY(6px)", "translateY(0px)"] },
      { duration: DURATION, delay: delaySec, ease: EASE },
    );
    entering.set(el, c);
    const done = () => settle(el);
    if (c && typeof c.then === "function") c.then(done, done);
    else done();
  } catch {
    settle(el);
  }
}

/** Stops any running countUp on el (leaves its text untouched). */
export function cancelCountUp(el) {
  const prev = el && counting.get(el);
  if (!prev) return;
  try {
    prev.stop();
  } catch {}
  counting.delete(el);
}

export function countUp(el, to, format, opts = {}) {
  if (!el) return;
  const fmt = typeof format === "function" ? format : String;
  const final = () => {
    el.textContent = fmt(to);
  };
  cancelCountUp(el);
  const from =
    el.dataset.countTo === undefined ? 0 : Number(el.dataset.countTo);
  if (!Number.isFinite(to)) {
    final();
    return;
  }
  el.dataset.countTo = String(to);
  if (!canAnimate()) {
    final();
    return;
  }
  try {
    const c = fm.animate(Number.isFinite(from) ? from : 0, to, {
      duration: opts.duration ?? DURATION,
      ease: EASE,
      onUpdate: (n) => {
        el.textContent = fmt(n);
      },
    });
    counting.set(el, c);
    const done = () => {
      if (counting.get(el) !== c) return; // superseded by a newer call
      counting.delete(el);
      final();
    };
    if (c && typeof c.then === "function") c.then(done, done);
    else done();
  } catch {
    final();
  }
}

/** Counts KPI tiles up by core.js kpi() key: specs are [key, number,
    formatter] and target #kpi-<key>-v (the value element, never the tile).
    Always ends on exactly fmt(n). */
export function countKpiTiles(specs) {
  for (const [key, n, fmt] of specs || []) {
    const el = document.getElementById(`kpi-${key}-v`);
    if (el) countUp(el, n, fmt);
  }
}

export function revealStagger(els, opts = {}) {
  if (!canAnimate()) return;
  const list = toList(els);
  const base = opts.delay ?? 0;
  list.forEach((el, i) => enter(el, base + i * 0.04));
}

/** Fades elements in as they scroll into view. Only elements entirely below
    the fold right now are touched - anything already on screen stays as it
    is (hiding it would flash visible -> hidden -> visible). */
export function revealOnView(els) {
  if (!canAnimate()) return;
  const fold = window.innerHeight || document.documentElement.clientHeight;
  const list = toList(els).filter(
    (el) => !el.dataset.motion && el.getBoundingClientRect().top >= fold,
  );
  for (const el of list) {
    try {
      el.dataset.motion = "pending";
      el.style.opacity = "0";
      fm.inView(
        el,
        () => {
          // Something else settled it meanwhile: never re-hide it.
          if (el.dataset.motion !== "pending") return;
          delete el.dataset.motion;
          enter(el, 0);
        },
        { amount: 0.1 },
      );
    } catch {
      settle(el); // no observer: just stay visible
    }
  }
}

/** Blocks styles.css animates itself under #view.is-entering (plus their
    containers) - revealPage leaves these, and anything holding one, alone
    so nothing enters twice (nested fades would compound). */
const CSS_ENTRANCE =
  ".kpis, .person-cards, .kpi, .panel, .person-card, .bcard, .tx-row, .networth-card, .metal-card, .debt-card";

export function revealPage(root) {
  try {
    if (!canAnimate()) return;
    const host = root || document.getElementById("view");
    if (!host) return;
    let kids = [...host.children];
    if (kids.length === 1) kids = [...kids[0].children];
    kids = kids.filter(
      (k) =>
        !k.matches(CSS_ENTRANCE) &&
        !k.querySelector(`${CSS_ENTRANCE}, [data-motion]`),
    );
    revealStagger(kids.slice(0, 12));
  } catch {
    /* motion must never break navigation */
  }
}

export function chartAnimation() {
  return reducedMotion()
    ? { duration: 0 }
    : { duration: 400, easing: "easeOutQuart" };
}
