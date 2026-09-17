/**
 * The component registry.
 *
 * This is the single most important file in the system. The Design Studio
 * reads it to decide what can be inserted and how each prop is edited; the
 * renderer reads it to decide how a node becomes pixels. Neither side may
 * know about a component the other does not, which is why they share one
 * definition rather than two.
 *
 * A definition is:
 *   label            what the palette calls it
 *   category         palette grouping
 *   glyph            icon name from core/icons.js
 *   description      one line, shown in the palette and the inspector header
 *   props            defaults, and the shape the renderer can rely on
 *   fields           how the inspector edits each prop
 *   acceptsChildren  whether it is a container
 *   resizable        which axes have handles, and the clamps
 *   states           extra interaction states the Style tab can target
 *   render           props -> DOM
 *
 * `fields` control types are resolved by studio/inspector.js:
 *   text · textarea · number · select · segmented · switch · color · icon
 *   size · spacing · radius · align · shadow · slider · font · chips · items
 */

import { el } from "../core/dom.js";
import { icon } from "../core/icons.js";

/* ---------------------------------------------------------------------------
   Shared prop fragments
   --------------------------------------------------------------------------- */

const SPACING_ZERO = { top: 0, right: 0, bottom: 0, left: 0 };

const CATEGORIES = [
  { key: "Layout", glyph: "layers", hint: "Structure and flow" },
  { key: "Content", glyph: "text", hint: "Text, media and marks" },
  { key: "Actions", glyph: "button", hint: "Things a user can press" },
  { key: "Data", glyph: "list", hint: "Collections and records" },
  { key: "Input", glyph: "input", hint: "Forms and capture" },
  { key: "Navigation", glyph: "nav", hint: "Moving between screens" },
  { key: "Feedback", glyph: "info", hint: "State and status" },
];

/* ---------------------------------------------------------------------------
   Style helpers shared by every render function
   --------------------------------------------------------------------------- */

/** Resolve `{{theme.colors.x}}` and bare token names against the live theme. */
export function resolveToken(value, theme) {
  if (typeof value !== "string") return value;

  const match = value.match(/^\{\{theme\.([a-zA-Z0-9_.]+)\}\}$/);
  if (match) {
    const parts = match[1].split(".");
    let node = theme;
    for (const part of parts) node = node?.[part];
    return node ?? value;
  }

  if (value.startsWith("$")) {
    const key = value.slice(1);
    return theme?.colors?.[key] ?? theme?.[key] ?? value;
  }

  return value;
}

export const spacingCss = (s) =>
  s ? `${s.top ?? 0}px ${s.right ?? 0}px ${s.bottom ?? 0}px ${s.left ?? 0}px` : "0";

export const radiusCss = (r) => {
  if (typeof r === "number") return `${r}px`;
  if (!r) return "0";
  return `${r.tl ?? 0}px ${r.tr ?? 0}px ${r.br ?? 0}px ${r.bl ?? 0}px`;
};

/** Translate the registry's size model into CSS. */
export function sizeCss(size, axis) {
  const value = size?.[axis];
  if (value === undefined || value === null || value === "hug") return null;
  if (value === "fill") return "100%";
  if (typeof value === "number") return `${value}px`;
  return String(value);
}

const SHADOWS = {
  none: "none",
  xs: "0 1px 2px rgb(0 0 0 / 0.06)",
  sm: "0 1px 3px rgb(0 0 0 / 0.1), 0 1px 2px rgb(0 0 0 / 0.06)",
  md: "0 4px 10px -2px rgb(0 0 0 / 0.12), 0 2px 4px -1px rgb(0 0 0 / 0.06)",
  lg: "0 12px 24px -6px rgb(0 0 0 / 0.16), 0 4px 8px -2px rgb(0 0 0 / 0.08)",
  glow: "0 0 0 3px rgb(0 0 0 / 0.06), 0 8px 24px -8px rgb(0 0 0 / 0.3)",
  inset: "inset 0 1px 2px rgb(0 0 0 / 0.14)",
};

export const shadowCss = (key) => SHADOWS[key] ?? SHADOWS.none;

export const shadowKeys = Object.keys(SHADOWS);

/**
 * Apply the props every component shares: box, spacing, size, appearance.
 *
 * `level` asks the active visual style for a surface first — flat borders,
 * soft neumorphic pairs, hard brutalist offsets, translucent glass — and the
 * node's own props are layered on top afterwards.
 *
 * The subtlety is that a registry default is not an author's decision. Card
 * defaults its background to the surface token, and if that were applied
 * blindly it would overwrite whatever the style just computed, so switching
 * style would change nothing. So an appearance prop only wins when it differs
 * from the component's declared default, which is exactly when somebody
 * actually chose it in the inspector.
 */
function applyBox(node, p, ctx, { level = null, type = null } = {}) {
  const s = node.style;
  const theme = ctx?.theme ?? ctx; // tolerate the older (node, p, theme) call
  const defaults = type ? registry[type]?.props ?? {} : {};
  const authored = (key) => JSON.stringify(p[key]) !== JSON.stringify(defaults[key]);

  if (level && typeof ctx?.surface === "function") {
    Object.assign(s, ctx.surface(level, {
      radius: p.radius,
      tint: authored("background") && p.background && p.background !== "transparent"
        ? resolveToken(p.background, theme)
        : null,
    }));
  }

  if (p.padding) s.padding = spacingCss(p.padding);
  if (p.margin) s.margin = spacingCss(p.margin);

  const w = sizeCss(p.size, "width");
  const h = sizeCss(p.size, "height");
  if (w) s.width = w;
  if (h) s.height = h;
  if (p.size?.minHeight) s.minHeight = `${p.size.minHeight}px`;
  if (p.size?.maxWidth) s.maxWidth = `${p.size.maxWidth}px`;

  if (p.background && p.background !== "transparent" && (!level || authored("background"))) {
    s.background = resolveToken(p.background, theme);
  }
  if (p.background === "transparent" && authored("background")) s.background = "transparent";

  if (p.radius !== undefined && (!level || authored("radius"))) s.borderRadius = radiusCss(p.radius);

  if (p.borderWidth && (!level || authored("borderWidth"))) {
    s.borderStyle = p.borderStyle || "solid";
    s.borderWidth = `${p.borderWidth}px`;
    s.borderColor = resolveToken(p.borderColor || theme.colors.border, theme);
  }
  if (p.shadow && p.shadow !== "none" && (!level || authored("shadow"))) s.boxShadow = shadowCss(p.shadow);
  if (p.opacity !== undefined && p.opacity !== 1) s.opacity = String(p.opacity);
  if (p.blur) s.backdropFilter = `blur(${p.blur}px)`;

  return node;
}

