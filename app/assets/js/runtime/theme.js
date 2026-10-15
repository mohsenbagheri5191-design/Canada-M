/**
 * Turning a resolved theme into something the renderer and the page chrome can
 * both use.
 *
 * Two jobs, and the first is the one that matters.
 *
 * The resolver returns whatever is stored on the design version, and that is
 * not guaranteed to be complete — the seeded rows carry only `colors`, and a
 * design published by an older dashboard will be missing whatever was added
 * since. The renderer, meanwhile, dereferences `theme.typography.fontFamily`
 * and asks `theme.style` for its surfaces. A partial theme therefore does not
 * degrade, it throws, and the app renders nothing at all.
 *
 * So a theme arriving from the wire is always merged over a complete default.
 * Missing keys fall back; present keys win.
 *
 * The second job is the page itself. The renderer styles the tree inline, but
 * the document background behind a short screen, the overscroll colour, the
 * text selection and the browser's own UI colour are not part of any tree.
 * Those read CSS custom properties, so the theme is mirrored onto :root.
 */

import { defaultTheme, makeTheme } from "../shared.js";

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** Deep merge, right wins, arrays replace rather than concatenate. */
function merge(base, patch) {
  if (!isObject(patch)) return base;
  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === null) continue;
    out[key] = isObject(value) && isObject(base[key]) ? merge(base[key], value) : value;
  }
  return out;
}

/**
 * Complete a theme from the wire.
 *
 * If it names a palette and style, the defaults come from that pairing, so a
 * design that stored only `{ palette: "ember", style: "neumorphic" }` resolves
 * to the whole thing. Otherwise the base is the app's default theme.
 */
export function normaliseTheme(wire) {
  if (!isObject(wire)) return defaultTheme();
  const base = wire.palette || wire.style ? makeTheme(wire.palette ?? "graphite", wire.style ?? "flat") : defaultTheme();
  return merge(base, wire);
}

/** Is this theme dark? Decided from the background, not from its name. */
export function isDark(theme) {
  const hex = String(theme?.colors?.background ?? "#ffffff").replace("#", "");
  const full = hex.length === 3 ? hex.split("").map((c) => c + c).join("") : hex;
  if (!/^[0-9a-f]{6}$/i.test(full)) return false;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);
  const channel = (v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b) < 0.4;
}

/** Mirror the theme onto :root as custom properties, and set the UI colour. */
export function applyTheme(theme, root = document.documentElement) {
  for (const [key, value] of Object.entries(theme.colors ?? {})) {
    root.style.setProperty(`--c-${kebab(key)}`, String(value));
  }
  root.style.setProperty("--font", theme.typography?.fontFamily ?? "system-ui, sans-serif");
  root.style.setProperty("--fs-base", `${theme.typography?.baseSize ?? 14}px`);
  root.style.setProperty("--r-panel", `${theme.radius?.panel ?? 14}px`);
  root.style.setProperty("--r-control", `${theme.radius?.control ?? 10}px`);

  const dark = isDark(theme);
  root.dataset.appTheme = dark ? "dark" : "light";
  root.style.colorScheme = dark ? "dark" : "light";

  // The browser chrome — the address bar on Android, the status bar area on
  // iOS when installed — takes its colour from here, so a dark app with a
  // white bar above it stops looking like two applications.
  let meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement("meta");
    meta.name = "theme-color";
    document.head.appendChild(meta);
  }
  meta.content = theme.colors?.background ?? "#ffffff";
}

const kebab = (s) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
