/* Motion helpers (Framer Motion DOM, vendored in ./vendor/framer-motion-dom.js).
   Every helper is a safe no-op when the user prefers reduced motion or the
   vendored module failed to load, and is safe to call repeatedly. Nothing
   here is required for the app to work: content is always left in its final,
   visible state (never stuck at opacity 0). */

let fm = null; // { animate, stagger, inView } once loaded
// Started at import time so the module is normally ready before the first
// page render. A call made before it resolves simply skips its animation.
const ready = import("./vendor/framer-motion-dom.js")
  .then((m) => (fm = m))
  .catch(() => null);
void ready;

const running = new WeakMap(); // el -> animation controls

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
  running.delete(el);
}

function enter(el, delaySec) {
  if (el.dataset.motion) return; // already animating in this render
  el.dataset.motion = "1";
  try {
    const c = fm.animate(
      el,
      { opacity: [0, 1], transform: ["translateY(6px)", "translateY(0px)"] },
      { duration: 0.28, delay: delaySec, ease: [0.16, 1, 0.3, 1] },
    );
    running.set(el, c);
    const done = () => settle(el);
    if (c && typeof c.then === "function") c.then(done, done);
    else done();
  } catch {
    settle(el);
  }
}

/** Stops any running countUp on el (leaves its text untouched). */
export function cancelCountUp(el) {
  const prev = el && running.get(el);
  if (!prev) return;
  try {
    prev.stop();
  } catch {}
  running.delete(el);
}

export function countUp(el, to, format, opts = {}) {
  if (!el) return;
  const fmt = typeof format === "function" ? format : String;
  const final = () => {
    el.textContent = fmt(to);
  };
  const prev = running.get(el);
  if (prev) {
    try {
      prev.stop();
    } catch {}
    running.delete(el);
  }
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
      duration: opts.duration ?? 0.6,
      ease: [0.16, 1, 0.3, 1],
      onUpdate: (n) => {
        el.textContent = fmt(n);
      },
    });
    running.set(el, c);
    const done = () => {
      if (running.get(el) !== c) return; // superseded by a newer call
      running.delete(el);
      final();
    };
    if (c && typeof c.then === "function") c.then(done, done);
    else done();
  } catch {
    final();
  }
}

export function revealStagger(els, opts = {}) {
  if (!canAnimate()) return;
  const list = toList(els);
  const base = opts.delay ?? 0;
  list.forEach((el, i) => enter(el, base + i * 0.04));
}

export function revealOnView(els) {
  if (!canAnimate()) return;
  const list = toList(els).filter((el) => !el.dataset.motion);
  if (!list.length) return;
  try {
    // Hide up front only what is about to be observed; inView reveals it.
    list.forEach((el) => {
      el.dataset.motion = "pending";
      el.style.opacity = "0";
    });
    list.forEach((el) => {
      fm.inView(
        el,
        () => {
          delete el.dataset.motion;
          enter(el, 0);
        },
        { amount: 0.1 },
      );
    });
    // Safety net: never leave anything hidden if the observer never fires.
    setTimeout(() => {
      list.forEach((el) => {
        if (el.dataset.motion === "pending") settle(el);
      });
    }, 2500);
  } catch {
    list.forEach(settle);
  }
}

export function revealPage(root) {
  try {
    if (!canAnimate()) return;
    const host = root || document.getElementById("view");
    if (!host) return;
    let kids = [...host.children];
    if (kids.length === 1) kids = [...kids[0].children];
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
