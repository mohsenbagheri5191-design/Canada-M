/**
 * App visual styles.
 *
 * A theme answers "what colours?". A style answers "what does a surface feel
 * like?" — and that is the difference between a colour picker and a design
 * tool. Two designs can share a palette and look nothing alike because one is
 * flat with hairline borders and the other is neumorphic with soft shadow
 * pairs.
 *
 * Every style implements the same three surface levels, so any component can
 * ask for a surface without knowing which style is active:
 *
 *   page     the backdrop a screen sits on
 *   raised   a card, tile or row that sits above the page
 *   inset    a well pressed into the page: inputs, tracks, wells
 *   control  an interactive raised object: buttons, chips
 *
 * A style returns plain CSS properties. It never returns a class name, because
 * the renderer has to work inside the studio canvas, inside a palette
 * thumbnail and inside the real app, and only inline properties survive all
 * three.
 */

/* ---------------------------------------------------------------------------
   Helpers
   --------------------------------------------------------------------------- */

/** Mix two colours without needing a colour library at render time. */
const mix = (a, b, amount) => `color-mix(in srgb, ${a} ${Math.round(amount * 100)}%, ${b})`;

/** A translucent version of a colour, for tints and glass. */
const alpha = (colour, a) => `color-mix(in srgb, ${colour} ${Math.round(a * 100)}%, transparent)`;

/* ---------------------------------------------------------------------------
   The styles
   --------------------------------------------------------------------------- */

export const appStyles = [
  {
    key: "flat",
    name: "Flat",
    description: "Hairline borders, no shadows. Dense and quiet.",
    swatchHint: "borders",
    tokens: { radiusScale: 1, borderWidth: 1 },
    surface({ c, level, radius, tint }) {
      const base = {
        page:    { background: c.background },
        raised:  { background: tint ?? c.surface, border: `1px solid ${c.border}` },
        inset:   { background: c.surfaceSunken, border: `1px solid ${c.border}` },
        control: { background: tint ?? c.surfaceSunken, border: `1px solid ${c.border}` },
      }[level];
      return { ...base, borderRadius: radius, boxShadow: "none" };
    },
  },

  {
    key: "elevated",
    name: "Elevated",
    description: "Soft drop shadows, no borders. Familiar and friendly.",
    swatchHint: "shadow",
    tokens: { radiusScale: 1.15, borderWidth: 0 },
    surface({ c, level, radius, tint }) {
      const base = {
        page:    { background: c.background, boxShadow: "none" },
        raised:  { background: tint ?? c.surface, boxShadow: "0 1px 2px rgb(0 0 0 / 0.06), 0 4px 12px -2px rgb(0 0 0 / 0.1)" },
        inset:   { background: c.surfaceSunken, boxShadow: "inset 0 1px 2px rgb(0 0 0 / 0.08)" },
        control: { background: tint ?? c.surface, boxShadow: "0 1px 2px rgb(0 0 0 / 0.08), 0 2px 6px -1px rgb(0 0 0 / 0.1)" },
      }[level];
      return { border: "none", borderRadius: radius, ...base };
    },
  },

  {
    key: "neumorphic",
    name: "Neumorphic",
    description: "Surfaces the same colour as the page, shaped by a light and dark shadow pair.",
    swatchHint: "soft",
    tokens: { radiusScale: 1.6, borderWidth: 0 },
    surface({ c, level, radius, tint, dark }) {
      // The pair has to be derived from the surface colour rather than fixed,
      // or the highlight disappears on a dark palette and the shadow
      // disappears on a light one.
      const shade = dark ? "rgb(0 0 0 / 0.55)" : "rgb(155 170 195 / 0.55)";
      const light = dark ? "rgb(255 255 255 / 0.05)" : "rgb(255 255 255 / 0.95)";

      const base = {
        page:    { background: c.background, boxShadow: "none" },
        raised:  { background: tint ?? c.surface, boxShadow: `6px 6px 14px ${shade}, -5px -5px 12px ${light}` },
        inset:   { background: tint ?? c.surface, boxShadow: `inset 4px 4px 9px ${shade}, inset -3px -3px 8px ${light}` },
        control: { background: tint ?? c.surface, boxShadow: `4px 4px 9px ${shade}, -3px -3px 8px ${light}` },
      }[level];
      return { border: "none", borderRadius: radius, ...base };
    },
  },

  {
    key: "outlined",
    name: "Outlined",
    description: "Heavier borders, transparent fills. Reads as a blueprint.",
    swatchHint: "outline",
    tokens: { radiusScale: 0.9, borderWidth: 2 },
    surface({ c, level, radius, tint }) {
      const base = {
        page:    { background: c.background, border: "none" },
        raised:  { background: "transparent", border: `2px solid ${c.border}` },
        inset:   { background: "transparent", border: `2px solid ${c.border}` },
        control: { background: tint ?? "transparent", border: `2px solid ${tint ? "transparent" : c.text}` },
      }[level];
      return { borderRadius: radius, boxShadow: "none", ...base };
    },
  },

  {
    key: "glass",
    name: "Glass",
    description: "Translucent panels over a blurred backdrop. Best on a photo or gradient.",
    swatchHint: "blur",
    tokens: { radiusScale: 1.4, borderWidth: 1 },
    surface({ c, level, radius, tint, dark }) {
      const film = dark ? alpha("#ffffff", 0.08) : alpha("#ffffff", 0.55);
      const edge = dark ? alpha("#ffffff", 0.14) : alpha("#ffffff", 0.7);

      const base = {
        page:    { background: c.background, backdropFilter: "none" },
        raised:  { background: tint ?? film, border: `1px solid ${edge}`, backdropFilter: "blur(14px) saturate(1.3)" },
        inset:   { background: dark ? alpha("#000000", 0.22) : alpha("#ffffff", 0.35), border: `1px solid ${edge}`, backdropFilter: "blur(8px)" },
        control: { background: tint ?? film, border: `1px solid ${edge}`, backdropFilter: "blur(10px)" },
      }[level];
      return { borderRadius: radius, boxShadow: level === "page" ? "none" : "0 8px 26px -10px rgb(0 0 0 / 0.3)", ...base };
    },
  },

  {
    key: "brutalist",
    name: "Brutalist",
    description: "Hard offset shadows, square corners, thick black edges.",
    swatchHint: "hard",
    tokens: { radiusScale: 0.15, borderWidth: 2 },
    surface({ c, level, radius, tint }) {
      const base = {
        page:    { background: c.background, boxShadow: "none", border: "none" },
        raised:  { background: tint ?? c.surface, border: `2px solid ${c.text}`, boxShadow: `4px 4px 0 0 ${c.text}` },
        inset:   { background: c.surfaceSunken, border: `2px solid ${c.text}`, boxShadow: "none" },
        control: { background: tint ?? c.surface, border: `2px solid ${c.text}`, boxShadow: `3px 3px 0 0 ${c.text}` },
      }[level];
      return { borderRadius: radius, ...base };
    },
  },

  {
    key: "soft",
    name: "Soft",
    description: "Tinted fills, generous radii, no hard edges anywhere.",
    swatchHint: "tint",
    tokens: { radiusScale: 1.8, borderWidth: 0 },
    surface({ c, level, radius, tint }) {
      const base = {
        page:    { background: c.background },
        raised:  { background: tint ?? mix(c.primary, c.surface, 0.05) },
        inset:   { background: mix(c.primary, c.surfaceSunken, 0.07) },
        control: { background: tint ?? mix(c.primary, c.surface, 0.1) },
      }[level];
      return { border: "none", borderRadius: radius, boxShadow: "none", ...base };
    },
  },
];

