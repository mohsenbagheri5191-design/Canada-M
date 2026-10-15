/**
 * The theme editor.
 *
 * Edits the token set for the current design version, with a live component
 * gallery beside the controls so the effect of a token change is visible while
 * it is being made. Colour pairs are contrast-checked as you type; a pair that
 * fails AA is flagged here rather than at publish time.
 */

import { el, mount } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { themePresets, appStyles, appPalettes, createSurfaceResolver } from "../data/presets.js";
import { ramp, contrastGrade, inkFor, fmt } from "../core/util.js";
import { modal, section, fieldRow, colorField, numberField, toast, segmented, searchField } from "../core/ui.js";
import { renderScreen } from "../render/renderer.js";
import { clone } from "../core/store.js";

/** Colour tokens, grouped, with the background each is normally read against. */
const COLOR_GROUPS = [
  {
    name: "Surfaces",
    tokens: [
      { key: "background", label: "Background" },
      { key: "surface", label: "Surface" },
      { key: "surfaceSunken", label: "Sunken" },
      { key: "border", label: "Border" },
    ],
  },
  {
    name: "Text",
    tokens: [
      { key: "text", label: "Primary", against: "background" },
      { key: "textSecondary", label: "Secondary", against: "background" },
      { key: "textTertiary", label: "Tertiary", against: "background" },
    ],
  },
  {
    name: "Brand",
    tokens: [
      { key: "primary", label: "Primary", against: "background" },
      { key: "primarySoft", label: "Primary soft" },
      { key: "onPrimary", label: "On primary", against: "primary" },
    ],
  },
  {
    name: "Semantic",
    tokens: [
      { key: "success", label: "Success", against: "background" },
      { key: "warning", label: "Warning", against: "background" },
      { key: "danger", label: "Danger", against: "background" },
      { key: "info", label: "Info", against: "background" },
    ],
  },
];

