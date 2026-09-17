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
  { key: "Tasks", glyph: "listChecks", hint: "Projects, tasks and boards" },
  { key: "Notes", glyph: "note", hint: "Notes, labels and long text" },
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
   Domain primitives

   Small pieces shared by the task, project and note components. They live here
   rather than inside one component because a priority flag must look the same
   on a task row, a board card and a project header, and the only way to
   guarantee that is for there to be one of it.
   --------------------------------------------------------------------------- */

/** Initials, the same way Avatar derives them. */
function initials(name, count = 2) {
  const parts = String(name || "?").trim().split(/\s+/);
  const first = parts[0]?.[0] ?? "?";
  if (count < 2 || parts.length < 2) return first.toUpperCase();
  return (first + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * A readable foreground for an arbitrary background.
 *
 * Relative luminance per WCAG, which matters because tag and chip colours are
 * author-chosen: a solid amber tag with white text fails AA, and the author
 * has no way to know unless the component decides for them.
 */
export function readableOn(background, colors) {
  const hex = String(background || "").trim();
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex);
  if (!m) return colors?.onPrimary ?? "#ffffff";

  const raw = m[1].length === 3 ? m[1].split("").map((ch) => ch + ch).join("") : m[1];
  const channel = (i) => {
    const v = parseInt(raw.slice(i * 2, i * 2 + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
  return luminance > 0.45 ? "#101114" : "#ffffff";
}

/** A circular initials bubble, used wherever a person appears inline. */
function initialsBubble(name, colors, side = 26, letters = 2) {
  return el(
    "span",
    {
      style: {
        display: "grid",
        placeItems: "center",
        width: `${side}px`,
        height: `${side}px`,
        borderRadius: "999px",
        flexShrink: "0",
        background: colors.surfaceSunken,
        color: colors.textSecondary,
        fontSize: `${Math.max(9, Math.round(side * (letters < 2 ? 0.44 : 0.38)))}px`,
        fontWeight: "650",
        letterSpacing: "0.01em",
      },
    },
    initials(name, letters),
  );
}

/**
 * Overlapping members with a "+n" when the list runs past `max`.
 *
 * Only the leading bubble is fully visible; the rest are cropped to the
 * uncovered slice. Two centred letters never fit in that slice at any size —
 * the label is about 0.49 of the diameter wide, leaving 0.26 of clearance
 * against a 0.28 overlap — so they clip to nonsense like ";O". A stack
 * therefore shows one letter per person; a stack of one shows both, because
 * nothing covers it.
 */
function avatarStack(names, colors, side = 26, max = 4) {
  const shown = names.slice(0, max);
  const overflow = names.length - shown.length;
  const lift = Math.round(side * 0.28);
  const node = el("div", { style: { display: "flex", alignItems: "center" } });

  shown.forEach((name, i) => {
    const bubble = initialsBubble(name, colors, side, shown.length > 1 || overflow > 0 ? 1 : 2);
    Object.assign(bubble.style, {
      marginLeft: i === 0 ? "0" : `-${lift}px`,
      boxShadow: `0 0 0 2px ${colors.surface}`,
      zIndex: String(shown.length - i),
    });
    node.appendChild(bubble);
  });

  if (overflow > 0) {
    // The counter is the rightmost bubble, so it is the most covered one. Its
    // label is padded into the uncovered slice instead of centred in a box
    // whose left half is hidden behind the last avatar.
    const more = el(
      "span",
      {
        style: {
          display: "grid",
          placeItems: "center",
          boxSizing: "border-box",
          width: `${side}px`,
          height: `${side}px`,
          paddingLeft: `${lift}px`,
          borderRadius: "999px",
          marginLeft: `-${lift}px`,
          background: colors.surface,
          color: colors.textTertiary,
          fontSize: `${Math.max(9, Math.round(side * 0.34))}px`,
          fontWeight: "650",
          boxShadow: `0 0 0 2px ${colors.surface}, inset 0 0 0 1px ${colors.border}`,
        },
      },
      `+${overflow}`,
    );
    node.appendChild(more);
  }
  return node;
}

const TASK_STATES = {
  open: { glyph: "square", tone: "textTertiary" },
  doing: { glyph: "circleDot", tone: "primary" },
  done: { glyph: "checkSquare", tone: "success" },
  blocked: { glyph: "alertCircle", tone: "danger" },
};

/** The state marker on a task row. */
function taskMark(state, colors) {
  const spec = TASK_STATES[state] ?? TASK_STATES.open;
  return el("span", { style: { display: "flex", flexShrink: "0", color: colors[spec.tone] ?? colors.textTertiary } }, icon(spec.glyph, 18));
}

const PRIORITIES = {
  low: { tone: "textTertiary", label: "Low" },
  medium: { tone: "info", label: "Medium" },
  high: { tone: "warning", label: "High" },
  urgent: { tone: "danger", label: "Urgent" },
};

/** A priority flag, or nothing at all when the priority is "none". */
function priorityMark(priority, colors) {
  const spec = PRIORITIES[priority];
  if (!spec) return null;
  return el("span", { style: { display: "flex", flexShrink: "0", color: colors[spec.tone] ?? colors.textTertiary }, title: spec.label }, icon("flag", 13));
}

/** A soft pill for a label. */
function tagPill(text, colors, colour = null) {
  const tone = colour || colors.textTertiary;
  return el(
    "span",
    {
      style: {
        display: "inline-flex",
        alignItems: "center",
        padding: "2px 7px",
        borderRadius: "999px",
        fontSize: "10.5px",
        fontWeight: "600",
        letterSpacing: "0.01em",
        whiteSpace: "nowrap",
        background: `color-mix(in srgb, ${tone} 15%, transparent)`,
        color: tone,
      },
    },
    String(text ?? ""),
  );
}

/** A due date, tinted red once it is past. */
function dueChip(text, overdue, colors) {
  const tone = overdue ? colors.danger : colors.textSecondary;
  return el(
    "span",
    {
      style: {
        display: "inline-flex",
        alignItems: "center",
        gap: "4px",
        flexShrink: "0",
        padding: overdue ? "2px 7px" : "0",
        borderRadius: "999px",
        background: overdue ? `color-mix(in srgb, ${colors.danger} 14%, transparent)` : "transparent",
        fontSize: "11.5px",
        fontWeight: overdue ? "650" : "500",
        color: tone,
        fontVariantNumeric: "tabular-nums",
      },
    },
    icon(overdue ? "alertCircle" : "calendar", 12),
    String(text ?? ""),
  );
}

/**
 * A progress ring.
 *
 * Drawn as SVG with a dash offset rather than two stacked conic gradients,
 * because a conic gradient cannot round its own cap and the join shows.
 */
function progressRing(pct, tone, colors, diameter = 84, thickness = 8, showValue = true) {
  const r = (diameter - thickness) / 2;
  const circumference = 2 * Math.PI * r;
  const filled = (Math.max(0, Math.min(100, pct)) / 100) * circumference;

  const wrap = el("div", { style: { position: "relative", width: `${diameter}px`, height: `${diameter}px`, flexShrink: "0" } });
  wrap.appendChild(
    el("div", {
      style: { position: "absolute", inset: "0" },
      html:
        `<svg viewBox="0 0 ${diameter} ${diameter}" style="width:100%;height:100%;transform:rotate(-90deg)">` +
        `<circle cx="${diameter / 2}" cy="${diameter / 2}" r="${r}" fill="none" stroke="${colors.surfaceSunken}" stroke-width="${thickness}"/>` +
        `<circle cx="${diameter / 2}" cy="${diameter / 2}" r="${r}" fill="none" stroke="${tone}" stroke-width="${thickness}"` +
        ` stroke-linecap="round" stroke-dasharray="${filled} ${circumference}"/>` +
        `</svg>`,
    }),
  );

  if (showValue) {
    wrap.appendChild(
      el(
        "div",
        {
          style: {
            position: "absolute",
            inset: "0",
            display: "grid",
            placeItems: "center",
            fontSize: `${Math.max(11, Math.round(diameter * 0.24))}px`,
            fontWeight: "680",
            color: colors.text,
            letterSpacing: "-0.02em",
            fontVariantNumeric: "tabular-nums",
          },
        },
        `${pct}%`,
      ),
    );
  }
  return wrap;
}

/** One block of a rich-text note body. */
function richBlock(block, { c, base, ordinal }) {
  const text = String(block.text ?? "");

  switch (block.kind) {
    case "h1":
      return el("div", { style: { fontSize: `${base + 9}px`, fontWeight: "680", color: c.text, letterSpacing: "-0.02em", lineHeight: "1.25" } }, text);
    case "h2":
      return el("div", { style: { fontSize: `${base + 4}px`, fontWeight: "660", color: c.text, letterSpacing: "-0.01em", lineHeight: "1.3" } }, text);
    case "h3":
      return el("div", { style: { fontSize: `${base + 1}px`, fontWeight: "640", color: c.text, lineHeight: "1.35" } }, text);

    case "bullet":
      return el(
        "div",
        { style: { display: "flex", gap: "9px", alignItems: "flex-start" } },
        el("span", { style: { width: "5px", height: "5px", borderRadius: "999px", background: c.textTertiary, flexShrink: "0", marginTop: `${Math.round(base * 0.55)}px` } }),
        el("span", { style: { fontSize: `${base}px`, lineHeight: "1.55", color: c.textSecondary } }, text),
      );

    case "number":
      return el(
        "div",
        { style: { display: "flex", gap: "9px", alignItems: "flex-start" } },
        el("span", { style: { fontSize: `${base - 1}px`, fontWeight: "600", color: c.textTertiary, flexShrink: "0", minWidth: "14px", fontVariantNumeric: "tabular-nums" } }, `${ordinal}.`),
        el("span", { style: { fontSize: `${base}px`, lineHeight: "1.55", color: c.textSecondary } }, text),
      );

    case "todo":
      return el(
        "div",
        { style: { display: "flex", gap: "8px", alignItems: "flex-start" } },
        el("span", { style: { display: "flex", flexShrink: "0", marginTop: "1px", color: block.done ? c.success : c.textTertiary } }, icon(block.done ? "checkSquare" : "square", base + 2)),
        el(
          "span",
          { style: { fontSize: `${base}px`, lineHeight: "1.5", color: block.done ? c.textTertiary : c.textSecondary, textDecoration: block.done ? "line-through" : "none" } },
          text,
        ),
      );

    case "quote":
      return el(
        "div",
        {
          style: {
            paddingLeft: "12px",
            borderLeft: `2px solid ${c.border}`,
            fontSize: `${base}px`,
            lineHeight: "1.55",
            fontStyle: "italic",
            color: c.textSecondary,
          },
        },
        text,
      );

    case "code":
      return el(
        "div",
        {
          style: {
            padding: "10px 12px",
            borderRadius: "9px",
            background: c.surfaceSunken,
            border: `1px solid ${c.border}`,
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            fontSize: `${base - 1.5}px`,
            lineHeight: "1.5",
            color: c.text,
            whiteSpace: "pre-wrap",
            overflowX: "auto",
          },
        },
        text,
      );

    case "divider":
      return el("div", { style: { height: "1px", background: c.border, margin: "4px 0" } });

    default:
      return el("div", { style: { fontSize: `${base}px`, lineHeight: "1.55", color: c.textSecondary } }, text);
  }
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
      showValue: f.bool("Percentage"),
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


  /* ===== Projects, tasks and notes =======================================
     The domain set. These are the components the app is actually built from,
     so they carry real semantics — a task knows it can be done, a note knows
     it can be pinned — rather than being generic rows that happen to look
     right. Every one of them reads its surface from the active style, so a
     board and a note list restyle together.
     ====================================================================== */

  TaskRow: {
    label: "Task row",
    category: "Tasks",
    glyph: "checkSquare",
    description: "One task: state, title, due date, priority, assignee.",
    acceptsChildren: false,
    resizable: { width: true, height: false },
    states: ["hover", "pressed", "selected"],
    props: {
      title: "Draft the Q3 rollout plan",
      note: "",
      state: "open",
      priority: "none",
      due: "Thu",
      overdue: false,
      assignee: "",
      tags: [],
      showHandle: false,
      rowPadding: 12,
      radius: 12,
      background: "{{theme.colors.surface}}",
      borderWidth: 1,
      borderColor: "{{theme.colors.border}}",
    },
    fields: {
      title: f.text("Title"),
      note: f.text("Secondary line"),
      state: f.segmented("State", [
        { value: "open", icon: "square", tip: "Open" },
        { value: "doing", icon: "circleDot", tip: "In progress" },
        { value: "done", icon: "checkSquare", tip: "Done" },
        { value: "blocked", icon: "alertCircle", tip: "Blocked" },
      ]),
      priority: f.select("Priority", [
        { value: "none", label: "None" },
        { value: "low", label: "Low" },
        { value: "medium", label: "Medium" },
        { value: "high", label: "High" },
        { value: "urgent", label: "Urgent" },
      ]),
      due: f.text("Due"),
      overdue: f.bool("Past due"),
      assignee: f.text("Assignee"),
      tags: f.items("Tags"),
      showHandle: f.bool("Drag handle"),
      rowPadding: f.number("Row padding", { min: 4, max: 24, unit: "px" }),
      ...boxFields,
    },
    render(p, ctx) {
      const c = ctx.theme.colors;
      const done = p.state === "done";

      const node = el(
        "div",
        p.showHandle ? el("span", { style: { color: c.textTertiary, display: "flex", flexShrink: "0", cursor: "grab" } }, icon("dragHandle", 14)) : null,
        taskMark(p.state, c),
        el(
          "div",
          { style: { minWidth: 0, flex: "1 1 auto", display: "flex", flexDirection: "column", gap: "2px" } },
          el(
            "div",
            { style: { display: "flex", alignItems: "center", gap: "6px", minWidth: 0 } },
            el("span", {
              style: {
                fontSize: "14px",
                fontWeight: "500",
                color: done ? c.textTertiary : c.text,
                textDecoration: done ? "line-through" : "none",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              },
            }, String(p.title ?? "")),
            priorityMark(p.priority, c),
          ),
          p.note ? el("div", { style: { fontSize: "12px", color: c.textTertiary, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, String(p.note)) : null,
          Array.isArray(p.tags) && p.tags.length
            ? el("div", { style: { display: "flex", gap: "4px", flexWrap: "wrap", marginTop: "3px" } }, ...p.tags.map((t) => tagPill(t, c)))
            : null,
        ),
        p.due ? dueChip(p.due, p.overdue && !done, c) : null,
        p.assignee ? initialsBubble(p.assignee, c, 24) : null,
      );

      Object.assign(node.style, {
        display: "flex",
        alignItems: "center",
        gap: "10px",
        padding: `${p.rowPadding ?? 12}px`,
        opacity: done ? "0.72" : "1",
      });
      applyBox(node, p, ctx, { level: "raised", type: "TaskRow" });
      return node;
    },
  },

  TaskList: {
    label: "Task list",
    category: "Tasks",
    glyph: "listChecks",
    description: "A titled group of tasks with a completion count.",
    acceptsChildren: false,
    resizable: { width: true, height: false },
    props: {
      title: "This week",
      showCount: true,
      showProgress: true,
      gap: 8,
      rowPadding: 12,
      radius: 12,
      items: [
        { title: "Draft the Q3 rollout plan", state: "doing", priority: "high", due: "Thu", assignee: "Maya Chen", done: false },
        { title: "Review vendor quotes", state: "open", priority: "medium", due: "Fri", assignee: "Sam Okafor", done: false },
        { title: "Confirm the venue deposit", state: "done", priority: "none", due: "Mon", assignee: "Maya Chen", done: true },
        { title: "Waiting on legal sign-off", state: "blocked", priority: "urgent", due: "Wed", assignee: "", done: false },
      ],
      emptyText: "Nothing due",
    },
    fields: {
      title: f.text("Group title"),
      showCount: f.bool("Show count"),
      showProgress: f.bool("Progress bar"),
      items: f.items("Tasks", {
        shape: [
          { key: "title" },
          {
            key: "state",
            label: "State",
            control: "select",
            options: [
              { value: "open", label: "Open" },
              { value: "doing", label: "In progress" },
              { value: "done", label: "Done" },
              { value: "blocked", label: "Blocked" },
            ],
          },
          {
            key: "priority",
            label: "Priority",
            control: "select",
            options: [
              { value: "none", label: "None" },
              { value: "low", label: "Low" },
              { value: "medium", label: "Medium" },
              { value: "high", label: "High" },
              { value: "urgent", label: "Urgent" },
            ],
          },
          { key: "due", label: "Due" },
          { key: "assignee", label: "Assignee" },
        ],
      }),
      gap: f.number("Gap", { min: 0, max: 24, unit: "px" }),
      rowPadding: f.number("Row padding", { min: 4, max: 24, unit: "px" }),
      radius: f.radius(),
      emptyText: f.text("Empty message"),
    },
    render(p, ctx) {
      const c = ctx.theme.colors;
      const items = Array.isArray(p.items) ? p.items : [];
      // `state` is the source of truth; a legacy `done` flag is honoured so
      // rows authored before the four-state model still read correctly.
      const isDone = (t) => t.state === "done" || (t.state === undefined && Boolean(t.done));
      const complete = items.filter(isDone).length;

      const node = el("div");
      Object.assign(node.style, { display: "flex", flexDirection: "column", gap: `${p.gap ?? 8}px` });

      if (p.title || p.showCount) {
        node.appendChild(
          el(
            "div",
            { style: { display: "flex", alignItems: "baseline", gap: "8px", paddingBottom: "2px" } },
            p.title ? el("span", { style: { fontSize: "13px", fontWeight: "600", color: c.text, letterSpacing: "0.01em" } }, String(p.title)) : null,
            el("span", { style: { flex: "1 1 auto" } }),
            p.showCount && items.length
              ? el("span", { style: { fontSize: "12px", color: c.textTertiary, fontVariantNumeric: "tabular-nums" } }, `${complete}/${items.length}`)
              : null,
          ),
        );
      }

      if (p.showProgress && items.length) {
        node.appendChild(
          el(
            "div",
            { style: { height: "4px", borderRadius: "999px", background: c.surfaceSunken, overflow: "hidden", marginBottom: "2px" } },
            el("div", {
              style: {
                width: `${Math.round((complete / items.length) * 100)}%`,
                height: "100%",
                borderRadius: "999px",
                background: complete === items.length ? c.success : c.primary,
                transition: "width 240ms cubic-bezier(0.2,0,0,1)",
              },
            }),
          ),
        );
      }

      if (!items.length) {
        node.appendChild(
          el("div", { style: { padding: "18px", textAlign: "center", color: c.textTertiary, fontSize: "13px" } }, String(p.emptyText || "Nothing here")),
        );
        return node;
      }

      for (const item of items) {
        const state = item.state ?? (item.done ? "done" : "open");
        const row = registry.TaskRow.render(
          { ...registry.TaskRow.props, ...item, state, rowPadding: p.rowPadding ?? 12, radius: p.radius ?? 12, tags: item.tags ?? [] },
          ctx,
        );
        node.appendChild(row);
      }
      return node;
    },
  },

  Checklist: {
    label: "Checklist",
    category: "Tasks",
    glyph: "subtask",
    description: "Subtasks under a parent, with a done count.",
    acceptsChildren: false,
    resizable: { width: true, height: false },
    props: {
      title: "Acceptance criteria",
      items: [
        { text: "Copy reviewed", done: true },
        { text: "Screenshots attached", done: true },
        { text: "Stakeholder sign-off", done: false },
        { text: "Scheduled for release", done: false },
      ],
      showCount: true,
      showAdd: true,
      addLabel: "Add an item",
      gap: 2,
      padding: { top: 14, right: 14, bottom: 14, left: 14 },
      radius: 14,
      background: "{{theme.colors.surface}}",
      borderWidth: 1,
      borderColor: "{{theme.colors.border}}",
      shadow: "none",
    },
    fields: {
      title: f.text("Title"),
      items: f.items("Items", {
        shape: [{ key: "text", label: "Text" }, { key: "done", label: "Done", control: "switch" }],
      }),
      showCount: f.bool("Show count"),
      showAdd: f.bool("Add row"),
      addLabel: f.text("Add label"),
      gap: f.number("Gap", { min: 0, max: 16, unit: "px" }),
      ...boxFields,
    },
    render(p, ctx) {
      const c = ctx.theme.colors;
      const items = Array.isArray(p.items) ? p.items : [];
      const complete = items.filter((i) => i.done).length;

      const node = el(
        "div",
        p.title || p.showCount
          ? el(
              "div",
              { style: { display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px" } },
              p.title ? el("span", { style: { fontSize: "13px", fontWeight: "600", color: c.text } }, String(p.title)) : null,
              el("span", { style: { flex: "1 1 auto" } }),
              p.showCount && items.length
                ? el(
                    "span",
                    { style: { fontSize: "11px", fontWeight: "600", color: complete === items.length ? c.success : c.textTertiary, fontVariantNumeric: "tabular-nums" } },
                    `${complete} of ${items.length}`,
                  )
                : null,
            )
          : null,
        el(
          "div",
          { style: { display: "flex", flexDirection: "column", gap: `${p.gap ?? 2}px` } },
          ...items.map((item) =>
            el(
              "div",
              { style: { display: "flex", alignItems: "flex-start", gap: "9px", padding: "5px 0" } },
              el("span", { style: { display: "flex", flexShrink: "0", marginTop: "1px", color: item.done ? c.success : c.textTertiary } }, icon(item.done ? "checkSquare" : "square", 16)),
              el("span", {
                style: {
                  fontSize: "13.5px",
                  lineHeight: "1.45",
                  color: item.done ? c.textTertiary : c.text,
                  textDecoration: item.done ? "line-through" : "none",
                },
              }, String(item.text ?? "")),
            ),
          ),
          p.showAdd
            ? el(
                "div",
                { style: { display: "flex", alignItems: "center", gap: "9px", padding: "6px 0 0", color: c.textTertiary } },
                el("span", { style: { display: "flex", flexShrink: "0" } }, icon("plus", 15)),
                el("span", { style: { fontSize: "13px" } }, String(p.addLabel || "Add an item")),
              )
            : null,
        ),
      );

      applyBox(node, p, ctx, { level: "raised", type: "Checklist" });
      return node;
    },
  },

  KanbanBoard: {
    label: "Board",
    category: "Tasks",
    glyph: "kanban",
    description: "Columns of cards that scroll sideways.",
    acceptsChildren: false,
    resizable: { width: true, height: true, minHeight: 180 },
    props: {
      columns: [
        { title: "Backlog", accent: "{{theme.colors.textTertiary}}", cards: "Rewrite onboarding copy\nAudit the icon set\nMove docs to the new host" },
        { title: "In progress", accent: "{{theme.colors.primary}}", cards: "Q3 rollout plan\nVendor comparison" },
        { title: "Done", accent: "{{theme.colors.success}}", cards: "Venue deposit\nBudget sign-off" },
      ],
      columnWidth: 172,
      gap: 12,
      showCount: true,
      cardRadius: 10,
      columnRadius: 14,
    },
    fields: {
      columns: f.items("Columns", {
        shape: [
          { key: "title", label: "Title" },
          { key: "accent", label: "Accent", control: "color" },
          { key: "cards", label: "Cards", placeholder: "One per line" },
        ],
      }),
      columnWidth: f.number("Column width", { min: 120, max: 280, unit: "px" }),
      gap: f.number("Gap", { min: 4, max: 24, unit: "px" }),
      showCount: f.bool("Card count"),
      cardRadius: f.radius("Card radius"),
      columnRadius: f.radius("Column radius"),
    },
    render(p, ctx) {
      const c = ctx.theme.colors;
      const columns = Array.isArray(p.columns) ? p.columns : [];

      const node = el("div");
      Object.assign(node.style, {
        display: "flex",
        gap: `${p.gap ?? 12}px`,
        overflowX: "auto",
        paddingBottom: "4px",
        // The board is the one component that bleeds past the screen padding,
        // because a column clipped at the edge is how a board says "scroll".
        scrollbarWidth: "none",
      });

      for (const column of columns) {
        const cards = String(column.cards ?? "").split("\n").map((s) => s.trim()).filter(Boolean);
        const accent = resolveToken(column.accent || "{{theme.colors.primary}}", ctx.theme);

        const col = el(
          "div",
          el(
            "div",
            { style: { display: "flex", alignItems: "center", gap: "7px", marginBottom: "10px" } },
            el("span", { style: { width: "7px", height: "7px", borderRadius: "999px", background: accent, flexShrink: "0" } }),
            el("span", { style: { fontSize: "12px", fontWeight: "650", color: c.text, letterSpacing: "0.02em", textTransform: "uppercase" } }, String(column.title ?? "")),
            el("span", { style: { flex: "1 1 auto" } }),
            p.showCount ? el("span", { style: { fontSize: "11px", color: c.textTertiary, fontVariantNumeric: "tabular-nums" } }, String(cards.length)) : null,
          ),
          el(
            "div",
            { style: { display: "flex", flexDirection: "column", gap: "7px" } },
            ...cards.map((text) => {
              const card = el("div", el("span", { style: { fontSize: "13px", lineHeight: "1.4", color: c.text } }, text));
              Object.assign(card.style, { padding: "10px 11px", ...ctx.surface("raised", { radius: p.cardRadius ?? 10 }) });
              return card;
            }),
            el(
              "div",
              { style: { display: "flex", alignItems: "center", gap: "6px", padding: "7px 2px", color: c.textTertiary, fontSize: "12px" } },
              icon("plus", 13),
              "Add card",
            ),
          ),
        );

        Object.assign(col.style, {
          flex: `0 0 ${p.columnWidth ?? 172}px`,
          padding: "12px 11px",
          ...ctx.surface("inset", { radius: p.columnRadius ?? 14 }),
        });
        node.appendChild(col);
      }

      return node;
    },
  },

  ProjectCard: {
    label: "Project card",
    category: "Tasks",
    glyph: "layers",
    description: "A project summary: progress, team, due date, status.",
    acceptsChildren: false,
    resizable: { width: true, height: false },
    states: ["hover", "pressed"],
    props: {
      name: "Q3 Product Launch",
      client: "Northstar Solar",
      status: "On track",
      statusTone: "success",
      progress: 0.68,
      taskCount: "18 of 26 tasks",
      due: "3 Oct",
      members: ["Maya Chen", "Sam Okafor", "Priya Raman", "Leo Dubois"],
      accent: "{{theme.colors.primary}}",
      showRing: true,
      padding: { top: 16, right: 16, bottom: 16, left: 16 },
      radius: 16,
      background: "{{theme.colors.surface}}",
      borderWidth: 1,
      borderColor: "{{theme.colors.border}}",
      shadow: "none",
    },
    fields: {
      name: f.text("Name"),
      client: f.text("Subtitle"),
      status: f.text("Status label"),
      statusTone: f.select("Status tone", [
        { value: "success", label: "On track" },
        { value: "warning", label: "At risk" },
        { value: "danger", label: "Blocked" },
        { value: "info", label: "Info" },
        { value: "neutral", label: "Neutral" },
      ]),
      progress: f.slider("Progress", { min: 0, max: 1, step: 0.01 }),
      taskCount: f.text("Task count"),
      due: f.text("Due"),
      members: f.items("Members"),
      accent: f.color("Accent"),
      showRing: f.bool("As a ring"),
      ...boxFields,
    },
    render(p, ctx) {
      const c = ctx.theme.colors;
      const accent = resolveToken(p.accent || "{{theme.colors.primary}}", ctx.theme);
      const tone = p.statusTone === "neutral" ? c.textTertiary : c[p.statusTone] || c.success;
      const pct = Math.round((p.progress ?? 0) * 100);

      const node = el(
        "div",
        el(
          "div",
          { style: { display: "flex", alignItems: "flex-start", gap: "12px" } },
          el(
            "div",
            { style: { minWidth: 0, flex: "1 1 auto" } },
            el(
              "div",
              { style: { display: "flex", alignItems: "center", gap: "7px", marginBottom: "3px" } },
              el("span", { style: { width: "8px", height: "8px", borderRadius: "3px", background: accent, flexShrink: "0" } }),
              el("span", {
                style: { fontSize: "11px", fontWeight: "650", letterSpacing: "0.04em", textTransform: "uppercase", color: tone },
              }, String(p.status ?? "")),
            ),
            el("div", { style: { fontSize: "17px", fontWeight: "650", color: c.text, letterSpacing: "-0.01em", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, String(p.name ?? "")),
            p.client ? el("div", { style: { fontSize: "12.5px", color: c.textTertiary, marginTop: "2px" } }, String(p.client)) : null,
          ),
          p.showRing ? progressRing(pct, accent, c, 46, 5) : null,
        ),
        !p.showRing
          ? el(
              "div",
              { style: { marginTop: "14px", height: "6px", borderRadius: "999px", background: c.surfaceSunken, overflow: "hidden" } },
              el("div", { style: { width: `${pct}%`, height: "100%", borderRadius: "999px", background: accent } }),
            )
          : null,
        el(
          "div",
          { style: { display: "flex", alignItems: "center", gap: "10px", marginTop: "14px" } },
          Array.isArray(p.members) && p.members.length ? avatarStack(p.members, c, 26) : null,
          el("span", { style: { flex: "1 1 auto" } }),
          p.taskCount ? el("span", { style: { fontSize: "12px", color: c.textTertiary } }, String(p.taskCount)) : null,
          p.due
            ? el(
                "span",
                { style: { display: "flex", alignItems: "center", gap: "4px", fontSize: "12px", color: c.textSecondary, fontWeight: "500" } },
                icon("calendar", 13),
                String(p.due),
              )
            : null,
        ),
      );

      applyBox(node, p, ctx, { level: "raised", type: "ProjectCard" });
      return node;
    },
  },

  NoteCard: {
    label: "Note card",
    category: "Notes",
    glyph: "note",
    description: "A note preview: title, excerpt, tags, pin.",
    acceptsChildren: false,
    resizable: { width: true, height: true, minHeight: 80 },
    states: ["hover", "pressed"],
    props: {
      title: "Kickoff notes — 14 Sep",
      body: "Agreed the scope is the installer app plus the admin side. Ship the layout editor first; the rules engine can follow.",
      excerptLines: 3,
      meta: "Edited 2h ago",
      tags: ["meeting", "scope"],
      pinned: true,
      accent: "",
      showAccentBar: true,
      padding: { top: 14, right: 14, bottom: 14, left: 14 },
      radius: 14,
      background: "{{theme.colors.surface}}",
      borderWidth: 1,
      borderColor: "{{theme.colors.border}}",
      shadow: "none",
    },
    fields: {
      title: f.text("Title"),
      body: f.textarea("Excerpt"),
      excerptLines: f.number("Clamp lines", { min: 0, max: 10 }),
      meta: f.text("Meta line"),
      tags: f.items("Tags"),
      pinned: f.bool("Pinned"),
      accent: f.color("Accent", { allowNone: true }),
      showAccentBar: f.bool("Accent bar"),
      ...boxFields,
    },
    render(p, ctx) {
      const c = ctx.theme.colors;
      const accent = p.accent && p.accent !== "transparent" ? resolveToken(p.accent, ctx.theme) : null;

      const body = el("div", { style: { fontSize: "13px", lineHeight: "1.5", color: c.textSecondary, marginTop: "5px" } }, String(p.body ?? ""));
      if (p.excerptLines) {
        Object.assign(body.style, {
          display: "-webkit-box",
          webkitBoxOrient: "vertical",
          webkitLineClamp: String(p.excerptLines),
          overflow: "hidden",
        });
      }

      const node = el(
        "div",
        accent && p.showAccentBar
          ? el("span", { style: { position: "absolute", left: "0", top: "0", bottom: "0", width: "3px", background: accent, borderRadius: "3px 0 0 3px" } })
          : null,
        el(
          "div",
          { style: { display: "flex", alignItems: "flex-start", gap: "8px" } },
          el("div", { style: { fontSize: "14.5px", fontWeight: "620", color: c.text, flex: "1 1 auto", minWidth: 0, letterSpacing: "-0.005em" } }, String(p.title ?? "")),
          p.pinned ? el("span", { style: { color: accent || c.primary, display: "flex", flexShrink: "0", marginTop: "1px" } }, icon("pin", 14)) : null,
        ),
        p.body ? body : null,
        (Array.isArray(p.tags) && p.tags.length) || p.meta
          ? el(
              "div",
              { style: { display: "flex", alignItems: "center", gap: "5px", marginTop: "10px", flexWrap: "wrap" } },
              ...(Array.isArray(p.tags) ? p.tags : []).map((t) => tagPill(t, c)),
              el("span", { style: { flex: "1 1 auto" } }),
              p.meta ? el("span", { style: { fontSize: "11px", color: c.textTertiary, whiteSpace: "nowrap" } }, String(p.meta)) : null,
            )
          : null,
      );

      node.style.position = "relative";
      applyBox(node, p, ctx, { level: "raised", type: "NoteCard" });
      return node;
    },
  },

  RichText: {
    label: "Rich text",
    category: "Notes",
    glyph: "text",
    description: "A note body as typed blocks: headings, lists, quotes, code.",
    acceptsChildren: false,
    resizable: { width: true, height: false },
    props: {
      blocks: [
        { kind: "h2", text: "Kickoff notes" },
        { kind: "p", text: "Two surfaces to build: the installer app and the admin side that designs it." },
        { kind: "bullet", text: "Layout editor ships first" },
        { kind: "bullet", text: "Rules engine can follow" },
        { kind: "h3", text: "Order of work" },
        { kind: "number", text: "Agree the component contract" },
        { kind: "number", text: "Ship the editor" },
        { kind: "number", text: "Wire the renderer to resolve_layout" },
        { kind: "todo", text: "Confirm the schema with the backend", done: false },
        { kind: "todo", text: "Agree the component contract", done: true },
        { kind: "quote", text: "One registry, two readers. Nothing else." },
        { kind: "code", text: "resolve_layout(user_id) -> document" },
      ],
      gap: 9,
      bodySize: 14,
    },
    fields: {
      blocks: f.items("Blocks", {
        shape: [
          {
            key: "kind",
            label: "Type",
            control: "select",
            options: [
              { value: "h1", label: "Heading 1" },
              { value: "h2", label: "Heading 2" },
              { value: "h3", label: "Heading 3" },
              { value: "p", label: "Paragraph" },
              { value: "bullet", label: "Bulleted item" },
              { value: "number", label: "Numbered item" },
              { value: "todo", label: "To-do" },
              { value: "quote", label: "Quote" },
              { value: "code", label: "Code" },
              { value: "divider", label: "Divider" },
            ],
          },
          { key: "text", label: "Text" },
          { key: "done", label: "Done", control: "switch" },
        ],
      }),
      gap: f.number("Block gap", { min: 2, max: 24, unit: "px" }),
      bodySize: f.number("Body size", { min: 11, max: 20, unit: "px" }),
    },
    render(p, ctx) {
      const c = ctx.theme.colors;
      const base = p.bodySize ?? 14;
      const node = el("div");
      Object.assign(node.style, { display: "flex", flexDirection: "column", gap: `${p.gap ?? 9}px` });

      let ordinal = 0;
      for (const block of Array.isArray(p.blocks) ? p.blocks : []) {
        if (block.kind !== "number") ordinal = 0;
        node.appendChild(richBlock(block, { c, base, theme: ctx.theme, ordinal: block.kind === "number" ? ++ordinal : 0 }));
      }
      return node;
    },
  },

  TagList: {
    label: "Tags",
    category: "Notes",
    glyph: "tag",
    description: "Coloured labels, each with its own tone.",
    acceptsChildren: false,
    resizable: { width: true, height: false },
    props: {
      items: [
        { text: "design", color: "{{theme.colors.primary}}" },
        { text: "urgent", color: "{{theme.colors.danger}}" },
        { text: "research", color: "{{theme.colors.info}}" },
        { text: "backlog", color: "" },
      ],
      gap: 6,
      variant: "soft",
      showDot: false,
      wrap: true,
    },
    fields: {
      items: f.items("Tags", { shape: [{ key: "text", label: "Label" }, { key: "color", label: "Colour", control: "color" }] }),
      variant: f.segmented("Variant", [
        { value: "soft", label: "Soft" },
        { value: "solid", label: "Solid" },
        { value: "outline", label: "Outline" },
      ]),
      showDot: f.bool("Leading dot"),
      gap: f.number("Gap", { min: 2, max: 16, unit: "px" }),
      wrap: f.bool("Wrap"),
    },
    render(p, ctx) {
      const c = ctx.theme.colors;
      const node = el("div");
      Object.assign(node.style, {
        display: "flex",
        gap: `${p.gap ?? 6}px`,
        flexWrap: p.wrap === false ? "nowrap" : "wrap",
        overflowX: p.wrap === false ? "auto" : "visible",
      });

      for (const item of Array.isArray(p.items) ? p.items : []) {
        const colour = item.color ? resolveToken(item.color, ctx.theme) : c.textTertiary;
        const style =
          p.variant === "solid"
            ? { background: colour, color: readableOn(colour, c), border: "1px solid transparent" }
            : p.variant === "outline"
              ? { background: "transparent", color: colour, border: `1px solid ${colour}` }
              : { background: `color-mix(in srgb, ${colour} 16%, transparent)`, color: colour, border: "1px solid transparent" };

        node.appendChild(
          el(
            "span",
            {
              style: {
                display: "inline-flex",
                alignItems: "center",
                gap: "5px",
                padding: "3px 9px",
                borderRadius: "999px",
                fontSize: "11.5px",
                fontWeight: "600",
                whiteSpace: "nowrap",
                ...style,
              },
            },
            p.showDot ? el("span", { style: { width: "5px", height: "5px", borderRadius: "999px", background: "currentColor" } }) : null,
            String(item.text ?? ""),
          ),
        );
      }
      return node;
    },
  },

  AvatarGroup: {
    label: "Members",
    category: "Content",
    glyph: "avatarGroup",
    description: "Overlapping members with an overflow count.",
    acceptsChildren: false,
    resizable: { width: true, height: false },
    props: { names: ["Maya Chen", "Sam Okafor", "Priya Raman", "Leo Dubois", "Ana Ruiz"], max: 4, avatarSize: 30, label: "" },
    fields: {
      names: f.items("Names"),
      max: f.number("Show at most", { min: 1, max: 10 }),
      avatarSize: f.number("Size", { min: 18, max: 56, unit: "px" }),
      label: f.text("Trailing label"),
    },
    render(p, ctx) {
      const c = ctx.theme.colors;
      return el(
        "div",
        { style: { display: "flex", alignItems: "center", gap: "10px" } },
        avatarStack(Array.isArray(p.names) ? p.names : [], c, p.avatarSize ?? 30, p.max ?? 4),
        p.label ? el("span", { style: { fontSize: "12.5px", color: c.textTertiary } }, String(p.label)) : null,
      );
    },
  },

  ProgressRing: {
    label: "Progress ring",
    category: "Data",
    glyph: "ring",
    description: "Completion as a ring, with a label underneath.",
    acceptsChildren: false,
    resizable: { width: false, height: false },
    props: { value: 0.72, label: "Sprint complete", caption: "", diameter: 84, thickness: 8, tone: "primary", showValue: true, align: "center" },
    fields: {
      value: f.slider("Value", { min: 0, max: 1, step: 0.01 }),
      label: f.text("Label"),
      caption: f.text("Caption"),
      diameter: f.number("Diameter", { min: 40, max: 200, unit: "px" }),
      thickness: f.number("Thickness", { min: 2, max: 24, unit: "px" }),
      tone: f.select("Tone", [
        { value: "primary", label: "Primary" },
        { value: "success", label: "Success" },
        { value: "warning", label: "Warning" },
        { value: "danger", label: "Danger" },
        { value: "info", label: "Info" },
      ]),
      showValue: f.bool("Percentage"),
      align: f.segmented("Align", [
        { value: "left", icon: "alignLeft", tip: "Left" },
        { value: "center", icon: "alignCenter", tip: "Centre" },
      ]),
    },
    render(p, ctx) {
      const c = ctx.theme.colors;
      const tone = c[p.tone] || c.primary;
      const pct = Math.round((p.value ?? 0) * 100);

      return el(
        "div",
        {
          style: {
            display: "flex",
            flexDirection: "column",
            alignItems: p.align === "left" ? "flex-start" : "center",
            gap: "8px",
          },
        },
        progressRing(pct, tone, c, p.diameter ?? 84, p.thickness ?? 8, p.showValue !== false),
        p.label ? el("span", { style: { fontSize: "13px", fontWeight: "500", color: c.text } }, String(p.label)) : null,
        p.caption ? el("span", { style: { fontSize: "11.5px", color: c.textTertiary } }, String(p.caption)) : null,
      );
    },
  },

  CommentThread: {
    label: "Comments",
    category: "Data",
    glyph: "comment",
    description: "Discussion on a record, newest last.",
    acceptsChildren: false,
    resizable: { width: true, height: false },
    props: {
      title: "Activity",
      items: [
        { author: "Sam Okafor", body: "Moved the deadline to the 3rd — the vendor confirmed.", meta: "2d ago" },
        { author: "Maya Chen", body: "Noted. I'll redo the plan and re-share tomorrow.", meta: "1d ago" },
      ],
      showComposer: true,
      composerLabel: "Write a comment",
      gap: 14,
    },
    fields: {
      title: f.text("Title"),
      items: f.items("Comments", { shape: [{ key: "author", label: "Author" }, { key: "body", label: "Body" }, { key: "meta", label: "Time" }] }),
      showComposer: f.bool("Composer"),
      composerLabel: f.text("Placeholder"),
      gap: f.number("Gap", { min: 6, max: 28, unit: "px" }),
    },
    render(p, ctx) {
      const c = ctx.theme.colors;
      const node = el("div");
      Object.assign(node.style, { display: "flex", flexDirection: "column", gap: `${p.gap ?? 14}px` });

      if (p.title) {
        node.appendChild(el("div", { style: { fontSize: "13px", fontWeight: "600", color: c.text } }, String(p.title)));
      }

      for (const item of Array.isArray(p.items) ? p.items : []) {
        node.appendChild(
          el(
            "div",
            { style: { display: "flex", gap: "10px" } },
            initialsBubble(item.author ?? "?", c, 30),
            el(
              "div",
              { style: { minWidth: 0, flex: "1 1 auto" } },
              el(
                "div",
                { style: { display: "flex", alignItems: "baseline", gap: "7px" } },
                el("span", { style: { fontSize: "13px", fontWeight: "600", color: c.text } }, String(item.author ?? "")),
                item.meta ? el("span", { style: { fontSize: "11px", color: c.textTertiary } }, String(item.meta)) : null,
              ),
              el("div", { style: { fontSize: "13px", lineHeight: "1.5", color: c.textSecondary, marginTop: "2px" } }, String(item.body ?? "")),
            ),
          ),
        );
      }

      if (p.showComposer) {
        const box = el(
          "div",
          el("span", { style: { flex: "1 1 auto", fontSize: "13px", color: c.textTertiary } }, String(p.composerLabel || "Write a comment")),
          el("span", { style: { color: c.primary, display: "flex" } }, icon("send", 16)),
        );
        Object.assign(box.style, {
          display: "flex",
          alignItems: "center",
          gap: "8px",
          padding: "11px 13px",
          ...ctx.surface("inset", { radius: 12 }),
        });
        node.appendChild(box);
      }

      return node;
    },
  },

  AttachmentList: {
    label: "Attachments",
    category: "Data",
    glyph: "paperclip",
    description: "Files on a record, with type and size.",
    acceptsChildren: false,
    resizable: { width: true, height: false },
    props: {
      items: [
        { name: "rollout-plan.pdf", size: "820 KB", kind: "pdf" },
        { name: "site-survey.jpg", size: "2.4 MB", kind: "image" },
        { name: "budget.xlsx", size: "96 KB", kind: "sheet" },
      ],
      gap: 7,
      rowPadding: 10,
      radius: 11,
      showSize: true,
      emptyText: "No files yet",
    },
    fields: {
      items: f.items("Files", {
        shape: [
          { key: "name", label: "Name" },
          { key: "size", label: "Size" },
          {
            key: "kind",
            label: "Kind",
            control: "select",
            options: [
              { value: "file", label: "File" },
              { value: "pdf", label: "Document" },
              { value: "image", label: "Image" },
              { value: "sheet", label: "Spreadsheet" },
              { value: "code", label: "Code" },
              { value: "link", label: "Link" },
            ],
          },
        ],
      }),
      gap: f.number("Gap", { min: 0, max: 20, unit: "px" }),
      rowPadding: f.number("Row padding", { min: 4, max: 20, unit: "px" }),
      radius: f.radius(),
      showSize: f.bool("Show size"),
      emptyText: f.text("Empty message"),
    },
    render(p, ctx) {
      const c = ctx.theme.colors;
      const glyphs = { pdf: "file", image: "image", sheet: "table", code: "code", link: "link", file: "file" };
      const items = Array.isArray(p.items) ? p.items : [];

      const node = el("div");
      Object.assign(node.style, { display: "flex", flexDirection: "column", gap: `${p.gap ?? 7}px` });

      if (!items.length) {
        node.appendChild(el("div", { style: { padding: "16px", textAlign: "center", color: c.textTertiary, fontSize: "13px" } }, String(p.emptyText || "No files")));
        return node;
      }

      for (const item of items) {
        const row = el(
          "div",
          el(
            "span",
            { style: { display: "grid", placeItems: "center", width: "30px", height: "30px", borderRadius: "9px", background: `color-mix(in srgb, ${c.primary} 13%, transparent)`, color: c.primary, flexShrink: "0" } },
            icon(glyphs[item.kind] || "file", 15),
          ),
          el("span", { style: { flex: "1 1 auto", minWidth: 0, fontSize: "13px", color: c.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, String(item.name ?? "")),
          p.showSize && item.size ? el("span", { style: { fontSize: "11.5px", color: c.textTertiary, flexShrink: "0", fontVariantNumeric: "tabular-nums" } }, String(item.size)) : null,
          el("span", { style: { color: c.textTertiary, display: "flex", flexShrink: "0" } }, icon("download", 14)),
        );
        Object.assign(row.style, {
          display: "flex",
          alignItems: "center",
          gap: "10px",
          padding: `${p.rowPadding ?? 10}px`,
          ...ctx.surface("raised", { radius: p.radius ?? 11 }),
        });
        node.appendChild(row);
      }
      return node;
    },
  },

  MiniCalendar: {
    label: "Month",
    category: "Data",
    glyph: "monthGrid",
    description: "A month grid with markers on busy days.",
    acceptsChildren: false,
    resizable: { width: true, height: false },
    props: {
      monthLabel: "September 2026",
      firstWeekday: 1,
      days: 30,
      today: 17,
      marked: "3, 9, 12, 18, 24",
      weekStart: "mon",
      padding: { top: 14, right: 12, bottom: 12, left: 12 },
      radius: 16,
      background: "{{theme.colors.surface}}",
      borderWidth: 1,
      borderColor: "{{theme.colors.border}}",
      shadow: "none",
    },
    fields: {
      monthLabel: f.text("Month label"),
      days: f.number("Days in month", { min: 28, max: 31 }),
      firstWeekday: f.number("Starts on", { min: 0, max: 6 }),
      today: f.number("Highlight day", { min: 0, max: 31 }),
      marked: f.text("Marked days"),
      weekStart: f.segmented("Week starts", [
        { value: "mon", label: "Mon" },
        { value: "sun", label: "Sun" },
      ]),
      ...boxFields,
    },
    render(p, ctx) {
      const c = ctx.theme.colors;
      const sunFirst = p.weekStart === "sun";
      const names = sunFirst ? ["S", "M", "T", "W", "T", "F", "S"] : ["M", "T", "W", "T", "F", "S", "S"];
      const marked = new Set(
        String(p.marked ?? "")
          .split(",")
          .map((s) => Number(s.trim()))
          .filter((n) => Number.isFinite(n)),
      );

      // firstWeekday is authored Monday-based (0 = Monday) because that is how
      // the label row is authored; a Sunday-first grid just shifts the offset.
      const offset = ((p.firstWeekday ?? 0) + (sunFirst ? 1 : 0)) % 7;

      const grid = el("div");
      Object.assign(grid.style, { display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: "2px", marginTop: "8px" });

      for (const label of names) {
        grid.appendChild(
          el("div", { style: { fontSize: "10.5px", fontWeight: "600", color: c.textTertiary, textAlign: "center", paddingBottom: "4px" } }, label),
        );
      }
      for (let i = 0; i < offset; i += 1) grid.appendChild(el("div"));

      for (let day = 1; day <= (p.days ?? 30); day += 1) {
        const isToday = day === p.today;
        const cell = el(
          "div",
          el("span", { style: { fontSize: "12px", fontWeight: isToday ? "650" : "500", fontVariantNumeric: "tabular-nums" } }, String(day)),
          marked.has(day) && !isToday
            ? el("span", { style: { position: "absolute", bottom: "3px", left: "50%", transform: "translateX(-50%)", width: "4px", height: "4px", borderRadius: "999px", background: c.primary } })
            : null,
        );
        Object.assign(cell.style, {
          position: "relative",
          display: "grid",
          placeItems: "center",
          aspectRatio: "1",
          borderRadius: "9px",
          color: isToday ? c.onPrimary : c.text,
          background: isToday ? c.primary : "transparent",
        });
        grid.appendChild(cell);
      }

      const node = el(
        "div",
        el(
          "div",
          { style: { display: "flex", alignItems: "center", gap: "8px" } },
          el("span", { style: { fontSize: "13.5px", fontWeight: "620", color: c.text, flex: "1 1 auto" } }, String(p.monthLabel ?? "")),
          el("span", { style: { color: c.textTertiary, display: "flex" } }, icon("chevronLeft", 15)),
          el("span", { style: { color: c.textTertiary, display: "flex" } }, icon("chevronRight", 15)),
        ),
        grid,
      );

      applyBox(node, p, ctx, { level: "raised", type: "MiniCalendar" });
      return node;
    },
  },

  SearchBar: {
    label: "Search bar",
    category: "Input",
    glyph: "search",
    description: "A search field with an optional filter action.",
    acceptsChildren: false,
    resizable: { width: true, height: true, minHeight: 36, maxHeight: 64 },
    states: ["focus"],
    props: {
      placeholder: "Search notes, tasks and projects",
      value: "",
      showFilter: true,
      filterGlyph: "filter",
      showScopes: false,
      scopes: ["All", "Tasks", "Notes", "Projects"],
      scopeIndex: 0,
      size: { width: "fill", height: 44 },
      radius: 12,
    },
    fields: {
      placeholder: f.text("Placeholder"),
      value: f.text("Value"),
      showFilter: f.bool("Filter button"),
      filterGlyph: f.glyph("Filter icon"),
      showScopes: f.bool("Scope chips"),
      scopes: f.items("Scopes"),
      scopeIndex: f.number("Selected scope", { min: 0, max: 9 }),
      size: f.size(),
      radius: f.radius(),
    },
    render(p, ctx) {
      const c = ctx.theme.colors;
      const height = p.size?.height ?? 44;

      const field = el(
        "div",
        el("span", { style: { color: c.textTertiary, display: "flex", flexShrink: "0" } }, icon("search", 16)),
        el("span", { style: { flex: "1 1 auto", fontSize: "14px", color: p.value ? c.text : c.textTertiary, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, String(p.value || p.placeholder || "")),
        p.value ? el("span", { style: { color: c.textTertiary, display: "flex", flexShrink: "0" } }, icon("close", 14)) : null,
      );
      Object.assign(field.style, {
        display: "flex",
        alignItems: "center",
        gap: "9px",
        flex: "1 1 auto",
        minWidth: 0,
        height: `${height}px`,
        padding: "0 13px",
        ...ctx.surface("inset", { radius: p.radius }),
      });

      const row = el("div", { style: { display: "flex", alignItems: "center", gap: "8px" } }, field);

      if (p.showFilter) {
        const button = el("span", { style: { display: "grid", placeItems: "center", color: c.text, width: `${height}px`, height: `${height}px`, flexShrink: "0" } }, icon(p.filterGlyph || "filter", 17));
        Object.assign(button.style, ctx.surface("control", { radius: p.radius }));
        row.appendChild(button);
      }

      if (!p.showScopes) return row;

      const scopes = Array.isArray(p.scopes) ? p.scopes : [];
      return el(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: "10px", width: sizeCss(p.size, "width") || "100%" } },
        row,
        el(
          "div",
          { style: { display: "flex", gap: "6px", overflowX: "auto" } },
          ...scopes.map((label, i) => {
            const active = i === (p.scopeIndex ?? 0);
            const chip = el("span", { style: { fontSize: "12.5px", fontWeight: "550", whiteSpace: "nowrap", padding: "6px 12px", color: active ? readableOn(c.primary, c) : c.textSecondary } }, String(label));
            Object.assign(chip.style, ctx.surface("control", { radius: 999, tint: active ? c.primary : null }));
            return chip;
          }),
        ),
      );
    },
  },

  Accordion: {
    label: "Accordion",
    category: "Layout",
    glyph: "collapse",
    description: "Collapsible sections; the open one shows its body.",
    acceptsChildren: false,
    resizable: { width: true, height: false },
    props: {
      items: [
        { title: "Scope", body: "Installer app plus the admin dashboard that designs it.", open: true },
        { title: "Timeline", body: "Editor first, rules engine second, reporting last.", open: false },
        { title: "Open questions", body: "Who owns the component contract once both sides ship?", open: false },
      ],
      gap: 8,
      rowPadding: 13,
      radius: 12,
      showDivider: true,
    },
    fields: {
      items: f.items("Sections", { shape: [{ key: "title", label: "Title" }, { key: "body", label: "Body" }, { key: "open", label: "Open", control: "switch" }] }),
      gap: f.number("Gap", { min: 0, max: 20, unit: "px" }),
      rowPadding: f.number("Padding", { min: 6, max: 24, unit: "px" }),
      radius: f.radius(),
      showDivider: f.bool("Body rule"),
    },
    render(p, ctx) {
      const c = ctx.theme.colors;
      const node = el("div");
      Object.assign(node.style, { display: "flex", flexDirection: "column", gap: `${p.gap ?? 8}px` });

      for (const item of Array.isArray(p.items) ? p.items : []) {
        const open = Boolean(item.open);
        const panel = el(
          "div",
          el(
            "div",
            { style: { display: "flex", alignItems: "center", gap: "10px" } },
            el("span", { style: { flex: "1 1 auto", fontSize: "13.5px", fontWeight: "600", color: c.text } }, String(item.title ?? "")),
            el(
              "span",
              { style: { color: c.textTertiary, display: "flex", flexShrink: "0", transform: open ? "rotate(180deg)" : "none", transition: "transform 180ms cubic-bezier(0.2,0,0,1)" } },
              icon("chevronDown", 16),
            ),
          ),
          open && item.body
            ? el(
                "div",
                {
                  style: {
                    marginTop: "9px",
                    paddingTop: p.showDivider ? "9px" : "0",
                    borderTop: p.showDivider ? `1px solid ${c.border}` : "none",
                    fontSize: "13px",
                    lineHeight: "1.5",
                    color: c.textSecondary,
                  },
                },
                String(item.body),
              )
            : null,
        );
        Object.assign(panel.style, { padding: `${p.rowPadding ?? 13}px`, ...ctx.surface("raised", { radius: p.radius ?? 12 }) });
        node.appendChild(panel);
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