const byKey = new Map(appStyles.map((s) => [s.key, s]));

export const getStyle = (key) => byKey.get(key) ?? byKey.get("flat");

export const styleKeys = appStyles.map((s) => s.key);

/* ---------------------------------------------------------------------------
   The resolver every render function goes through
   --------------------------------------------------------------------------- */

/** Rough perceived lightness, to decide which half of a shadow pair to favour. */
function isDark(hex) {
  const h = String(hex ?? "").replace("#", "");
  if (h.length < 6) return false;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return (r * 299 + g * 587 + b * 114) / 1000 < 128;
}

/**
 * Build the surface helper handed to every component as `ctx.surface`.
 *
 *   ctx.surface("raised", { radius: 14 })
 *   ctx.surface("control", { radius: 999, tint: theme.colors.primary })
 *
 * `radius` is scaled by the style, so switching to Brutalist squares every
 * corner in the design without touching a single node's props, and switching
 * to Soft rounds them all. That is the point: a style change restyles the whole
 * app, not one component.
 */
export function createSurfaceResolver(theme) {
  const style = getStyle(theme?.style ?? "flat");
  const c = theme?.colors ?? {};
  const dark = isDark(c.background);
  const scale = style.tokens?.radiusScale ?? 1;

  const resolve = (level = "raised", { radius = null, tint = null } = {}) => {
    const baseRadius = radius ?? theme?.radius?.panel ?? 12;
    const scaled = typeof baseRadius === "number" ? `${Math.round(baseRadius * scale)}px` : baseRadius;

    try {
      return style.surface({ c, level, radius: scaled, tint, dark }) ?? {};
    } catch (error) {
      // A malformed style must not take the screen down with it, for the same
      // reason an unknown component type does not throw.
      console.warn(`[styles] "${style.key}" failed at level "${level}"`, error);
      return { background: c.surface, borderRadius: scaled };
    }
  };

  resolve.key = style.key;
  // Not `resolve.name`: a function's own `name` is non-writable, and module
  // code is strict, so assigning to it throws rather than being ignored.
  resolve.styleName = style.name;
  resolve.radiusScale = scale;
  resolve.borderWidth = style.tokens?.borderWidth ?? 1;
  resolve.dark = dark;
  return resolve;
}