const FONT_STACKS = [
  { value: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif", label: "Inter" },
  { value: "'IBM Plex Sans', Inter, system-ui, sans-serif", label: "IBM Plex Sans" },
  { value: "'Source Sans 3', Inter, system-ui, sans-serif", label: "Source Sans" },
  { value: "Georgia, 'Times New Roman', serif", label: "Georgia (serif)" },
  { value: "ui-monospace, 'SF Mono', Menlo, monospace", label: "Monospace" },
  { value: "system-ui, -apple-system, sans-serif", label: "System default" },
];

export function openThemeEditor(editor) {
  const working = clone(editor.theme);
  let seedHex = working.colors.primary;

  const preview = el("div.theme-preview");
  const controls = el("div.theme-controls");

  function repaintPreview() {
    mount(
      preview,
      el(
        "div.col",
        { style: { gap: "var(--s-4)" } },
        el(
          "div.col",
          { style: { gap: "var(--s-2)" } },
          el("span.eyebrow", "Live gallery"),
          el(
            "div.theme-gallery",
            { style: { maxHeight: "440px", overflow: "auto" } },
            gallery(working),
          ),
        ),
        el(
          "div.col",
          { style: { gap: "var(--s-2)" } },
          el("span.eyebrow", "Generated ramp from primary"),
          rampStrip(ramp(working.colors.primary)),
        ),
        contrastReport(working),
      ),
    );
  }

  function repaintControls() {
    mount(
      controls,
      section(
        "Start from a preset",
        el(
          "div.col",
          { style: { gap: "var(--s-2)" } },
          ...themePresets.map((preset) =>
            el(
              "button",
              {
                type: "button",
                class: `theme-card${JSON.stringify(preset.theme.colors) === JSON.stringify(working.colors) ? " active" : ""}`,
                onclick: () => {
                  Object.assign(working, clone(preset.theme));
                  seedHex = working.colors.primary;
                  repaintControls();
                  repaintPreview();
                },
              },
              el(
                "div.row",
                { style: { gap: "var(--s-2)" } },
                el("b", { style: { fontSize: "var(--fs-12)" } }, preset.name),
                el("span.spacer"),
                el("span.dim", { style: { fontSize: "var(--fs-11)" } }, preset.description),
              ),
              el(
                "div.theme-swatches",
                ...["background", "surface", "primary", "text", "success", "warning", "danger"].map((key) =>
                  el("span", { style: { background: preset.theme.colors[key] } }),
                ),
              ),
            ),
          ),
        ),
        { open: true },
      ),

      section(
        "Visual style",
        el(
          "div.col",
          { style: { gap: "var(--s-2)" } },
          el("span.hint", "What a surface feels like, independent of its colours. Changing this reshapes every card, input, button and row in the design at once."),
          el(
            "div",
            { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--s-2)" } },
            ...appStyles.map((style) =>
              el(
                "button",
                {
                  type: "button",
                  class: `theme-card${working.style === style.key ? " active" : ""}`,
                  "data-tip": style.description,
                  "data-tip-place": "right-start",
                  onclick: () => {
                    working.style = style.key;
                    repaintControls();
                    repaintPreview();
                  },
                },
                // A live miniature of the style applied to the working palette,
                // which is the only honest way to show what it does.
                stylePreview(style.key, working),
                el("b", { style: { fontSize: "var(--fs-11)" } }, style.name),
              ),
            ),
          ),
        ),
        { open: true },
      ),

      section(
        "Palette",
        el(
          "div.col",
          { style: { gap: "var(--s-3)" } },
          ...[...new Set(appPalettes.map((p) => p.group))].map((group) =>
            el(
              "div.col",
              { style: { gap: "5px" } },
              el("span.field-label", group),
              el(
                "div.preset-row",
                ...appPalettes
                  .filter((p) => p.group === group)
                  .map((palette) =>
                    el(
                      "button",
                      {
                        type: "button",
                        class: `preset-chip${working.palette === palette.key ? " active" : ""}`,
                        onclick: () => {
                          working.palette = palette.key;
                          working.colors = { ...palette.colors };
                          seedHex = palette.colors.primary;
                          repaintControls();
                          repaintPreview();
                        },
                      },
                      el("span", {
                        style: {
                          width: "9px",
                          height: "9px",
                          borderRadius: "999px",
                          background: palette.colors.primary,
                          boxShadow: `0 0 0 1px ${palette.colors.border}`,
                          flex: "none",
                        },
                      }),
                      palette.name,
                    ),
                  ),
              ),
            ),
          ),
        ),
        { open: true },
      ),

      section(
        "Generate a ramp",
        el(
          "div.col",
          { style: { gap: "var(--s-2)" } },
          el("span.hint", "Pick a seed and the whole scale is derived from it: lightness follows one curve, chroma peaks in the mid-tones."),
          fieldRow(
            "Seed",
            colorField(seedHex, (hex) => {
              seedHex = hex;
            }),
          ),
          el(
            "button.btn.subtle",
            {
              style: { width: "100%" },
              onclick: () => {
                const scale = ramp(seedHex);
                working.colors.primary = scale[500];
                working.colors.primarySoft = scale[working.colors.background && isDark(working.colors.background) ? 900 : 50];
                working.colors.onPrimary = inkFor(scale[500]);
                repaintControls();
                repaintPreview();
                toast("Ramp applied to the brand tokens", { tone: "success", duration: 2400 });
              },
            },
            icon("wand"),
            "Generate and apply",
          ),
          rampStrip(ramp(seedHex)),
        ),
        { open: true },
      ),

      ...COLOR_GROUPS.map((group) =>
        section(
          group.name,
          el(
            "div.col",
            { style: { gap: "var(--s-2)" } },
            ...group.tokens.map((token) =>
              fieldRow(
                token.label,
                colorField(
                  working.colors[token.key] ?? "#000000",
                  (hex, meta) => {
                    working.colors[token.key] = hex;
                    if (!meta.live) repaintControls();
                    repaintPreview();
                  },
                  { contrastAgainst: token.against ? working.colors[token.against] : null },
                ),
              ),
            ),
          ),
          { open: group.name === "Brand" || group.name === "Surfaces" },
        ),
      ),

      section(
        "Typography",
        el(
          "div.col",
          { style: { gap: "var(--s-2)" } },
          fieldRow(
            "Family",
            el(
              "select.select",
              {
                onchange: (event) => {
                  working.typography.fontFamily = event.target.value;
                  repaintPreview();
                },
              },
              ...FONT_STACKS.map((f) => el("option", { value: f.value, selected: f.value === working.typography.fontFamily }, f.label)),
            ),
          ),
          fieldRow(
            "Base size",
            numberField(working.typography.baseSize ?? 14, (v) => {
              working.typography.baseSize = v;
              repaintPreview();
            }, { min: 11, max: 20, unit: "px", tagIcon: "type" }),
          ),
          el("span.field-label", "Scale"),
          ...Object.entries(working.typography.scale ?? {}).map(([key, value]) =>
            fieldRow(
              fmt.label(key),
              numberField(value, (v) => {
                working.typography.scale[key] = v;
                repaintPreview();
              }, { min: 9, max: 64, unit: "px", tag: key[0].toUpperCase() }),
            ),
          ),
        ),
        { open: false },
      ),

      section(
        "Radius and spacing",
        el(
          "div.col",
          { style: { gap: "var(--s-2)" } },
          ...Object.entries(working.radius ?? {}).map(([key, value]) =>
            fieldRow(
              fmt.label(key),
              numberField(value, (v) => {
                working.radius[key] = v;
                repaintPreview();
              }, { min: 0, max: 999, unit: "px", tagIcon: "corner" }),
            ),
          ),
          ...Object.entries(working.spacing ?? {}).map(([key, value]) =>
            fieldRow(
              fmt.label(key),
              numberField(value, (v) => {
                working.spacing[key] = v;
                repaintPreview();
              }, { min: 0, max: 64, unit: "px", tagIcon: "spacing" }),
            ),
          ),
        ),
        { open: false },
      ),
    );
  }

  repaintControls();
  repaintPreview();

  modal(
    (close) => ({
      title: "Theme",
      subtitle: "Edit the token set for this design version. Every component restyles as you go.",
      body: el("div.theme-editor", controls, preview),
      footer: [
        el(
          "button.btn.ghost",
          {
            onclick: () => {
              const json = JSON.stringify(working, null, 2);
              navigator.clipboard?.writeText(json);
              toast("Theme JSON copied", { tone: "success", duration: 2000 });
            },
          },
          icon("copy"),
          "Copy JSON",
        ),
        el("div.spacer"),
        el("button.btn.subtle", { onclick: () => close() }, "Cancel"),
        el(
          "button.btn.primary",
          {
            onclick: () => {
              editor.setTheme(working);
              editor.commit("Update theme");
              close();
              toast("Theme applied", { tone: "success", detail: "Saved with the draft. Publish to send it to the app." });
            },
          },
          "Apply theme",
        ),
      ],
    }),
    { width: "xwide" },
  );
}

/**
 * A three-element sample of a style: a raised card, an inset well and a tinted
 * control. Enough to tell Neumorphic from Brutalist at a glance, which a name
 * and a description alone cannot do.
 */
function stylePreview(styleKey, theme) {
  const surface = createSurfaceResolver({ ...theme, style: styleKey });
  const c = theme.colors;

  const chip = (level, tint) =>
    el("span", {
      style: {
        display: "block",
        flex: "1 1 0",
        height: "22px",
        ...surface(level, { radius: 8, tint }),
      },
    });

  return el(
    "span",
    {
      style: {
        display: "flex",
        gap: "6px",
        padding: "8px",
        borderRadius: "8px",
        background: c.background,
        marginBottom: "2px",
      },
    },
    chip("raised", null),
    chip("inset", null),
    chip("control", c.primary),
  );
}

const isDark = (hex) => {
  const int = parseInt(hex.replace("#", ""), 16);
  const r = (int >> 16) & 255;
  const g = (int >> 8) & 255;
  const b = int & 255;
  return (r * 299 + g * 587 + b * 114) / 1000 < 128;
};

function rampStrip(scale) {
  return el(
    "div.ramp-row",
    ...Object.entries(scale).map(([stop, hex]) =>
      el("span", { style: { background: hex }, "data-tip": `${stop} · ${hex}` }),
    ),
  );
}

/** A miniature screen exercising every token at once. */
function gallery(theme) {
  const screen = {
    id: "gallery",
    name: "Gallery",
    root: {
      id: "g0",
      type: "Stack",
      props: {
        direction: "vertical",
        gap: 14,
        padding: { top: 18, right: 16, bottom: 20, left: 16 },
        background: "{{theme.colors.background}}",
        size: { width: "fill", height: "hug" },
      },
      children: [
        { id: "g1", type: "Header", props: { title: "Component gallery", subtitle: "Every token, at once", showBack: false, showAvatar: true } },
        {
          id: "g2",
          type: "Grid",
          props: { columns: 3, gap: 8 },
          children: [
            { id: "g2a", type: "StatTile", props: { label: "Open", value: "12", glyph: "list" } },
            { id: "g2b", type: "StatTile", props: { label: "Done", value: "38", glyph: "checkCircle" } },
            { id: "g2c", type: "StatTile", props: { label: "Late", value: "1", glyph: "alert" } },
          ],
        },
        { id: "g3", type: "ChipRow", props: {} },
        { id: "g4", type: "List", props: {} },
        { id: "g5", type: "Callout", props: {} },
        { id: "g6", type: "ProgressBar", props: { value: 0.64, label: "Route complete" } },
        { id: "g7", type: "Input", props: { label: "Customer", placeholder: "Search", required: true } },
        {
          id: "g8",
          type: "ButtonRow",
          props: { gap: 8 },
          children: [
            { id: "g8a", type: "Button", props: { label: "Secondary", variant: "secondary", size: { width: "fill", height: 44 }, fontSize: 14 } },
            { id: "g8b", type: "Button", props: { label: "Primary", variant: "primary", size: { width: "fill", height: 44 }, fontSize: 14 } },
          ],
        },
        {
          id: "g9",
          type: "Stack",
          props: { direction: "horizontal", gap: 6 },
          children: [
            { id: "g9a", type: "Badge", props: { text: "Success", tone: "success" } },
            { id: "g9b", type: "Badge", props: { text: "Warning", tone: "warning" } },
            { id: "g9c", type: "Badge", props: { text: "Danger", tone: "danger" } },
          ],
        },
        { id: "g10", type: "TabBar", props: {} },
      ],
    },
  };

  return renderScreen(screen, { theme, scope: {}, editable: false });
}

/** Every text-on-surface pair the design relies on, graded. */
function contrastReport(theme) {
  const pairs = [
    ["text", "background", "Body text"],
    ["textSecondary", "background", "Secondary text"],
    ["textTertiary", "background", "Tertiary text"],
    ["text", "surface", "Text on surface"],
    ["onPrimary", "primary", "Text on primary"],
    ["primary", "background", "Primary on background"],
    ["danger", "background", "Danger on background"],
  ];

  const rows = pairs.map(([fg, bg, label]) => {
    const grade = contrastGrade(theme.colors[fg], theme.colors[bg]);
    return el(
      "div",
      {
        style: {
          display: "grid",
          gridTemplateColumns: "1fr 54px 60px",
          alignItems: "center",
          gap: "var(--s-2)",
          padding: "4px var(--s-2)",
          borderRadius: "var(--r-control)",
          fontSize: "var(--fs-11)",
          background: grade.passes ? "transparent" : "var(--danger-soft)",
        },
      },
      el("span", { style: { color: "var(--text-secondary)" } }, label),
      el("span", { style: { fontFamily: "var(--font-mono)", color: grade.passes ? "var(--text-tertiary)" : "var(--danger)" } }, `${grade.text}:1`),
      el("span", { style: { color: grade.passes ? "var(--success)" : "var(--danger)", fontWeight: "var(--fw-semibold)" } }, grade.level),
    );
  });

  const failures = pairs.filter(([fg, bg]) => !contrastGrade(theme.colors[fg], theme.colors[bg]).passes).length;

  return el(
    "div.col",
    { style: { gap: "var(--s-2)" } },
    el(
      "span.eyebrow",
      { style: { display: "flex", alignItems: "center", gap: "6px" } },
      "WCAG 2.1 AA",
      failures > 0 ? el("span.pill.danger", `${failures} failing`) : el("span.pill.success", "All passing"),
    ),
    el("div.panel", { style: { padding: "var(--s-1)" } }, ...rows),
    failures > 0 &&
      el("div.callout.warning", icon("alert"), el("div", "Publish is blocked while a text token fails AA against its surface.")),
  );
}
