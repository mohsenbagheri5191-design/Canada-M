/**
 * Design Library — every design ever built, browsable and comparable.
 *
 * The compare view is the point of this tab: a structural diff between two
 * versions, next to rendered previews, so a review is real rather than
 * decorative.
 */

import { el, mount as mountTo } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { fmt, sortBy } from "../core/util.js";
import {
  searchField,
  segmented,
  emptyState,
  statusPill,
  pill,
  menu,
  modal,
  confirm,
  toast,
  metaRow,
} from "../core/ui.js";
import { registerCommands } from "../core/shell.js";
import { walk } from "../render/renderer.js";
import { renderMiniature } from "../studio/canvas.js";
import { screenTemplates, themePresets } from "../data/presets.js";
import { getDef } from "../data/registry.js";

export function mount(host, { db, go, setCrumbs, params, app }) {
  setCrumbs([{ label: "Design Library" }]);

  const state = {
    view: "grid",
    q: "",
    org: "",
    status: "",
    sort: "recent",
    compare: [],
  };

  const body = el("div.page-scroll");
  const toolbar = el("div.toolbar");
  const page = el("div.page", toolbar, body);
  host.appendChild(page);

  const unregister = registerCommands([
    { id: "lib.new", label: "New design", glyph: "plus", group: "Library", run: () => newDesignDialog() },
  ]);

  /* --- Toolbar ------------------------------------------------------------ */

  mountTo(
    toolbar,
    searchField("Search designs, descriptions and version labels", (value) => {
      state.q = value;
      render();
    }, { width: 300 }),
    el("div.vr"),
    el(
      "select.select",
      {
        style: { width: "auto" },
        onchange: (event) => {
          state.org = event.target.value;
          render();
        },
      },
      el("option", { value: "" }, "All organisations"),
      ...db.orgs.list().map((o) => el("option", { value: o.id }, o.name)),
    ),
    el(
      "select.select",
      {
        style: { width: "auto" },
        onchange: (event) => {
          state.status = event.target.value;
          render();
        },
      },
      el("option", { value: "" }, "Any status"),
      ...["draft", "published", "archived"].map((s) => el("option", { value: s }, fmt.label(s))),
    ),
    el(
      "select.select",
      {
        style: { width: "auto" },
        onchange: (event) => {
          state.sort = event.target.value;
          render();
        },
      },
      el("option", { value: "recent" }, "Recently updated"),
      el("option", { value: "name" }, "Name"),
      el("option", { value: "adoption" }, "Adoption"),
    ),
    el("div.spacer"),
    segmented(
      [
        { value: "grid", icon: "grid", tip: "Grid" },
        { value: "list", icon: "list", tip: "List" },
      ],
      state.view,
      (value) => {
        state.view = value;
        render();
      },
    ),
    el("button.btn.primary.sm", { onclick: () => newDesignDialog() }, icon("plus"), "New design"),
  );

  /* --- Data --------------------------------------------------------------- */

  function rows() {
    let designs = db.designs.list({ org: state.org || null, status: state.status || null });

    if (state.q) {
      const needle = state.q.toLowerCase();
      designs = designs.filter((d) => {
        if (`${d.name} ${d.description}`.toLowerCase().includes(needle)) return true;
        return db.designs.versions(d.id).some((v) => (v.label ?? "").toLowerCase().includes(needle));
      });
    }

    const enriched = designs.map((design) => {
      const versions = db.designs.versions(design.id);
      const live = versions.find((v) => v.status === "published");
      const draft = versions.find((v) => v.status === "draft");
      const assigned = db.assignments.list().filter((a) => versions.some((v) => v.id === a.design_version_id));
      const users = db.users.list({ role: "app_user" }).filter((u) => {
        const resolved = db.assignments.resolve(u.id).version;
        return resolved && versions.some((v) => v.id === resolved.id);
      });
      return { design, versions, live, draft, assigned, userCount: users.length, org: db.orgs.get(design.organization_id) };
    });

    if (state.sort === "name") return sortBy(enriched, (r) => r.design.name);
    if (state.sort === "adoption") return sortBy(enriched, (r) => r.userCount, "desc");
    return sortBy(enriched, (r) => r.design.updated_at, "desc");
  }

  /* --- Render -------------------------------------------------------------- */

  function render() {
    const data = rows();

    if (!data.length) {
      mountTo(
        body,
        emptyState(
          "library",
          state.q ? "No design matches" : "No designs yet",
          state.q ? "Try a shorter search, or clear the filters above." : "A design holds every screen for one app experience, versioned and publishable.",
          el("button.btn.primary", { onclick: () => newDesignDialog() }, icon("plus"), "New design"),
        ),
      );
      return;
    }

    mountTo(
      body,
      compareBar(),
      state.view === "grid"
        ? el("div.grid-3.stagger", ...data.map((row, i) => {
            const card = designCard(row);
            card.style.setProperty("--i", i);
            return card;
          }))
        : listTable(data),
    );
  }

  function compareBar() {
    if (!state.compare.length) return null;
    const picked = state.compare.map((id) => db.designs.version(id)).filter(Boolean);

    return el(
      "div.callout.accent",
      icon("compare"),
      el(
        "div",
        { style: { flex: "1 1 auto" } },
        el("b", `${picked.length} of 2 versions selected for compare`),
        el("div", { style: { marginTop: "2px" } }, picked.map((v) => `v${v.version_number}`).join(" vs ") || "Pick two versions from any design's menu."),
      ),
      picked.length === 2 &&
        el("button.btn.primary.sm", { onclick: () => openCompare(picked[0], picked[1]) }, "Compare"),
      el(
        "button.btn.sm.ghost",
        {
          onclick: () => {
            state.compare = [];
            render();
          },
        },
        "Clear",
      ),
    );
  }

  function designCard(row) {
    const { design, versions, live, draft, userCount, org } = row;
    const showVersion = live ?? draft ?? versions[versions.length - 1];
    const entry = showVersion?.document?.screens?.find((s) => s.isEntry) ?? showVersion?.document?.screens?.[0];

    const thumb = el("div.design-thumb");
    if (entry) {
      thumb.appendChild(renderMiniature(entry, showVersion.theme, { fit: "width" }));
    } else {
      thumb.appendChild(icon("library", 22));
    }
    thumb.appendChild(
      el("div.thumb-overlay", el("span.btn.primary.sm", icon("studio"), "Open in studio")),
    );

    return el(
      "article.card.interactive.design-card",
      { onclick: () => go("studio", { design: design.id }) },
      thumb,
      el(
        "div.design-card-body",
        el(
          "div.title-row",
          el("div.col", { style: { minWidth: 0, flex: "1 1 auto" } }, el("h3.truncate", design.name), el("span.desc", design.description || "No description")),
          el(
            "button.btn.sm.icon.ghost",
            {
              onclick: (event) => {
                event.stopPropagation();
                openDesignMenu(event.currentTarget, row);
              },
            },
            icon("more"),
          ),
        ),
        el(
          "div.row",
          { style: { gap: "5px", flexWrap: "wrap" } },
          statusPill(design.status),
          pill(`v${showVersion?.version_number ?? 1}`),
          draft && live && pill("draft ahead", "warning"),
        ),
      ),
      el(
        "div.design-card-foot",
        el("span.truncate", org?.name ?? "Global"),
        el("div.spacer"),
        el("span.row", { style: { gap: "4px" } }, icon("users", 11), fmt.number(userCount)),
        el("span", fmt.relative(design.updated_at)),
      ),
    );
  }

  function listTable(data) {
    return el(
      "div.panel",
      el(
        "div.table-wrap",
        el(
          "table.data",
          el(
            "thead",
            el(
              "tr",
              el("th", "Design"),
              el("th", "Organisation"),
              el("th", "Status"),
              el("th.num-cell", "Version"),
              el("th.num-cell", "Users"),
              el("th", "Updated"),
              el("th.tight", ""),
            ),
          ),
          el(
            "tbody",
            ...data.map((row) =>
              el(
                "tr.clickable",
                { onclick: () => go("studio", { design: row.design.id }) },
                el("td.primary-cell", el("div.row", { style: { gap: "var(--s-2)" } }, icon(row.design.status === "published" ? "library" : "edit", 13), row.design.name)),
                el("td", row.org?.name ?? "Global"),
                el("td", statusPill(row.design.status)),
                el("td.num-cell", `v${(row.live ?? row.draft ?? row.versions.at(-1))?.version_number ?? 1}`),
                el("td.num-cell", fmt.number(row.userCount)),
                el("td", fmt.relative(row.design.updated_at)),
                el(
                  "td.tight",
                  el(
                    "div.row-actions",
                    el(
                      "button.btn.sm.icon.ghost",
                      {
                        onclick: (event) => {
                          event.stopPropagation();
                          openDesignMenu(event.currentTarget, row);
                        },
                      },
                      icon("more"),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  /* --- Menus and dialogs ---------------------------------------------------- */

  function openDesignMenu(anchor, row) {
    const { design, versions, live } = row;

    menu(
      anchor,
      [
        { label: "Open in studio", icon: "studio", onSelect: () => go("studio", { design: design.id }) },
        { label: "Version history", icon: "history", onSelect: () => openVersions(row) },
        {
          label: "Add to compare",
          icon: "compare",
          disabled: state.compare.length >= 2,
          onSelect: () => {
            const pick = live ?? versions.at(-1);
            state.compare = [...state.compare, pick.id].slice(-2);
            render();
          },
        },
        "-",
        { label: "Duplicate", icon: "duplicate", onSelect: () => duplicateDialog(design) },
        {
          label: "Rename",
          icon: "edit",
          onSelect: () => renameDialog(design),
        },
        {
          label: design.status === "archived" ? "Restore" : "Archive",
          icon: "package",
          onSelect: () => {
            db.designs.update(design.id, { status: design.status === "archived" ? "draft" : "archived" });
            toast(design.status === "archived" ? "Design restored" : "Design archived", { tone: "info" });
            render();
          },
        },
        live && {
          label: "Roll back to the previous version",
          icon: "rollback",
          onSelect: async () => {
            const ok = await confirm({
              title: "Roll back?",
              message: "The previously published version becomes live again. Clients pick it up within the cache TTL, under 60 seconds.",
              confirmLabel: "Roll back",
              tone: "danger",
            });
            if (!ok) return;
            const result = db.designs.rollback(design.id);
            if (result) {
              toast(`Rolled back to v${result.version_number}`, { tone: "success" });
              render();
            } else {
              toast("No earlier published version to roll back to", { tone: "warning" });
            }
          },
        },
        "-",
        {
          label: "Delete",
          icon: "trash",
          tone: "danger",
          onSelect: async () => {
            const assignmentCount = row.assigned.length;
            const ok = await confirm({
              title: `Delete "${design.name}"?`,
              message:
                assignmentCount > 0
                  ? `${fmt.plural(assignmentCount, "assignment")} point at this design. Deleting it sends those users to their organisation's default.`
                  : "Nothing is assigned to this design, so no user is affected.",
              confirmLabel: "Delete design",
              tone: "danger",
              typeToConfirm: design.status === "published" && assignmentCount > 0 ? design.name : null,
            });
            if (!ok) return;
            db.designs.remove(design.id);
            toast("Design deleted", { tone: "info" });
            render();
          },
        },
      ].filter(Boolean),
      { minWidth: 250 },
    );
  }

  function newDesignDialog() {
    modal((close) => {
      let name = "";
      let orgId = app.get("org");
      let template = "home";
      let themeKey = themePresets[0].key;

      return {
        title: "New design",
        subtitle: "Starts as a draft. Nothing is live until you publish and assign it.",
        body: [
          el("div.field", el("label", "Name"), el("input.input", { placeholder: "Technician v2", oninput: (e) => (name = e.target.value) })),
          el(
            "div.field-grid-2",
            el(
              "div.field",
              el("label", "Organisation"),
              el(
                "select.select",
                { onchange: (e) => (orgId = e.target.value) },
                ...db.orgs.list().map((o) => el("option", { value: o.id, selected: o.id === orgId }, o.name)),
              ),
            ),
            el(
              "div.field",
              el("label", "Theme"),
              el(
                "select.select",
                { onchange: (e) => (themeKey = e.target.value) },
                ...themePresets.map((t) => el("option", { value: t.key }, t.name)),
              ),
            ),
          ),
          el(
            "div.field",
            el("label", "Starting screen"),
            el(
              "div",
              { style: { display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "var(--s-2)" } },
              ...screenTemplates.map((t) =>
                el(
                  "button",
                  {
                    type: "button",
                    class: "theme-card",
                    dataset: { template: t.key },
                    onclick: (event) => {
                      template = t.key;
                      for (const card of event.currentTarget.parentElement.children) card.classList.toggle("active", card.dataset.template === t.key);
                    },
                  },
                  el("span", { style: { display: "flex", color: "var(--text-tertiary)" } }, icon(t.glyph, 15)),
                  el("b", { style: { fontSize: "var(--fs-11)" } }, t.name),
                ),
              ),
            ),
          ),
        ],
        footer: [
          el("div.spacer"),
          el("button.btn.subtle", { onclick: () => close() }, "Cancel"),
          el(
            "button.btn.primary",
            {
              onclick: () => {
                if (!name.trim()) return toast("Give the design a name", { tone: "warning" });
                const theme = themePresets.find((t) => t.key === themeKey)?.theme;
                const { design } = db.designs.create({ name: name.trim(), organization_id: orgId, template, theme });
                close();
                toast(`${design.name} created`, { tone: "success", detail: "Opening the studio." });
                go("studio", { design: design.id });
              },
            },
            "Create and open",
          ),
        ],
      };
    });
  }

  function renameDialog(design) {
    modal((close) => {
      let name = design.name;
      let description = design.description;
      return {
        title: "Rename design",
        body: [
          el("div.field", el("label", "Name"), el("input.input", { value: name, oninput: (e) => (name = e.target.value) })),
          el("div.field", el("label", "Description"), el("textarea.textarea", { value: description, oninput: (e) => (description = e.target.value) })),
        ],
        footer: [
          el("div.spacer"),
          el("button.btn.subtle", { onclick: () => close() }, "Cancel"),
          el(
            "button.btn.primary",
            {
              onclick: () => {
                db.designs.update(design.id, { name: name.trim() || design.name, description });
                close();
                render();
              },
            },
            "Save",
          ),
        ],
      };
    });
  }

  function duplicateDialog(design) {
    modal((close) => {
      let name = `${design.name} copy`;
      let orgId = design.organization_id;
      return {
        title: "Duplicate design",
        subtitle: "Copies the most recent version into a fresh draft.",
        body: [
          el("div.field", el("label", "Name"), el("input.input", { value: name, oninput: (e) => (name = e.target.value) })),
          el(
            "div.field",
            el("label", "Organisation"),
            el(
              "select.select",
              { onchange: (e) => (orgId = e.target.value) },
              ...db.orgs.list().map((o) => el("option", { value: o.id, selected: o.id === orgId }, o.name)),
            ),
            el("span.hint", "Duplicating into another organisation is how a working design is rolled out to a new client."),
          ),
        ],
        footer: [
          el("div.spacer"),
          el("button.btn.subtle", { onclick: () => close() }, "Cancel"),
          el(
            "button.btn.primary",
            {
              onclick: () => {
                const copy = db.designs.duplicate(design.id, { name, organization_id: orgId });
                close();
                toast(`${copy.name} created`, { tone: "success" });
                render();
              },
            },
            "Duplicate",
          ),
        ],
      };
    });
  }

  function openVersions(row) {
    modal(
      (close) => ({
        title: `${row.design.name} — versions`,
        subtitle: `${fmt.plural(row.versions.length, "version")}. Published versions are immutable.`,
        body: el(
          "div.timeline-rail",
          ...row.versions
            .slice()
            .reverse()
            .map((version) =>
              el(
                "div.timeline-entry",
                { dataset: { kind: version.status === "published" ? "publish" : version.status === "rolled_back" ? "rollback" : version.status === "draft" ? "draft" : "archived" } },
                el(
                  "div.row",
                  { style: { gap: "var(--s-2)", alignItems: "baseline" } },
                  el("b", `v${version.version_number}`),
                  el("span.muted", version.label || "—"),
                  statusPill(version.status),
                  el("div.spacer"),
                  el("span.dim", { style: { fontSize: "var(--fs-11)" } }, fmt.relative(version.published_at ?? version.created_at)),
                ),
                el(
                  "div.row",
                  { style: { gap: "var(--s-2)", marginTop: "4px" } },
                  el(
                    "button.btn.sm.subtle",
                    {
                      onclick: () => {
                        close();
                        go("studio", { design: row.design.id, version: version.id });
                      },
                    },
                    "Open",
                  ),
                  el(
                    "button.btn.sm.ghost",
                    {
                      onclick: () => {
                        state.compare = [...state.compare, version.id].slice(-2);
                        close();
                        render();
                      },
                    },
                    icon("compare"),
                    "Compare",
                  ),
                ),
              ),
            ),
        ),
      }),
      { width: "wide" },
    );
  }

  /* --- Compare -------------------------------------------------------------- */

  function openCompare(a, b) {
    const [left, right] = a.version_number <= b.version_number ? [a, b] : [b, a];
    const diff = diffDocuments(left.document, right.document);

    modal(
      () => ({
        title: "Compare versions",
        subtitle: `v${left.version_number} → v${right.version_number} · ${diff.length ? fmt.plural(diff.length, "change") : "identical"}`,
        body: [
          el(
            "div.compare-grid",
            comparePane(`v${left.version_number}`, left),
            comparePane(`v${right.version_number}`, right, true),
          ),
          el(
            "div.col",
            { style: { gap: "var(--s-2)" } },
            el("span.eyebrow", "Structural diff"),
            diff.length
              ? el(
                  "div.col",
                  { style: { gap: "2px", maxHeight: "260px", overflow: "auto" } },
                  ...diff.map((change) =>
                    el(
                      "div.diff-row",
                      { dataset: { kind: change.kind } },
                      el("span.op", change.kind),
                      el("span.truncate", change.label),
                      el("div.spacer"),
                      el("span", { style: { opacity: 0.7, fontSize: "var(--fs-11)" } }, change.where),
                    ),
                  ),
                )
              : el("div.callout.success", icon("checkCircle"), el("div", "These two versions are structurally identical.")),
          ),
        ],
      }),
      { width: "xwide" },
    );
  }

  function comparePane(title, version, highlight = false) {
    const entry = version.document.screens.find((s) => s.isEntry) ?? version.document.screens[0];
    const frame = el("div", {
      style: {
        position: "relative",
        height: "340px",
        borderRadius: "var(--r-panel)",
        border: `1px solid ${highlight ? "var(--accent-line)" : "var(--line)"}`,
        background: "var(--bg-sunken)",
        overflow: "hidden",
      },
    });
    if (entry) frame.appendChild(renderMiniature(entry, version.theme, { fit: "contain" }));

    return el(
      "div.col",
      { style: { gap: "var(--s-2)" } },
      el("div.row", el("span.eyebrow", title), statusPill(version.status), el("div.spacer"), el("span.dim", { style: { fontSize: "var(--fs-11)" } }, version.label || "—")),
      frame,
    );
  }

  render();
  if (params.create) newDesignDialog();

  return unregister;
}

/* ---------------------------------------------------------------------------
   Structural diff.
   Compares by node id, so a moved node reads as "moved" rather than as a
   delete plus an add. This is what makes the compare view worth reading.
   --------------------------------------------------------------------------- */

export function diffDocuments(before, after) {
  const changes = [];

  const indexOf = (doc) => {
    const map = new Map();
    for (const screen of doc.screens ?? []) {
      walk(screen.root, (node, parent, index) => {
        map.set(node.id, { node, parentId: parent?.id ?? null, index, screen: screen.name });
        return true;
      });
    }
    return map;
  };

  const a = indexOf(before);
  const b = indexOf(after);

  const nameOf = (node) => node.name || getDef(node.type)?.label || node.type;

  for (const [id, entry] of b) {
    if (!a.has(id)) {
      changes.push({ kind: "added", label: nameOf(entry.node), where: entry.screen });
      continue;
    }

    const old = a.get(id);
    if (old.parentId !== entry.parentId || old.index !== entry.index) {
      changes.push({ kind: "moved", label: nameOf(entry.node), where: entry.screen });
    }
    if (JSON.stringify(old.node.props) !== JSON.stringify(entry.node.props)) {
      const keys = changedKeys(old.node.props, entry.node.props);
      changes.push({ kind: "restyled", label: `${nameOf(entry.node)} · ${keys.slice(0, 3).join(", ")}${keys.length > 3 ? ` +${keys.length - 3}` : ""}`, where: entry.screen });
    }
  }

  for (const [id, entry] of a) {
    if (!b.has(id)) changes.push({ kind: "removed", label: nameOf(entry.node), where: entry.screen });
  }

  const order = { added: 0, removed: 1, moved: 2, restyled: 3 };
  return changes.sort((x, y) => order[x.kind] - order[y.kind]);
}

function changedKeys(before = {}, after = {}) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
}
