/**
 * Assignments — bind a design version to an audience.
 *
 * The tab's job is to make the current state unmistakable: a matrix of who
 * gets what, a rule list with priorities, conflict detection, and a resolution
 * preview before anything is saved.
 */

import { el, mount as mountTo } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { fmt, hueOf, downloadFile, toCsv } from "../core/util.js";
import {
  segmented,
  emptyState,
  statusPill,
  pill,
  avatar,
  menu,
  modal,
  confirm,
  toast,
  switchControl,
  searchField,
  metaRow,
} from "../core/ui.js";
import { registerCommands } from "../core/shell.js";

export function mount(host, { db, go, setCrumbs, params }) {
  setCrumbs([{ label: "Assignments" }]);

  let view = "matrix";

  const body = el("div.page-scroll");
  const toolbar = el("div.toolbar");
  host.appendChild(el("div.page", toolbar, body));

  const unregister = registerCommands([
    { id: "asg.new", label: "New assignment", glyph: "plus", group: "Assignments", run: () => openCreate() },
    { id: "asg.conflicts", label: "Check assignment conflicts", glyph: "alert", group: "Assignments", run: () => { view = "list"; render(); } },
  ]);

  mountTo(
    toolbar,
    segmented(
      [
        { value: "matrix", label: "Matrix", icon: "grid" },
        { value: "list", label: "Rules", icon: "list" },
      ],
      view,
      (value) => {
        view = value;
        render();
      },
    ),
    el("div.spacer"),
    el("button.btn.sm.ghost", { onclick: () => exportCsv() }, icon("download"), "Export"),
    el("button.btn.primary.sm", { onclick: () => openCreate() }, icon("plus"), "New assignment"),
  );

  /* --- Render --------------------------------------------------------------- */

  function render() {
    const conflicts = db.assignments.conflicts().filter((c) => c.samePriority);

    mountTo(
      body,
      el(
        "div.page-head",
        el("div.col", el("h1", "Assignments"), el("div.sub", "Which design version each organisation and user resolves to, and why.")),
        el("div.spacer"),
        summaryStrip(),
      ),
      conflicts.length ? conflictPanel(conflicts) : null,
      view === "matrix" ? matrixPanel() : rulesPanel(),
      resolutionPanel(),
    );
  }

  function summaryStrip() {
    const assignments = db.assignments.list();
    const users = db.users.list({ role: "app_user" });
    const covered = users.filter((u) => db.assignments.resolve(u.id).version).length;

    return el(
      "div.inline-stats",
      el("div.inline-stat", el("b", String(assignments.length)), el("span", "rules")),
      el("div.inline-stat", el("b", String(assignments.filter((a) => a.scope === "user").length)), el("span", "user overrides")),
      el("div.inline-stat", el("b", `${covered}/${users.length}`), el("span", "users resolved")),
    );
  }

  function conflictPanel(conflicts) {
    return el(
      "div.callout.warning",
      icon("alert"),
      el(
        "div",
        { style: { flex: "1 1 auto" } },
        el("b", `${fmt.plural(conflicts.length, "organisation")} has two rules at the same priority.`),
        el(
          "div",
          { style: { marginTop: "3px" } },
          conflicts
            .map((c) => {
              const org = db.orgs.get(c.organization_id);
              return `${org?.name}: ${c.rules.length} rules at priority ${c.winner.priority}`;
            })
            .join(" · "),
        ),
        el("div", { style: { marginTop: "3px" } }, "Resolution falls back to insertion order, which is not something to rely on."),
      ),
      el(
        "button.btn.sm.subtle",
        {
          onclick: () => {
            for (const conflict of conflicts) {
              conflict.rules.forEach((rule, index) => {
                db.assignments.update(rule.id, { priority: rule.priority + (conflict.rules.length - index - 1) });
              });
            }
            toast("Priorities spread out", { tone: "success", detail: "Each rule now has a distinct priority, so the winner is explicit." });
            render();
          },
        },
        "Fix priorities",
      ),
    );
  }

  /* --- Matrix ---------------------------------------------------------------- */

  function matrixPanel() {
    const orgs = db.orgs.list();
    const designs = db.designs.list();
    const assignments = db.assignments.list();

    const head = el(
      "tr",
      el("th", "Organisation"),
      ...designs.map((d) => el("th", el("div.col", { style: { gap: 0 } }, el("span", d.name), el("span.dim", { style: { fontSize: "10px" } }, db.orgs.get(d.organization_id)?.name ?? "Global")))),
    );

    const rows = orgs.map((org) => {
      const overrides = assignments.filter((a) => a.scope === "user" && db.users.get(a.user_id)?.organization_id === org.id);

      return el(
        "tr",
        el(
          "th",
          el(
            "div.row",
            { style: { gap: "var(--s-2)" } },
            el("span.org-mark", { style: { "--hue": hueOf(org.slug) } }, org.name.slice(0, 1)),
            el("span.truncate", org.name),
            org.status === "suspended" && pill("suspended", "danger"),
            overrides.length ? el("span.pill.warning", { "data-tip": `${overrides.length} personal override(s) in this organisation` }, `${overrides.length}`) : null,
          ),
        ),
        ...designs.map((design) => {
          const versions = db.designs.versions(design.id);
          const rule = assignments.find(
            (a) => a.scope === "organization" && a.organization_id === org.id && versions.some((v) => v.id === a.design_version_id),
          );
          const version = rule ? versions.find((v) => v.id === rule.design_version_id) : null;

          return el(
            "td",
            el(
              "button",
              {
                type: "button",
                class: `matrix-cell${rule ? " assigned" : ""}`,
                onclick: (event) => openCellMenu(event.currentTarget, org, design, rule),
              },
              rule ? icon("check", 12) : icon("plus", 12),
              el("span.truncate", version ? `v${version.version_number}` : "—"),
              rule ? el("span", { style: { marginLeft: "auto", fontSize: "10px", opacity: 0.7 } }, `p${rule.priority}`) : null,
            ),
          );
        }),
      );
    });

    return el(
      "section.panel",
      el(
        "div.panel-head",
        el("h2", "Organisation × design"),
        el("div.spacer"),
        el("span.dim", { style: { fontSize: "var(--fs-11)" } }, "Click a cell to assign or change a version"),
      ),
      el("div.matrix", el("table.matrix-table", el("thead", head), el("tbody", ...rows))),
    );
  }

  function openCellMenu(anchor, org, design, existing) {
    const versions = db.designs.versions(design.id);

    menu(
      anchor,
      [
        { label: `${design.name} → ${org.name}`, header: true },
        ...versions.map((version) => ({
          label: `v${version.version_number} — ${version.label ?? fmt.label(version.status)}`,
          icon: version.status === "published" ? "checkCircle" : "edit",
          checked: existing?.design_version_id === version.id,
          disabled: version.status === "draft",
          onSelect: () => {
            if (existing) db.assignments.update(existing.id, { design_version_id: version.id });
            else db.assignments.create({ design_version_id: version.id, scope: "organization", organization_id: org.id, priority: 10 });
            toast(`${org.name} now resolves to v${version.version_number}`, { tone: "success" });
            render();
          },
        })),
        existing && "-",
        existing && {
          label: "Remove this assignment",
          icon: "trash",
          tone: "danger",
          onSelect: () => {
            const removed = { ...existing };
            db.assignments.remove(existing.id);
            render();
            toast("Assignment removed", {
              tone: "info",
              undo: () => {
                db.assignments.create(removed);
                render();
              },
            });
          },
        },
      ].filter(Boolean),
      { minWidth: 260 },
    );
  }

  /* --- Rule list --------------------------------------------------------------- */

  function rulesPanel() {
    const assignments = db.assignments.list().sort((a, b) => b.priority - a.priority);

    if (!assignments.length) {
      return el("section.panel", emptyState("assignments", "No assignment rules", "Every user falls back to their organisation's default published design.", el("button.btn.primary", { onclick: () => openCreate() }, icon("plus"), "New assignment")));
    }

    return el(
      "section.panel",
      el("div.panel-head", el("h2", "Assignment rules"), el("div.spacer"), el("span.dim", { style: { fontSize: "var(--fs-11)" } }, "Higher priority wins")),
      el(
        "div.table-wrap",
        el(
          "table.data",
          el("thead", el("tr", el("th", "Scope"), el("th", "Target"), el("th", "Design version"), el("th.num-cell", "Priority"), el("th", "Window"), el("th", "Created"), el("th.tight", "On"), el("th.tight", ""))),
          el(
            "tbody",
            ...assignments.map((rule) => {
              const version = db.designs.version(rule.design_version_id);
              const design = version ? db.designs.get(version.design_id) : null;
              const target = rule.scope === "user" ? db.users.get(rule.user_id) : db.orgs.get(rule.organization_id);

              return el(
                "tr",
                el("td", pill(rule.scope === "user" ? "User" : "Organisation", rule.scope === "user" ? "warning" : "")),
                el(
                  "td.primary-cell",
                  el(
                    "div.row",
                    { style: { gap: "var(--s-2)" } },
                    rule.scope === "user" ? avatar(target?.full_name ?? "?", { size: "sm", hue: hueOf(target?.id ?? "") }) : icon("org", 13),
                    el("span.truncate", rule.scope === "user" ? target?.full_name ?? "Deleted user" : target?.name ?? "Deleted organisation"),
                  ),
                ),
                el("td", design ? `${design.name} v${version.version_number}` : "Missing version"),
                el("td.num-cell", String(rule.priority)),
                el("td", rule.starts_at || rule.ends_at ? `${rule.starts_at ? fmt.date(rule.starts_at) : "—"} → ${rule.ends_at ? fmt.date(rule.ends_at) : "—"}` : "Always"),
                el("td", fmt.relative(rule.created_at)),
                el(
                  "td.tight",
                  switchControl(rule.enabled !== false, (value) => {
                    db.assignments.update(rule.id, { enabled: value });
                    render();
                  }),
                ),
                el(
                  "td.tight",
                  el(
                    "div.row-actions",
                    el(
                      "button.btn.sm.icon.ghost",
                      {
                        "data-tip": "Remove",
                        onclick: async () => {
                          const ok = await confirm({ title: "Remove this rule?", message: "Affected users fall through to the next matching rule.", confirmLabel: "Remove", tone: "danger" });
                          if (!ok) return;
                          db.assignments.remove(rule.id);
                          render();
                        },
                      },
                      icon("trash"),
                    ),
                  ),
                ),
              );
            }),
          ),
        ),
      ),
    );
  }

  /* --- Resolution snapshot ------------------------------------------------------ */

  function resolutionPanel() {
    const users = db.users.list({ role: "app_user" });
    const byVersion = new Map();

    for (const user of users) {
      const { version } = db.assignments.resolve(user.id);
      const key = version?.id ?? "__fallback";
      if (!byVersion.has(key)) byVersion.set(key, []);
      byVersion.get(key).push(user);
    }

    const rows = [...byVersion.entries()]
      .map(([versionId, list]) => {
        const version = versionId === "__fallback" ? null : db.designs.version(versionId);
        const design = version ? db.designs.get(version.design_id) : null;
        return { version, design, users: list };
      })
      .sort((a, b) => b.users.length - a.users.length);

    const total = users.length || 1;

    return el(
      "section.panel",
      el("div.panel-head", el("h2", "Who sees what, right now"), el("div.spacer"), el("span.dim", { style: { fontSize: "var(--fs-11)" } }, `${users.length} app users`)),
      el(
        "div.panel-body",
        { style: { display: "flex", flexDirection: "column", gap: "var(--s-2)" } },
        ...rows.map((row) =>
          el(
            "div.flow-row",
            { style: { height: "30px" } },
            el("span", { style: { width: "220px", flex: "none", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: "var(--fs-12)" } }, row.design ? `${row.design.name} v${row.version.version_number}` : "Built-in static layout"),
            el("span.bar", el("i", { style: { width: `${(row.users.length / total) * 100}%` } })),
            el("span.count", fmt.number(row.users.length)),
            el(
              "button.btn.sm.ghost",
              { onclick: () => go("paths", { version: row.version?.id ?? "" }) },
              "Inspect",
            ),
          ),
        ),
      ),
    );
  }

  /* --- Create flow ---------------------------------------------------------------- */

  function openCreate() {
    modal(
      (close) => {
        const draft = {
          scope: "organization",
          organization_id: db.orgs.list()[0]?.id ?? null,
          user_id: null,
          design_version_id: null,
          priority: 10,
          starts_at: null,
          ends_at: null,
        };

        const previewBox = el("div.col", { style: { gap: "var(--s-2)" } });
        const targetBox = el("div.field");
        const versionBox = el("div.field");

        function repaintTarget() {
          if (draft.scope === "organization") {
            mountTo(
              targetBox,
              el("label", "Organisation"),
              el(
                "select.select",
                {
                  onchange: (event) => {
                    draft.organization_id = event.target.value;
                    repaintPreview();
                  },
                },
                ...db.orgs.list().map((o) => el("option", { value: o.id, selected: o.id === draft.organization_id }, o.name)),
              ),
            );
          } else {
            const search = searchField("Search users by name or email", (value) => {
              paintUserList(value);
            });
            const list = el("div.source-tree", { style: { maxHeight: "170px" } });

            const paintUserList = (q = "") => {
              const users = db.users.list({ q, role: "app_user" }).slice(0, 40);
              mountTo(
                list,
                ...users.map((user) =>
                  el(
                    "button.source-field",
                    {
                      style: { fontFamily: "var(--font-sans)", fontSize: "var(--fs-12)", height: "26px" },
                      class: draft.user_id === user.id ? "source-field" : "source-field",
                      onclick: () => {
                        draft.user_id = user.id;
                        draft.organization_id = user.organization_id;
                        paintUserList(q);
                        repaintPreview();
                      },
                    },
                    draft.user_id === user.id ? icon("check", 12) : avatar(user.full_name, { size: "sm", hue: hueOf(user.id) }),
                    el("span.truncate", user.full_name),
                    el("span.value", db.orgs.get(user.organization_id)?.name ?? ""),
                  ),
                ),
              );
            };
            paintUserList();

            mountTo(targetBox, el("label", "User"), search, list);
          }
          repaintVersions();
        }

        function repaintVersions() {
          const designs = db.designs.list().filter((d) => !draft.organization_id || d.organization_id === draft.organization_id || !d.organization_id);
          const options = [];
          for (const design of designs) {
            for (const version of db.designs.versions(design.id)) {
              if (version.status === "draft") continue;
              options.push({ value: version.id, label: `${design.name} — v${version.version_number} (${version.label ?? version.status})` });
            }
          }
          if (!options.length) {
            mountTo(versionBox, el("label", "Design version"), el("div.callout.warning", icon("alert"), el("div", "No published version exists for this organisation yet. Publish one first.")));
            draft.design_version_id = null;
            return;
          }
          draft.design_version_id = draft.design_version_id && options.some((o) => o.value === draft.design_version_id) ? draft.design_version_id : options[0].value;
          mountTo(
            versionBox,
            el("label", "Design version"),
            el(
              "select.select",
              {
                onchange: (event) => {
                  draft.design_version_id = event.target.value;
                  repaintPreview();
                },
              },
              ...options.map((o) => el("option", { value: o.value, selected: o.value === draft.design_version_id }, o.label)),
            ),
          );
          repaintPreview();
        }

        function repaintPreview() {
          if (!draft.design_version_id || (draft.scope === "user" && !draft.user_id)) {
            mountTo(previewBox, el("div.callout", icon("info"), el("div", draft.scope === "user" ? "Pick a user to see the impact." : "Pick a design version to see the impact.")));
            return;
          }

          const impact = db.assignments.previewImpact({ ...draft, enabled: true });
          const changed = impact.changed;
          const overrides = db.assignments.list().filter((a) => a.scope === "user" && a.enabled);

          mountTo(
            previewBox,
            el("span.eyebrow", "Resolution preview"),
            el(
              "div.callout.accent",
              icon("users"),
              el(
                "div",
                el("b", changed.length ? `${fmt.plural(changed.length, "user")} will see a different design after this change.` : "No user's resolved design changes."),
                draft.scope === "organization" && overrides.length
                  ? el("div", { style: { marginTop: "3px" } }, `${fmt.plural(overrides.length, "user")} keep a personal override and are unaffected.`)
                  : null,
              ),
            ),
            changed.length
              ? el(
                  "div",
                  { style: { maxHeight: "150px", overflow: "auto", border: "1px solid var(--line)", borderRadius: "var(--r-control)" } },
                  ...changed.slice(0, 30).map((entry) => {
                    const beforeVersion = entry.before ? db.designs.version(entry.before) : null;
                    const afterVersion = entry.after ? db.designs.version(entry.after) : null;
                    return el(
                      "div.row",
                      { style: { gap: "var(--s-2)", padding: "4px var(--s-2)", fontSize: "var(--fs-11)", borderBottom: "1px solid var(--line-faint)" } },
                      avatar(entry.user.full_name, { size: "sm", hue: hueOf(entry.user.id) }),
                      el("span.truncate", { style: { flex: "1 1 auto" } }, entry.user.full_name),
                      el("span.dim", beforeVersion ? `v${beforeVersion.version_number}` : "fallback"),
                      icon("arrowRight", 11),
                      el("span", { style: { color: "var(--accent)" } }, afterVersion ? `v${afterVersion.version_number}` : "fallback"),
                    );
                  }),
                  changed.length > 30 && el("div", { style: { padding: "4px var(--s-2)", fontSize: "var(--fs-11)", color: "var(--text-tertiary)" } }, `and ${changed.length - 30} more`),
                )
              : null,
          );
        }

        repaintTarget();

        return {
          title: "New assignment",
          subtitle: "Bind a published design version to an organisation or a single user.",
          body: [
            el(
              "div.field",
              el("label", "Scope"),
              segmented(
                [
                  { value: "organization", label: "Organisation", icon: "org" },
                  { value: "user", label: "Single user", icon: "user" },
                ],
                draft.scope,
                (value) => {
                  draft.scope = value;
                  draft.priority = value === "user" ? 90 : 10;
                  priorityInput.value = draft.priority;
                  repaintTarget();
                },
                { block: true },
              ),
            ),
            targetBox,
            versionBox,
            el(
              "div.field-grid-2",
              el(
                "div.field",
                el("label", "Priority"),
                (function () {
                  const input = el("input.input", {
                    type: "number",
                    value: draft.priority,
                    oninput: (event) => {
                      draft.priority = Number(event.target.value) || 0;
                      repaintPreview();
                    },
                  });
                  priorityInput = input;
                  return input;
                })(),
                el("span.hint", "Higher wins. User overrides usually sit at 90."),
              ),
              el(
                "div.field",
                el("label", "Active window (optional)"),
                el(
                  "div.field-grid-2",
                  el("input.input", { type: "date", onchange: (e) => { draft.starts_at = e.target.value || null; repaintPreview(); } }),
                  el("input.input", { type: "date", onchange: (e) => { draft.ends_at = e.target.value || null; repaintPreview(); } }),
                ),
              ),
            ),
            previewBox,
          ],
          footer: [
            el("div.spacer"),
            el("button.btn.subtle", { onclick: () => close() }, "Cancel"),
            el(
              "button.btn.primary",
              {
                onclick: () => {
                  if (!draft.design_version_id) return toast("Pick a design version", { tone: "warning" });
                  if (draft.scope === "user" && !draft.user_id) return toast("Pick a user", { tone: "warning" });
                  db.assignments.create(draft);
                  close();
                  toast("Assignment created", { tone: "success", detail: "Takes effect on the next app fetch." });
                  render();
                },
              },
              "Create assignment",
            ),
          ],
        };
      },
      { width: "wide" },
    );
  }

  let priorityInput;

  /* --- Export -------------------------------------------------------------------- */

  function exportCsv() {
    const users = db.users.list({ role: "app_user" });
    const rows = users.map((user) => {
      const { version, rule, trace } = db.assignments.resolve(user.id);
      const design = version ? db.designs.get(version.design_id) : null;
      return {
        name: user.full_name,
        email: user.email,
        organization: db.orgs.get(user.organization_id)?.name ?? "",
        design: design?.name ?? "Built-in static layout",
        version: version ? `v${version.version_number}` : "",
        rule: rule ? `${rule.scope} priority ${rule.priority}` : "default",
        why: trace.find((t) => t.hit)?.step ?? "",
      };
    });

    downloadFile(
      `assignments-${new Date().toISOString().slice(0, 10)}.csv`,
      toCsv(
        [
          { key: "name", label: "Name" },
          { key: "email", label: "Email" },
          { key: "organization", label: "Organisation" },
          { key: "design", label: "Design" },
          { key: "version", label: "Version" },
          { key: "rule", label: "Winning rule" },
          { key: "why", label: "Resolved by" },
        ],
        rows,
      ),
    );
    toast(`Exported ${fmt.plural(rows.length, "row")}`, { tone: "success" });
  }

  render();
  if (params.create) openCreate();

  return unregister;
}
