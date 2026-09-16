/**
 * A very small DOM layer.
 *
 * There is no framework here on purpose: this repository ships static assets
 * with no build step, and a dashboard this interactive spends most of its time
 * doing direct, surgical DOM work anyway (drag, resize, measure) where a
 * virtual DOM is a tax rather than a help.
 *
 * `el` is the only thing most modules need.
 */

/**
 * Create an element.
 *
 *   el("div.card", { onclick: f }, "text", el("span", "child"))
 *
 * The tag string carries a CSS-like shorthand: `tag.class.class#id`.
 * Props are applied as properties when the element has them (so `onclick`,
 * `value`, `checked` all behave), otherwise as attributes. `style` takes an
 * object, `dataset` takes an object, `class` appends.
 */
export function el(spec, ...rest) {
  const [tagPart, ...classParts] = String(spec).split(".");
  let tag = tagPart || "div";
  let id = null;

  const hash = tag.indexOf("#");
  if (hash > -1) {
    id = tag.slice(hash + 1);
    tag = tag.slice(0, hash) || "div";
  }

  const node = document.createElement(tag);
  if (id) node.id = id;

  for (const cls of classParts) {
    const h = cls.indexOf("#");
    if (h > -1) {
      node.id = cls.slice(h + 1);
      if (h > 0) node.classList.add(cls.slice(0, h));
    } else if (cls) {
      node.classList.add(cls);
    }
  }

  let children = rest;
  const first = rest[0];
  if (first && typeof first === "object" && !Array.isArray(first) && !(first instanceof Node)) {
    applyProps(node, first);
    children = rest.slice(1);
  }

  append(node, children);
  return node;
}

function applyProps(node, props) {
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;

    if (key === "style" && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) {
        if (v === null || v === undefined) continue;
        if (k.startsWith("--")) node.style.setProperty(k, String(v));
        else node.style[k] = v;
      }
    } else if (key === "dataset" && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) {
        if (v === null || v === undefined) continue;
        node.dataset[k] = String(v);
      }
    } else if (key === "class") {
      for (const c of String(value).split(/\s+/)) if (c) node.classList.add(c);
    } else if (key === "html") {
      // Only ever called with strings this module built itself.
      node.innerHTML = value;
    } else if (key === "ref" && typeof value === "function") {
      value(node);
    } else if (key in node) {
      node[key] = value;
    } else {
      node.setAttribute(key, value === true ? "" : String(value));
    }
  }
}

function append(node, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false || child === true) continue;
    if (Array.isArray(child)) append(node, child);
    else if (child instanceof Node) node.appendChild(child);
    else node.appendChild(document.createTextNode(String(child)));
  }
}

/** Create an SVG element tree from a path spec. Used by the icon set. */
export function svg(viewBox, ...children) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  node.setAttribute("viewBox", viewBox);
  node.setAttribute("fill", "none");
  node.setAttribute("stroke", "currentColor");
  node.setAttribute("stroke-width", "1.6");
  node.setAttribute("stroke-linecap", "round");
  node.setAttribute("stroke-linejoin", "round");
  node.setAttribute("aria-hidden", "true");
  for (const c of children) if (c) node.appendChild(c);
  return node;
}

/** Create a raw SVG child node, e.g. svgEl("path", { d: "M0 0" }). */
export function svgEl(tag, attrs = {}) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    node.setAttribute(k, String(v));
  }
  return node;
}

/** Replace all children of `node` with `children`. */
export function mount(node, ...children) {
  node.replaceChildren();
  append(node, children);
  return node;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** addEventListener returning its own disposer, so teardown stays honest. */
export function on(target, type, handler, options) {
  target.addEventListener(type, handler, options);
  return () => target.removeEventListener(type, handler, options);
}

/** One-shot delegated listener. */
export function delegate(root, selector, type, handler) {
  return on(root, type, (event) => {
    const match = event.target.closest(selector);
    if (match && root.contains(match)) handler(event, match);
  });
}

/** Trailing-edge debounce. */
export function debounce(fn, wait = 200) {
  let timer = null;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
  wrapped.cancel = () => clearTimeout(timer);
  wrapped.flush = (...args) => {
    clearTimeout(timer);
    fn(...args);
  };
  return wrapped;
}

/** Animation-frame throttle, for pointer-move work. */
export function raf(fn) {
  let pending = false;
  let lastArgs = null;
  return (...args) => {
    lastArgs = args;
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      fn(...lastArgs);
    });
  };
}

