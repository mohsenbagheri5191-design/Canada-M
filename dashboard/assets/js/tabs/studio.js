/**
 * Design Studio.
 *
 * Owns the editor: the document, selection, history, autosave and the wiring
 * between the canvas, the layer tree and the inspector. Those three modules
 * never talk to each other; they all talk to the `editor` object built here.
 */

import { el, mount as mountTo, on, debounce } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { History, clone, persist } from "../core/store.js";
import { uid, clamp, fmt } from "../core/util.js";
import { toast, menu, confirm, modal, segmented, splitHandle, emptyState } from "../core/ui.js";
import { registerCommands } from "../core/shell.js";
import { registry, getDef, defaultProps } from "../data/registry.js";
import { devices, screenTemplates } from "../data/presets.js";
import {
  findNode,
  findParent,
  countNodes,
  maxDepth,
  cloneSubtree,
  walk,
  layeredProps,
  propOrigin,
  renderScreen as renderScreenSync,
} from "../render/renderer.js";
import { createCanvas } from "../studio/canvas.js";
import { createInspector } from "../studio/inspector.js";
import { openThemeEditor } from "../studio/theme-editor.js";
import { openPublishPanel, openVersionHistory, validateDocument } from "../studio/publish.js";

export function mount(host, { db, go, setCrumbs, params, app }) {
  /* ======================================================================
     Load the design and version to edit
     ====================================================================== */

  const designs = db.designs.list();
  if (!designs.length) {
    host.appendChild(
      el(
        "div.page-scroll",
        emptyState("studio", "No designs yet", "Create one from the Design Library and it opens here.", el("button.btn.primary", { onclick: () => go("library", { create: "1" }) }, icon("plus"), "New design")),
      ),
    );
    return null;
  }

  const designId = params.design ?? persist.read("studio.design") ?? designs[0].id;
  const design = db.designs.get(designId) ?? designs[0];
  const versions = db.designs.versions(design.id);

  // Prefer an explicit version, then the working draft, then the live one.
  let version =
    (params.version && versions.find((v) => v.id === params.version)) ||
    versions.find((v) => v.status === "draft") ||
    versions.find((v) => v.status === "published") ||
    versions[versions.length - 1];

  // A published version is immutable: open it read-only until it is forked.
  let readOnly = version.status !== "draft";

  persist.write("studio.design", design.id);
  setCrumbs([
    { label: "Design Studio", onSelect: () => go("library") },
    { label: design.name },
    { label: `v${version.version_number}` },
  ]);

  /* ======================================================================
     Editor state
     ====================================================================== */

  const editor = {
    design,
    version,
    doc: clone(version.document),
    theme: clone(version.theme),
    screenIndex: 0,
    selection: [],
    clipboard: null,
    styleClipboard: null,
    zoom: persist.read("studio.zoom", 0.75),
    device: devices.find((d) => d.key === persist.read("studio.device", "iphone-15")) ?? devices[0],
    rotated: false,
    breakpoint: "base",
    state: "default",
    pendingBindKey: null,
    savedBlocks: persist.read("studio.blocks", []),

    get screen() {
      return this.doc.screens[this.screenIndex] ?? this.doc.screens[0];
    },
    get nodeCount() {
      return this.screen ? countNodes(this.screen.root) : 0;
    },
    get maxDepth() {
      return this.screen ? maxDepth(this.screen.root) : 0;
    },
  };

  // Declared up here because History.reset fires onChange immediately, and
  // paintHistoryButtons reads them.
  let undoButton = null;
  let redoButton = null;

  const history = new History({ limit: 100, onChange: () => paintHistoryButtons() });
  history.reset({ doc: editor.doc, theme: editor.theme }, "Opened");

  /* ======================================================================
     Mutations. Everything funnels through these so history and autosave
     stay honest.
     ====================================================================== */

  Object.assign(editor, {
    scope() {
      const org = db.orgs.get(app.get("org"));
      const user = db.users.list({ org: org?.id, role: "app_user" })[0];
      const sources = {};
      for (const source of db.entities.dataSources()) sources[source.key] = source.sample;
      return {
        user: { id: user?.id, firstName: (user?.full_name ?? "Maya Chen").split(" ")[0], role: user?.role ?? "app_user", email: user?.email },
        org: { id: org?.id, name: org?.name, plan: org?.plan },
        route: { params: {} },
        state: {},
        theme: editor.theme,
        ...sources,
      };
    },

    dataSources: () => db.entities.dataSources(),

    makeNode(type) {
      return { id: uid("n"), type, props: defaultProps(type), ...(getDef(type)?.acceptsChildren ? { children: [] } : {}) };
    },

    commit(label, options = {}) {
      if (readOnly) return;
      history.commit({ doc: editor.doc, theme: editor.theme }, label, options);
      refresh();
      autosave();
    },

    /** Apply a snapshot from history without pushing a new entry. */
    applySnapshot(snapshot) {
      editor.doc = clone(snapshot.doc);
      editor.theme = clone(snapshot.theme);
      editor.screenIndex = clamp(editor.screenIndex, 0, editor.doc.screens.length - 1);
      editor.selection = editor.selection.filter((id) => findNode(editor.screen.root, id));
      refresh();
      autosave();
    },

    /* --- Selection ------------------------------------------------------ */

    select(ids) {
      editor.selection = Array.isArray(ids) ? ids : [ids];
      canvas.paintOverlay();
      inspector.render();
      inspector.revealLayer(editor.selection[0]);
    },

    toggleSelection(id) {
      editor.selection = editor.selection.includes(id)
        ? editor.selection.filter((x) => x !== id)
        : [...editor.selection, id];
      canvas.paintOverlay();
      inspector.render();
    },

    hoverLayer(id) {
      void id;
    },

    focusField(key) {
      inspector.setPanel("style");
      setTimeout(() => {
        const input = inspector.node.querySelector(`.inspector-body input, .inspector-body textarea`);
        input?.focus();
        input?.select?.();
      }, 30);
      void key;
    },

    /* --- Props ---------------------------------------------------------- */

    /**
     * The object an edit should be written into, given the breakpoint and
     * state selected in the inspector. Created on first write so a node that
     * has never been overridden carries no empty layers.
     */
    writeLayer(node) {
      if (editor.state !== "default") {
        node.states = node.states ?? {};
        node.states[editor.state] = node.states[editor.state] ?? {};
        return node.states[editor.state];
      }
      if (editor.breakpoint !== "base") {
        node.responsive = node.responsive ?? {};
        node.responsive[editor.breakpoint] = node.responsive[editor.breakpoint] ?? {};
        return node.responsive[editor.breakpoint];
      }
      return node.props;
    },

    /** What the selected breakpoint and state actually resolve to. */
    effectiveProps(node) {
      return layeredProps(node, getDef(node.type), { breakpoint: editor.breakpoint, state: editor.state });
    },

    /** Which layer a prop's current value comes from. */
    originOf(node, key) {
      return propOrigin(node, key, { breakpoint: editor.breakpoint, state: editor.state });
    },

    patchProps(id, patch, { silent = false } = {}) {
      const node = findNode(editor.screen.root, id);
      if (!node || readOnly) return;
      Object.assign(editor.writeLayer(node), patch);
      if (silent) {
        canvas.render();
      } else {
        refresh();
      }
    },

    setProps(id, props) {
      const node = findNode(editor.screen.root, id);
      if (!node || readOnly) return;
      if (editor.breakpoint === "base" && editor.state === "default") node.props = props;
      else Object.assign(editor.writeLayer(node), props);
    },

    /** Drop an override so the prop inherits again. */
    clearOverride(id, key) {
      const node = findNode(editor.screen.root, id);
      if (!node || readOnly) return;

      if (editor.state !== "default") delete node.states?.[editor.state]?.[key];
      else if (editor.breakpoint !== "base") delete node.responsive?.[editor.breakpoint]?.[key];
      else return;

      // Do not leave empty layers behind; they would show up in diffs as noise.
      if (node.states?.[editor.state] && !Object.keys(node.states[editor.state]).length) delete node.states[editor.state];
      if (node.states && !Object.keys(node.states).length) delete node.states;
      if (node.responsive?.[editor.breakpoint] && !Object.keys(node.responsive[editor.breakpoint]).length) delete node.responsive[editor.breakpoint];
      if (node.responsive && !Object.keys(node.responsive).length) delete node.responsive;

      editor.commit("Clear override");
    },

    setActions(id, actions) {
      const node = findNode(editor.screen.root, id);
      if (!node || readOnly) return;
      if (Object.keys(actions).length) node.actions = actions;
      else delete node.actions;
    },

    setCondition(id, condition) {
      const node = findNode(editor.screen.root, id);
      if (!node || readOnly) return;
      if (condition) node.visibleIf = condition;
      else delete node.visibleIf;
    },

    renameNode(id, name) {
      const node = findNode(editor.screen.root, id);
      if (!node) return;
      if (name) node.name = name;
      else delete node.name;
      editor.commit("Rename layer");
    },

    toggleHidden(id) {
      const node = findNode(editor.screen.root, id);
      if (!node) return;
      node.hidden = !node.hidden;
      editor.commit(node.hidden ? "Hide layer" : "Show layer");
    },

    toggleLocked(id) {
      const node = findNode(editor.screen.root, id);
      if (!node) return;
      node.locked = !node.locked;
      editor.commit(node.locked ? "Lock layer" : "Unlock layer");
    },

    setTheme(theme) {
      editor.theme = clone(theme);
    },

    /* --- Tree ----------------------------------------------------------- */

    insertComponent(type) {
      const node = editor.makeNode(type);
      editor.insertTree(node, { label: `Insert ${getDef(type)?.label ?? type}` });
    },

    /**
     * Insert a preset tree. Without an explicit parent it goes next to the
     * current selection, which is what a person expects when they click a
     * palette entry rather than dragging it.
     */
    insertTree(tree, { parentId = null, index = null, label = "Insert" } = {}) {
      if (readOnly) return warnReadOnly();

      const stamped = stampIds(tree);
      let parent;
      let at;

      if (parentId) {
        parent = findNode(editor.screen.root, parentId);
        at = index ?? (parent.children?.length ?? 0);
      } else if (editor.selection.length) {
        const selected = findNode(editor.screen.root, editor.selection[0]);
        const def = getDef(selected?.type);
        if (def?.acceptsChildren) {
          parent = selected;
          at = selected.children?.length ?? 0;
        } else {
          parent = findParent(editor.screen.root, selected.id) ?? editor.screen.root;
          at = (parent.children ?? []).findIndex((c) => c.id === selected.id) + 1;
        }
      } else {
        parent = editor.screen.root;
        at = parent.children?.length ?? 0;
      }

      if (!parent || !getDef(parent.type)?.acceptsChildren) parent = editor.screen.root;
      parent.children = parent.children ?? [];
      parent.children.splice(at, 0, stamped);

      editor.select([stamped.id]);
      editor.commit(label);
      return stamped;
    },

    moveNode(id, parentId, index) {
      if (readOnly) return false;
      const node = findNode(editor.screen.root, id);
      const target = findNode(editor.screen.root, parentId);
      if (!node || !target || !getDef(target.type)?.acceptsChildren) return false;

      // A node can never become its own descendant.
      let inside = false;
      walk(node, (n) => {
        if (n.id === parentId) inside = true;
        return true;
      });
      if (inside) return false;

      const oldParent = findParent(editor.screen.root, id);
      if (!oldParent) return false;

      const from = oldParent.children.findIndex((c) => c.id === id);
      oldParent.children.splice(from, 1);

      let at = index;
      if (oldParent.id === target.id && from < index) at -= 1;

      target.children = target.children ?? [];
      target.children.splice(clamp(at, 0, target.children.length), 0, node);
      return true;
    },

    duplicate() {
      if (readOnly) return warnReadOnly();
      const created = [];
      for (const id of editor.selection) {
        const node = findNode(editor.screen.root, id);
        const parent = findParent(editor.screen.root, id);
        if (!node || !parent) continue;
        const copy = cloneSubtree(node, (type) => uid(type === "Stack" ? "n" : "n"));
        const at = parent.children.findIndex((c) => c.id === id) + 1;
        parent.children.splice(at, 0, copy);
        created.push(copy.id);
      }
      if (!created.length) return;
      editor.select(created);
      editor.commit("Duplicate");
    },

    deleteSelection() {
      if (readOnly) return warnReadOnly();
      const removed = [];
      for (const id of editor.selection) {
        if (id === editor.screen.root.id) continue;
        const parent = findParent(editor.screen.root, id);
        if (!parent) continue;
        const at = parent.children.findIndex((c) => c.id === id);
        if (at === -1) continue;
        removed.push({ node: clone(parent.children[at]), parentId: parent.id, index: at });
        parent.children.splice(at, 1);
      }
      if (!removed.length) return;

      editor.select([]);
      editor.commit(`Delete ${removed.length === 1 ? getDef(removed[0].node.type)?.label ?? "element" : `${removed.length} elements`}`);

      toast(`Deleted ${fmt.plural(removed.length, "element")}`, {
        tone: "info",
        duration: 6000,
        undo: () => {
          for (const entry of removed) {
            const parent = findNode(editor.screen.root, entry.parentId);
            if (parent) {
              parent.children = parent.children ?? [];
              parent.children.splice(Math.min(entry.index, parent.children.length), 0, entry.node);
            }
          }
          editor.select(removed.map((r) => r.node.id));
          editor.commit("Restore deleted");
        },
      });
    },

    wrapSelection(type = "Stack") {
      if (readOnly) return warnReadOnly();
      const ids = editor.selection.filter((id) => id !== editor.screen.root.id);
      if (!ids.length) return;

      const parent = findParent(editor.screen.root, ids[0]);
      if (!parent) return;

      // Only wrap siblings; wrapping across parents has no sensible meaning.
      const siblings = ids.filter((id) => parent.children.some((c) => c.id === id));
      if (!siblings.length) return;

      const firstIndex = Math.min(...siblings.map((id) => parent.children.findIndex((c) => c.id === id)));
      const taken = parent.children.filter((c) => siblings.includes(c.id));
      parent.children = parent.children.filter((c) => !siblings.includes(c.id));

      const wrapper = editor.makeNode(type);
      wrapper.children = taken;
      parent.children.splice(firstIndex, 0, wrapper);

      editor.select([wrapper.id]);
      editor.commit(`Wrap in ${getDef(type)?.label ?? type}`);
    },

    copy() {
      const nodes = editor.selection.map((id) => findNode(editor.screen.root, id)).filter(Boolean);
      if (!nodes.length) return;
      editor.clipboard = clone(nodes);
      toast(`Copied ${fmt.plural(nodes.length, "element")}`, { tone: "info", duration: 1600 });
    },

    paste(intoId = null) {
      if (readOnly) return warnReadOnly();
      if (!editor.clipboard?.length) return;
      const created = [];
      for (const node of editor.clipboard) {
        const inserted = editor.insertTree(clone(node), { parentId: intoId, label: "Paste" });
        if (inserted) created.push(inserted.id);
      }
      if (created.length) editor.select(created);
    },

    copyStyle() {
      const node = findNode(editor.screen.root, editor.selection[0]);
      if (!node) return;
      const def = getDef(node.type);
      const styleKeys = Object.entries(def?.fields ?? {})
        .filter(([, spec]) => ["Appearance", "Spacing", "Typography", "Size"].includes(spec.group))
        .map(([key]) => key);
      // Copy what is on screen, which at a non-base breakpoint means the
      // resolved value rather than the base one.
      const effective = editor.effectiveProps(node);
      editor.styleClipboard = Object.fromEntries(
        styleKeys.filter((k) => k in effective).map((k) => [k, clone(effective[k])]),
      );
      toast(`Copied ${fmt.plural(Object.keys(editor.styleClipboard).length, "style property")}`, { tone: "info", duration: 1800 });
      inspector.render();
    },

    pasteStyle() {
      if (readOnly) return warnReadOnly();
      if (!editor.styleClipboard) return;
      let count = 0;
      for (const id of editor.selection) {
        const node = findNode(editor.screen.root, id);
        const def = getDef(node?.type);
        if (!node || !def) continue;
        const declared = new Set(Object.keys(def.fields ?? {}));
        const target = editor.writeLayer(node);
        for (const [key, value] of Object.entries(editor.styleClipboard)) {
          if (declared.has(key)) target[key] = clone(value);
        }
        count += 1;
      }
      if (count) editor.commit(`Paste style onto ${count}`);
    },

    saveAsBlock() {
      const node = findNode(editor.screen.root, editor.selection[0]);
      if (!node) return;

      modal((close) => {
        let name = getDef(node.type)?.label ?? node.type;
        return {
          title: "Save as a reusable block",
          subtitle: "It appears under Sections in the Insert panel, for this browser.",
          body: el("div.field", el("label", "Name"), el("input.input", { value: name, oninput: (e) => (name = e.target.value) })),
          footer: [
            el("div.spacer"),
            el("button.btn.subtle", { onclick: () => close() }, "Cancel"),
            el(
              "button.btn.primary",
              {
                onclick: () => {
                  editor.savedBlocks = [...editor.savedBlocks, { key: uid("blk"), name, tree: clone(node) }];
                  persist.write("studio.blocks", editor.savedBlocks);
                  close();
                  inspector.setPanel("insert");
                  toast(`"${name}" saved as a block`, {
                    tone: "success",
                    detail: "It is at the top of the Insert panel under Saved blocks.",
                  });
                },
              },
              "Save block",
            ),
          ],
        };
      });
    },

    removeSavedBlock(key) {
      const block = editor.savedBlocks.find((b) => b.key === key);
      editor.savedBlocks = editor.savedBlocks.filter((b) => b.key !== key);
      persist.write("studio.blocks", editor.savedBlocks);
      inspector.render();
      toast(`Forgot "${block?.name ?? "block"}"`, {
        tone: "info",
        undo: () => {
          if (!block) return;
          editor.savedBlocks = [...editor.savedBlocks, block];
          persist.write("studio.blocks", editor.savedBlocks);
          inspector.render();
        },
      });
    },

    /* --- Screens --------------------------------------------------------- */

    patchScreen(patch) {
      const screen = editor.screen;
      if (!screen || readOnly) return;

      // Only one entry screen may exist at a time.
      if (patch.isEntry === true) {
        for (const other of editor.doc.screens) other.isEntry = false;
      }
      Object.assign(screen, patch);
    },

    addScreen(templateKey = "blank") {
      if (readOnly) return warnReadOnly();
      const template = screenTemplates.find((t) => t.key === templateKey) ?? screenTemplates[0];
      const index = editor.doc.screens.length;
      editor.doc.screens.push({
        id: uid("scr"),
        name: `${template.name} ${index + 1}`,
        route: `/screen-${index + 1}`,
        isEntry: false,
        requiresRole: null,
        transition: "slide",
        root: stampIds(template.tree()),
      });
      editor.screenIndex = index;
      editor.selection = [];
      editor.commit("Add screen");
    },

    duplicateScreen() {
      if (readOnly) return warnReadOnly();
      const screen = editor.screen;
      const copy = clone(screen);
      copy.id = uid("scr");
      copy.name = `${screen.name} copy`;
      copy.route = `${screen.route}-copy`;
      copy.isEntry = false;
      stampIds(copy.root);
      editor.doc.screens.splice(editor.screenIndex + 1, 0, copy);
      editor.screenIndex += 1;
      editor.selection = [];
      editor.commit("Duplicate screen");
    },

    async deleteScreen() {
      if (readOnly) return warnReadOnly();
      if (editor.doc.screens.length < 2) return;
      const screen = editor.screen;
      const ok = await confirm({
        title: `Delete "${screen.name}"?`,
        message: "Any action that navigates to this screen becomes a dead link, which validation will flag before publish.",
        confirmLabel: "Delete screen",
        tone: "danger",
      });
      if (!ok) return;
      editor.doc.screens.splice(editor.screenIndex, 1);
      editor.screenIndex = clamp(editor.screenIndex, 0, editor.doc.screens.length - 1);
      editor.selection = [];
      editor.commit("Delete screen");
    },

    goToScreen(index) {
      editor.screenIndex = clamp(index, 0, editor.doc.screens.length - 1);
      editor.selection = [];
      refresh();
    },

    applyTemplate(template) {
      if (readOnly) return warnReadOnly();
      editor.screen.root = stampIds(template.tree());
      editor.selection = [];
      editor.commit(`Apply ${template.name} template`);
    },

    revealNode(screenId, nodeId) {
      const index = editor.doc.screens.findIndex((s) => s.id === screenId);
      if (index > -1) editor.screenIndex = index;
      refresh();
      editor.select([nodeId]);
      inspector.setPanel("style");
    },

    /* --- Canvas view ----------------------------------------------------- */

    setZoom(next) {
      editor.zoom = clamp(Number(next.toFixed(3)), 0.25, 2);
      persist.write("studio.zoom", editor.zoom);
      canvas.applyZoom();
      canvas.paintOverlay();
      paintZoomLabel();
    },

    setDevice(key) {
      editor.device = devices.find((d) => d.key === key) ?? devices[0];
      persist.write("studio.device", editor.device.key);
      refresh();
    },

    setRotated(value) {
      editor.rotated = value;
      refresh();
    },

    /* --- Versions -------------------------------------------------------- */

    versions: () => db.designs.versions(design.id),

    /**
     * Two numbers, because they answer different questions.
     *
     * `users` is who resolves to this exact version today — the people the
     * publish changes immediately. `designUsers` is who resolves to any
     * version of this design, which is who an assignment repointed at the new
     * version would reach. Reporting only the first reads as "this affects
     * nobody" on the very common case of publishing a successor version that
     * no rule points at yet.
     */
    publishImpact() {
      const versionIds = new Set(db.designs.versions(design.id).map((v) => v.id));
      const users = db.users.list({ role: "app_user" });

      const onVersion = users.filter((u) => db.assignments.resolve(u.id).version?.id === editor.version.id);
      const onDesign = users.filter((u) => versionIds.has(db.assignments.resolve(u.id).version?.id));

      return {
        users: onVersion.length,
        orgs: new Set(onVersion.map((u) => u.organization_id)).size,
        designUsers: onDesign.length,
        designOrgs: new Set(onDesign.map((u) => u.organization_id)).size,
      };
    },

    livePreview() {
      const live = db.designs.versions(design.id).find((v) => v.status === "published");
      return live?.document?.screens?.find((s) => s.isEntry) ?? live?.document?.screens?.[0] ?? null;
    },

    screenForThumb() {
      return editor.doc.screens.find((s) => s.isEntry) ?? editor.doc.screens[0];
    },

    publish(label) {
      db.designs.saveDraft(editor.version.id, editor.doc, editor.theme);
      const published = db.designs.publish(editor.version.id, label);
      if (!published) return;
      editor.version = published;
      readOnly = true;
      paintToolbar();
      toast(`v${published.version_number} is live`, {
        tone: "success",
        detail: "Clients pick it up on their next fetch, inside the cache TTL.",
        action: { label: "Fork a draft", run: () => forkAndOpen(published.id) },
      });
    },

    forkFrom(versionId) {
      const forked = db.designs.fork(versionId);
      return forked;
    },

    openLayerMenu(event, layer) {
      const isRoot = layer.id === editor.screen.root.id;
      menu(
        { left: event.clientX, top: event.clientY, right: event.clientX, bottom: event.clientY, width: 0, height: 0 },
        [
          { label: "Duplicate", icon: "duplicate", shortcut: "⌘D", disabled: isRoot, onSelect: () => editor.duplicate() },
          { label: "Copy", icon: "copy", disabled: isRoot, onSelect: () => editor.copy() },
          { label: "Paste inside", icon: "cornerDownRight", disabled: !getDef(layer.type)?.acceptsChildren || !editor.clipboard, onSelect: () => editor.paste(layer.id) },
          "-",
          { label: "Wrap in a stack", icon: "stack", disabled: isRoot, onSelect: () => editor.wrapSelection() },
          { label: "Copy style", icon: "palette", onSelect: () => editor.copyStyle() },
          { label: "Paste style", icon: "droplet", disabled: !editor.styleClipboard, onSelect: () => editor.pasteStyle() },
          { label: "Save as a block", icon: "package", disabled: isRoot, onSelect: () => editor.saveAsBlock() },
          "-",
          { label: layer.hidden ? "Show" : "Hide", icon: layer.hidden ? "eye" : "eyeOff", onSelect: () => editor.toggleHidden(layer.id) },
          { label: layer.locked ? "Unlock" : "Lock", icon: layer.locked ? "unlock" : "lock", onSelect: () => editor.toggleLocked(layer.id) },
          "-",
          { label: "Delete", icon: "trash", tone: "danger", disabled: isRoot, onSelect: () => editor.deleteSelection() },
        ],
        { minWidth: 200 },
      );
    },
  });

  function warnReadOnly() {
    toast("This version is published and immutable", {
      tone: "warning",
      detail: "Fork a draft to make changes.",
      action: { label: "Fork a draft", run: () => forkAndOpen(editor.version.id) },
    });
    return false;
  }

  function stampIds(node) {
    node.id = uid("n");
    (node.children ?? []).forEach(stampIds);
    return node;
  }

  function forkAndOpen(versionId) {
    const forked = db.designs.fork(versionId);
    if (forked) go("studio", { design: design.id, version: forked.id });
  }

  /* ======================================================================
     Autosave
     ====================================================================== */

  let saveState = "saved";
  const saveLabel = el("span.save-state");

  const autosave = debounce(() => {
    if (readOnly) return;
    saveState = "saving";
    paintSaveState();
    db.designs.saveDraft(editor.version.id, editor.doc, editor.theme);
    setTimeout(() => {
      saveState = "saved";
      paintSaveState(new Date());
    }, 260);
  }, 2000);

  function paintSaveState(at = null) {
    if (readOnly) {
      mountTo(saveLabel, el("span.dot"), "Published · read-only");
      return;
    }
    if (saveState === "saving") {
      mountTo(saveLabel, el("span.dot.accent"), "Saving…");
      return;
    }
    mountTo(saveLabel, el("span.dot.success"), at ? `Saved ${fmt.relative(at)}` : "Saved");
  }

  /* ======================================================================
     Views
     ====================================================================== */

  const canvas = createCanvas(editor);
  editor.canvas = canvas;

  const inspector = createInspector(editor);
  editor.inspector = inspector;

  const toolbar = el("div.studio-toolbar");
  const canvasBar = el("div.canvas-bar");
  const screenStrip = el("div.screen-strip");
  const zoomLabel = el("span", { style: { fontSize: "var(--fs-11)", color: "var(--text-secondary)", minWidth: "36px", textAlign: "center" } });

  const canvasRegion = el("div.canvas-region", canvasBar, canvas.node, screenStrip);

  const inspectorSplit = splitHandle((dx) => {
    const current = Number.parseInt(getComputedStyle(inspector.node).width, 10);
    inspector.node.style.setProperty("--inspector-w", `${clamp(current - dx, 268, 480)}px`);
    canvas.paintOverlay();
  });

  const root = el(
    "div.studio",
    toolbar,
    el("div.studio-body", canvasRegion, inspectorSplit, inspector.node),
  );

  host.appendChild(root);

  /* --- Toolbar ------------------------------------------------------------ */

  function paintToolbar() {
    undoButton = el(
      "button.btn.icon.ghost",
      { "data-tip": "Undo", "data-tip-key": "⌘Z", disabled: !history.canUndo, onclick: () => doUndo() },
      icon("undo"),
    );
    redoButton = el(
      "button.btn.icon.ghost",
      { "data-tip": "Redo", "data-tip-key": "⌘⇧Z", disabled: !history.canRedo, onclick: () => doRedo() },
      icon("redo"),
    );

    mountTo(
      toolbar,
      el(
        "div.studio-title",
        icon("studio", 15),
        el("input", {
          value: design.name,
          "data-tip": "Rename this design",
          onchange: (event) => {
            const name = event.target.value.trim() || design.name;
            db.designs.update(design.id, { name });
            design.name = name;
            setCrumbs([{ label: "Design Studio", onSelect: () => go("library") }, { label: name }, { label: `v${editor.version.version_number}` }]);
          },
        }),
      ),
      el(
        "button.version-pill",
        { "data-tip": "Version history", onclick: () => openVersionHistory(editor, { onOpen: (id) => go("studio", { design: design.id, version: id }) }) },
        `v${editor.version.version_number}`,
        el(`span.pill.${editor.version.status === "published" ? "success" : "warning"}`, { style: { height: "14px", fontSize: "10px" } }, fmt.label(editor.version.status)),
        icon("chevronDown"),
      ),
      readOnly &&
        el(
          "button.btn.sm.subtle",
          { onclick: () => forkAndOpen(editor.version.id) },
          icon("gitBranch"),
          "Fork a draft",
        ),
      el("div.vr"),
      undoButton,
      redoButton,
      el(
        "button.btn.icon.ghost",
        { "data-tip": "History", onclick: (event) => openHistoryMenu(event.currentTarget) },
        icon("history"),
      ),
      el("div.vr"),
      el(
        "button.btn.sm.ghost",
        { "data-tip": "Edit the design tokens", onclick: () => openThemeEditor(editor) },
        icon("palette"),
        "Theme",
      ),
      el(
        "button.btn.sm.ghost",
        { "data-tip": "Run validation without publishing", onclick: () => runValidation() },
        icon("shield"),
        "Validate",
      ),
      el("div.spacer"),
      saveLabel,
      el(
        "button.btn.sm.subtle",
        { onclick: () => openPreviewLink() },
        icon("externalLink"),
        "Preview link",
      ),
      el(
        "button.btn.primary.sm",
        {
          "data-tip": "Publish this version",
          "data-tip-key": "⌘↵",
          disabled: readOnly,
          onclick: () => openPublishPanel(editor, { onPublished: () => paintToolbar() }),
        },
        icon("publish"),
        "Publish",
      ),
    );

    paintSaveState();
  }

  function paintHistoryButtons() {
    if (undoButton) {
      undoButton.disabled = !history.canUndo;
      undoButton.dataset.tip = history.undoLabel ? `Undo ${history.undoLabel.toLowerCase()}` : "Undo";
    }
    if (redoButton) {
      redoButton.disabled = !history.canRedo;
      redoButton.dataset.tip = history.redoLabel ? `Redo ${history.redoLabel.toLowerCase()}` : "Redo";
    }
  }

  function openHistoryMenu(anchor) {
    const entries = history.entries.slice(0, 24);
    menu(
      anchor,
      [
        { label: `History · ${history.depth} steps`, header: true },
        ...entries.map((entry, i) => ({
          label: entry.label,
          icon: i === 0 ? "check" : "clock",
          onSelect: () => {
            const result = history.jumpTo(entry.index);
            if (result) editor.applySnapshot(result.snapshot);
          },
        })),
      ],
      { minWidth: 240 },
    );
  }

  /* --- Canvas bar --------------------------------------------------------- */

  function paintCanvasBar() {
    mountTo(
      canvasBar,
      el(
        "select.select",
        {
          style: { width: "auto", maxWidth: "190px" },
          "data-tip": "Device frame",
          onchange: (event) => editor.setDevice(event.target.value),
        },
        ...devices.map((d) => el("option", { value: d.key, selected: d.key === editor.device.key }, `${d.name} · ${d.width}×${d.height}`)),
      ),
      el(
        "button.btn.icon.ghost",
        { "data-tip": "Rotate", onclick: () => editor.setRotated(!editor.rotated), "aria-pressed": String(editor.rotated) },
        icon("rotate"),
      ),
      el("div.vr"),
      el("button.btn.icon.ghost", { "data-tip": "Zoom out", onclick: () => editor.setZoom(editor.zoom - 0.1) }, icon("zoomOut")),
      el("button.btn.sm.ghost", { "data-tip": "Reset zoom", "data-tip-key": "⌘0", onclick: () => editor.setZoom(1) }, zoomLabel),
      el("button.btn.icon.ghost", { "data-tip": "Zoom in", onclick: () => editor.setZoom(editor.zoom + 0.1) }, icon("zoomIn")),
      el("button.btn.icon.ghost", { "data-tip": "Fit to screen", "data-tip-key": "⌘1", onclick: () => canvas.fitToScreen() }, icon("fitScreen")),
      el("div.spacer"),
      el(
        "span.dim",
        { style: { fontSize: "var(--fs-11)" } },
        `${editor.nodeCount} / ${500} nodes · depth ${editor.maxDepth} / 20`,
      ),
      el("div.vr"),
      el(
        "button.btn.sm.ghost",
        { "data-tip": "Preview as an app user would see it", onclick: () => openPreviewModal() },
        icon("play"),
        "Preview",
      ),
    );
    paintZoomLabel();
  }

  function paintZoomLabel() {
    zoomLabel.textContent = `${Math.round(editor.zoom * 100)}%`;
  }

  /* --- Screen strip -------------------------------------------------------- */

  function paintScreenStrip() {
    mountTo(
      screenStrip,
      ...editor.doc.screens.map((screen, index) =>
        el(
          "button",
          {
            type: "button",
            class: `screen-chip${index === editor.screenIndex ? " active" : ""}`,
            onclick: () => editor.goToScreen(index),
            oncontextmenu: (event) => {
              event.preventDefault();
              editor.goToScreen(index);
              menu(
                { left: event.clientX, top: event.clientY, right: event.clientX, bottom: event.clientY, width: 0, height: 0 },
                [
                  { label: "Duplicate screen", icon: "duplicate", onSelect: () => editor.duplicateScreen() },
                  { label: "Set as entry", icon: "target", disabled: screen.isEntry, onSelect: () => { editor.patchScreen({ isEntry: true }); editor.commit("Set entry screen"); } },
                  "-",
                  { label: "Delete screen", icon: "trash", tone: "danger", disabled: editor.doc.screens.length < 2, onSelect: () => editor.deleteScreen() },
                ],
              );
            },
          },
          screen.isEntry && el("span.entry-mark", { "data-tip": "Entry screen" }),
          el("span", screen.name),
          el("span.route", screen.route),
        ),
      ),
      el(
        "button.btn.sm.ghost",
        { "data-tip": "Add a screen", onclick: (event) => openAddScreenMenu(event.currentTarget) },
        icon("plus"),
        "Screen",
      ),
    );
  }

  function openAddScreenMenu(anchor) {
    menu(
      anchor,
      [
        { label: "Start from", header: true },
        ...screenTemplates.map((t) => ({
          label: t.name,
          icon: t.glyph,
          onSelect: () => editor.addScreen(t.key),
        })),
      ],
      { placement: "top-start", minWidth: 200 },
    );
  }

  /* ======================================================================
     Preview and validation
     ====================================================================== */

  function runValidation() {
    const result = validateDocument(editor.doc, editor.theme);
    if (!result.errors.length && !result.warnings.length) {
      toast("Validation clean", { tone: "success", detail: `${result.stats.screens} screens, ${result.stats.nodes} nodes, ${result.stats.routes} unique routes.` });
      return;
    }
    toast(
      `${result.errors.length ? fmt.plural(result.errors.length, "error") : "No errors"}, ${fmt.plural(result.warnings.length, "warning")}`,
      {
        tone: result.errors.length ? "danger" : "warning",
        detail: (result.errors[0] ?? result.warnings[0])?.title,
        action: { label: "Review", run: () => openPublishPanel(editor, { onPublished: () => paintToolbar() }) },
      },
    );
  }

  function openPreviewLink() {
    const token = `pv_${Math.random().toString(36).slice(2, 12)}`;
    const url = `/t/${db.orgs.get(app.get("org"))?.slug ?? "org"}${editor.screen.route}?preview=${token}`;
    modal((close) => ({
      title: "Preview link",
      subtitle: "A short-lived signed token. Shareable for review without dashboard access.",
      body: [
        el("div.code", url),
        el(
          "div.callout",
          icon("shield"),
          el(
            "div",
            el("b", "Valid for 30 minutes."),
            " The app renders this draft instead of the assigned version, disables telemetry, and watermarks the screen.",
          ),
        ),
      ],
      footer: [
        el("div.spacer"),
        el("button.btn.subtle", { onclick: () => close() }, "Close"),
        el(
          "button.btn.primary",
          {
            onclick: () => {
              navigator.clipboard?.writeText(url);
              toast("Preview link copied", { tone: "success" });
              close();
            },
          },
          icon("copy"),
          "Copy link",
        ),
      ],
    }));
  }

  function openPreviewModal() {
    modal(
      () => ({
        title: "Preview",
        subtitle: `${editor.screen.name} · as an app user would see it`,
        body: el(
          "div",
          { style: { display: "grid", placeItems: "center", padding: "var(--s-3)" } },
          (() => {
            // A real device frame at a readable size, scrollable like the app.
            const scale = 0.62;
            const frame = el("div.device", { style: { "--device-radius": `${editor.device.radius}px` } });
            const screenBox = el("div.device-screen", {
              style: { width: `${editor.device.width}px`, height: `${editor.device.height}px` },
            });
            const content = el("div.device-content");
            content.appendChild(
              renderScreenSync(editor.screen, { theme: editor.theme, scope: editor.scope(), editable: false }),
            );
            screenBox.append(content, el("div.device-home", { style: { color: editor.theme?.colors?.text ?? "#000" } }));
            frame.append(screenBox);
            frame.style.transform = `scale(${scale})`;
            frame.style.transformOrigin = "top center";

            // The scaled frame still occupies its unscaled box, so the wrapper
            // is sized to the scaled result to avoid a tall empty modal.
            return el(
              "div",
              { style: { height: `${(editor.device.height + 22) * scale}px`, width: `${(editor.device.width + 22) * scale}px` } },
              frame,
            );
          })(),
        ),
      }),
      { width: "wide" },
    );
  }

  /* ======================================================================
     Refresh
     ====================================================================== */

  function refresh() {
    canvas.render();
    canvas.applyZoom();
    inspector.render();
    paintScreenStrip();
    paintCanvasBar();
  }

  function doUndo() {
    const result = history.undo();
    if (!result) return;
    editor.applySnapshot(result.snapshot);
    toast(`Undid ${result.label.toLowerCase()}`, { tone: "info", duration: 1400 });
  }

  function doRedo() {
    const result = history.redo();
    if (!result) return;
    editor.applySnapshot(result.snapshot);
  }

  /* ======================================================================
     Keyboard
     ====================================================================== */

  const offKeys = on(document, "keydown", (event) => {
    const target = event.target;
    const typing =
      target instanceof HTMLElement &&
      (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);

    const meta = event.metaKey || event.ctrlKey;

    if (meta && event.key.toLowerCase() === "z") {
      event.preventDefault();
      if (event.shiftKey) doRedo();
      else doUndo();
      return;
    }

    if (meta && event.key === "0") {
      event.preventDefault();
      editor.setZoom(1);
      return;
    }
    if (meta && event.key === "1") {
      event.preventDefault();
      canvas.fitToScreen();
      return;
    }
    if (meta && event.key === "s") {
      event.preventDefault();
      autosave.flush();
      toast("Saved", { tone: "success", duration: 1400 });
      return;
    }
    if (meta && event.key === "Enter") {
      event.preventDefault();
      if (!readOnly) openPublishPanel(editor, { onPublished: () => paintToolbar() });
      return;
    }

    if (typing) return;

    if (meta && event.key.toLowerCase() === "d") {
      event.preventDefault();
      editor.duplicate();
      return;
    }
    if (meta && event.key.toLowerCase() === "c") {
      editor.copy();
      return;
    }
    if (meta && event.key.toLowerCase() === "v") {
      editor.paste();
      return;
    }
    if (meta && event.key.toLowerCase() === "g") {
      event.preventDefault();
      editor.wrapSelection();
      return;
    }

    if (event.key === "Backspace" || event.key === "Delete") {
      if (!editor.selection.length) return;
      event.preventDefault();
      editor.deleteSelection();
      return;
    }

    if (event.key === "Escape") {
      if (editor.selection.length) {
        event.preventDefault();
        editor.select([]);
      }
      return;
    }

    // Arrow keys move the selection within its parent.
    if ((event.key === "ArrowUp" || event.key === "ArrowDown") && editor.selection.length === 1) {
      const id = editor.selection[0];
      const parent = findParent(editor.screen.root, id);
      if (!parent) return;
      event.preventDefault();
      const at = parent.children.findIndex((c) => c.id === id);
      const to = clamp(at + (event.key === "ArrowDown" ? 1 : -1), 0, parent.children.length - 1);
      if (to === at) return;
      const [node] = parent.children.splice(at, 1);
      parent.children.splice(to, 0, node);
      editor.commit("Reorder");
      canvas.showGuides(id);
      return;
    }

    if (event.key === "Tab" && editor.selection.length === 1) {
      const id = editor.selection[0];
      const parent = findParent(editor.screen.root, id);
      if (!parent) return;
      event.preventDefault();
      const at = parent.children.findIndex((c) => c.id === id);
      const next = parent.children[(at + (event.shiftKey ? -1 : 1) + parent.children.length) % parent.children.length];
      if (next) editor.select([next.id]);
    }
  });

  /* ======================================================================
     Commands and first paint
     ====================================================================== */

  const unregister = registerCommands([
    { id: "studio.theme", label: "Open the theme editor", glyph: "palette", group: "Studio", run: () => openThemeEditor(editor) },
    { id: "studio.publish", label: "Publish this version", glyph: "publish", group: "Studio", hint: "⌘↵", run: () => openPublishPanel(editor, { onPublished: () => paintToolbar() }) },
    { id: "studio.validate", label: "Validate this document", glyph: "shield", group: "Studio", run: () => runValidation() },
    { id: "studio.history", label: "Version history", glyph: "history", group: "Studio", run: () => openVersionHistory(editor, { onOpen: (id) => go("studio", { design: design.id, version: id }) }) },
    { id: "studio.preview", label: "Copy a preview link", glyph: "externalLink", group: "Studio", run: () => openPreviewLink() },
    { id: "studio.screen", label: "Add a screen", glyph: "plus", group: "Studio", run: () => editor.addScreen() },
    ...screenTemplates.map((t) => ({
      id: `studio.template.${t.key}`,
      label: `Add a ${t.name} screen`,
      glyph: t.glyph,
      group: "Studio",
      run: () => editor.addScreen(t.key),
    })),
  ]);

  paintToolbar();
  refresh();
  requestAnimationFrame(() => canvas.fitToScreen());

  if (readOnly) {
    toast(`v${editor.version.version_number} is published`, {
      tone: "info",
      detail: "Open read-only. Fork a draft to edit.",
      duration: 5200,
      action: { label: "Fork a draft", run: () => forkAndOpen(editor.version.id) },
    });
  }

  /* --- Teardown ------------------------------------------------------------ */

  return () => {
    offKeys();
    unregister();
    autosave.flush();
  };
}
