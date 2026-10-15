/**
 * The layer tree.
 *
 * Drag to reorder and reparent, rename in place, lock, hide and solo.
 * Fully keyboard navigable: arrows move, left/right collapse and expand,
 * Enter renames, Backspace deletes.
 */

import { el, mount, on, drag } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { getDef } from "../data/registry.js";
import { findNode, findParent, pathTo } from "../render/renderer.js";
import { searchField } from "../core/ui.js";

export function createLayers(editor) {
  const collapsed = new Set();
  let filter = "";
  let soloId = null;

  const tree = el("div.layer-tree", { role: "tree", tabIndex: 0 });

  const search = searchField("Filter layers", (value) => {
    filter = value.trim().toLowerCase();
    render();
  });

  const node = el(
    "div.col",
    { style: { minHeight: 0 } },
    el("div.palette-search", search),
    tree,
  );

  /* --- Render ------------------------------------------------------------ */

  function render() {
    const root = editor.screen?.root;
    if (!root) {
      mount(tree, el("div", { style: { padding: "var(--s-4)", color: "var(--text-tertiary)", fontSize: "var(--fs-12)" } }, "No screen selected."));
      return;
    }

    const rows = [];
    walk(root, 0, rows);
    mount(tree, ...rows);
  }

  function matches(layer) {
    if (!filter) return true;
    const label = (layer.name || getDef(layer.type)?.label || layer.type).toLowerCase();
    if (label.includes(filter)) return true;
    return (layer.children ?? []).some(matches);
  }

  function walk(layer, depth, out) {
    if (!matches(layer)) return;

    const def = getDef(layer.type);
    const selected = editor.selection.includes(layer.id);
    const hasChildren = Boolean(layer.children?.length);
    const isCollapsed = collapsed.has(layer.id) && !filter;
    const dimmed = layer.hidden || (soloId && !pathTo(editor.screen.root, soloId).some((n) => n.id === layer.id) && !isInside(layer, soloId));

    const row = el(
      `div.layer-row${selected ? ".selected" : ""}${dimmed ? ".dim" : ""}`,
      {
        role: "treeitem",
        "aria-selected": String(selected),
        dataset: { id: layer.id },
        style: { paddingLeft: `${depth * 13 + 4}px` },
        onclick: (event) => {
          if (event.shiftKey) editor.toggleSelection(layer.id);
          else editor.select([layer.id]);
        },
        ondblclick: () => beginRename(row, layer),
        onpointerenter: () => editor.hoverLayer?.(layer.id),
        oncontextmenu: (event) => {
          event.preventDefault();
          editor.select([layer.id]);
          editor.openLayerMenu?.(event, layer);
        },
        onpointerdown: (event) => {
          if (event.button !== 0) return;
          if (event.target.closest(".layer-tools, .layer-twisty")) return;
          startDrag(event, layer);
        },
      },
      hasChildren
        ? el(
            "button.layer-twisty",
            {
              type: "button",
              "aria-expanded": String(!isCollapsed),
              onclick: (event) => {
                event.stopPropagation();
                if (collapsed.has(layer.id)) collapsed.delete(layer.id);
                else collapsed.add(layer.id);
                render();
              },
            },
            icon("chevronRight"),
          )
        : el("span.layer-twisty"),
      el("span.layer-glyph", icon(def?.glyph ?? "box")),
      el("span.layer-name", layer.name || def?.label || layer.type),
      el(
        "span.layer-tools",
        el(
          "button",
          {
            type: "button",
            "data-tip": soloId === layer.id ? "Unsolo" : "Solo",
            class: soloId === layer.id ? "on" : "",
            onclick: (event) => {
              event.stopPropagation();
              soloId = soloId === layer.id ? null : layer.id;
              render();
            },
          },
          icon("target"),
        ),
        el(
          "button",
          {
            type: "button",
            "data-tip": layer.hidden ? "Show" : "Hide",
            class: layer.hidden ? "on" : "",
            onclick: (event) => {
              event.stopPropagation();
              editor.toggleHidden(layer.id);
            },
          },
          icon(layer.hidden ? "eyeOff" : "eye"),
        ),
        el(
          "button",
          {
            type: "button",
            "data-tip": layer.locked ? "Unlock" : "Lock",
            class: layer.locked ? "on" : "",
            onclick: (event) => {
              event.stopPropagation();
              editor.toggleLocked(layer.id);
            },
          },
          icon(layer.locked ? "lock" : "unlock"),
        ),
      ),
    );

    out.push(row);

    if (!isCollapsed) {
      for (const child of layer.children ?? []) walk(child, depth + 1, out);
    }
  }

  function isInside(layer, id) {
    if (layer.id === id) return true;
    return (layer.children ?? []).some((c) => isInside(c, id));
  }

  /* --- Rename ------------------------------------------------------------ */

  function beginRename(row, layer) {
    const nameCell = row.querySelector(".layer-name");
    const input = el("input", {
      value: layer.name || getDef(layer.type)?.label || layer.type,
      onkeydown: (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          input.blur();
        } else if (event.key === "Escape") {
          event.preventDefault();
          render();
        }
        event.stopPropagation();
      },
      onblur: () => {
        const value = input.value.trim();
        editor.renameNode(layer.id, value || null);
      },
    });
    mount(nameCell, input);
    input.focus();
    input.select();
  }

  /* --- Drag to reorder and reparent -------------------------------------- */

  function startDrag(event, layer) {
    if (layer.id === editor.screen.root.id) return;

    let target = null;

    drag(event, {
      threshold: 4,
      cursor: "grabbing",
      onMove: ({ x, y }) => {
        clearDropMarks();
        const row = document.elementFromPoint(x, y)?.closest?.(".layer-row");
        if (!row || !tree.contains(row)) {
          target = null;
          return;
        }

        const overId = row.dataset.id;
        if (overId === layer.id || isInside(layer, overId)) {
          target = null;
          return;
        }

        const overLayer = findNode(editor.screen.root, overId);
        const def = getDef(overLayer?.type);
        const rect = row.getBoundingClientRect();
        const ratio = (y - rect.top) / rect.height;

        if (def?.acceptsChildren && ratio > 0.3 && ratio < 0.7) {
          row.classList.add("drop-inside");
          target = { parentId: overId, index: (overLayer.children ?? []).length };
        } else {
          const before = ratio <= 0.5;
          row.classList.add(before ? "drop-before" : "drop-after");
          const parent = findParent(editor.screen.root, overId);
          if (!parent) {
            target = null;
            return;
          }
          const index = parent.children.findIndex((c) => c.id === overId) + (before ? 0 : 1);
          target = { parentId: parent.id, index };
        }
      },
      onEnd: ({ moved }) => {
        clearDropMarks();
        if (!moved || !target) return;
        if (editor.moveNode(layer.id, target.parentId, target.index)) {
          editor.commit(`Move ${layer.name || layer.type}`);
        }
      },
    });
  }

  function clearDropMarks() {
    for (const row of tree.querySelectorAll(".drop-before, .drop-after, .drop-inside")) {
      row.classList.remove("drop-before", "drop-after", "drop-inside");
    }
  }

  /* --- Keyboard ---------------------------------------------------------- */

  on(tree, "keydown", (event) => {
    const rows = Array.from(tree.querySelectorAll(".layer-row"));
    if (!rows.length) return;
    const currentIndex = rows.findIndex((r) => r.dataset.id === editor.selection[0]);

    if (event.key === "ArrowDown") {
      event.preventDefault();
      editor.select([rows[Math.min(currentIndex + 1, rows.length - 1)].dataset.id]);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      editor.select([rows[Math.max(currentIndex - 1, 0)].dataset.id]);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      const id = editor.selection[0];
      if (id && !collapsed.has(id) && findNode(editor.screen.root, id)?.children?.length) {
        collapsed.add(id);
        render();
      } else {
        const parent = findParent(editor.screen.root, id);
        if (parent) editor.select([parent.id]);
      }
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      const id = editor.selection[0];
      if (collapsed.has(id)) {
        collapsed.delete(id);
        render();
      } else {
        const layer = findNode(editor.screen.root, id);
        if (layer?.children?.length) editor.select([layer.children[0].id]);
      }
    } else if (event.key === "Enter") {
      event.preventDefault();
      const row = rows[currentIndex];
      if (row) beginRename(row, findNode(editor.screen.root, row.dataset.id));
    }
  });

  /** Keep the selected row in view when selection changes elsewhere. */
  function reveal(id) {
    for (const parent of pathTo(editor.screen.root, id).slice(0, -1)) collapsed.delete(parent.id);
    render();
    tree.querySelector(`.layer-row[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "nearest" });
  }

  return { node, render, reveal };
}
