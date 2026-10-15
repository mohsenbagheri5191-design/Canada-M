/**
 * The right-hand inspector.
 *
 * Five panels: Insert, Layers, Style, Data, Screen. Style is generated from
 * the registry's `fields` map, so adding a prop to a component makes it
 * editable here with no change to this file.
 */

import { el, mount, on, drag } from "../core/dom.js";
import { icon, iconNames } from "../core/icons.js";
import { registry, getDef, groupedFields, categories, shadowKeys } from "../data/registry.js";
import { blocks, blockGroups, screenTemplates, stylePresetGroups, stylePresetPatch, devices } from "../data/presets.js";
import { formatterNames, comparators, findNode, BREAKPOINTS } from "../render/renderer.js";
import { fuzzy, fmt, clamp } from "../core/util.js";
import {
  section,
  fieldRow,
  numberField,
  sliderField,
  segmented,
  switchControl,
  colorField,
  searchField,
  emptyState,
  toast,
  menu,
  modal,
  pill,
} from "../core/ui.js";
import { renderMiniature } from "./canvas.js";
import { createLayers } from "./layers.js";

const PANELS = [
  { key: "insert", label: "Insert", glyph: "plus" },
  { key: "layers", label: "Layers", glyph: "layers" },
  { key: "style", label: "Style", glyph: "palette" },
  { key: "data", label: "Data", glyph: "appdata" },
  { key: "screen", label: "Screen", glyph: "device" },
];