/** Typography props, shared by every text-bearing component. */
function applyType(node, p, theme) {
  const s = node.style;
  s.fontFamily = p.fontFamily ? resolveToken(p.fontFamily, theme) : theme.typography.fontFamily;
  if (p.fontSize) s.fontSize = `${p.fontSize}px`;
  if (p.fontWeight) s.fontWeight = String(p.fontWeight);
  if (p.lineHeight) s.lineHeight = String(p.lineHeight);
  if (p.letterSpacing !== undefined) s.letterSpacing = `${p.letterSpacing}em`;
  if (p.color) s.color = resolveToken(p.color, theme);
  if (p.align) s.textAlign = p.align;
  if (p.transform && p.transform !== "none") s.textTransform = p.transform;
  if (p.truncate) {
    s.overflow = "hidden";
    s.textOverflow = "ellipsis";
    s.display = "-webkit-box";
    s.webkitBoxOrient = "vertical";
    s.webkitLineClamp = String(p.truncate);
  }
  return node;
}

/* ---------------------------------------------------------------------------
   Field shorthands
   --------------------------------------------------------------------------- */

const f = {
  text: (label, opts = {}) => ({ control: "text", label, bindable: true, ...opts }),
  textarea: (label, opts = {}) => ({ control: "textarea", label, bindable: true, ...opts }),
  number: (label, opts = {}) => ({ control: "number", label, ...opts }),
  slider: (label, opts = {}) => ({ control: "slider", label, ...opts }),
  select: (label, options, opts = {}) => ({ control: "select", label, options, ...opts }),
  segmented: (label, options, opts = {}) => ({ control: "segmented", label, options, ...opts }),
  bool: (label, opts = {}) => ({ control: "switch", label, bindable: true, ...opts }),
  color: (label, opts = {}) => ({ control: "color", label, ...opts }),
  glyph: (label, opts = {}) => ({ control: "icon", label, ...opts }),
  size: (label = "Size") => ({ control: "size", label }),
  spacing: (label, opts = {}) => ({ control: "spacing", label, ...opts }),
  radius: (label = "Radius") => ({ control: "radius", label }),
  shadow: (label = "Shadow") => ({ control: "shadow", label }),
  items: (label, opts = {}) => ({ control: "items", label, ...opts }),
  chips: (label, options, opts = {}) => ({ control: "chips", label, options, ...opts }),
};

/** The appearance and spacing group every component gets for free. */
const boxFields = {
  padding: f.spacing("Padding", { group: "Spacing" }),
  margin: f.spacing("Margin", { group: "Spacing" }),
  size: { ...f.size(), group: "Size" },
  background: f.color("Background", { group: "Appearance", allowNone: true }),
  radius: { ...f.radius(), group: "Appearance" },
  borderWidth: f.number("Border", { group: "Appearance", min: 0, max: 8, unit: "px" }),
  borderColor: f.color("Border colour", { group: "Appearance" }),
  shadow: { ...f.shadow(), group: "Appearance" },
  opacity: f.slider("Opacity", { group: "Appearance", min: 0, max: 1, step: 0.01 }),
};

const typeFields = {
  fontSize: f.number("Size", { group: "Typography", min: 8, max: 72, unit: "px" }),
  fontWeight: f.select(
    "Weight",
    [
      { value: 300, label: "Light" },
      { value: 400, label: "Regular" },
      { value: 500, label: "Medium" },
      { value: 600, label: "Semibold" },
      { value: 700, label: "Bold" },
    ],
    { group: "Typography" },
  ),
  lineHeight: f.number("Line height", { group: "Typography", min: 0.8, max: 2.4, step: 0.05 }),
  letterSpacing: f.number("Tracking", { group: "Typography", min: -0.08, max: 0.3, step: 0.005, unit: "em" }),
  color: f.color("Colour", { group: "Typography" }),
  align: f.segmented(
    "Align",
    [
      { value: "left", icon: "alignLeft", tip: "Left" },
      { value: "center", icon: "alignCenter", tip: "Centre" },
      { value: "right", icon: "alignRight", tip: "Right" },
    ],
    { group: "Typography" },
  ),
  transform: f.select(
    "Case",
    [
      { value: "none", label: "As typed" },
      { value: "uppercase", label: "UPPER" },
      { value: "capitalize", label: "Title" },
      { value: "lowercase", label: "lower" },
    ],
    { group: "Typography" },
  ),
  truncate: f.number("Clamp lines", { group: "Typography", min: 0, max: 8 }),
};

/* ---------------------------------------------------------------------------
   The registry
   --------------------------------------------------------------------------- */

