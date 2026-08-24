/* GSAP-backed motion primitives. app.js and charts.js call these named
   functions rather than raw GSAP, so reduced-motion is one guard here
   instead of a check scattered across every call site, and callers don't
   need to know GSAP's API. */

const reduced = () =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Animates a number from `from` to `to`, formatting each tick through
    `fmt` (money()/pct()/etc.) so the display never shows an unformatted
    raw number mid-count. Falls back to an instant text-set when motion is
    reduced, GSAP hasn't loaded, or from/to are equal or not both finite
    numbers (e.g. a metric currently showing "—"). */
export function countUp(el, from, to, fmt, duration = 0.6) {
  if (
    !el ||
    reduced() ||
    !window.gsap ||
    !Number.isFinite(from) ||
    !Number.isFinite(to) ||
    from === to
  ) {
    if (el) el.textContent = fmt(to);
    return;
  }
  const obj = { v: from };
  gsap.to(obj, {
    v: to,
    duration,
    ease: "power2.out",
    onUpdate: () => (el.textContent = fmt(obj.v)),
  });
}

/** Staggers an array/NodeList of elements in with an 8px rise + fade.
    No-ops (sets opacity 1 immediately) under reduced motion or a missing
    GSAP, and does nothing at all for an empty list. */
export function revealStagger(els, { stagger = 0.04, duration = 0.35 } = {}) {
  const list = Array.from(els || []);
  if (!list.length) return;
  if (reduced() || !window.gsap) {
    list.forEach((el) => (el.style.opacity = 1));
    return;
  }
  gsap.fromTo(
    list,
    { opacity: 0, y: 8 },
    { opacity: 1, y: 0, duration, stagger, ease: "power2.out" },
  );
}

/** Marks an element as hover-liftable (see .card-hoverable in styles.css).
    Exists so call sites don't need to know the CSS class name directly. */
export function cardHoverable(el) {
  if (el) el.classList.add("card-hoverable");
}

/** Fades and height-collapses an element before its caller removes it
    from the DOM/state. Resolves once the animation completes, or
    immediately under reduced motion / missing GSAP (callers must still
    await the returned promise either way). */
export function exitCollapse(el, duration = 0.25) {
  if (!el || reduced() || !window.gsap) return Promise.resolve();
  return new Promise((resolve) => {
    gsap.to(el, {
      opacity: 0,
      height: 0,
      marginTop: 0,
      marginBottom: 0,
      paddingTop: 0,
      paddingBottom: 0,
      duration,
      ease: "power1.in",
      onComplete: resolve,
    });
  });
}

/** Fades/slides #view out, runs renderFn synchronously, then fades/slides
    the new content in. Falls back to calling renderFn directly (no
    animation) under reduced motion or a missing GSAP. */
export function viewTransition(renderFn) {
  const view = document.getElementById("view");
  if (!view || reduced() || !window.gsap) {
    renderFn();
    return;
  }
  gsap.to(view, {
    opacity: 0,
    y: -6,
    duration: 0.12,
    ease: "power1.in",
    onComplete: () => {
      renderFn();
      gsap.fromTo(
        view,
        { opacity: 0, y: 8 },
        { opacity: 1, y: 0, duration: 0.18, ease: "power2.out" },
      );
    },
  });
}