export function createInspector(editor) {
  let active = "style";

  const strip = el("div.tabstrip");
  const body = el("div.inspector-body");
  const selectionBar = el("div.inspector-selection");
  const layers = createLayers(editor);

  const node = el(
    "aside.inspector",
    el("div.inspector-head", selectionBar, strip),
    body,
  );

  for (const panel of PANELS) {
    strip.appendChild(
      el(
        "button",
        {
          type: "button",
          "aria-selected": String(panel.key === active),
          dataset: { panel: panel.key },
          onclick: () => setPanel(panel.key),
        },
        icon(panel.glyph),
        el("span", panel.label),
      ),
    );
  }

  function setPanel(key) {
    active = key;
    for (const button of strip.querySelectorAll("[data-panel]")) {
      button.setAttribute("aria-selected", String(button.dataset.panel === key));
    }
    render();
  }

  /* --- Selection header --------------------------------------------------- */

  function renderSelectionBar() {
    const ids = editor.selection;

    if (!ids.length) {
      mount(
        selectionBar,
        el("span.type-mark", icon("device")),
        el("div.col.spacer", el("b", { style: { fontSize: "var(--fs-12)" } }, editor.screen?.name ?? "Screen"), el("small.dim", { style: { fontSize: "var(--fs-11)" } }, editor.screen?.route ?? "")),
        el("span.dim", { style: { fontSize: "var(--fs-11)" } }, `${editor.nodeCount} nodes`),
      );
      return;
    }

    if (ids.length > 1) {
      mount(
        selectionBar,
        el("span.type-mark", icon("layers")),
        el("div.col.spacer", el("b", { style: { fontSize: "var(--fs-12)" } }, `${ids.length} selected`)),
        el("button.btn.sm.ghost", { onclick: () => editor.select([]) }, "Clear"),
      );
      return;
    }

    const layer = findNode(editor.screen.root, ids[0]);
    const def = getDef(layer?.type);

    mount(
      selectionBar,
      el("span.type-mark", icon(def?.glyph ?? "box")),
      el(
        "div.col.spacer",
        { style: { minWidth: 0 } },
        el("b.truncate", { style: { fontSize: "var(--fs-12)" } }, layer?.name || def?.label || layer?.type || "—"),
        el("small.truncate.dim", { style: { fontSize: "var(--fs-11)" } }, def?.description ?? ""),
      ),
      layer?.locked && el("span", { "data-tip": "Locked", style: { color: "var(--text-tertiary)", display: "flex" } }, icon("lock", 12)),
      el(
        "button.btn.sm.icon.ghost",
        { "data-tip": "Node actions", onclick: (event) => editor.openLayerMenu(event, layer) },
        icon("more"),
      ),
    );
  }

  /* --- Panels ------------------------------------------------------------- */

  function render() {
    renderSelectionBar();

    switch (active) {
      case "insert":
        mount(body, insertPanel());
        break;
      case "layers":
        mount(body, layers.node);
        layers.render();
        break;
      case "style":
        mount(body, stylePanel());
        break;
      case "data":
        mount(body, dataPanel());
        break;
      case "screen":
        mount(body, screenPanel());
        break;
      default:
        mount(body);
    }
  }

  /* ======================================================================
     Insert
     ====================================================================== */

  let insertMode = "blocks";
  let insertQuery = "";

  function insertPanel() {
    const wrap = el("div.col", { style: { minHeight: 0 } });

    const modes = segmented(
      [
        { value: "blocks", label: "Sections" },
        { value: "components", label: "Elements" },
        { value: "templates", label: "Screens" },
      ],
      insertMode,
      (value) => {
        insertMode = value;
        render();
      },
      { block: true },
    );

    wrap.appendChild(
      el(
        "div.palette-search",
        { style: { display: "flex", flexDirection: "column", gap: "var(--s-2)" } },
        modes,
        searchField(
          insertMode === "blocks" ? "Search section presets" : insertMode === "components" ? "Search elements" : "Search screen templates",
          (value) => {
            insertQuery = value;
            mount(list, ...listChildren());
          },
          { value: insertQuery },
        ),
      ),
    );

    const list = el("div.col", { style: { gap: 0, paddingBottom: "var(--s-6)" } });
    mount(list, ...listChildren());
    wrap.appendChild(list);
    return wrap;
  }

  function listChildren() {
    if (insertMode === "components") return componentList();
    if (insertMode === "templates") return templateList();
    return blockList();
  }

  function blockList() {
    const out = [];
    const q = insertQuery.trim();

    // Blocks saved from the canvas come first: they are this project's own,
    // and burying them under thirty built-ins would make "Save as a block"
    // a dead end.
    const saved = (editor.savedBlocks ?? []).filter((b) => fuzzy(q, b.name).hit);
    if (saved.length) {
      out.push(
        section(
          el("span.row", { style: { gap: "6px" } }, icon("package", 12), "Saved blocks", el("span.dim", { style: { fontWeight: 400 } }, `${saved.length}`)),
          el(
            "div.palette-grid",
            ...saved.map((block) =>
              blockCard(
                { key: block.key, name: block.name, description: "Saved from this design", tree: () => structuredClone(block.tree) },
                { onRemove: () => editor.removeSavedBlock(block.key) },
              ),
            ),
          ),
          { open: true, id: "blocks-saved" },
        ),
      );
    }

    for (const group of blockGroups) {
      const items = blocks
        .filter((b) => b.group === group.key)
        .map((b) => ({ block: b, match: fuzzy(q, `${b.name} ${b.description} ${b.tags.join(" ")}`) }))
        .filter((r) => r.match.hit)
        .sort((a, b) => b.match.score - a.match.score)
        .map((r) => r.block);

      if (!items.length) continue;

      out.push(
        section(
          el("span.row", { style: { gap: "6px" } }, icon(group.glyph, 12), group.name, el("span.dim", { style: { fontWeight: 400 } }, `${items.length}`)),
          el("div.palette-grid", ...items.map(blockCard)),
          { open: true, id: `blocks-${group.key}` },
        ),
      );
    }

    if (!out.length) {
      out.push(emptyState("search", "No section matches", "Try a different word, or switch to Elements for the raw building blocks."));
    }
    return out;
  }

  function blockCard(block, { onRemove = null } = {}) {
    return el(
      "div",
      { style: { position: "relative" } },
      el(
        "button.palette-card",
        {
          type: "button",
          style: { width: "100%" },
          "data-tip": block.description,
          "data-tip-place": "left-start",
          onclick: () => {
            editor.insertTree(block.tree(), { label: `Insert ${block.name}` });
          },
          onpointerdown: (event) => beginPaletteDrag(event, { label: block.name, glyph: "package", make: () => block.tree() }),
        },
        el("div.palette-thumb", thumbFor(block)),
        el("div.palette-meta", el("b", block.name), el("small", block.description)),
      ),
      onRemove &&
        el(
          "button.btn.sm.icon.ghost",
          {
            "data-tip": "Forget this block",
            style: { position: "absolute", top: "3px", right: "3px", background: "var(--surface-overlay)", border: "1px solid var(--line)" },
            onclick: (event) => {
              event.stopPropagation();
              onRemove();
            },
          },
          icon("close", 11),
        ),
    );
  }

  /** A real miniature render of the preset, not an illustration. */
  function thumbFor(block) {
    try {
      const tree = block.tree();
      stampIds(tree);
      // Rendered at phone width and scaled down, so the tile shows the block
      // at its real proportions rather than a squashed approximation.
      return renderMiniature(
        { id: "thumb", name: "thumb", root: tree },
        editor.theme,
        { width: 393, height: 240, fit: "width" },
      );
    } catch (error) {
      console.warn("[inspector] thumbnail failed", error);
      return icon("box", 20);
    }
  }

  function stampIds(node, seed = 0) {
    node.id = `t${seed}`;
    (node.children ?? []).forEach((child, i) => stampIds(child, seed * 20 + i + 1));
    return node;
  }

  function componentList() {
    const q = insertQuery.trim();
    const out = [];

    for (const category of categories) {
      const types = Object.keys(registry)
        .filter((type) => registry[type].category === category.key)
        .map((type) => ({ type, match: fuzzy(q, `${registry[type].label} ${type} ${registry[type].description}`) }))
        .filter((r) => r.match.hit)
        .sort((a, b) => b.match.score - a.match.score)
        .map((r) => r.type);

      if (!types.length) continue;

      out.push(
        section(
          el("span.row", { style: { gap: "6px" } }, icon(category.glyph, 12), category.key),
          el(
            "div.col",
            { style: { gap: "1px" } },
            ...types.map((type) => {
              const def = registry[type];
              return el(
                "button.palette-list-row",
                {
                  type: "button",
                  "data-tip": def.description,
                  "data-tip-place": "left-start",
                  onclick: () => editor.insertComponent(type),
                  onpointerdown: (event) => beginPaletteDrag(event, { label: def.label, glyph: def.glyph, make: () => editor.makeNode(type) }),
                },
                el("span.glyph", icon(def.glyph)),
                el("span.truncate", def.label),
                def.acceptsChildren && el("span", { style: { color: "var(--text-tertiary)", display: "flex" } }, icon("cornerDownRight", 11)),
              );
            }),
          ),
          { open: true, id: `cat-${category.key}` },
        ),
      );
    }

    if (!out.length) out.push(emptyState("search", "No element matches", "Every element the app can render is listed here."));
    return out;
  }

  function templateList() {
    const q = insertQuery.trim();
    const items = screenTemplates.filter((t) => fuzzy(q, `${t.name} ${t.description}`).hit);

    return [
      el(
        "div",
        { style: { padding: "var(--s-3)" } },
        el("div.callout", icon("info"), el("div", "A screen template replaces the current screen's content. Add a new screen first if you want to keep this one.")),
      ),
      el(
        "div.palette-grid",
        ...items.map((template) =>
          el(
            "button.palette-card",
            {
              type: "button",
              "data-tip": template.description,
              "data-tip-place": "left-start",
              onclick: () => editor.applyTemplate(template),
            },
            el("div.palette-thumb", thumbFor(template)),
            el("div.palette-meta", el("b", template.name), el("small", template.description)),
          ),
        ),
      ),
    ];
  }

  /** Drag a palette entry onto the canvas. */
  function beginPaletteDrag(event, { label, glyph, make }) {
    if (event.button !== 0) return;

    const ghost = el("div.drag-ghost", icon(glyph ?? "box"), label);
    let target = null;
    let started = false;

    drag(event, {
      threshold: 6,
      onStart: () => {
        started = true;
        document.body.appendChild(ghost);
      },
      onMove: ({ x, y }) => {
        ghost.style.left = `${x}px`;
        ghost.style.top = `${y}px`;
        target = editor.canvas.previewExternalDrop(x, y);
      },
      onEnd: () => {
        ghost.remove();
        editor.canvas.clearExternalDrop();
        if (!started) return;
        if (!target) return;
        editor.insertTree(make(), { parentId: target.parent.id, index: target.index, label: `Insert ${label}` });
      },
    });
  }

  /* ======================================================================
     Style
     ====================================================================== */

  function stylePanel() {
    const ids = editor.selection;

    if (!ids.length) {
      return el(
        "div.col",
        emptyState(
          "pointer",
          "Nothing selected",
          "Click an element on the canvas, or pick one from Layers, to edit its style.",
          el("button.btn.subtle", { onclick: () => setPanel("insert") }, icon("plus"), "Insert something"),
        ),
      );
    }

    if (ids.length > 1) return multiStylePanel(ids);

    const layer = findNode(editor.screen.root, ids[0]);
    const def = getDef(layer?.type);
    if (!layer || !def) return emptyState("alert", "Unknown component", `"${layer?.type}" is not in the registry.`);

    const declared = new Set(Object.keys(def.fields ?? {}));
    const out = [];

    out.push(contextBar(def, layer));

    // Style presets first: the fastest path to a decent result.
    //
    // A preset only applies the props the component actually declares, so a
    // group where just one preset would do anything is dropped: a lone chip
    // under a heading reads as a bug rather than as a deliberately short list.
    const applicable = (preset) => Object.keys(preset.props).some((k) => declared.has(k));
    const relevantGroups = stylePresetGroups
      .map((group) => ({ ...group, presets: group.presets.filter(applicable) }))
      .filter((group) => group.presets.length > 1);

    if (relevantGroups.length) {
      out.push(
        section(
          "Presets",
          el(
            "div.col",
            { style: { gap: "var(--s-3)" } },
            ...relevantGroups.map((group) =>
              el(
                "div.col",
                { style: { gap: "5px" } },
                el("span.field-label", group.name),
                el(
                  "div.preset-row",
                  ...group.presets
                    .map((preset) =>
                      el(
                        "button.preset-chip",
                        {
                          type: "button",
                          onclick: () => {
                            // A patch, so applying a preset while editing a
                            // breakpoint overrides only what the preset sets.
                            editor.patchProps(layer.id, stylePresetPatch(preset.props, declared));
                            editor.commit(`${preset.name} preset`);
                          },
                        },
                        preset.name,
                      ),
                    ),
                ),
              ),
            ),
          ),
          { open: true, id: "presets" },
        ),
      );
    }

    for (const group of groupedFields(layer.type)) {
      out.push(
        section(
          group.name,
          el("div.col", { style: { gap: "var(--s-2)" } }, ...group.fields.map((spec) => controlFor(layer, spec))),
          { open: group.name === "Content" || group.name === "Size" || group.name === "Appearance", id: `style-${group.name}` },
        ),
      );
    }

    return el("div.col", { style: { gap: 0 } }, ...out);
  }

  /**
   * Breakpoint and interaction-state selector.
   *
   * A breakpoint that already carries overrides is marked, and the bar states
   * which layer edits are landing in — the one thing that has to be
   * unambiguous, because every control below writes into it.
   */
  function contextBar(def, layer) {
    const states = ["default", ...(def.states ?? [])];
    const overrideCount =
      editor.state !== "default"
        ? Object.keys(layer.states?.[editor.state] ?? {}).length
        : editor.breakpoint !== "base"
          ? Object.keys(layer.responsive?.[editor.breakpoint] ?? {}).length
          : 0;

    const editingBase = editor.breakpoint === "base" && editor.state === "default";

    return el(
      "div.col",
      { style: { gap: 0 } },
      el(
        "div.style-context",
        el(
          "div.col",
          { style: { gap: "3px", flex: "1 1 0", minWidth: 0 } },
          el("span.field-label", "Breakpoint"),
          segmented(
            BREAKPOINTS.map((b) => ({
              value: b.key,
              icon: b.glyph,
              tip: `${b.label} — ${b.hint}${Object.keys(layer.responsive?.[b.key] ?? {}).length ? ` · ${Object.keys(layer.responsive[b.key]).length} overridden` : ""}`,
            })),
            editor.breakpoint,
            (value) => {
              editor.breakpoint = value;
              editor.canvas.render();
              render();
            },
            { block: true },
          ),
        ),
        states.length > 1 &&
          el(
            "div.col",
            { style: { gap: "3px", flex: "1 1 0", minWidth: 0 } },
            el("span.field-label", "State"),
            el(
              "select.select",
              {
                value: editor.state,
                onchange: (event) => {
                  editor.state = event.target.value;
                  editor.canvas.render();
                  render();
                },
              },
              ...states.map((s) => el("option", { value: s }, fmt.label(s))),
            ),
          ),
      ),
      !editingBase &&
        el(
          "div",
          {
            style: {
              display: "flex",
              alignItems: "center",
              gap: "6px",
              padding: "6px var(--s-3)",
              background: "var(--warning-soft)",
              color: "var(--warning)",
              fontSize: "var(--fs-11)",
              borderBottom: "1px solid var(--line-faint)",
            },
          },
          icon("layers", 12),
          el(
            "span",
            { style: { flex: "1 1 auto" } },
            editor.state !== "default"
              ? `Editing the ${fmt.label(editor.state)} state · ${overrideCount} override${overrideCount === 1 ? "" : "s"}`
              : `Editing the ${BREAKPOINTS.find((b) => b.key === editor.breakpoint)?.label} override · ${overrideCount} value${overrideCount === 1 ? "" : "s"}`,
          ),
          el(
            "button",
            {
              type: "button",
              style: { color: "inherit", textDecoration: "underline", fontSize: "var(--fs-11)" },
              onclick: () => {
                editor.breakpoint = "base";
                editor.state = "default";
                editor.canvas.render();
                render();
              },
            },
            "Back to base",
          ),
        ),
    );
  }

  function multiStylePanel(ids) {
    const types = new Set(ids.map((id) => findNode(editor.screen.root, id)?.type));
    const shared = [...types].length === 1 ? [...types][0] : null;

    return el(
      "div.col",
      { style: { gap: 0 } },
      section(
        "Arrange",
        el(
          "div.col",
          { style: { gap: "var(--s-2)" } },
          el(
            "div.preset-row",
            el("button.preset-chip", { onclick: () => editor.wrapSelection() }, icon("stack", 11), "Wrap in stack"),
            el("button.preset-chip", { onclick: () => editor.wrapSelection("Card") }, icon("card", 11), "Wrap in card"),
            el("button.preset-chip", { onclick: () => editor.duplicate() }, icon("duplicate", 11), "Duplicate"),
            el("button.preset-chip", { onclick: () => editor.deleteSelection() }, icon("trash", 11), "Delete"),
          ),
        ),
        { open: true },
      ),
      shared
        ? section(
            "Shared presets",
            el(
              "div.col",
              { style: { gap: "var(--s-3)" } },
              ...stylePresetGroups.map((group) =>
                el(
                  "div.col",
                  { style: { gap: "5px" } },
                  el("span.field-label", group.name),
                  el(
                    "div.preset-row",
                    ...group.presets.map((preset) =>
                      el(
                        "button.preset-chip",
                        {
                          onclick: () => {
                            const declared = new Set(Object.keys(getDef(shared)?.fields ?? {}));
                            for (const id of ids) {
                              const layer = findNode(editor.screen.root, id);
                              editor.patchProps(id, stylePresetPatch(preset.props, declared), { silent: true });
                            }
                            editor.commit(`${preset.name} preset on ${ids.length}`);
                          },
                        },
                        preset.name,
                      ),
                    ),
                  ),
                ),
              ),
            ),
            { open: true },
          )
        : el(
            "div",
            { style: { padding: "var(--s-4)" } },
            el("div.callout", icon("info"), el("div", "The selection mixes component types. Select one type at a time to edit its style, or use Arrange above.")),
          ),
    );
  }

  /* --- Individual controls ------------------------------------------------ */

  function controlFor(layer, spec) {
    // Read through the layer stack, not the base props, so the panel shows
    // what the canvas is drawing for the selected breakpoint and state.
    const value = editor.effectiveProps(layer)[spec.key];
    const origin = editor.originOf(layer, spec.key);
    const overridden = origin === "breakpoint" || origin === "state";
    const bound = value && typeof value === "object" && Object.hasOwn(value, "$bind");

    const set = (next, meta = {}) => {
      editor.patchProps(layer.id, { [spec.key]: next }, { silent: meta.live });
      if (!meta.live) editor.commit(`${spec.label ?? fmt.label(spec.key)}`, { coalesceKey: `prop:${layer.id}:${spec.key}` });
    };

    /**
     * The label carries the override state: a dot when this layer sets its own
     * value, clickable to drop back to inherited. Without it, an override is
     * invisible and people edit the wrong layer for an hour.
     */
    const labelNode = (extra = null) =>
      el(
        "span.field-label.row",
        { style: { gap: "4px", minWidth: 0 } },
        overridden
          ? el("button", {
              class: "inherited-mark",
              "data-tip": `Overridden at ${editor.state !== "default" ? fmt.label(editor.state) : editor.breakpoint}. Click to inherit again.`,
              style: { border: 0, padding: 0, cursor: "pointer" },
              onclick: () => editor.clearOverride(layer.id, spec.key),
            })
          : null,
        el("span.truncate", spec.label ?? fmt.label(spec.key)),
        extra,
      );

    if (bound) {
      return el(
        "div.field-row",
        labelNode(),
        el(
          "div.row",
          { style: { gap: "4px" } },
          el("span.token-badge", icon("link"), value.$bind),
          el("div.spacer"),
          el(
            "button.btn.sm.icon.ghost",
            {
              "data-tip": "Unbind",
              onclick: () => {
                set(value.fallback ?? "");
              },
            },
            icon("close"),
          ),
        ),
      );
    }

    const control = buildControl(spec, value, set, layer);

    // A bindable field gets a small link affordance beside it.
    if (spec.bindable) {
      return el(
        "div.field-row",
        labelNode(
          el(
            "button",
            {
              type: "button",
              "data-tip": "Bind to data",
              style: { color: "var(--text-tertiary)", display: "flex", padding: "1px", borderRadius: "3px", flex: "none" },
              onclick: () => {
                setPanel("data");
                editor.pendingBindKey = spec.key;
              },
            },
            icon("link", 10),
          ),
        ),
        control,
      );
    }

    // Controls taller than one line get the label above them. Squeezing a
    // list of task rows into the 1fr half of an 84px/1fr grid leaves every
    // input too narrow to read what is in it.
    const WIDE = new Set(["spacing", "radius", "size", "textarea", "items", "chips"]);
    if (WIDE.has(spec.control)) {
      return el("div.field-row.wide", labelNode(), control);
    }

    return el("div.field-row", labelNode(), control);
  }

  function buildControl(spec, value, set, layer) {
    switch (spec.control) {
      case "text":
        return el("input.input", {
          value: value ?? "",
          placeholder: spec.placeholder ?? "",
          oninput: (event) => set(event.target.value, { live: true }),
          onchange: (event) => set(event.target.value),
        });

      case "textarea":
        return el("textarea.textarea", {
          value: value ?? "",
          rows: 3,
          oninput: (event) => set(event.target.value, { live: true }),
          onchange: (event) => set(event.target.value),
        });

      case "number":
        return numberField(value ?? 0, (v, meta) => set(v, meta), {
          min: spec.min ?? -9999,
          max: spec.max ?? 9999,
          step: spec.step ?? 1,
          unit: spec.unit,
          tagIcon: "slidersH",
          tip: "Drag to change",
        });

      case "slider":
        return sliderField(Number(value ?? spec.min ?? 0), (v, meta) => set(v, meta), {
          min: spec.min ?? 0,
          max: spec.max ?? 100,
          step: spec.step ?? 1,
        });

      case "select":
        return el(
          "select.select",
          {
            value: String(value ?? ""),
            onchange: (event) => {
              const raw = event.target.value;
              const option = spec.options.find((o) => String(o.value) === raw);
              set(option ? option.value : raw);
            },
          },
          ...spec.options.map((o) => el("option", { value: String(o.value) }, o.label)),
        );

      case "segmented":
        return segmented(spec.options, value, (v) => set(v), { block: true });

      case "switch":
        return el("div.row", switchControl(Boolean(value), (v) => set(v)));

      case "color": {
        // A transparent value stays transparent: it must reach colorField as
        // itself so the control can show a none state instead of black.
        const resolved =
          typeof value === "string" && value.startsWith("#")
            ? value
            : (resolveThemeColor(value, editor.theme) ?? (spec.allowNone ? "transparent" : editor.theme?.colors?.text ?? "#000000"));

        return colorField(resolved, (v, meta) => set(v, meta), {
          contrastAgainst: editor.theme?.colors?.background,
          allowNone: Boolean(spec.allowNone),
        });
      }

      case "icon":
        return iconControl(value, (v) => set(v));

      case "size":
        return sizeControl(value ?? {}, (v, meta) => set(v, meta), layer);

      case "spacing":
        return spacingControl(value ?? {}, (v, meta) => set(v, meta));

      case "radius":
        return radiusControl(value ?? 0, (v, meta) => set(v, meta));

      case "shadow":
        return el(
          "div.preset-row",
          ...shadowKeys.map((key) =>
            el(
              "button",
              {
                type: "button",
                class: `preset-chip${value === key ? " active" : ""}`,
                onclick: () => set(key),
              },
              fmt.label(key),
            ),
          ),
        );

      case "items":
        return itemsControl(value ?? [], (v) => set(v), spec);

      default:
        return el("input.input", { value: String(value ?? ""), onchange: (event) => set(event.target.value) });
    }
  }

  function resolveThemeColor(value, theme) {
    if (typeof value !== "string") return null;
    const match = value.match(/^\{\{theme\.colors\.(\w+)\}\}$/);
    if (match) return theme?.colors?.[match[1]] ?? null;
    return null;
  }

  /* --- Composite controls -------------------------------------------------- */

  function sizeControl(size, set, layer) {
    const def = getDef(layer.type);
    const modeFor = (axis) => {
      const v = size[axis];
      if (v === "fill") return "fill";
      if (v === "hug" || v === undefined) return "hug";
      return "fixed";
    };

    const axisRow = (axis, label) => {
      const enabled = axis === "width" ? def?.resizable?.width !== false : def?.resizable?.height !== false;
      const mode = modeFor(axis);

      return el(
        "div",
        { style: { display: "grid", gridTemplateColumns: "1fr 88px", gap: "4px", alignItems: "center" } },
        segmented(
          [
            { value: "hug", label: "Hug", tip: "Size to content" },
            { value: "fill", label: "Fill", tip: "Fill the parent" },
            { value: "fixed", label: "Fixed", tip: "An exact value" },
          ],
          mode,
          (next) => {
            const value = next === "fixed" ? (typeof size[axis] === "number" ? size[axis] : axis === "width" ? 200 : 48) : next;
            set({ ...size, [axis]: value });
          },
          { block: true },
        ),
        mode === "fixed"
          ? numberField(Number(size[axis]) || 0, (v, meta) => set({ ...size, [axis]: v }, meta), { min: 0, max: 4000, unit: "px", tag: label })
          : el("span.dim", { style: { fontSize: "var(--fs-11)", textAlign: "center" } }, mode === "fill" ? "100%" : "auto"),
      );
    };

    return el(
      "div.col",
      { style: { gap: "5px" }, dataset: { disabled: "false" } },
      el("span.field-label", "Width"),
      axisRow("width", "W"),
      el("span.field-label", "Height"),
      axisRow("height", "H"),
    );
  }

  /** The visual box-model editor, with a link toggle for all four sides. */
  function spacingControl(spacing, set) {
    let linked = spacing.top === spacing.right && spacing.right === spacing.bottom && spacing.bottom === spacing.left;

    const input = (side, cls) =>
      el("input", {
        class: cls,
        value: spacing[side] ?? 0,
        inputMode: "numeric",
        onchange: (event) => {
          const v = Number.parseFloat(event.target.value) || 0;
          set(linked ? { top: v, right: v, bottom: v, left: v } : { ...spacing, [side]: v });
        },
        onkeydown: (event) => {
          const dir = event.key === "ArrowUp" ? 1 : event.key === "ArrowDown" ? -1 : 0;
          if (!dir) return;
          event.preventDefault();
          const v = clamp((Number.parseFloat(event.target.value) || 0) + dir * (event.shiftKey ? 8 : 4), 0, 400);
          event.target.value = v;
          set(linked ? { top: v, right: v, bottom: v, left: v } : { ...spacing, [side]: v });
        },
      });

    const linkButton = el(
      "button",
      {
        type: "button",
        class: `box-link${linked ? " on" : ""}`,
        "data-tip": linked ? "Sides linked" : "Link all sides",
        onclick: () => {
          linked = !linked;
          linkButton.classList.toggle("on", linked);
          if (linked) {
            const v = spacing.top ?? 0;
            set({ top: v, right: v, bottom: v, left: v });
          }
        },
      },
      icon("link"),
    );

    return el(
      "div.box-model",
      input("top", "t"),
      input("left", "l"),
      el("div.box-center", linkButton),
      input("right", "r"),
      input("bottom", "b"),
    );
  }

  function radiusControl(radius, set) {
    const isUniform = typeof radius === "number";
    let uniform = isUniform;

    const corners = isUniform
      ? { tl: radius, tr: radius, br: radius, bl: radius }
      : { tl: 0, tr: 0, br: 0, bl: 0, ...radius };

    const toggle = el(
      "button.btn.sm.icon.ghost",
      {
        "data-tip": uniform ? "Per-corner" : "All corners",
        onclick: () => {
          uniform = !uniform;
          set(uniform ? corners.tl : { ...corners });
        },
      },
      icon(uniform ? "corner" : "link"),
    );

    if (uniform) {
      return el(
        "div",
        { style: { display: "grid", gridTemplateColumns: "1fr auto", gap: "4px" } },
        el(
          "div.col",
          { style: { gap: "4px" } },
          numberField(corners.tl, (v, meta) => set(v, meta), { min: 0, max: 999, unit: "px", tagIcon: "corner" }),
          el(
            "div.preset-row",
            ...[0, 6, 10, 14, 20, 999].map((value) =>
              el("button.preset-chip", { onclick: () => set(value) }, value === 999 ? "Pill" : String(value)),
            ),
          ),
        ),
        toggle,
      );
    }

    return el(
      "div",
      { style: { display: "grid", gridTemplateColumns: "1fr auto", gap: "4px" } },
      el(
        "div.corner-grid",
        ...["tl", "tr", "bl", "br"].map((corner) =>
          numberField(corners[corner], (v, meta) => set({ ...corners, [corner]: v }, meta), { min: 0, max: 999, tag: corner.toUpperCase() }),
        ),
      ),
      toggle,
    );
  }

  function iconControl(value, set) {
    const preview = el(
      "button.btn.subtle",
      {
        style: { width: "100%", justifyContent: "flex-start" },
        onclick: () => openIconPicker(value, set),
      },
      value ? icon(value) : icon("search"),
      el("span.truncate", value || "Choose an icon"),
      el("div.spacer"),
      value && el("span", { style: { color: "var(--text-tertiary)", display: "flex" }, onclick: (e) => { e.stopPropagation(); set(""); } }, icon("close", 12)),
    );
    return preview;
  }

  function openIconPicker(current, set) {
    modal((close) => {
      let query = "";
      const grid = el("div.icon-grid");

      const paint = () => {
        const names = iconNames.filter((name) => fuzzy(query, name).hit);
        mount(
          grid,
          ...names.map((name) =>
            el(
              "button",
              {
                type: "button",
                class: `icon-cell${name === current ? " active" : ""}`,
                "data-tip": name,
                onclick: () => {
                  set(name);
                  close();
                },
              },
              icon(name),
            ),
          ),
        );
      };
      paint();

      return {
        title: "Choose an icon",
        subtitle: `${iconNames.length} glyphs, one grid, one stroke weight.`,
        body: [
          searchField("Search icons", (value) => {
            query = value;
            paint();
          }),
          grid,
        ],
      };
    });
  }

  /** Editor for list-shaped props: chips, list rows, tab labels. */
  /**
   * A `shape` entry is either a key name, edited as text, or a descriptor
   * `{ key, control, options }` so a row can carry a switch or an enum. Task
   * rows and note cards need both, and a checkbox typed as the string "true"
   * is the kind of thing that only breaks once it reaches the renderer.
   */
  function itemsControl(items, set, spec) {
    const shape = spec.shape ? spec.shape.map((s) => (typeof s === "string" ? { key: s } : s)) : null;

    const move = (index, delta) => {
      const target = index + delta;
      if (target < 0 || target >= items.length) return;
      const next = [...items];
      [next[index], next[target]] = [next[target], next[index]];
      set(next);
    };

    const rows = items.map((item, index) => {
      if (!shape) {
        return el(
          "div.row",
          { style: { gap: "4px" } },
          el("input.input", {
            value: String(item ?? ""),
            onchange: (event) => {
              const next = [...items];
              next[index] = event.target.value;
              set(next);
            },
          }),
          el(
            "button.btn.sm.icon.ghost",
            {
              "data-tip": "Remove",
              onclick: () => set(items.filter((_, i) => i !== index)),
            },
            icon("close"),
          ),
        );
      }

      const write = (key) => (value) => {
        const next = [...items];
        next[index] = { ...item, [key]: value };
        set(next);
      };

      const controlFor = (entry) => {
        const current = item?.[entry.key];
        switch (entry.control) {
          case "icon":
            return iconControl(current, write(entry.key));
          case "switch":
            return el("div.row", switchControl(Boolean(current), write(entry.key)));
          case "select": {
            const options = entry.options ?? [];
            return el(
              "select.select",
              {
                value: String(current ?? options[0]?.value ?? ""),
                onchange: (event) => {
                  const raw = event.target.value;
                  const option = options.find((o) => String(o.value) === raw);
                  write(entry.key)(option ? option.value : raw);
                },
              },
              ...options.map((o) => el("option", { value: String(o.value) }, o.label)),
            );
          }
          case "color":
            return colorField(
              typeof current === "string" && current.startsWith("#")
                ? current
                : (resolveThemeColor(current, editor.theme) ?? editor.theme?.colors?.primary ?? "#000000"),
              write(entry.key),
              { contrastAgainst: editor.theme?.colors?.background },
            );
          case "number":
            return numberField(Number(current) || 0, write(entry.key), entry);
          default:
            return el("input.input", {
              value: String(current ?? ""),
              placeholder: entry.placeholder ?? "",
              onchange: (event) => write(entry.key)(event.target.value),
            });
        }
      };

      // `glyph` stays special-cased by name so the shapes written before typed
      // entries existed keep their icon picker.
      const typed = shape.map((entry) => (entry.control ? entry : { ...entry, control: entry.key === "glyph" ? "icon" : "text" }));

      const title = item?.title ?? item?.label ?? item?.name ?? "";

      return el(
        "div.action-card",
        el(
          "div.action-card-head",
          icon("dragHandle", 12),
          el("span.spacer", String(title).trim() || `Item ${index + 1}`),
          el(
            "button.btn.sm.icon.ghost",
            { "data-tip": "Move up", disabled: index === 0, onclick: () => move(index, -1) },
            icon("arrowUp"),
          ),
          el(
            "button.btn.sm.icon.ghost",
            { "data-tip": "Move down", disabled: index === items.length - 1, onclick: () => move(index, 1) },
            icon("arrowDown"),
          ),
          el("button.btn.sm.icon.ghost", { "data-tip": "Remove", onclick: () => set(items.filter((_, i) => i !== index)) }, icon("close")),
        ),
        el("div.action-card-body", ...typed.map((entry) => fieldRow(entry.label ?? fmt.label(entry.key), controlFor(entry)))),
      );
    });

    return el(
      "div.col",
      { style: { gap: "var(--s-2)" } },
      ...rows,
      el(
        "button.btn.subtle.sm",
        {
          style: { width: "100%" },
          onclick: () => {
            const blank = shape
              ? Object.fromEntries(
                  shape.map((entry) => {
                    if (entry.control === "switch") return [entry.key, false];
                    if (entry.control === "select") return [entry.key, entry.options?.[0]?.value ?? ""];
                    if (entry.control === "number") return [entry.key, entry.min ?? 0];
                    return [entry.key, ""];
                  }),
                )
              : "New item";
            set([...items, blank]);
          },
        },
        icon("plus"),
        "Add item",
      ),
    );
  }

  /* ======================================================================
     Data
     ====================================================================== */

  function dataPanel() {
    const ids = editor.selection;
    if (ids.length !== 1) {
      return emptyState("appdata", "Select one element", "Bindings, actions and conditions apply to a single element at a time.");
    }

    const layer = findNode(editor.screen.root, ids[0]);
    const def = getDef(layer?.type);
    if (!layer || !def) return emptyState("alert", "Unknown component", "");

    const bindable = Object.entries(def.fields ?? {}).filter(([, spec]) => spec.bindable);
    const sources = editor.dataSources();

    return el(
      "div.col",
      { style: { gap: 0 } },
      section("Bind a property", bindingSection(layer, bindable, sources), { open: true, id: "bind" }),
      section("Actions", actionsSection(layer), { open: true, id: "actions" }),
      section("Conditional visibility", conditionSection(layer), { open: Boolean(layer.visibleIf), id: "conditions" }),
    );
  }

  function bindingSection(layer, bindable, sources) {
    if (!bindable.length) {
      return el("div.callout", icon("info"), el("div", `${getDef(layer.type)?.label} has no bindable properties. Text, labels and values are the usual ones.`));
    }

    let propKey = editor.pendingBindKey && bindable.some(([k]) => k === editor.pendingBindKey) ? editor.pendingBindKey : bindable[0][0];
    editor.pendingBindKey = null;

    let sourceId = sources[0]?.id ?? null;
    const tree = el("div.source-tree");
    const formatSelect = el("select.select", ...formatterNames.map((f) => el("option", { value: f }, fmt.label(f))));
    const fallbackInput = el("input.input", { placeholder: "Shown when the value is missing" });

    function paintTree() {
      const source = sources.find((s) => s.id === sourceId);
      if (!source) {
        mount(tree, el("div", { style: { padding: "var(--s-3)", fontSize: "var(--fs-11)", color: "var(--text-tertiary)" } }, "No source selected."));
        return;
      }

      mount(
        tree,
        ...source.fields.map((field) =>
          el(
            "button.source-field",
            {
              type: "button",
              onclick: () => {
                editor.patchProps(layer.id, {
                  [propKey]: {
                    $bind: `${source.key}.${field.key}`,
                    format: formatSelect.value === "none" ? undefined : formatSelect.value,
                    fallback: fallbackInput.value || undefined,
                  },
                });
                editor.commit(`Bind ${propKey}`);
                toast(`${fmt.label(propKey)} bound to ${source.key}.${field.key}`, { tone: "success", duration: 2600 });
                render();
              },
            },
            icon("link", 11),
            el("span", `${source.key}.${field.key}`),
            el("span.value", String(source.sample?.[field.key] ?? "—")),
          ),
        ),
      );
    }

    const propSelect = el(
      "select.select",
      { onchange: (event) => (propKey = event.target.value) },
      ...bindable.map(([key, spec]) => el("option", { value: key, selected: key === propKey }, spec.label ?? fmt.label(key))),
    );

    const sourceSelect = el(
      "select.select",
      {
        onchange: (event) => {
          sourceId = event.target.value;
          paintTree();
        },
      },
      ...sources.map((s) => el("option", { value: s.id }, `${s.name} (${s.count})`)),
    );

    paintTree();

    return el(
      "div.col",
      { style: { gap: "var(--s-2)" } },
      fieldRow("Property", propSelect),
      fieldRow("Source", sourceSelect),
      el("span.field-label", "Click a field to bind it"),
      tree,
      fieldRow("Format", formatSelect),
      fieldRow("Fallback", fallbackInput),
      el(
        "div.callout",
        icon("shield"),
        el("div", el("b", "Registered sources only."), " The document never carries a URL; the server resolves a source id to an endpoint, so a design cannot make the app call somewhere new."),
      ),
    );
  }

  const ACTION_TYPES = [
    "navigate",
    "goBack",
    "openModal",
    "closeModal",
    "callSource",
    "submitForm",
    "setState",
    "copyToClipboard",
    "openUrl",
    "signOut",
  ];

  function actionsSection(layer) {
    const actions = layer.actions ?? {};
    const triggers = ["onPress", "onLongPress", "onChange", "onSubmit", "onAppear"];

    const setActions = (next) => {
      editor.setActions(layer.id, next);
      editor.commit("Edit actions");
      render();
    };

    const cards = Object.entries(actions).map(([trigger, chain]) => {
      const list = Array.isArray(chain) ? chain : [chain];

      return el(
        "div.action-card",
        el(
          "div.action-card-head",
          icon("bolt", 12),
          el("span.spacer", fmt.label(trigger)),
          el(
            "button.btn.sm.icon.ghost",
            {
              "data-tip": "Remove trigger",
              onclick: () => {
                const next = { ...actions };
                delete next[trigger];
                setActions(next);
              },
            },
            icon("close"),
          ),
        ),
        el(
          "div.action-card-body",
          ...list.map((step, index) =>
            el(
              "div.col",
              { style: { gap: "4px" } },
              el(
                "div.row",
                { style: { gap: "4px" } },
                el(
                  "select.select",
                  {
                    onchange: (event) => {
                      const next = { ...actions };
                      next[trigger] = list.map((s, i) => (i === index ? { ...s, type: event.target.value } : s));
                      setActions(next);
                    },
                  },
                  ...ACTION_TYPES.map((t) => el("option", { value: t, selected: t === step.type }, fmt.label(t))),
                ),
                list.length > 1 &&
                  el(
                    "button.btn.sm.icon.ghost",
                    {
                      "data-tip": "Remove step",
                      onclick: () => {
                        const next = { ...actions };
                        next[trigger] = list.filter((_, i) => i !== index);
                        setActions(next);
                      },
                    },
                    icon("close"),
                  ),
              ),
              ...actionParams(step, (patch) => {
                const next = { ...actions };
                next[trigger] = list.map((s, i) => (i === index ? { ...s, ...patch } : s));
                setActions(next);
              }),
            ),
          ),
          el(
            "button.btn.sm.ghost",
            {
              style: { width: "100%" },
              onclick: () => {
                const next = { ...actions };
                next[trigger] = [...list, { type: "navigate", to: "/home" }];
                setActions(next);
              },
            },
            icon("plus"),
            "Chain another action",
          ),
        ),
      );
    });

    const unused = triggers.filter((t) => !actions[t]);

    return el(
      "div.col",
      { style: { gap: "var(--s-2)" } },
      ...(cards.length ? cards : [el("div.callout", icon("info"), el("div", "No actions yet. Pick a trigger below to make this element do something."))]),
      unused.length &&
        el(
          "div.preset-row",
          ...unused.map((trigger) =>
            el(
              "button.preset-chip",
              {
                onclick: () => setActions({ ...actions, [trigger]: [{ type: "navigate", to: editor.doc.screens[0]?.route ?? "/home" }] }),
              },
              icon("plus", 10),
              fmt.label(trigger),
            ),
          ),
        ),
    );
  }

  function actionParams(step, patch) {
    switch (step.type) {
      case "navigate":
        return [
          fieldRow(
            "To",
            el(
              "select.select",
              { onchange: (event) => patch({ to: event.target.value }) },
              ...editor.doc.screens.map((s) => el("option", { value: s.route, selected: s.route === step.to }, `${s.name} — ${s.route}`)),
            ),
          ),
        ];
      case "openUrl":
        return [fieldRow("URL", el("input.input", { value: step.url ?? "", onchange: (e) => patch({ url: e.target.value }) }))];
      case "callSource":
        return [
          fieldRow(
            "Source",
            el(
              "select.select",
              { onchange: (event) => patch({ source: event.target.value }) },
              ...editor.dataSources().map((s) => el("option", { value: s.id, selected: s.id === step.source }, s.name)),
            ),
          ),
        ];
      case "setState":
        return [
          fieldRow("Key", el("input.input", { value: step.key ?? "", onchange: (e) => patch({ key: e.target.value }) })),
          fieldRow("Value", el("input.input", { value: step.value ?? "", onchange: (e) => patch({ value: e.target.value }) })),
        ];
      case "openModal":
        return [fieldRow("Modal id", el("input.input", { value: step.modal ?? "", onchange: (e) => patch({ modal: e.target.value }) }))];
      case "copyToClipboard":
        return [fieldRow("Text", el("input.input", { value: step.text ?? "", onchange: (e) => patch({ text: e.target.value }) }))];
      default:
        return [];
    }
  }

  function conditionSection(layer) {
    const condition = layer.visibleIf ?? null;
    const clauses = condition?.all ?? [];

    const setCondition = (next) => {
      editor.setCondition(layer.id, next);
      editor.commit("Edit visibility");
      render();
    };

    const scopes = ["user.role", "user.id", "user.firstName", "org.plan", "org.id", "state.expanded", "route.params.id"];

    return el(
      "div.col",
      { style: { gap: "var(--s-2)" } },
      clauses.length
        ? el(
            "div.col",
            { style: { gap: "4px" } },
            el("span.field-label", "Show this element only when all of these are true"),
            ...clauses.map((clause, index) =>
              el(
                "div.condition-row",
                el(
                  "select.select",
                  {
                    onchange: (event) => {
                      const next = clauses.map((c, i) => (i === index ? { ...c, left: `$${event.target.value}` } : c));
                      setCondition({ all: next });
                    },
                  },
                  ...scopes.map((s) => el("option", { value: s, selected: `$${s}` === clause.left }, s)),
                ),
                el(
                  "select.select",
                  {
                    onchange: (event) => {
                      const next = clauses.map((c, i) => (i === index ? { ...c, op: event.target.value } : c));
                      setCondition({ all: next });
                    },
                  },
                  ...comparators.map((c) => el("option", { value: c, selected: c === clause.op }, c)),
                ),
                el("input.input", {
                  value: clause.right ?? "",
                  onchange: (event) => {
                    const next = clauses.map((c, i) => (i === index ? { ...c, right: event.target.value } : c));
                    setCondition({ all: next });
                  },
                }),
                el(
                  "button.btn.sm.icon.ghost",
                  {
                    onclick: () => {
                      const next = clauses.filter((_, i) => i !== index);
                      setCondition(next.length ? { all: next } : null);
                    },
                  },
                  icon("close"),
                ),
              ),
            ),
          )
        : el("div.callout", icon("eye"), el("div", "Always visible. Add a condition to hide it for some users.")),
      el(
        "button.btn.subtle.sm",
        {
          style: { width: "100%" },
          onclick: () => setCondition({ all: [...clauses, { left: "$user.role", op: "==", right: "app_user" }] }),
        },
        icon("plus"),
        "Add a condition",
      ),
      clauses.length &&
        el(
          "div.callout",
          icon("shield"),
          el("div", el("b", "No code is evaluated."), " Conditions are structured data, checked by a comparison-only interpreter with no function calls."),
        ),
    );
  }

  /* ======================================================================
     Screen
     ====================================================================== */

  function screenPanel() {
    const screen = editor.screen;
    if (!screen) return emptyState("device", "No screen", "Add a screen to begin.");

    const patch = (key, value, label) => {
      editor.patchScreen({ [key]: value });
      editor.commit(label ?? `Screen ${key}`, { coalesceKey: `screen:${key}` });
    };

    const duplicateRoute = editor.doc.screens.some((s) => s.id !== screen.id && s.route === screen.route);

    return el(
      "div.col",
      { style: { gap: 0 } },
      section(
        "Route",
        el(
          "div.col",
          { style: { gap: "var(--s-2)" } },
          fieldRow("Name", el("input.input", { value: screen.name, onchange: (e) => patch("name", e.target.value, "Rename screen") })),
          fieldRow(
            "Path",
            el("input.input", {
              value: screen.route,
              spellcheck: false,
              class: duplicateRoute ? "input invalid" : "input",
              onchange: (e) => patch("route", e.target.value.startsWith("/") ? e.target.value : `/${e.target.value}`, "Change route"),
            }),
          ),
          duplicateRoute && el("div.callout.danger", icon("alert"), el("div", "Another screen already uses this path. Publish is blocked until it is unique.")),
          fieldRow("Entry screen", el("div.row", switchControl(Boolean(screen.isEntry), (v) => patch("isEntry", v, "Set entry screen")))),
          fieldRow(
            "Requires role",
            el(
              "select.select",
              { onchange: (e) => patch("requiresRole", e.target.value || null, "Set required role") },
              el("option", { value: "", selected: !screen.requiresRole }, "Anyone signed in"),
              ...["app_user", "org_admin", "designer", "viewer"].map((r) => el("option", { value: r, selected: screen.requiresRole === r }, fmt.label(r))),
            ),
          ),
        ),
        { open: true, id: "screen-route" },
      ),
      section(
        "Behaviour",
        el(
          "div.col",
          { style: { gap: "var(--s-2)" } },
          fieldRow(
            "Transition",
            segmented(
              [
                { value: "slide", label: "Slide" },
                { value: "fade", label: "Fade" },
                { value: "none", label: "None" },
              ],
              screen.transition ?? "slide",
              (v) => patch("transition", v, "Change transition"),
              { block: true },
            ),
          ),
          fieldRow("Scrollable", el("div.row", switchControl(screen.scroll !== false, (v) => patch("scroll", v, "Scroll behaviour")))),
          fieldRow("Safe area", el("div.row", switchControl(screen.safeArea !== false, (v) => patch("safeArea", v, "Safe area")))),
        ),
        { open: true, id: "screen-behaviour" },
      ),
      section(
        "Device",
        el(
          "div.col",
          { style: { gap: "var(--s-2)" } },
          fieldRow(
            "Frame",
            el(
              "select.select",
              {
                onchange: (event) => {
                  editor.setDevice(event.target.value);
                },
              },
              ...devices.map((d) => el("option", { value: d.key, selected: d.key === editor.device.key }, `${d.name} · ${d.width}×${d.height}`)),
            ),
          ),
          fieldRow(
            "Rotate",
            el("div.row", switchControl(editor.rotated, (v) => editor.setRotated(v))),
          ),
        ),
        { open: true, id: "screen-device" },
      ),
      section(
        "This screen",
        el(
          "div.col",
          { style: { gap: "var(--s-2)" } },
          el(
            "div.row",
            { style: { gap: "var(--s-3)" } },
            el("div.inline-stat", el("b", String(editor.nodeCount)), el("span", "nodes")),
            el("div.inline-stat", el("b", String(editor.maxDepth)), el("span", "max depth")),
            el("div.inline-stat", el("b", String(editor.doc.screens.length)), el("span", "screens")),
          ),
          el(
            "div.preset-row",
            el("button.preset-chip", { onclick: () => editor.duplicateScreen() }, icon("duplicate", 10), "Duplicate screen"),
            el("button.preset-chip", { onclick: () => editor.addScreen() }, icon("plus", 10), "New screen"),
            editor.doc.screens.length > 1 &&
              el("button.preset-chip", { onclick: () => editor.deleteScreen() }, icon("trash", 10), "Delete screen"),
          ),
        ),
        { open: true, id: "screen-stats" },
      ),
    );
  }

  /* --- Public surface ------------------------------------------------------ */

  return {
    node,
    render,
    setPanel,
    get panel() {
      return active;
    },
    revealLayer: (id) => {
      if (active === "layers") layers.reveal(id);
    },
  };
}
