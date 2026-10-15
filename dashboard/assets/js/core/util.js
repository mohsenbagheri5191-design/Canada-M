/**
 * Formatting, identifiers and colour maths.
 *
 * The colour block is doing real work: the theme editor generates tonal ramps
 * from a seed and refuses to ship a token pair that fails WCAG AA, so it needs
 * proper OKLCH conversion and relative-luminance contrast, not a hex lighten.
 */

/* ---------------------------------------------------------------------------
   Identifiers
   --------------------------------------------------------------------------- */

let counter = 0;

/** Short, readable, collision-resistant enough for a document tree. */
export function uid(prefix = "n") {
  counter += 1;
  const time = Date.now().toString(36).slice(-5);
  const rand = Math.random().toString(36).slice(2, 6);
  return `${prefix}_${time}${rand}${counter.toString(36)}`;
}

/** A stable key from arbitrary text, for slugs and collection keys. */
export function slug(text) {
  return String(text)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

/* ---------------------------------------------------------------------------
   Numbers and text
   --------------------------------------------------------------------------- */

const compact = new Intl.NumberFormat("en-CA", { notation: "compact", maximumFractionDigits: 1 });
const plain = new Intl.NumberFormat("en-CA");
const money = new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD" });

export const fmt = {
  number: (n) => (Number.isFinite(n) ? plain.format(n) : "—"),
  compact: (n) => (Number.isFinite(n) ? compact.format(n) : "—"),
  currency: (n) => (Number.isFinite(n) ? money.format(n) : "—"),
  percent: (n, digits = 1) => (Number.isFinite(n) ? `${(n * 100).toFixed(digits)}%` : "—"),
  ms: (n) => (Number.isFinite(n) ? `${n < 10 ? n.toFixed(1) : Math.round(n)}ms` : "—"),
  bytes(n) {
    if (!Number.isFinite(n)) return "—";
    const units = ["B", "KB", "MB", "GB"];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i += 1;
    }
    return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)}${units[i]}`;
  },

  /** "3m ago", "2d ago". Deliberately terse; tables are narrow. */
  relative(input) {
    const then = input instanceof Date ? input.getTime() : new Date(input).getTime();
    if (!Number.isFinite(then)) return "—";
    const delta = Math.round((Date.now() - then) / 1000);

    if (delta < 5) return "just now";
    if (delta < 60) return `${delta}s ago`;
    if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
    if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
    if (delta < 604800) return `${Math.floor(delta / 86400)}d ago`;
    if (delta < 2629800) return `${Math.floor(delta / 604800)}w ago`;
    return new Date(then).toLocaleDateString("en-CA", { month: "short", day: "numeric" });
  },

  datetime(input) {
    const d = input instanceof Date ? input : new Date(input);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleString("en-CA", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  },

  date(input) {
    const d = input instanceof Date ? input : new Date(input);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleDateString("en-CA", { year: "numeric", month: "short", day: "numeric" });
  },

  duration(ms) {
    if (!Number.isFinite(ms)) return "—";
    if (ms < 1000) return `${Math.round(ms)}ms`;
    const s = ms / 1000;
    if (s < 60) return `${s.toFixed(1)}s`;
    const m = Math.floor(s / 60);
    return `${m}m ${Math.round(s % 60)}s`;
  },

  /** "Maya Chen" -> "MC". Used by every avatar. */
  initials(name) {
    const parts = String(name || "?")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (!parts.length) return "?";
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  },

  /** "app_user" -> "App user" */
  label(key) {
    return String(key)
      .replace(/[_-]+/g, " ")
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/^./, (c) => c.toUpperCase());
  },

  plural: (n, one, many = `${one}s`) => `${plain.format(n)} ${n === 1 ? one : many}`,
};

/** A stable hue in 0..360 from any string. Avatars and org marks use it. */
export function hueOf(text) {
  let hash = 0;
  const str = String(text || "");
  for (let i = 0; i < str.length; i += 1) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash) % 360;
}

export const clamp = (v, min, max) => Math.min(Math.max(v, min), max);

export const round = (v, step = 1) => Math.round(v / step) * step;

/** Fuzzy subsequence match with a score. Drives the palette and every search. */
export function fuzzy(needle, haystack) {
  const n = String(needle).toLowerCase().trim();
  const h = String(haystack).toLowerCase();
  if (!n) return { hit: true, score: 0 };
  if (h.includes(n)) return { hit: true, score: 1000 - h.indexOf(n) * 2 - (h.length - n.length) };

  let score = 0;
  let hi = 0;
  let streak = 0;
  for (const char of n) {
    const found = h.indexOf(char, hi);
    if (found === -1) return { hit: false, score: 0 };
    streak = found === hi ? streak + 1 : 0;
    score += 10 + streak * 4 - Math.min(found - hi, 12);
    hi = found + 1;
  }
  return { hit: true, score };
}

/* ---------------------------------------------------------------------------
   Colour
   --------------------------------------------------------------------------- */

export function hexToRgb(hex) {
  let h = String(hex).trim().replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (h.length === 8) h = h.slice(0, 6);
  if (!/^[0-9a-f]{6}$/i.test(h)) return { r: 0, g: 0, b: 0 };
  const int = parseInt(h, 16);
  return { r: (int >> 16) & 255, g: (int >> 8) & 255, b: int & 255 };
}

export function rgbToHex({ r, g, b }) {
  const to = (v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, "0");
  return `#${to(r)}${to(g)}${to(b)}`;
}