/* ---------------------------------------------------------------------------
   Palettes
   --------------------------------------------------------------------------- */

const baseTypography = {
  fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  baseSize: 14,
  scale: { caption: 12, body: 14, lead: 16, title: 20, display: 28 },
};

/**
 * Palettes are separate from styles so they combine freely: seven styles times
 * these palettes is the range the studio offers, rather than a fixed list of
 * whole looks.
 */
export const appPalettes = [
  {
    key: "graphite",
    name: "Graphite",
    group: "Neutral",
    colors: {
      background: "#f4f5f7", surface: "#ffffff", surfaceSunken: "#e9eaee", border: "#d9dbe1",
      text: "#15171c", textSecondary: "#4d5361", textTertiary: "#7c8393",
      primary: "#2f6fed", primarySoft: "#e4ecfd", onPrimary: "#ffffff",
      success: "#17864a", warning: "#8a6a00", danger: "#c8352d", info: "#2f6fed",
    },
  },
  {
    key: "midnight",
    name: "Midnight",
    group: "Neutral",
    colors: {
      background: "#0f1218", surface: "#171b23", surfaceSunken: "#1f242e", border: "#2a3040",
      text: "#eef1f6", textSecondary: "#a2abbd", textTertiary: "#6f7889",
      primary: "#5b8cff", primarySoft: "#1a2340", onPrimary: "#080c16",
      success: "#43c77e", warning: "#e8bc4a", danger: "#f06a63", info: "#5b8cff",
    },
  },
  {
    key: "amber",
    name: "Amber",
    group: "Warm",
    colors: {
      background: "#fbf8f4", surface: "#ffffff", surfaceSunken: "#f3ece3", border: "#e5dbcc",
      text: "#1d1710", textSecondary: "#55493a", textTertiary: "#877a68",
      primary: "#e07a00", primarySoft: "#fdefdc", onPrimary: "#1d1204",
      success: "#2f7d4f", warning: "#a9701a", danger: "#bd3a2c", info: "#2f6aa8",
    },
  },
  {
    key: "ember",
    name: "Ember",
    group: "Warm",
    colors: {
      background: "#14100e", surface: "#1e1815", surfaceSunken: "#271f1b", border: "#382d26",
      text: "#f6efe9", textSecondary: "#b9a898", textTertiary: "#8a7868",
      primary: "#ff9130", primarySoft: "#2f1f12", onPrimary: "#1a0e03",
      success: "#4cc47c", warning: "#e9bd52", danger: "#f4685c", info: "#6fa8f5",
    },
  },
  {
    key: "crimson",
    name: "Crimson",
    group: "Warm",
    colors: {
      background: "#fdf7f6", surface: "#ffffff", surfaceSunken: "#f6e9e7", border: "#e8d2cf",
      text: "#1c1211", textSecondary: "#57413e", textTertiary: "#8a6e6a",
      primary: "#c0392b", primarySoft: "#fbe7e4", onPrimary: "#ffffff",
      success: "#2c7a4b", warning: "#a3711c", danger: "#a5261c", info: "#2b5ea8",
    },
  },
  {
    key: "azure",
    name: "Azure",
    group: "Cool",
    colors: {
      background: "#f5f8fc", surface: "#ffffff", surfaceSunken: "#e8eef6", border: "#d4dfec",
      text: "#101823", textSecondary: "#455263", textTertiary: "#75828f",
      primary: "#1668d6", primarySoft: "#e1ecfb", onPrimary: "#ffffff",
      success: "#15804a", warning: "#8a6500", danger: "#c33228", info: "#1668d6",
    },
  },
  {
    key: "slate-dark",
    name: "Slate Dark",
    group: "Cool",
    colors: {
      background: "#101418", surface: "#182027", surfaceSunken: "#202a32", border: "#2c3945",
      text: "#eaf0f5", textSecondary: "#9aa8b5", textTertiary: "#6b7986",
      primary: "#38bdf8", primarySoft: "#102b3a", onPrimary: "#04141d",
      success: "#41c98a", warning: "#e5bb4d", danger: "#ef6b6b", info: "#38bdf8",
    },
  },
  {
    key: "ink",
    name: "Ink",
    group: "Monochrome",
    colors: {
      background: "#fafafa", surface: "#ffffff", surfaceSunken: "#efefef", border: "#dcdcdc",
      text: "#101010", textSecondary: "#4a4a4a", textTertiary: "#7c7c7c",
      primary: "#141414", primarySoft: "#ebebeb", onPrimary: "#ffffff",
      success: "#1f7a3d", warning: "#8a6a00", danger: "#b3261e", info: "#1a4fa0",
    },
  },
  {
    key: "carbon",
    name: "Carbon",
    group: "Monochrome",
    colors: {
      background: "#0c0c0d", surface: "#151517", surfaceSunken: "#1d1d20", border: "#2b2b30",
      text: "#f2f2f3", textSecondary: "#a3a3aa", textTertiary: "#74747c",
      primary: "#f2f2f3", primarySoft: "#26262a", onPrimary: "#0c0c0d",
      success: "#4ad07f", warning: "#e5bd4f", danger: "#f06a63", info: "#6ba5f0",
    },
  },
  {
    key: "high-contrast",
    name: "High contrast",
    group: "Accessible",
    colors: {
      background: "#ffffff", surface: "#ffffff", surfaceSunken: "#f0f0f0", border: "#000000",
      text: "#000000", textSecondary: "#1f1f1f", textTertiary: "#3a3a3a",
      primary: "#00417a", primarySoft: "#dbe8f5", onPrimary: "#ffffff",
      success: "#0d6b2f", warning: "#6f4200", danger: "#9e0000", info: "#00417a",
    },
  },
  {
    key: "high-contrast-dark",
    name: "High contrast dark",
    group: "Accessible",
    colors: {
      background: "#000000", surface: "#0b0b0b", surfaceSunken: "#151515", border: "#ffffff",
      text: "#ffffff", textSecondary: "#e4e4e4", textTertiary: "#c2c2c2",
      primary: "#7fc4ff", primarySoft: "#102233", onPrimary: "#000000",
      success: "#6ee899", warning: "#ffd75e", danger: "#ff8f86", info: "#7fc4ff",
    },
  },
];