export const registry = {
  /* ===== Layout ========================================================== */

  Stack: {
    label: "Stack",
    category: "Layout",
    glyph: "stack",
    description: "A row or column that lays its children out on one axis.",
    acceptsChildren: true,
    resizable: { width: true, height: true },
    props: {
      direction: "vertical",
      gap: 12,
      align: "stretch",
      justify: "start",
      wrap: false,
      padding: { ...SPACING_ZERO },
      background: "transparent",
      radius: 0,
      size: { width: "fill", height: "hug" },
      shadow: "none",
      opacity: 1,
    },
    fields: {
      direction: f.segmented("Direction", [
        { value: "vertical", icon: "rows", tip: "Vertical" },
        { value: "horizontal", icon: "columns", tip: "Horizontal" },
      ]),
      gap: f.number("Gap", { min: 0, max: 96, unit: "px" }),
      align: f.select("Align", [
        { value: "stretch", label: "Stretch" },
        { value: "start", label: "Start" },
        { value: "center", label: "Centre" },
        { value: "end", label: "End" },
      ]),
      justify: f.select("Distribute", [
        { value: "start", label: "Start" },
        { value: "center", label: "Centre" },
        { value: "end", label: "End" },
        { value: "space-between", label: "Space between" },
        { value: "space-around", label: "Space around" },
      ]),
      wrap: f.bool("Wrap"),
      ...boxFields,
    },
    render(p, ctx, children) {
      const node = el("div", { dataset: { kind: "stack" } });
      const s = node.style;
      s.display = "flex";
      s.flexDirection = p.direction === "horizontal" ? "row" : "column";
      s.gap = `${p.gap ?? 0}px`;
      s.alignItems = p.align === "start" ? "flex-start" : p.align === "end" ? "flex-end" : p.align === "center" ? "center" : "stretch";
      s.justifyContent =
        { start: "flex-start", end: "flex-end", center: "center", "space-between": "space-between", "space-around": "space-around" }[p.justify] ?? "flex-start";
      if (p.wrap) s.flexWrap = "wrap";
      applyBox(node, p, ctx, { type: "Stack" });
      node.append(...children);
      return node;
    },
  },

  Grid: {
    label: "Grid",
    category: "Layout",
    glyph: "grid",
    description: "A fixed-column grid. Good for tiles and stat rows.",
    acceptsChildren: true,
    resizable: { width: true, height: true },
    props: {
      columns: 2,
      gap: 12,
      padding: { ...SPACING_ZERO },
      background: "transparent",
      radius: 0,
      size: { width: "fill", height: "hug" },
      shadow: "none",
      opacity: 1,
    },
    fields: {
      columns: f.number("Columns", { min: 1, max: 6 }),
      gap: f.number("Gap", { min: 0, max: 64, unit: "px" }),
      ...boxFields,
    },
    render(p, ctx, children) {
      const node = el("div");
      node.style.display = "grid";
      node.style.gridTemplateColumns = `repeat(${p.columns || 2}, minmax(0, 1fr))`;
      node.style.gap = `${p.gap ?? 0}px`;
      applyBox(node, p, ctx, { type: "Grid" });
      node.append(...children);
      return node;
    },
  },

  Card: {
    label: "Card",
    category: "Layout",
    glyph: "card",
    description: "A bordered surface that groups related content.",
    acceptsChildren: true,
    resizable: { width: true, height: true, minHeight: 40 },
    props: {
      gap: 10,
      padding: { top: 14, right: 14, bottom: 14, left: 14 },
      background: "{{theme.colors.surface}}",
      radius: 14,
      borderWidth: 1,
      borderColor: "{{theme.colors.border}}",
      shadow: "sm",
      size: { width: "fill", height: "hug" },
      opacity: 1,
    },
    fields: {
      gap: f.number("Gap", { min: 0, max: 48, unit: "px" }),
      ...boxFields,
    },
    render(p, ctx, children) {
      const node = el("div");
      node.style.display = "flex";
      node.style.flexDirection = "column";
      node.style.gap = `${p.gap ?? 0}px`;
      applyBox(node, p, ctx, { level: "raised", type: "Card" });
      node.append(...children);
      return node;
    },
  },

  Spacer: {
    label: "Spacer",
    category: "Layout",
    glyph: "spacer",
    description: "Empty space that pushes siblings apart.",
    acceptsChildren: false,
    resizable: { width: false, height: true, minHeight: 2, maxHeight: 240 },
    props: { size: { height: 16 }, grow: false },
    fields: {
      size: f.size("Height"),
      grow: f.bool("Fill remaining space"),
    },
    render(p) {
      const node = el("div");
      node.style.height = p.grow ? "auto" : `${p.size?.height ?? 16}px`;
      if (p.grow) node.style.flex = "1 1 auto";
      node.style.flexShrink = "0";
      return node;
    },
  },

  Divider: {
    label: "Divider",
    category: "Layout",
    glyph: "divider",
    description: "A hairline rule between sections.",
    acceptsChildren: false,
    resizable: { width: true, height: false },
    props: {
      color: "{{theme.colors.border}}",
      thickness: 1,
      inset: 0,
      margin: { top: 4, right: 0, bottom: 4, left: 0 },
    },
    fields: {
      color: f.color("Colour"),
      thickness: f.number("Thickness", { min: 1, max: 6, unit: "px" }),
      inset: f.number("Inset", { min: 0, max: 48, unit: "px" }),
      margin: f.spacing("Margin", { group: "Spacing" }),
    },
    render(p, ctx) {
      const node = el("div");
      node.style.height = `${p.thickness ?? 1}px`;
      node.style.background = resolveToken(p.color, ctx.theme);
      node.style.marginInline = `${p.inset ?? 0}px`;
      node.style.margin = spacingCss(p.margin);
      node.style.flexShrink = "0";
      return node;
    },
  },

  /* ===== Content ========================================================= */

  Heading: {
    label: "Heading",
    category: "Content",
    glyph: "type",
    description: "A section title.",
    acceptsChildren: false,
    resizable: { width: true, height: false },
    props: {
      text: "Section title",
      level: 2,
      fontSize: 20,
      fontWeight: 600,
      lineHeight: 1.25,
      letterSpacing: -0.015,
      color: "{{theme.colors.text}}",
      align: "left",
      transform: "none",
      truncate: 0,
      margin: { ...SPACING_ZERO },
    },
    fields: {
      text: f.text("Text"),
      level: f.segmented("Level", [
        { value: 1, label: "H1" },
        { value: 2, label: "H2" },
        { value: 3, label: "H3" },
      ]),
      ...typeFields,
      margin: f.spacing("Margin", { group: "Spacing" }),
    },
    render(p, ctx) {
      const node = el(`h${Math.min(Math.max(p.level || 2, 1), 6)}`, String(p.text ?? ""));
      node.style.margin = spacingCss(p.margin);
      return applyType(node, p, ctx.theme);
    },
  },

  Text: {
    label: "Text",
    category: "Content",
    glyph: "text",
    description: "Body copy.",
    acceptsChildren: false,
    resizable: { width: true, height: false },
    props: {
      text: "Body text goes here.",
      fontSize: 14,
      fontWeight: 400,
      lineHeight: 1.5,
      letterSpacing: 0,
      color: "{{theme.colors.textSecondary}}",
      align: "left",
      transform: "none",
      truncate: 0,
      margin: { ...SPACING_ZERO },
    },
    fields: {
      text: f.textarea("Text"),
      ...typeFields,
      margin: f.spacing("Margin", { group: "Spacing" }),
    },
    render(p, ctx) {
      const node = el("p", String(p.text ?? ""));
      node.style.margin = spacingCss(p.margin);
      return applyType(node, p, ctx.theme);
    },
  },

  Image: {
    label: "Image",
    category: "Content",
    glyph: "image",
    description: "A picture, with a defined aspect ratio.",
    acceptsChildren: false,
    resizable: { width: true, height: true, minHeight: 40 },
    props: {
      src: "",
      alt: "",
      ratio: "16 / 9",
      fit: "cover",
      radius: 12,
      size: { width: "fill" },
      shadow: "none",
      opacity: 1,
    },
    fields: {
      src: f.text("Source URL"),
      alt: f.text("Alt text"),
      ratio: f.select("Aspect", [
        { value: "16 / 9", label: "16:9" },
        { value: "4 / 3", label: "4:3" },
        { value: "1 / 1", label: "Square" },
        { value: "3 / 4", label: "Portrait" },
        { value: "21 / 9", label: "Ultra-wide" },
      ]),
      fit: f.segmented("Fit", [
        { value: "cover", label: "Cover" },
        { value: "contain", label: "Contain" },
      ]),
      ...boxFields,
    },
    render(p, ctx) {
      const node = el("div");
      node.style.aspectRatio = p.ratio || "16 / 9";
      node.style.overflow = "hidden";
      node.style.display = "grid";
      node.style.placeItems = "center";
      node.style.background = ctx.theme.colors.surfaceSunken;
      node.style.color = ctx.theme.colors.textTertiary;
      applyBox(node, p, ctx, { type: "Image" });

      if (p.src) {
        const img = el("img", { src: p.src, alt: p.alt || "" });
        img.style.width = "100%";
        img.style.height = "100%";
        img.style.objectFit = p.fit || "cover";
        node.appendChild(img);
      } else {
        // A real placeholder: it states what is missing rather than showing a
        // grey box that looks like a loading state.
        node.append(icon("image", 20));
      }
      return node;
    },
  },

  Icon: {
    label: "Icon",
    category: "Content",
    glyph: "sparkle",
    description: "A single glyph from the app icon set.",
    acceptsChildren: false,
    resizable: { width: false, height: false },
    props: { name: "zap", size: 24, color: "{{theme.colors.primary}}", background: "transparent", radius: 999, padding: { ...SPACING_ZERO } },
    fields: {
      name: f.glyph("Icon"),
      size: f.number("Size", { min: 10, max: 96, unit: "px" }),
      color: f.color("Colour"),
      background: f.color("Background", { group: "Appearance", allowNone: true }),
      radius: { ...f.radius(), group: "Appearance" },
      padding: f.spacing("Padding", { group: "Spacing" }),
    },
    render(p, ctx) {
      const node = el("span");
      node.style.display = "inline-flex";
      node.style.color = resolveToken(p.color, ctx.theme);
      node.style.flexShrink = "0";
      if (p.background && p.background !== "transparent") {
        node.style.background = resolveToken(p.background, ctx.theme);
        node.style.borderRadius = radiusCss(p.radius);
        node.style.padding = spacingCss(p.padding);
      }
      node.appendChild(icon(p.name || "zap", p.size || 24));
      return node;
    },
  },

  Badge: {
    label: "Badge",
    category: "Content",
    glyph: "tag",
    description: "A small status marker.",
    acceptsChildren: false,
    resizable: { width: false, height: false },
    props: {
      text: "Scheduled",
      tone: "neutral",
      glyph: "",
      size: { height: 24 },
    },
    fields: {
      text: f.text("Label"),
      tone: f.select("Tone", [
        { value: "neutral", label: "Neutral" },
        { value: "primary", label: "Primary" },
        { value: "success", label: "Success" },
        { value: "warning", label: "Warning" },
        { value: "danger", label: "Danger" },
      ]),
      glyph: f.glyph("Icon"),
    },
    render(p, ctx) {
      const tone = ctx.theme.colors[p.tone === "neutral" ? "textSecondary" : p.tone] || ctx.theme.colors.textSecondary;
      const node = el("span", p.glyph ? icon(p.glyph, 13) : null, el("span", String(p.text ?? "")));
      Object.assign(node.style, {
        display: "inline-flex",
        alignItems: "center",
        gap: "5px",
        height: `${p.size?.height ?? 24}px`,
        padding: "0 9px",
        borderRadius: "999px",
        background: `color-mix(in srgb, ${tone} 15%, transparent)`,
        color: tone,
        fontSize: "12px",
        fontWeight: "600",
        width: "fit-content",
        flexShrink: "0",
      });
      return node;
    },
  },

  Avatar: {
    label: "Avatar",
    category: "Content",
    glyph: "avatarIcon",
    description: "A person, by initials or photo.",
    acceptsChildren: false,
    resizable: { width: false, height: false },
    props: { name: "Avery Wilson", src: "", size: { width: 40, height: 40 }, ring: false },
    fields: {
      name: f.text("Name"),
      src: f.text("Photo URL"),
      size: f.size(),
      ring: f.bool("Accent ring"),
    },
    render(p, ctx) {
      const side = p.size?.width ?? 40;
      const node = el("span");
      Object.assign(node.style, {
        display: "grid",
        placeItems: "center",
        width: `${side}px`,
        height: `${side}px`,
        borderRadius: "999px",
        background: ctx.theme.colors.surfaceSunken,
        color: ctx.theme.colors.text,
        fontSize: `${Math.round(side * 0.36)}px`,
        fontWeight: "600",
        flexShrink: "0",
        overflow: "hidden",
        boxShadow: p.ring ? `0 0 0 2px ${ctx.theme.colors.primary}` : "none",
      });
      if (p.src) {
        const img = el("img", { src: p.src, alt: p.name || "" });
        Object.assign(img.style, { width: "100%", height: "100%", objectFit: "cover" });
        node.appendChild(img);
      } else {
        const parts = String(p.name || "?").trim().split(/\s+/);
        node.textContent = ((parts[0]?.[0] ?? "?") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
      }
      return node;
    },
  },

  /* ===== Actions ========================================================= */

  Button: {
    label: "Button",
    category: "Actions",
    glyph: "button",
    description: "The primary way a user does something.",
    acceptsChildren: false,
    resizable: { width: true, height: true, minHeight: 32, maxHeight: 72 },
    states: ["hover", "pressed", "disabled"],
    props: {
      label: "Start workflow",
      variant: "primary",
      glyph: "",
      iconSide: "left",
      size: { width: "fill", height: 48 },
      radius: 12,
      fontSize: 15,
      fontWeight: 600,
      disabled: false,
      fullWidth: true,
    },
    fields: {
      label: f.text("Label"),
      variant: f.segmented("Variant", [
        { value: "primary", label: "Primary" },
        { value: "secondary", label: "Secondary" },
        { value: "ghost", label: "Ghost" },
        { value: "danger", label: "Danger" },
      ]),
      glyph: f.glyph("Icon"),
      iconSide: f.segmented("Icon side", [
        { value: "left", label: "Left" },
        { value: "right", label: "Right" },
      ]),
      size: f.size(),
      radius: f.radius(),
      fontSize: f.number("Text size", { group: "Typography", min: 11, max: 24, unit: "px" }),
      fontWeight: typeFields.fontWeight,
      disabled: f.bool("Disabled"),
    },
    render(p, ctx) {
      const c = ctx.theme.colors;
      const variants = {
        primary: { background: c.primary, color: c.onPrimary, border: "transparent" },
        secondary: { background: c.surfaceSunken, color: c.text, border: c.border },
        ghost: { background: "transparent", color: c.primary, border: "transparent" },
        danger: { background: c.danger, color: "#fff", border: "transparent" },
      };
      const v = variants[p.variant] || variants.primary;

      const node = el(
        "button",
        { type: "button", disabled: Boolean(p.disabled) },
        p.glyph && p.iconSide === "left" ? icon(p.glyph, Math.round((p.fontSize || 15) * 1.15)) : null,
        el("span", String(p.label ?? "")),
        p.glyph && p.iconSide === "right" ? icon(p.glyph, Math.round((p.fontSize || 15) * 1.15)) : null,
      );

      // A ghost button has no surface by definition; everything else is a
      // raised control the style shapes, tinted by its variant.
      const surface =
        p.variant === "ghost"
          ? { background: "transparent", border: "none", borderRadius: radiusCss(p.radius) }
          : ctx.surface("control", { radius: p.radius, tint: v.background });

      Object.assign(node.style, {
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: "8px",
        width: sizeCss(p.size, "width") || "auto",
        height: `${p.size?.height ?? 48}px`,
        padding: "0 18px",
        ...surface,
        color: v.color,
        fontSize: `${p.fontSize ?? 15}px`,
        fontWeight: String(p.fontWeight ?? 600),
        fontFamily: ctx.theme.typography.fontFamily,
        cursor: p.disabled ? "not-allowed" : "pointer",
        opacity: p.disabled ? "0.45" : "1",
        flexShrink: "0",
        transition: "filter 140ms ease, transform 140ms ease",
      });

      return node;
    },
  },

  ButtonRow: {
    label: "Button row",
    category: "Actions",
    glyph: "columns",
    description: "Two or three actions side by side.",
    acceptsChildren: true,
    resizable: { width: true, height: false },
    props: { gap: 10, align: "fill", padding: { ...SPACING_ZERO } },
    fields: {
      gap: f.number("Gap", { min: 0, max: 32, unit: "px" }),
      align: f.segmented("Sizing", [
        { value: "fill", label: "Equal" },
        { value: "hug", label: "Natural" },
      ]),
      padding: f.spacing("Padding", { group: "Spacing" }),
    },
    render(p, ctx, children) {
      const node = el("div");
      Object.assign(node.style, {
        display: "flex",
        gap: `${p.gap ?? 10}px`,
        padding: spacingCss(p.padding),
      });
      for (const child of children) {
        if (p.align === "fill") child.style.flex = "1 1 0";
        node.appendChild(child);
      }
      return node;
    },
  },

  ChipRow: {
    label: "Chip row",
    category: "Actions",
    glyph: "tag",
    description: "A scrolling row of filters or quick choices.",
    acceptsChildren: false,
    resizable: { width: true, height: false },
    props: {
      items: ["All", "Scheduled", "In progress", "Done"],
      selectedIndex: 0,
      gap: 8,
      radius: 999,
    },
    fields: {
      items: f.items("Chips"),
      selectedIndex: f.number("Selected", { min: 0, max: 20 }),
      gap: f.number("Gap", { min: 0, max: 24, unit: "px" }),
      radius: f.radius(),
    },
    render(p, ctx) {
      const c = ctx.theme.colors;
      const node = el("div");
      Object.assign(node.style, {
        display: "flex",
        gap: `${p.gap ?? 8}px`,
        overflowX: "auto",
        paddingBottom: "2px",
      });
      (p.items || []).forEach((text, i) => {
        const active = i === p.selectedIndex;
        const chip = el("span", String(text));
        Object.assign(chip.style, {
          flexShrink: "0",
          padding: "7px 14px",
          ...ctx.surface("control", { radius: p.radius, tint: active ? c.primary : null }),
          color: active ? c.onPrimary : c.textSecondary,
          fontSize: "13px",
          fontWeight: active ? "600" : "500",
        });
        node.appendChild(chip);
      });
      return node;
    },
  },

  /* ===== Navigation ====================================================== */

  Header: {
    label: "Header",
    category: "Navigation",
    glyph: "nav",
    description: "The screen's top bar: title, back action, avatar.",
    acceptsChildren: false,
    resizable: { width: true, height: true, minHeight: 44, maxHeight: 120 },
    props: {
      title: "Job detail",
      subtitle: "",
      showBack: true,
      showAvatar: true,
      avatarName: "Maya Chen",
      align: "left",
      size: { height: 56 },
      background: "transparent",
      padding: { top: 0, right: 0, bottom: 0, left: 0 },
    },
    fields: {
      title: f.text("Title"),
      subtitle: f.text("Subtitle"),
      showBack: f.bool("Back button"),
      showAvatar: f.bool("Avatar"),
      avatarName: f.text("Avatar name"),
      align: f.segmented("Align", [
        { value: "left", icon: "alignLeft", tip: "Left" },
        { value: "center", icon: "alignCenter", tip: "Centre" },
      ]),
      size: f.size(),
      background: f.color("Background", { group: "Appearance", allowNone: true }),
      padding: f.spacing("Padding", { group: "Spacing" }),
    },
    render(p, ctx) {
      const c = ctx.theme.colors;
      const titleBlock = el(
        "div",
        { style: { minWidth: 0, flex: p.align === "center" ? "1 1 auto" : "1 1 auto", textAlign: p.align } },
        el("div", { style: { fontSize: "17px", fontWeight: "600", color: c.text, lineHeight: "1.25" } }, String(p.title ?? "")),
        p.subtitle
          ? el("div", { style: { fontSize: "12px", color: c.textTertiary, lineHeight: "1.3", marginTop: "1px" } }, String(p.subtitle))
          : null,
      );

      const node = el(
        "div",
        p.showBack
          ? el("span", {
              style: { display: "grid", placeItems: "center", width: "32px", height: "32px", borderRadius: "10px", background: c.surfaceSunken, color: c.text, flexShrink: "0" },
            }, icon("chevronLeft", 17))
          : null,
        titleBlock,
        p.showAvatar
          ? el("span", {
              style: { display: "grid", placeItems: "center", width: "32px", height: "32px", borderRadius: "999px", background: c.primary, color: c.onPrimary, fontSize: "12px", fontWeight: "700", flexShrink: "0" },
            }, String(p.avatarName || "?").split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase())
          : null,
      );

      Object.assign(node.style, {
        display: "flex",
        alignItems: "center",
        gap: "12px",
        height: `${p.size?.height ?? 56}px`,
        flexShrink: "0",
      });
      applyBox(node, p, ctx, { type: "Header" });
      return node;
    },
  },

  TabBar: {
    label: "Tab bar",
    category: "Navigation",
    glyph: "nav",
    description: "The app's bottom navigation.",
    acceptsChildren: false,
    resizable: { width: true, height: true, minHeight: 48, maxHeight: 88 },
    props: {
      items: ["Home", "Jobs", "Rewards", "Profile"],
      icons: ["overview", "list", "gift", "user"],
      activeIndex: 0,
      size: { height: 62 },
      background: "{{theme.colors.surface}}",
    },
    fields: {
      items: f.items("Labels"),
      activeIndex: f.number("Active", { min: 0, max: 5 }),
      size: f.size(),
      background: f.color("Background", { group: "Appearance" }),
    },
    render(p, ctx) {
      const c = ctx.theme.colors;
      const node = el("div");
      Object.assign(node.style, {
        display: "flex",
        alignItems: "center",
        height: `${p.size?.height ?? 62}px`,
        borderTop: `1px solid ${c.border}`,
        background: resolveToken(p.background, ctx.theme),
        flexShrink: "0",
      });

      (p.items || []).forEach((label, i) => {
        const active = i === p.activeIndex;
        const glyph = (p.icons || [])[i] || "box";
        node.appendChild(
          el(
            "div",
            {
              style: {
                flex: "1 1 0",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: "3px",
                color: active ? c.primary : c.textTertiary,
              },
            },
            icon(glyph, 20),
            el("span", { style: { fontSize: "10px", fontWeight: active ? "600" : "500" } }, String(label)),
          ),
        );
      });

      return node;
    },
  },

  /* ===== Data ============================================================ */

  StatTile: {
    label: "Stat tile",
    category: "Data",
    glyph: "chart",
    description: "One number with a label, for a KPI row.",
    acceptsChildren: false,
    resizable: { width: true, height: true, minHeight: 56 },
    props: {
      label: "Jobs today",
      value: "12",
      delta: "",
      glyph: "",
      padding: { top: 14, right: 14, bottom: 14, left: 14 },
      background: "{{theme.colors.surface}}",
      radius: 14,
      borderWidth: 1,
      borderColor: "{{theme.colors.border}}",
      shadow: "none",
      align: "left",
    },
    fields: {
      label: f.text("Label"),
      value: f.text("Value"),
      delta: f.text("Change"),
      glyph: f.glyph("Icon"),
      align: f.segmented("Align", [
        { value: "left", icon: "alignLeft", tip: "Left" },
        { value: "center", icon: "alignCenter", tip: "Centre" },
      ]),
      ...boxFields,
    },
    render(p, ctx) {
      const c = ctx.theme.colors;
      const node = el(
        "div",
        el(
          "div",
          { style: { display: "flex", alignItems: "center", gap: "6px", justifyContent: p.align === "center" ? "center" : "flex-start" } },
          p.glyph ? el("span", { style: { color: c.primary, display: "flex" } }, icon(p.glyph, 14)) : null,
          el("span", { style: { fontSize: "12px", color: c.textTertiary, fontWeight: "500" } }, String(p.label ?? "")),
        ),
        el(
          "div",
          { style: { display: "flex", alignItems: "baseline", gap: "6px", marginTop: "4px", justifyContent: p.align === "center" ? "center" : "flex-start" } },
          el("span", { style: { fontSize: "24px", fontWeight: "650", color: c.text, letterSpacing: "-0.02em" } }, String(p.value ?? "")),
          p.delta ? el("span", { style: { fontSize: "12px", color: c.success, fontWeight: "600" } }, String(p.delta)) : null,
        ),
      );
      node.style.textAlign = p.align || "left";
      applyBox(node, p, ctx, { level: "raised", type: "StatTile" });
      return node;
    },
  },

  List: {
    label: "List",
    category: "Data",
    glyph: "list",
    description: "Repeats a row for every record in a bound source.",
    acceptsChildren: false,
    resizable: { width: true, height: false },
    props: {
      items: [
        { title: "Avery Wilson", subtitle: "Solar installation · Mississauga", meta: "09:00", glyph: "sun" },
        { title: "Noah Patel", subtitle: "Panel inspection · Brampton", meta: "11:30", glyph: "shield" },
        { title: "Priya Raman", subtitle: "Battery service · Oakville", meta: "14:00", glyph: "zap" },
      ],
      gap: 8,
      showIcon: true,
      showChevron: true,
      rowPadding: 12,
      radius: 12,
      background: "{{theme.colors.surface}}",
      borderWidth: 1,
      borderColor: "{{theme.colors.border}}",
      emptyText: "Nothing scheduled",
    },
    fields: {
      items: f.items("Rows", { shape: ["title", "subtitle", "meta", "glyph"] }),
      gap: f.number("Gap", { min: 0, max: 24, unit: "px" }),
      showIcon: f.bool("Leading icon"),
      showChevron: f.bool("Trailing chevron"),
      rowPadding: f.number("Row padding", { min: 4, max: 24, unit: "px" }),
      radius: f.radius(),
      background: f.color("Row background", { group: "Appearance" }),
      borderWidth: f.number("Border", { group: "Appearance", min: 0, max: 4, unit: "px" }),
      borderColor: f.color("Border colour", { group: "Appearance" }),
      emptyText: f.text("Empty message"),
    },
    render(p, ctx) {
      const c = ctx.theme.colors;
      const node = el("div");
      Object.assign(node.style, { display: "flex", flexDirection: "column", gap: `${p.gap ?? 8}px` });

      const items = Array.isArray(p.items) ? p.items : [];
      if (!items.length) {
        node.appendChild(
          el("div", { style: { padding: "20px", textAlign: "center", color: c.textTertiary, fontSize: "13px" } }, String(p.emptyText || "No records")),
        );
        return node;
      }

      for (const item of items) {
        const row = el(
          "div",
          p.showIcon
            ? el("span", {
                style: { display: "grid", placeItems: "center", width: "34px", height: "34px", borderRadius: "11px", background: `color-mix(in srgb, ${c.primary} 14%, transparent)`, color: c.primary, flexShrink: "0" },
              }, icon(item.glyph || "box", 17))
            : null,
          el(
            "div",
            { style: { minWidth: 0, flex: "1 1 auto" } },
            el("div", { style: { fontSize: "14px", fontWeight: "600", color: c.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, String(item.title ?? "")),
            item.subtitle
              ? el("div", { style: { fontSize: "12px", color: c.textTertiary, marginTop: "1px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, String(item.subtitle))
              : null,
          ),
          item.meta ? el("span", { style: { fontSize: "12px", color: c.textSecondary, flexShrink: "0", fontVariantNumeric: "tabular-nums" } }, String(item.meta)) : null,
          p.showChevron ? el("span", { style: { color: c.textTertiary, display: "flex", flexShrink: "0" } }, icon("chevronRight", 15)) : null,
        );

        Object.assign(row.style, {
          display: "flex",
          alignItems: "center",
          gap: "11px",
          padding: `${p.rowPadding ?? 12}px`,
          // The row is a raised surface, so a style change reshapes every row
          // in every list at once.
          ...ctx.surface("raised", { radius: p.radius }),
        });
        node.appendChild(row);
      }
      return node;
    },
  },

  Timeline: {
    label: "Timeline",
    category: "Data",
    glyph: "activity",
    description: "Ordered events with a connecting spine.",
    acceptsChildren: false,
    resizable: { width: true, height: false },
    props: {
      items: [
        { title: "Job created", meta: "08:12", state: "done" },
        { title: "Technician assigned", meta: "08:40", state: "done" },
        { title: "On site", meta: "09:05", state: "active" },
        { title: "Report submitted", meta: "—", state: "pending" },
      ],
      gap: 16,
    },
    fields: {
      items: f.items("Events", { shape: ["title", "meta", "state"] }),
      gap: f.number("Gap", { min: 8, max: 40, unit: "px" }),
    },
    render(p, ctx) {
      const c = ctx.theme.colors;
      const node = el("div");
      Object.assign(node.style, { display: "flex", flexDirection: "column", gap: `${p.gap ?? 16}px` });

      (p.items || []).forEach((item, i, all) => {
        const tone = item.state === "done" ? c.success : item.state === "active" ? c.primary : c.textTertiary;
        node.appendChild(
          el(
            "div",
            { style: { display: "flex", gap: "12px", position: "relative" } },
            el(
              "div",
              { style: { display: "flex", flexDirection: "column", alignItems: "center", flexShrink: "0" } },
              el("span", {
                style: {
                  width: "10px",
                  height: "10px",
                  borderRadius: "999px",
                  marginTop: "4px",
                  background: item.state === "pending" ? "transparent" : tone,
                  border: `2px solid ${tone}`,
                },
              }),
              i < all.length - 1
                ? el("span", { style: { flex: "1 1 auto", width: "2px", marginTop: "4px", marginBottom: "-" + (p.gap ?? 16) + "px", background: c.border, minHeight: `${p.gap ?? 16}px` } })
                : null,
            ),
            el(
              "div",
              { style: { minWidth: 0, paddingBottom: "2px" } },
              el("div", { style: { fontSize: "14px", fontWeight: "500", color: item.state === "pending" ? c.textTertiary : c.text } }, String(item.title ?? "")),
              item.meta ? el("div", { style: { fontSize: "12px", color: c.textTertiary, marginTop: "1px" } }, String(item.meta)) : null,
            ),
          ),
        );
      });

      return node;
    },
  },

  ProgressBar: {
    label: "Progress",
    category: "Data",
    glyph: "barChart",
    description: "Completion against a target.",
    acceptsChildren: false,
    resizable: { width: true, height: false },
    props: { value: 0.64, label: "Route complete", showValue: true, height: 8, tone: "primary", radius: 999 },
    fields: {
      value: f.slider("Value", { min: 0, max: 1, step: 0.01 }),
      label: f.text("Label"),
      showValue: f.bool("Show percentage"),
      height: f.number("Thickness", { min: 3, max: 24, unit: "px" }),
      tone: f.select("Tone", [
        { value: "primary", label: "Primary" },
        { value: "success", label: "Success" },
        { value: "warning", label: "Warning" },
        { value: "danger", label: "Danger" },
      ]),
      radius: f.radius(),
    },
    render(p, ctx) {
      const c = ctx.theme.colors;
      const tone = c[p.tone] || c.primary;
      const pct = Math.round((p.value ?? 0) * 100);

      return el(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: "7px" } },
        (p.label || p.showValue) &&
          el(
            "div",
            { style: { display: "flex", alignItems: "baseline", gap: "8px" } },
            p.label ? el("span", { style: { fontSize: "13px", color: c.textSecondary } }, String(p.label)) : null,
            el("span", { style: { flex: "1 1 auto" } }),
            p.showValue ? el("span", { style: { fontSize: "13px", fontWeight: "600", color: c.text } }, `${pct}%`) : null,
          ),
        el(
          "div",
          { style: { height: `${p.height ?? 8}px`, borderRadius: radiusCss(p.radius), background: c.surfaceSunken, overflow: "hidden" } },
          el("div", { style: { width: `${pct}%`, height: "100%", borderRadius: radiusCss(p.radius), background: tone, transition: "width 240ms cubic-bezier(0.2,0,0,1)" } }),
        ),
      );
    },
  },

  Map: {
    label: "Map",
    category: "Data",
    glyph: "mapPin",
    description: "A location preview with pins.",
    acceptsChildren: false,
    resizable: { width: true, height: true, minHeight: 100, maxHeight: 420 },
    props: { caption: "Mississauga, ON", pins: 3, size: { width: "fill", height: 180 }, radius: 14 },
    fields: {
      caption: f.text("Caption"),
      pins: f.number("Pins", { min: 0, max: 12 }),
      size: f.size(),
      radius: f.radius(),
    },
    render(p, ctx) {
      const c = ctx.theme.colors;
      const node = el("div");
      Object.assign(node.style, {
        position: "relative",
        width: sizeCss(p.size, "width") || "100%",
        height: `${p.size?.height ?? 180}px`,
        borderRadius: radiusCss(p.radius),
        overflow: "hidden",
        background: c.surfaceSunken,
        border: `1px solid ${c.border}`,
      });

      // A schematic street grid. Honest about being a placeholder while still
      // reading as a map at preview size.
      const lines = [];
      for (let i = 1; i < 6; i += 1) {
        lines.push(`<line x1="0" y1="${i * 34}" x2="300" y2="${i * 34 - 12}" stroke="${c.border}" stroke-width="1"/>`);
        lines.push(`<line x1="${i * 52}" y1="0" x2="${i * 52 + 14}" y2="200" stroke="${c.border}" stroke-width="1"/>`);
      }
      node.appendChild(
        el("div", {
          style: { position: "absolute", inset: 0 },
          html: `<svg viewBox="0 0 300 200" preserveAspectRatio="none" style="width:100%;height:100%">${lines.join("")}</svg>`,
        }),
      );

      for (let i = 0; i < (p.pins ?? 0); i += 1) {
        const pin = el("span", { style: { position: "absolute", left: `${18 + i * 21}%`, top: `${32 + ((i * 37) % 44)}%`, color: c.primary } }, icon("mapPin", 22));
        node.appendChild(pin);
      }

      if (p.caption) {
        node.appendChild(
          el("div", {
            style: {
              position: "absolute",
              left: "10px",
              bottom: "10px",
              padding: "5px 10px",
              borderRadius: "999px",
              background: c.surface,
              border: `1px solid ${c.border}`,
              color: c.text,
              fontSize: "12px",
              fontWeight: "500",
            },
          }, String(p.caption)),
        );
      }

      return node;
    },
  },

  /* ===== Input =========================================================== */

  Input: {
    label: "Text field",
    category: "Input",
    glyph: "input",
    description: "Single-line capture.",
    acceptsChildren: false,
    resizable: { width: true, height: true, minHeight: 36, maxHeight: 72 },
    states: ["focus", "disabled", "error"],
    props: {
      label: "Customer name",
      placeholder: "Enter a name",
      value: "",
      required: false,
      helpText: "",
      inputType: "text",
      size: { width: "fill", height: 46 },
      radius: 12,
    },
    fields: {
      label: f.text("Label"),
      placeholder: f.text("Placeholder"),
      value: f.text("Value"),
      inputType: f.select("Type", [
        { value: "text", label: "Text" },
        { value: "email", label: "Email" },
        { value: "tel", label: "Phone" },
        { value: "number", label: "Number" },
        { value: "date", label: "Date" },
        { value: "password", label: "Password" },
      ]),
      required: f.bool("Required"),
      helpText: f.text("Help text"),
      size: f.size(),
      radius: f.radius(),
    },
    render(p, ctx) {
      const c = ctx.theme.colors;
      const box = el("div", { style: { display: "flex", alignItems: "center", padding: "0 14px" } }, el("span", { style: { color: p.value ? c.text : c.textTertiary, fontSize: "14px" } }, String(p.value || p.placeholder || "")));
      Object.assign(box.style, {
        height: `${p.size?.height ?? 46}px`,
        ...ctx.surface("inset", { radius: p.radius }),
      });

      return el(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: "6px", width: sizeCss(p.size, "width") || "100%" } },
        p.label
          ? el(
              "label",
              { style: { fontSize: "13px", fontWeight: "500", color: c.textSecondary } },
              String(p.label),
              p.required ? el("span", { style: { color: c.danger, marginLeft: "3px" } }, "*") : null,
            )
          : null,
        box,
        p.helpText ? el("span", { style: { fontSize: "12px", color: c.textTertiary } }, String(p.helpText)) : null,
      );
    },
  },

  Select: {
    label: "Select",
    category: "Input",
    glyph: "chevronDown",
    description: "Choose one from a list.",
    acceptsChildren: false,
    resizable: { width: true, height: true, minHeight: 36, maxHeight: 72 },
    props: {
      label: "Job type",
      options: ["Installation", "Inspection", "Repair"],
      value: "Installation",
      size: { width: "fill", height: 46 },
      radius: 12,
    },
    fields: {
      label: f.text("Label"),
      options: f.items("Options"),
      value: f.text("Selected"),
      size: f.size(),
      radius: f.radius(),
    },
    render(p, ctx) {
      const c = ctx.theme.colors;
      const box = el(
        "div",
        el("span", { style: { flex: "1 1 auto", fontSize: "14px", color: c.text } }, String(p.value ?? "")),
        el("span", { style: { color: c.textTertiary, display: "flex" } }, icon("chevronDown", 16)),
      );
      Object.assign(box.style, {
        display: "flex",
        alignItems: "center",
        gap: "8px",
        height: `${p.size?.height ?? 46}px`,
        padding: "0 14px",
        ...ctx.surface("inset", { radius: p.radius }),
      });

      return el(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: "6px", width: sizeCss(p.size, "width") || "100%" } },
        p.label ? el("label", { style: { fontSize: "13px", fontWeight: "500", color: c.textSecondary } }, String(p.label)) : null,
        box,
      );
    },
  },

  Toggle: {
    label: "Toggle row",
    category: "Input",
    glyph: "toggle",
    description: "A labelled switch.",
    acceptsChildren: false,
    resizable: { width: true, height: false },
    props: { label: "Send arrival notification", description: "", value: true },
    fields: {
      label: f.text("Label"),
      description: f.text("Description"),
      value: f.bool("On"),
    },
    render(p, ctx) {
      const c = ctx.theme.colors;
      return el(
        "div",
        { style: { display: "flex", alignItems: "center", gap: "14px" } },
        el(
          "div",
          { style: { flex: "1 1 auto", minWidth: 0 } },
          el("div", { style: { fontSize: "14px", color: c.text, fontWeight: "500" } }, String(p.label ?? "")),
          p.description ? el("div", { style: { fontSize: "12px", color: c.textTertiary, marginTop: "2px" } }, String(p.description)) : null,
        ),
        el(
          "span",
          {
            style: {
              position: "relative",
              width: "44px",
              height: "26px",
              borderRadius: "999px",
              background: p.value ? c.primary : c.surfaceSunken,
              border: `1px solid ${p.value ? "transparent" : c.border}`,
              flexShrink: "0",
              transition: "background 160ms cubic-bezier(0.2,0,0,1)",
            },
          },
          el("span", {
            style: {
              position: "absolute",
              top: "3px",
              left: p.value ? "21px" : "3px",
              width: "18px",
              height: "18px",
              borderRadius: "999px",
              background: p.value ? c.onPrimary : c.textTertiary,
              transition: "left 160ms cubic-bezier(0.2,0,0,1)",
            },
          }),
        ),
      );
    },
  },

  /* ===== Feedback ======================================================== */

  Callout: {
    label: "Callout",
    category: "Feedback",
    glyph: "info",
    description: "An inline notice with a tone.",
    acceptsChildren: false,
    resizable: { width: true, height: false },
    props: {
      title: "Parts arriving late",
      body: "The inverter ships Thursday. Reschedule if the customer cannot wait.",
      tone: "warning",
      glyph: "alert",
      radius: 12,
      padding: { top: 12, right: 14, bottom: 12, left: 14 },
    },
    fields: {
      title: f.text("Title"),
      body: f.textarea("Body"),
      tone: f.select("Tone", [
        { value: "info", label: "Info" },
        { value: "success", label: "Success" },
        { value: "warning", label: "Warning" },
        { value: "danger", label: "Danger" },
      ]),
      glyph: f.glyph("Icon"),
      radius: f.radius(),
      padding: f.spacing("Padding", { group: "Spacing" }),
    },
    render(p, ctx) {
      const c = ctx.theme.colors;
      const tone = c[p.tone] || c.info;
      const node = el(
        "div",
        p.glyph ? el("span", { style: { color: tone, display: "flex", flexShrink: "0", marginTop: "1px" } }, icon(p.glyph, 16)) : null,
        el(
          "div",
          { style: { minWidth: 0 } },
          p.title ? el("div", { style: { fontSize: "13px", fontWeight: "600", color: c.text } }, String(p.title)) : null,
          p.body ? el("div", { style: { fontSize: "13px", color: c.textSecondary, marginTop: "2px", lineHeight: "1.45" } }, String(p.body)) : null,
        ),
      );
      Object.assign(node.style, {
        display: "flex",
        gap: "10px",
        padding: spacingCss(p.padding),
        borderRadius: radiusCss(p.radius),
        background: `color-mix(in srgb, ${tone} 11%, transparent)`,
        border: `1px solid color-mix(in srgb, ${tone} 30%, transparent)`,
      });
      return node;
    },
  },

  EmptyState: {
    label: "Empty state",
    category: "Feedback",
    glyph: "box",
    description: "What a screen shows when it has no data.",
    acceptsChildren: false,
    resizable: { width: true, height: true, minHeight: 100 },
    props: {
      glyph: "calendar",
      title: "Nothing scheduled",
      body: "New jobs appear here as soon as dispatch assigns them.",
      actionLabel: "Refresh",
      padding: { top: 32, right: 24, bottom: 32, left: 24 },
    },
    fields: {
      glyph: f.glyph("Icon"),
      title: f.text("Title"),
      body: f.textarea("Body"),
      actionLabel: f.text("Action label"),
      padding: f.spacing("Padding", { group: "Spacing" }),
    },
    render(p, ctx) {
      const c = ctx.theme.colors;
      const node = el(
        "div",
        el("span", { style: { display: "grid", placeItems: "center", width: "52px", height: "52px", borderRadius: "16px", background: c.surfaceSunken, color: c.textTertiary } }, icon(p.glyph || "box", 24)),
        el("div", { style: { fontSize: "15px", fontWeight: "600", color: c.text, marginTop: "14px" } }, String(p.title ?? "")),
        p.body ? el("div", { style: { fontSize: "13px", color: c.textTertiary, marginTop: "4px", maxWidth: "30ch", lineHeight: "1.5" } }, String(p.body)) : null,
        p.actionLabel
          ? el("div", { style: { marginTop: "16px", padding: "10px 18px", borderRadius: "10px", background: c.surfaceSunken, border: `1px solid ${c.border}`, color: c.text, fontSize: "13px", fontWeight: "600" } }, String(p.actionLabel))
          : null,
      );
      Object.assign(node.style, {
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        textAlign: "center",
        padding: spacingCss(p.padding),
      });
      return node;
    },
  },
};

/* ---------------------------------------------------------------------------
   Registry helpers
   --------------------------------------------------------------------------- */

export const componentTypes = Object.keys(registry);

export const categories = CATEGORIES.filter((c) => componentTypes.some((t) => registry[t].category === c.key));

export const getDef = (type) => registry[type] ?? null;

/** Defaults for a fresh node of this type. Deep-copied so nodes never alias. */
export function defaultProps(type) {
  const def = registry[type];
  if (!def) return {};
  return structuredClone(def.props ?? {});
}

/** Every field for a type, grouped for the inspector, in declaration order. */
export function groupedFields(type) {
  const def = registry[type];
  if (!def) return [];

  const groups = new Map();
  for (const [key, spec] of Object.entries(def.fields ?? {})) {
    const group = spec.group ?? "Content";
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push({ key, ...spec });
  }

  // A stable, meaningful order regardless of declaration order.
  const order = ["Content", "Size", "Spacing", "Typography", "Appearance"];
  return [...groups.entries()]
    .sort((a, b) => {
      const ai = order.indexOf(a[0]);
      const bi = order.indexOf(b[0]);
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    })
    .map(([name, fields]) => ({ name, fields }));
}