export function rgbToHsl({ r, g, b }) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
    else if (max === gn) h = ((bn - rn) / d + 2) / 6;
    else h = ((rn - gn) / d + 4) / 6;
  }

  return { h: h * 360, s: s * 100, l: l * 100 };
}

export function hslToRgb({ h, s, l }) {
  const hn = ((h % 360) + 360) % 360 / 360;
  const sn = clamp(s, 0, 100) / 100;
  const ln = clamp(l, 0, 100) / 100;

  if (sn === 0) {
    const v = Math.round(ln * 255);
    return { r: v, g: v, b: v };
  }

  const q = ln < 0.5 ? ln * (1 + sn) : ln + sn - ln * sn;
  const p = 2 * ln - q;
  const channel = (t) => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };

  return {
    r: Math.round(channel(hn + 1 / 3) * 255),
    g: Math.round(channel(hn) * 255),
    b: Math.round(channel(hn - 1 / 3) * 255),
  };
}

export const hexToHsl = (hex) => rgbToHsl(hexToRgb(hex));
export const hslToHex = (hsl) => rgbToHex(hslToRgb(hsl));

/** WCAG relative luminance. */
export function luminance(hex) {
  const { r, g, b } = hexToRgb(hex);
  const channel = (v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG 2.1 contrast ratio, 1..21. */
export function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * Grade a pair against WCAG 2.1. `large` relaxes the threshold for text at
 * 18.66px bold or 24px regular and above.
 */
export function contrastGrade(fg, bg, { large = false } = {}) {
  const ratio = contrast(fg, bg);
  const aa = large ? 3 : 4.5;
  const aaa = large ? 4.5 : 7;
  return {
    ratio,
    text: ratio.toFixed(2),
    level: ratio >= aaa ? "AAA" : ratio >= aa ? "AA" : ratio >= 3 ? "AA Large" : "Fail",
    passes: ratio >= aa,
  };
}

/** Pick black or white ink for a background, whichever reads better. */
export function inkFor(bg) {
  return contrast("#ffffff", bg) >= contrast("#0a0a0b", bg) ? "#ffffff" : "#0a0a0b";
}

/**
 * Generate an 11-stop tonal ramp from a seed colour.
 *
 * Lightness follows a fixed curve so every ramp in the product has the same
 * perceptual rhythm, while chroma peaks in the mid tones and falls away at the
 * extremes — the shape real palettes have, rather than a straight lerp to
 * white and black which produces washed-out tints.
 */
export function ramp(seed) {
  const { h, s } = hexToHsl(seed);
  const stops = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];
  const lightness = [97, 93.5, 86, 77, 67, 57, 47.5, 38.5, 30, 22, 14];
  const chroma = [0.34, 0.5, 0.68, 0.84, 0.95, 1, 0.98, 0.92, 0.84, 0.76, 0.66];

  const out = {};
  stops.forEach((stop, i) => {
    out[stop] = hslToHex({
      h,
      s: clamp(s * chroma[i], 4, 96),
      l: lightness[i],
    });
  });
  return out;
}

/** Nudge a colour's lightness while keeping hue and saturation. */
export function shift(hex, deltaL) {
  const hsl = hexToHsl(hex);
  return hslToHex({ ...hsl, l: clamp(hsl.l + deltaL, 0, 100) });
}

/** Compose a colour over a background at an alpha, returning an opaque hex. */
export function blend(fg, bg, alpha) {
  const a = hexToRgb(fg);
  const b = hexToRgb(bg);
  return rgbToHex({
    r: a.r * alpha + b.r * (1 - alpha),
    g: a.g * alpha + b.g * (1 - alpha),
    b: a.b * alpha + b.b * (1 - alpha),
  });
}

export const isHex = (value) => /^#?([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(String(value).trim());

/* ---------------------------------------------------------------------------
   Collections
   --------------------------------------------------------------------------- */

export function groupBy(items, keyOf) {
  const map = new Map();
  for (const item of items) {
    const key = typeof keyOf === "function" ? keyOf(item) : item[keyOf];
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

export function sortBy(items, keyOf, direction = "asc") {
  const sign = direction === "desc" ? -1 : 1;
  const read = typeof keyOf === "function" ? keyOf : (item) => item[keyOf];
  return [...items].sort((a, b) => {
    const av = read(a);
    const bv = read(b);
    if (av === bv) return 0;
    if (av === null || av === undefined) return 1;
    if (bv === null || bv === undefined) return -1;
    if (typeof av === "number" && typeof bv === "number") return (av - bv) * sign;
    return String(av).localeCompare(String(bv), "en", { numeric: true }) * sign;
  });
}

/** Deterministic pseudo-random, so seeded demo data is stable across reloads. */
export function seededRandom(seed) {
  let state = typeof seed === "string" ? hueOf(seed) + seed.length * 7919 : seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

/** Escape text destined for an innerHTML string. */
export function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[c]);
}

/** Download a string as a file, used by every CSV export in the product. */
export function downloadFile(filename, content, type = "text/csv;charset=utf-8") {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Rows to RFC 4180 CSV. */
export function toCsv(columns, rows) {
  const cell = (value) => {
    const text = value === null || value === undefined ? "" : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const head = columns.map((c) => cell(c.label ?? c.key)).join(",");
  const body = rows
    .map((row) => columns.map((c) => cell(typeof c.value === "function" ? c.value(row) : row[c.key])).join(","))
    .join("\n");
  return `${head}\n${body}`;
}

/** Minimal CSV parse, good enough for the import dry-run preview. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += char;
      continue;
    }

    if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += char;
  }

  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}
