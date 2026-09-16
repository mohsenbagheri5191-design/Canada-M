/**
 * The canvas.
 *
 * Renders the screen through the shared renderer inside a device frame, then
 * lays a transparent overlay on top for hover, selection, resize handles,
 * insertion lines, alignment guides and marquee select.
 *
 * Nothing here mutates the document directly; every change goes through the
 * editor's commit API so undo, autosave and the layer tree stay in step.
 */

import { el, mount, on, drag, raf } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { getDef } from "../data/registry.js";
import { renderScreen, findNode, findParent, pathTo, cloneSubtree } from "../render/renderer.js";
import { clamp } from "../core/util.js";
import { menu, toast } from "../core/ui.js";

const SNAP = 4; // the grid everything lands on
const GUIDE_TOLERANCE = 5;

export function createCanvas(editor) {
  /* --- Structure --------------------------------------------------------- */

  const overlay = el("div.overlay");
  const content = el("div.device-content");
  const inner = el("div", { style: { position: "relative", minHeight: "100%" } });
  const screenBox = el("div.device-screen");
  const deviceBox = el("div.device");
  const stage = el("div.canvas-stage");
  const viewport = el("div.canvas-viewport");

  content.appendChild(inner);
  screenBox.append(content, overlay);
  deviceBox.appendChild(screenBox);
  stage.appendChild(deviceBox);
  viewport.appendChild(stage);

  /** DOM node for each layout node id, rebuilt on every render. */
  const domFor = new Map();

  let hoverId = null;
  let dragging = false;

  /* --- Geometry ---------------------------------------------------------- */

  const boxOf = (node) => {
    const a = node.getBoundingClientRect();
    const b = inner.getBoundingClientRect();
    const z = editor.zoom;
    return {
      x: (a.left - b.left) / z,
      y: (a.top - b.top) / z,
      w: a.width / z,
      h: a.height / z,
    };
  };

  const pointToLocal = (clientX, clientY) => {
    const b = inner.getBoundingClientRect();
    return { x: (clientX - b.left) / editor.zoom, y: (clientY - b.top) / editor.zoom };
  };

  /** The deepest rendered node under a point, skipping locked subtrees. */
  function nodeAt(clientX, clientY, { skip = new Set() } = {}) {
    const stackEls = document.elementsFromPoint(clientX, clientY);
    for (const candidate of stackEls) {
      if (!inner.contains(candidate)) continue;
      const host = candidate.closest("[data-node-id]");
      if (!host) continue;
      const id = host.dataset.nodeId;
      if (skip.has(id)) continue;
      const node = findNode(editor.screen.root, id);
      if (!node || node.locked) continue;
      return { id, node, dom: host };
    }
    return null;
  }

  /* --- Render ------------------------------------------------------------ */

  function render() {
    domFor.clear();

    const device = editor.device;
    const width = editor.rotated ? device.height : device.width;
    const height = editor.rotated ? device.width : device.height;

    deviceBox.style.setProperty("--device-radius", `${device.radius}px`);
    screenBox.style.width = `${width}px`;
    screenBox.style.height = `${height}px`;

    mount(
      screenBox,
      content,
      device.notch && !editor.rotated ? el("div.device-notch") : null,
      el("div.device-home", { style: { color: editor.theme?.colors?.text ?? "#000" } }),
      statusBar(),
      overlay,
    );

    const tree = renderScreen(editor.screen, {
      theme: editor.theme,
      scope: editor.scope(),
      editable: true,
      onNode: (node, dom) => domFor.set(node.id, dom),
    });

    // Leave room for the status bar so content is never hidden behind it.
    tree.style.paddingTop = editor.screen?.safeArea === false ? "0" : "44px";
    mount(inner, tree);

    paintOverlay();
  }

  function statusBar() {
    const ink = editor.theme?.colors?.text ?? "#000";
    return el(
      "div.device-status",
      { style: { color: ink } },
      el("span", "9:41"),
      el(
        "span",
        { style: { display: "flex", alignItems: "center", gap: "5px" } },
        el("span.bars", el("i", { style: { height: "4px" } }), el("i", { style: { height: "6px" } }), el("i", { style: { height: "8px" } }), el("i", { style: { height: "10px" } })),
        el("span", { style: { fontSize: "11px" } }, "LTE"),
        el("span", {
          style: { width: "20px", height: "10px", border: "1px solid currentColor", borderRadius: "3px", position: "relative", opacity: 0.9 },
          html: `<span style="position:absolute;inset:1.5px;right:5px;background:currentColor;border-radius:1px"></span>`,
        }),
      ),
    );
  }

  /* --- Overlay ----------------------------------------------------------- */

  function paintOverlay() {
    const parts = [];

    // Hover outline, suppressed while dragging and for already-selected nodes.
    if (hoverId && !dragging && !editor.selection.includes(hoverId)) {
      const dom = domFor.get(hoverId);
      if (dom) {
        const box = boxOf(dom);
        const node = findNode(editor.screen.root, hoverId);
        parts.push(el("div.hover-box", { style: rectStyle(box) }));
        parts.push(
          el(
            "div.hover-badge",
            { style: { left: `${box.x}px`, top: `${Math.max(0, box.y - 19)}px` } },
            icon(getDef(node?.type)?.glyph ?? "box"),
            node?.name || node?.type || "",
          ),
        );
      }
    }

    // Selection, with handles when exactly one node is selected.
    const multi = editor.selection.length > 1;
    for (const id of editor.selection) {
      const dom = domFor.get(id);
      if (!dom) continue;
      const box = boxOf(dom);
      parts.push(el(`div.select-box${multi ? ".multi" : ""}`, { style: rectStyle(box) }));

      if (!multi && !dragging) {
        const node = findNode(editor.screen.root, id);
        const def = getDef(node?.type);
        const canW = def?.resizable?.width;
        const canH = def?.resizable?.height;
        for (const dir of ["nw", "n", "ne", "e", "se", "s", "sw", "w"]) {
          const horizontal = dir === "e" || dir === "w";
          const vertical = dir === "n" || dir === "s";
          if (horizontal && !canW) continue;
          if (vertical && !canH) continue;
          if (!horizontal && !vertical && !(canW || canH)) continue;
          parts.push(handle(dir, box, node, def));
        }
      }
    }

    mount(overlay, ...parts);
  }

  const rectStyle = (b) => ({
    left: `${b.x}px`,
    top: `${b.y}px`,
    width: `${b.w}px`,
    height: `${b.h}px`,
  });

  function handle(dir, box, node, def) {
    const positions = {
      nw: [box.x, box.y],
      n: [box.x + box.w / 2, box.y],
      ne: [box.x + box.w, box.y],
      e: [box.x + box.w, box.y + box.h / 2],
      se: [box.x + box.w, box.y + box.h],
      s: [box.x + box.w / 2, box.y + box.h],
      sw: [box.x, box.y + box.h],
      w: [box.x, box.y + box.h / 2],
    };
    const [hx, hy] = positions[dir];

    return el("div.handle", {
      dataset: { dir },
      style: { left: `${hx - 4.5}px`, top: `${hy - 4.5}px` },
      onpointerdown: (event) => {
        event.stopPropagation();
        startResize(event, node, def, dir, box);
      },
    });
  }

  /* --- Resize ------------------------------------------------------------ */

  function startResize(event, node, def, dir, startBox) {
    const readout = el("div.size-readout");
    overlay.appendChild(readout);

    const parentDom = domFor.get(findParent(editor.screen.root, node.id)?.id);
    const parentWidth = parentDom ? boxOf(parentDom).w : startBox.w;

    dragging = true;

    drag(event, {
      onMove: ({ dx, dy, shift }) => {
        const z = editor.zoom;
        let w = startBox.w;
        let h = startBox.h;

        if (dir.includes("e")) w = startBox.w + dx / z;
        if (dir.includes("w")) w = startBox.w - dx / z;
        if (dir.includes("s")) h = startBox.h + dy / z;
        if (dir.includes("n")) h = startBox.h - dy / z;

        if (shift && def.resizable?.width && def.resizable?.height) {
          const ratio = startBox.w / Math.max(startBox.h, 1);
          if (Math.abs(dx) > Math.abs(dy)) h = w / ratio;
          else w = h * ratio;
        }

        w = Math.round(w / SNAP) * SNAP;
        h = Math.round(h / SNAP) * SNAP;

        const min = def.resizable?.minHeight ?? 8;
        const max = def.resizable?.maxHeight ?? 4000;
        h = clamp(h, min, max);
        w = clamp(w, 8, 4000);

        const size = { ...(node.props.size ?? {}) };
        if (def.resizable?.width && (dir.includes("e") || dir.includes("w"))) size.width = w;
        if (def.resizable?.height && (dir.includes("n") || dir.includes("s"))) size.height = h;

        editor.patchProps(node.id, { size }, { silent: true });
        render();

        const pct = Math.round((w / Math.max(parentWidth, 1)) * 100);
        readout.textContent = `${Math.round(w)} × ${Math.round(h)}  ·  ${pct}%`;
        const box = boxOf(domFor.get(node.id) ?? parentDom ?? inner);
        readout.style.left = `${box.x + box.w / 2 - 44}px`;
        readout.style.top = `${box.y + box.h + 8}px`;
        overlay.appendChild(readout);
      },
      onEnd: ({ moved }) => {
        dragging = false;
        readout.remove();
        if (moved) editor.commit(`Resize ${node.name || node.type}`, { coalesceKey: `resize:${node.id}` });
        else render();
      },
    });
  }

  /* --- Move (reorder and reparent) --------------------------------------- */

  function startMove(event, node) {
    const subtreeIds = new Set();
    const collect = (n) => {
      subtreeIds.add(n.id);
      (n.children ?? []).forEach(collect);
    };
    collect(node);

    let target = null;
    const line = el("div.insert-line");
    const parentBox = el("div.drop-parent");

    dragging = true;

    drag(event, {
      threshold: 4,
      cursor: "grabbing",
      onStart: () => {
        overlay.append(parentBox, line);
        paintOverlay();
      },
      onMove: ({ x, y }) => {
        target = resolveDropTarget(x, y, subtreeIds);
        if (!target) {
          line.style.display = "none";
          parentBox.style.display = "none";
          return;
        }

        line.style.display = "";
        parentBox.style.display = "";

        const parentDom = domFor.get(target.parent.id);
        if (parentDom) Object.assign(parentBox.style, rectStyle(boxOf(parentDom)));

        Object.assign(line.style, target.lineStyle);
        line.dataset.axis = target.axis;
      },
      onEnd: ({ moved }) => {
        dragging = false;
        line.remove();
        parentBox.remove();

        if (!moved || !target) {
          render();
          return;
        }

        const ok = editor.moveNode(node.id, target.parent.id, target.index);
        if (!ok) toast("That drop is not allowed there", { tone: "warning", duration: 2200 });
        else editor.commit(`Move ${node.name || node.type}`);
      },
    });
  }

  /**
   * Work out where a pointer position would insert.
   * Returns the receiving parent, the index, and where to draw the line.
   */
  function resolveDropTarget(clientX, clientY, skip) {
    const hit = nodeAt(clientX, clientY, { skip });
    if (!hit) return null;

    // Walk up to the nearest container that accepts children.
    let candidate = hit.node;
    let chain = pathTo(editor.screen.root, candidate.id);
    let container = null;
    for (let i = chain.length - 1; i >= 0; i -= 1) {
      const def = getDef(chain[i].type);
      if (def?.acceptsChildren && !skip.has(chain[i].id) && !chain[i].locked) {
        container = chain[i];
        break;
      }
    }
    if (!container) return null;

    const containerDom = domFor.get(container.id);
    if (!containerDom) return null;

    const horizontal = container.props?.direction === "horizontal" || container.type === "ButtonRow" || container.type === "Grid";
    const kids = (container.children ?? []).filter((c) => !skip.has(c.id));
    const local = pointToLocal(clientX, clientY);
    const containerBox = boxOf(containerDom);

    // Empty container: drop straight in.
    if (!kids.length) {
      return {
        parent: container,
        index: 0,
        axis: horizontal ? "y" : "x",
        lineStyle: horizontal
          ? { left: `${containerBox.x + 6}px`, top: `${containerBox.y + 6}px`, height: `${Math.max(containerBox.h - 12, 12)}px` }
          : { left: `${containerBox.x + 6}px`, top: `${containerBox.y + containerBox.h / 2}px`, width: `${Math.max(containerBox.w - 12, 12)}px` },
      };
    }

    // Find the gap the pointer is nearest to.
    let index = kids.length;
    for (let i = 0; i < kids.length; i += 1) {
      const kidDom = domFor.get(kids[i].id);
      if (!kidDom) continue;
      const box = boxOf(kidDom);
      const mid = horizontal ? box.x + box.w / 2 : box.y + box.h / 2;
      const point = horizontal ? local.x : local.y;
      if (point < mid) {
        index = i;
        break;
      }
    }

    const anchorKid = kids[Math.min(index, kids.length - 1)];
    const anchorBox = boxOf(domFor.get(anchorKid.id) ?? containerDom);
    const after = index >= kids.length;

    const lineStyle = horizontal
      ? {
          left: `${(after ? anchorBox.x + anchorBox.w : anchorBox.x) - 1}px`,
          top: `${containerBox.y + 2}px`,
          height: `${Math.max(containerBox.h - 4, 12)}px`,
        }
      : {
          left: `${containerBox.x + 2}px`,
          top: `${(after ? anchorBox.y + anchorBox.h : anchorBox.y) - 1}px`,
          width: `${Math.max(containerBox.w - 4, 12)}px`,
        };

    // The real index has to count skipped siblings back in.
    const realIndex = realIndexFor(container, kids, index, skip);

    return { parent: container, index: realIndex, axis: horizontal ? "y" : "x", lineStyle };
  }

  function realIndexFor(container, visibleKids, visibleIndex, skip) {
    const all = container.children ?? [];
    if (visibleIndex >= visibleKids.length) {
      return all.length;
    }
    const targetId = visibleKids[visibleIndex].id;
    const found = all.findIndex((c) => c.id === targetId);
    return found === -1 ? all.length : found;
  }

  /* --- Alignment guides (shown while nudging with the keyboard) ----------- */

  function showGuides(nodeId) {
    const dom = domFor.get(nodeId);
    if (!dom) return;
    const box = boxOf(dom);
    const guides = [];

    for (const [id, other] of domFor) {
      if (id === nodeId) continue;
      const b = boxOf(other);
      const pairs = [
        [box.x, b.x, "y"],
        [box.x + box.w, b.x + b.w, "y"],
        [box.x + box.w / 2, b.x + b.w / 2, "y"],
        [box.y, b.y, "x"],
        [box.y + box.h, b.y + b.h, "x"],
      ];
      for (const [a, c, axis] of pairs) {
        if (Math.abs(a - c) <= GUIDE_TOLERANCE) {
          guides.push(
            el("div.guide", {
              dataset: { axis },
              style:
                axis === "y"
                  ? { left: `${c}px`, top: "0", height: "100%" }
                  : { top: `${c}px`, left: "0", width: "100%" },
            }),
          );
        }
      }
    }

    for (const guide of guides) overlay.appendChild(guide);
    setTimeout(() => guides.forEach((g) => g.remove()), 700);
  }

  /* --- Alt-held spacing measurements -------------------------------------- */

  function showMeasurements(nodeId) {
    const dom = domFor.get(nodeId);
    if (!dom) return;
    const parent = findParent(editor.screen.root, nodeId);
    if (!parent) return;
    const parentDom = domFor.get(parent.id);
    if (!parentDom) return;

    const box = boxOf(dom);
    const pBox = boxOf(parentDom);
    const marks = [];

    const gaps = [
      { x: box.x, y: pBox.y, w: box.w, h: Math.max(box.y - pBox.y, 0), value: Math.round(box.y - pBox.y) },
      { x: box.x, y: box.y + box.h, w: box.w, h: Math.max(pBox.y + pBox.h - (box.y + box.h), 0), value: Math.round(pBox.y + pBox.h - (box.y + box.h)) },
      { x: pBox.x, y: box.y, w: Math.max(box.x - pBox.x, 0), h: box.h, value: Math.round(box.x - pBox.x) },
      { x: box.x + box.w, y: box.y, w: Math.max(pBox.x + pBox.w - (box.x + box.w), 0), h: box.h, value: Math.round(pBox.x + pBox.w - (box.x + box.w)) },
    ];

    for (const gap of gaps) {
      if (gap.value <= 0 || gap.w < 1 || gap.h < 1) continue;
      marks.push(
        el(
          "div.measure",
          { style: { left: `${gap.x}px`, top: `${gap.y}px`, width: `${gap.w}px`, height: `${gap.h}px` } },
          el("span", String(gap.value)),
        ),
      );
    }

    mount(overlay.querySelector(".measure-layer") ?? overlay.appendChild(el("div.measure-layer")), ...marks);
  }

  function clearMeasurements() {
    overlay.querySelector(".measure-layer")?.replaceChildren();
  }

  /* --- Pointer wiring ----------------------------------------------------- */

  on(inner, "pointermove", raf((event) => {
    if (dragging) return;
    const hit = nodeAt(event.clientX, event.clientY);
    const next = hit?.id ?? null;
    if (next !== hoverId) {
      hoverId = next;
      paintOverlay();
    }
    if (event.altKey && editor.selection.length === 1) showMeasurements(editor.selection[0]);
    else clearMeasurements();
  }));

  on(inner, "pointerleave", () => {
    if (hoverId) {
      hoverId = null;
      paintOverlay();
    }
    clearMeasurements();
  });

  on(inner, "pointerdown", (event) => {
    if (event.button !== 0) return;
    const hit = nodeAt(event.clientX, event.clientY);

    if (!hit) {
      startMarquee(event);
      return;
    }

    if (event.shiftKey) {
      editor.toggleSelection(hit.id);
      return;
    }

    if (!editor.selection.includes(hit.id)) editor.select([hit.id]);

    // A press on the selection begins a move once it passes the threshold.
    startMove(event, hit.node);
  });

  on(inner, "contextmenu", (event) => {
    const hit = nodeAt(event.clientX, event.clientY);
    if (!hit) return;
    event.preventDefault();
    if (!editor.selection.includes(hit.id)) editor.select([hit.id]);
    openContextMenu(event, hit.node);
  });

  on(inner, "dblclick", (event) => {
    const hit = nodeAt(event.clientX, event.clientY);
    if (!hit) return;
    // Double-click drops into text editing where the component has a text prop.
    const def = getDef(hit.node.type);
    const textKey = def?.fields?.text ? "text" : def?.fields?.label ? "label" : def?.fields?.title ? "title" : null;
    if (textKey) editor.focusField(textKey);
  });

  function startMarquee(event) {
    const start = pointToLocal(event.clientX, event.clientY);
    const box = el("div.marquee");
    overlay.appendChild(box);
    dragging = true;

    drag(event, {
      threshold: 3,
      onMove: ({ x, y }) => {
        const now = pointToLocal(x, y);
        Object.assign(box.style, {
          left: `${Math.min(start.x, now.x)}px`,
          top: `${Math.min(start.y, now.y)}px`,
          width: `${Math.abs(now.x - start.x)}px`,
          height: `${Math.abs(now.y - start.y)}px`,
        });
      },
      onEnd: ({ moved, event: endEvent }) => {
        dragging = false;
        const rect = box.getBoundingClientRect();
        box.remove();

        if (!moved) {
          editor.select([]);
          return;
        }

        const end = pointToLocal(endEvent.clientX, endEvent.clientY);
        const area = {
          x1: Math.min(start.x, end.x),
          y1: Math.min(start.y, end.y),
          x2: Math.max(start.x, end.x),
          y2: Math.max(start.y, end.y),
        };

        const hits = [];
        for (const [id, dom] of domFor) {
          if (id === editor.screen.root.id) continue;
          const b = boxOf(dom);
          if (b.x >= area.x1 - 2 && b.y >= area.y1 - 2 && b.x + b.w <= area.x2 + 2 && b.y + b.h <= area.y2 + 2) {
            hits.push({ id, depth: pathTo(editor.screen.root, id).length });
          }
        }

        // Keep the shallowest nodes so selecting a card does not also select
        // everything inside it.
        const minDepth = Math.min(...hits.map((h) => h.depth), Infinity);
        editor.select(hits.filter((h) => h.depth === minDepth).map((h) => h.id));
        void rect;
      },
    });
  }

  function openContextMenu(event, node) {
    const def = getDef(node.type);
    const isRoot = node.id === editor.screen.root.id;

    menu(
      { left: event.clientX, top: event.clientY, right: event.clientX, bottom: event.clientY, width: 0, height: 0 },
      [
        { label: "Duplicate", icon: "duplicate", shortcut: "⌘D", disabled: isRoot, onSelect: () => editor.duplicate() },
        { label: "Copy", icon: "copy", shortcut: "⌘C", disabled: isRoot, onSelect: () => editor.copy() },
        { label: "Paste inside", icon: "cornerDownRight", disabled: !def?.acceptsChildren || !editor.clipboard, onSelect: () => editor.paste(node.id) },
        "-",
        { label: "Wrap in a stack", icon: "stack", shortcut: "⌘G", disabled: isRoot, onSelect: () => editor.wrapSelection() },
        { label: "Copy style", icon: "palette", onSelect: () => editor.copyStyle() },
        { label: "Paste style", icon: "droplet", disabled: !editor.styleClipboard, onSelect: () => editor.pasteStyle() },
        "-",
        { label: "Save as a block", icon: "package", disabled: isRoot, onSelect: () => editor.saveAsBlock() },
        { label: node.hidden ? "Show" : "Hide", icon: node.hidden ? "eye" : "eyeOff", onSelect: () => editor.toggleHidden(node.id) },
        { label: node.locked ? "Unlock" : "Lock", icon: node.locked ? "unlock" : "lock", onSelect: () => editor.toggleLocked(node.id) },
        "-",
        { label: "Delete", icon: "trash", tone: "danger", shortcut: "⌫", disabled: isRoot, onSelect: () => editor.deleteSelection() },
      ],
      { minWidth: 210 },
    );
  }

  /* --- Drops from the palette --------------------------------------------- */

  /**
   * Called by the Insert panel while dragging a component or block.
   * Returns the resolved target so the caller can commit the insert.
   */
  function previewExternalDrop(clientX, clientY) {
    const target = resolveDropTarget(clientX, clientY, new Set());
    let line = overlay.querySelector(".insert-line.external");
    let parentBox = overlay.querySelector(".drop-parent.external");

    if (!target) {
      line?.remove();
      parentBox?.remove();
      return null;
    }

    if (!line) {
      line = el("div.insert-line.external");
      overlay.appendChild(line);
    }
    if (!parentBox) {
      parentBox = el("div.drop-parent.external");
      overlay.appendChild(parentBox);
    }

    const parentDom = domFor.get(target.parent.id);
    if (parentDom) Object.assign(parentBox.style, rectStyle(boxOf(parentDom)));
    Object.assign(line.style, target.lineStyle);
    line.dataset.axis = target.axis;

    return target;
  }

  function clearExternalDrop() {
    overlay.querySelector(".insert-line.external")?.remove();
    overlay.querySelector(".drop-parent.external")?.remove();
  }

  /* --- Zoom --------------------------------------------------------------- */

  /**
   * Zoom is a transform on the device, not on the stage, and the stage is
   * sized to the *scaled* result. A transformed element keeps its untransformed
   * layout box, so scaling the stage itself would leave the viewport centring
   * an 852px-tall box around a 400px-tall picture.
   */
  function applyZoom() {
    const z = editor.zoom;
    const w = (editor.rotated ? editor.device.height : editor.device.width) + 22;
    const h = (editor.rotated ? editor.device.width : editor.device.height) + 22;

    stage.style.width = `${Math.round(w * z)}px`;
    stage.style.height = `${Math.round(h * z)}px`;
    deviceBox.style.transform = `scale(${z})`;
  }

  on(viewport, "wheel", (event) => {
    if (!(event.ctrlKey || event.metaKey)) return;
    event.preventDefault();
    editor.setZoom(editor.zoom * (event.deltaY > 0 ? 0.92 : 1.08));
  }, { passive: false });

  function fitToScreen() {
    // The viewport's own padding, the device bezel and its outer ring all sit
    // outside the screen rect, so they come off the budget before dividing.
    const chrome = 96;
    const availableH = viewport.clientHeight - chrome;
    const availableW = viewport.clientWidth - chrome;
    const h = (editor.rotated ? editor.device.width : editor.device.height) + 22;
    const w = (editor.rotated ? editor.device.height : editor.device.width) + 22;
    editor.setZoom(clamp(Math.min(availableH / h, availableW / w), 0.25, 1.5));
  }

  /* --- Public surface ----------------------------------------------------- */

  return {
    node: viewport,
    render,
    paintOverlay,
    applyZoom,
    fitToScreen,
    previewExternalDrop,
    clearExternalDrop,
    showGuides,
    domFor,
    get hoverId() {
      return hoverId;
    },
  };
}