/**
 * A theme is a palette plus a style plus type and scale. Presets are just
 * useful pairings; the studio lets either half be changed independently.
 */
export function makeTheme(paletteKey, styleKey, overrides = {}) {
  const palette = appPalettes.find((p) => p.key === paletteKey) ?? appPalettes[0];
  const style = getStyle(styleKey);

  return {
    palette: palette.key,
    style: style.key,
    colors: { ...palette.colors },
    typography: { ...baseTypography },
    radius: { control: 10, panel: 14, pill: 999 },
    spacing: { base: 4, gap: 12, padding: 16 },
    ...overrides,
  };
}

/** The pairings offered as one-click starting points. */
export const themePresets = [
  { key: "graphite-flat",       name: "Graphite Flat",    description: "Dense and neutral. The safe default.",        theme: makeTheme("graphite", "flat") },
  { key: "azure-elevated",      name: "Azure Elevated",   description: "Soft shadows, cool blues.",                    theme: makeTheme("azure", "elevated") },
  { key: "graphite-neumorphic", name: "Soft Graphite",    description: "Neumorphic surfaces on a light grey.",         theme: makeTheme("graphite", "neumorphic") },
  { key: "amber-soft",          name: "Warm Soft",        description: "Tinted fills and generous radii.",             theme: makeTheme("amber", "soft") },
  { key: "midnight-elevated",   name: "Midnight",         description: "Dark, cool, familiar.",                        theme: makeTheme("midnight", "elevated") },
  { key: "ember-neumorphic",    name: "Ember Soft",       description: "Neumorphic in the dark, warm accent.",         theme: makeTheme("ember", "neumorphic") },
  { key: "slate-glass",         name: "Slate Glass",      description: "Translucent panels over a dark backdrop.",     theme: makeTheme("slate-dark", "glass") },
  { key: "ink-outlined",        name: "Ink Outline",      description: "Blueprint look, monochrome.",                  theme: makeTheme("ink", "outlined") },
  { key: "ink-brutalist",       name: "Ink Brutal",       description: "Hard offsets, square corners.",                theme: makeTheme("ink", "brutalist") },
  { key: "carbon-flat",         name: "Carbon",           description: "Near-black, monochrome, hairline borders.",     theme: makeTheme("carbon", "flat") },
  { key: "crimson-elevated",    name: "Crimson",          description: "Warm red on warm white.",                      theme: makeTheme("crimson", "elevated") },
  { key: "hc-light",            name: "High contrast",    description: "Built to clear AA everywhere, including small text.", theme: makeTheme("high-contrast", "outlined") },
  { key: "hc-dark",             name: "High contrast dark", description: "The same, inverted.",                        theme: makeTheme("high-contrast-dark", "outlined") },
];

/** The theme a brand-new design starts from. */
export const defaultTheme = () => makeTheme("graphite", "flat");