/** Focus trap for modals and drawers. Returns a disposer. */
export function trapFocus(container) {
  const selector =
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  const previous = document.activeElement;

  const focusables = () =>
    Array.from(container.querySelectorAll(selector)).filter(
      (n) => n.offsetParent !== null || n === document.activeElement,
    );

  const first = focusables()[0];
  (first || container).focus?.();

  const off = on(container, "keydown", (event) => {
    if (event.key !== "Tab") return;
    const items = focusables();
    if (!items.length) return;
    const head = items[0];
    const tail = items[items.length - 1];
    if (event.shiftKey && document.activeElement === head) {
      event.preventDefault();
      tail.focus();
    } else if (!event.shiftKey && document.activeElement === tail) {
      event.preventDefault();
      head.focus();
    }
  });

  return () => {
    off();
    previous?.focus?.();
  };
}

/**
 * Pointer drag helper. Handles capture, movement deltas and cleanup so that
 * every drag interaction in the product behaves the same way.
 */
export function drag(event, { onStart, onMove, onEnd, cursor, threshold = 0 } = {}) {
  event.preventDefault();

  const startX = event.clientX;
  const startY = event.clientY;
  let started = threshold === 0;
  let prevX = startX;
  let prevY = startY;

  if (started && cursor) document.body.style.cursor = cursor;
  if (started) onStart?.({ startX, startY, event });

  const move = raf((e) => {
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;

    if (!started) {
      if (Math.hypot(dx, dy) < threshold) return;
      started = true;
      if (cursor) document.body.style.cursor = cursor;
      onStart?.({ startX, startY, event: e });
    }

    onMove?.({
      dx,
      dy,
      x: e.clientX,
      y: e.clientY,
      stepX: e.clientX - prevX,
      stepY: e.clientY - prevY,
      shift: e.shiftKey,
      alt: e.altKey,
      meta: e.metaKey || e.ctrlKey,
      event: e,
    });

    prevX = e.clientX;
    prevY = e.clientY;
  });

  const up = (e) => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", up);
    document.body.style.cursor = "";
    document.body.classList.remove("resizing");
    onEnd?.({
      moved: started,
      dx: e.clientX - startX,
      dy: e.clientY - startY,
      event: e,
    });
  };

  document.body.classList.add("resizing");
  window.addEventListener("pointermove", move, { passive: true });
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", up);
}

/** Position a floating element next to an anchor, flipping to stay on screen. */
export function anchorTo(floating, anchor, { placement = "bottom-start", gap = 6 } = {}) {
  const a = anchor instanceof Element ? anchor.getBoundingClientRect() : anchor;
  const f = floating.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const [side, align = "start"] = placement.split("-");

  let top;
  let left;

  if (side === "bottom") top = a.bottom + gap;
  else if (side === "top") top = a.top - f.height - gap;
  else top = a.top;

  if (side === "right") left = a.right + gap;
  else if (side === "left") left = a.left - f.width - gap;
  else if (align === "end") left = a.right - f.width;
  else if (align === "center") left = a.left + a.width / 2 - f.width / 2;
  else left = a.left;

  // Flip vertically rather than run off the bottom.
  if (side === "bottom" && top + f.height > vh - 8 && a.top - f.height - gap > 8) {
    top = a.top - f.height - gap;
  }

  left = Math.min(Math.max(8, left), vw - f.width - 8);
  top = Math.min(Math.max(8, top), vh - f.height - 8);

  floating.style.top = `${Math.round(top)}px`;
  floating.style.left = `${Math.round(left)}px`;
  floating.style.setProperty("--origin", side === "top" ? "bottom left" : "top left");
}