/**
 * A scaled, non-interactive render of a screen, used by the palette
 * thumbnails, the library cards, the compare view and the publish panel.
 *
 * The wrapper fills its parent and clips; the inner tree is laid out at its
 * real width and scaled with a transform, so text stays crisp and layout is
 * identical to the canvas. The scale is measured rather than guessed, because
 * every caller sizes its container differently.
 *
 *   fit: "width"    fill the parent's width, crop the overflow (card thumbs)
 *   fit: "contain"  fit the whole screen inside the parent (compare, preview)
 *
 * The parent must be positioned; every call site here sets position: relative.
 */
export function renderMiniature(screen, theme, { width = 393, height = 852, fit = "width", background = null } = {}) {
  const inner = el("div", {
    style: {
      position: "absolute",
      top: 0,
      left: 0,
      width: `${width}px`,
      transformOrigin: "top left",
      pointerEvents: "none",
      background: background ?? theme?.colors?.background ?? "transparent",
    },
  });

  try {
    inner.appendChild(renderScreen(screen, { theme, scope: {}, editable: false }));
  } catch (error) {
    console.warn("[canvas] miniature render failed", error);
  }

  const wrap = el(
    "div",
    { style: { position: "absolute", inset: 0, overflow: "hidden", pointerEvents: "none" } },
    inner,
  );

  const measure = () => {
    const w = wrap.clientWidth;
    const h = wrap.clientHeight;
    if (!w) return;
    const scale = fit === "contain" ? Math.min(w / width, h / height) : w / width;
    inner.style.transform = `scale(${scale})`;
    inner.style.left = fit === "contain" ? `${(w - width * scale) / 2}px` : "0px";
    inner.style.minHeight = `${height}px`;
  };

  // Measured on attach and whenever the container resizes, so the same
  // component works in a 62px palette tile and a 300px compare pane.
  requestAnimationFrame(measure);
  new ResizeObserver(measure).observe(wrap);

  return wrap;
}

export { cloneSubtree };
