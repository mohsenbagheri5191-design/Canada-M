/**
 * Features — compose features, toggle them per client, configure settings.
 *
 * The tab is honest about a boundary the brief insists on: a composed feature
 * can be assembled here end to end, a code feature cannot. The builder shows a
 * live "buildable here" checklist and, where something is missing, produces a
 * copyable developer request rather than a dead end.
 */

import { el, mount as mountTo } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { fmt, slug, hueOf } from "../core/util.js";
import {
  emptyState,
  statusPill,
  pill,
  switchControl,
  menu,
  modal,
  confirm,
  toast,
  drawer,
  segmented,
  searchField,
  metaRow,
  numberField,
  fieldRow,
  section,
} from "../core/ui.js";
import { registerCommands } from "../core/shell.js";

export function mount(host, { db, go, setCrumbs, params, app }) {
  setCrumbs([{ label: "Features" }]);

  let view = "matrix";

  const body = el("div.page-scroll");
  const toolbar = el("div.toolbar");
  host.appendChild(el("div.page", toolbar, body));

  const unregister = registerCommands([
    { id: "ftr.new", label: "New feature", glyph: "plus", group: "Features", run: () => openBuilder() },
    { id: "ftr.settings", label: "Organisation settings", glyph: "settings", group: "Features", run: () => openOrgSettings() },
  ]);

  mountTo(
    toolbar,
    segmented(
      [
        { value: "matrix", label: "Toggle matrix", icon: "grid" },
        { value: "catalogue", label: "Catalogue", icon: "package" },
      ],
      view,
      (value) => {
        view = value;
        render();
      },
    ),
    el("div.spacer"),
    el("button.btn.sm.ghost", { onclick: () => openOrgSettings() }, icon("settings"), "Organisation settings"),
    el("button.btn.primary.sm", { onclick: () => openBuilder() }, icon("plus"), "New feature"),
  );

  /* --- Render --------------------------------------------------------------- */

  function render() {
    const features = db.features.list();
    const assignments = db.features.assignments();

    mountTo(
      body,
      el(
        "div.page-head",
        el("div.col", el("h1", "Features"), el("div.sub", "A feature bundles screens, routes, a collection, permissions, a nav entry and settings, switched on per client.")),
        el("div.spacer"),
        el(
          "div.inline-stats",
          el("div.inline-stat", el("b", String(features.length)), el("span", "features")),
          el("div.inline-stat", el("b", String(features.filter((f) => f.origin === "composed").length)), el("span", "composed here")),
          el("div.inline-stat", el("b", String(assignments.filter((a) => a.enabled).length)), el("span", "enabled pairs")),
        ),
      ),
      view === "matrix" ? matrixPanel() : cataloguePanel(),
    );
  }

  /* --- Toggle matrix ---------------------------------------------------------- */

  function matrixPanel() {
    const orgs = db.orgs.list();
    const features = db.features.list();

    return el(
      "section.panel",
      el(
        "div.panel-head",
        el("h2", "Organisation × feature"),
        el("div.spacer"),
        el("span.dim", { style: { fontSize: "var(--fs-11)" } }, "Every toggle writes to the audit log and takes effect on the next app fetch"),
      ),
      el(
        "div.matrix",
        el(
          "table.matrix-table",
          el(
            "thead",
            el(
              "tr",
              el("th", "Organisation"),
              ...features.map((feature) =>
                el(
                  "th",
                  el(
                    "div.row",
                    { style: { gap: "5px" } },
                    icon(feature.icon ?? "box", 12),
                    el("span.truncate", feature.name),
                    feature.origin === "code" ? pill("code", "info") : null,
                    feature.status === "draft" ? pill("draft", "warning") : null,
                  ),
                ),
              ),
            ),
          ),
          el(
            "tbody",
            ...orgs.map((org) =>
              el(
                "tr",
                el(
                  "th",
                  el(
                    "div.row",
                    { style: { gap: "var(--s-2)" } },
                    el("span.org-mark", { style: { "--hue": hueOf(org.slug) } }, org.name.slice(0, 1)),
                    el("span.truncate", org.name),
                    el(
                      "button.btn.sm.icon.ghost",
                      { "data-tip": "Organisation settings", onclick: () => openOrgSettings(org.id) },
                      icon("settings"),
                    ),
                  ),
                ),
                ...features.map((feature) => {
                  const assignment = db.features.assignment(feature.id, org.id);
                  const disabled = feature.status !== "published";

                  return el(
                    "td",
                    el(
                      "div.toggle-cell",
                      el(
                        "div.row",
                        { style: { gap: "5px" } },
                        switchControl(
                          Boolean(assignment?.enabled),
                          (value) => toggleFeature(feature, org, value),
                          { disabled },
                        ),
                        assignment?.enabled && Object.keys(feature.settings_schema ?? {}).length
                          ? el(
                              "button.btn.sm.icon.ghost",
                              {
                                "data-tip": "Per-organisation settings",
                                onclick: () => openFeatureSettings(feature, org),
                              },
                              icon("slidersH"),
                            )
                          : null,
                      ),
                    ),
                  );
                }),
              ),
            ),
          ),
        ),
      ),
    );
  }

  async function toggleFeature(feature, org, next) {
    if (next) {
      const missing = db.features.missingDependencies(feature.id, org.id);
      if (missing.length) {
        const ok = await confirm({
          title: `${feature.name} depends on ${missing.map((m) => m.name).join(" and ")}`,
          message: `Turning it on without ${missing.length === 1 ? "that" : "those"} would leave screens that cannot load their data. Enable ${missing.length === 1 ? "it" : "them"} too?`,
          confirmLabel: "Enable all",
        });
        if (!ok) {
          render();
          return;
        }
        for (const dep of missing) db.features.toggle(dep.id, org.id, true);
      }

      const impact = enableImpact(feature, org);
      db.features.toggle(feature.id, org.id, true);
      render();
      toast(`${feature.name} enabled for ${org.name}`, {
        tone: "success",
        detail: `${fmt.plural(impact.users, "user")} affected · ${fmt.plural(impact.screens, "screen")} become reachable`,
        undo: () => {
          db.features.toggle(feature.id, org.id, false);
          render();
        },
      });
      return;
    }

    const dependants = db.features.dependants(feature.id, org.id);
    if (dependants.length) {
      render();
      toast(`Cannot disable ${feature.name}`, {
        tone: "danger",
        detail: `${dependants.map((d) => d.name).join(", ")} ${dependants.length === 1 ? "depends" : "depend"} on it and ${dependants.length === 1 ? "is" : "are"} still on for ${org.name}.`,
        duration: 6000,
      });
      return;
    }

    const impact = enableImpact(feature, org);
    db.features.toggle(feature.id, org.id, false);
    render();
    toast(`${feature.name} disabled for ${org.name}`, {
      tone: "info",
      detail: `${fmt.plural(impact.screens, "screen")} and any nav entry pointing at them are stripped from that organisation's layout response.`,
      undo: () => {
        db.features.toggle(feature.id, org.id, true);
        render();
      },
    });
  }

  function enableImpact(feature, org) {
    const users = db.users.list({ org: org.id, role: "app_user" }).length;
    const screens = feature.manifest?.screens?.length ?? 0;
    const routes = feature.manifest?.routes?.length ?? 0;
    const collections = feature.manifest?.collections?.length ?? 0;
    return { users, screens, routes, collections };
  }

  /* --- Catalogue -------------------------------------------------------------- */

  function cataloguePanel() {
    const features = db.features.list();

    if (!features.length) {
      return emptyState("features", "No features yet", "Bundle screens, data and navigation into something you can switch on per client.", el("button.btn.primary", { onclick: () => openBuilder() }, icon("plus"), "New feature"));
    }

    return el(
      "div.grid-3.stagger",
      ...features.map((feature, i) => {
        const enabledCount = db.features.assignments().filter((a) => a.feature_id === feature.id && a.enabled).length;

        const card = el(
          "article.card.feature-card",
          el(
            "div.head",
            el(`span.feature-mark${feature.origin === "code" ? ".code" : ""}`, icon(feature.icon ?? "box")),
            el(
              "div.col",
              { style: { minWidth: 0, flex: "1 1 auto", gap: "2px" } },
              el("div.row", { style: { gap: "var(--s-2)" } }, el("b.truncate", feature.name), statusPill(feature.status)),
              el("span.dim", { style: { fontSize: "var(--fs-11)" } }, `${feature.origin === "code" ? "Code feature" : "Composed here"} · v${feature.manifest?.version ?? 1}`),
            ),
            el(
              "button.btn.sm.icon.ghost",
              { onclick: (event) => openFeatureMenu(event.currentTarget, feature) },
              icon("more"),
            ),
          ),
          el("p.prose", { style: { fontSize: "var(--fs-12)", margin: 0 } }, feature.description),
          el(
            "div.row",
            { style: { gap: "5px", flexWrap: "wrap" } },
            pill(`${feature.manifest?.screens?.length ?? 0} screens`, "", "device"),
            pill(`${feature.manifest?.collections?.length ?? 0} collections`, "", "appdata"),
            pill(`${Object.keys(feature.settings_schema ?? {}).length} settings`, "", "slidersH"),
          ),
          feature.depends_on?.length
            ? el("div.row", { style: { gap: "5px", fontSize: "var(--fs-11)", color: "var(--text-tertiary)" } }, icon("link", 11), `Depends on ${feature.depends_on.join(", ")}`)
            : null,
          el(
            "div.row",
            { style: { gap: "var(--s-2)", paddingTop: "var(--s-2)", borderTop: "1px solid var(--line-faint)" } },
            el("span.dim", { style: { fontSize: "var(--fs-11)" } }, `On for ${enabledCount} of ${db.orgs.list().length}`),
            el("div.spacer"),
            el("button.btn.sm.ghost", { onclick: () => openFeatureDrawer(feature) }, "Open"),
          ),
        );
        card.style.setProperty("--i", i);
        return card;
      }),
    );
  }

  function openFeatureMenu(anchor, feature) {
    menu(
      anchor,
      [
        { label: "Open", icon: "expand", onSelect: () => openFeatureDrawer(feature) },
        { label: "Edit", icon: "edit", disabled: feature.origin === "code", onSelect: () => openBuilder(feature) },
        {
          label: feature.status === "published" ? "Published" : "Publish",
          icon: "publish",
          disabled: feature.status === "published",
          onSelect: () => {
            db.features.publish(feature.id);
            toast(`${feature.name} published`, { tone: "success", detail: "It can now be switched on per organisation." });
            render();
          },
        },
        "-",
        {
          label: "Copy manifest",
          icon: "json",
          onSelect: () => {
            navigator.clipboard?.writeText(JSON.stringify(feature.manifest, null, 2));
            toast("Manifest copied", { tone: "success", duration: 1600 });
          },
        },
      ],
      { minWidth: 190 },
    );
  }

  function openFeatureDrawer(feature) {
    const orgs = db.orgs.list();

    drawer(
      (close) => ({
        leading: el(`span.feature-mark${feature.origin === "code" ? ".code" : ""}`, icon(feature.icon ?? "box")),
        title: feature.name,
        subtitle: `${feature.origin === "code" ? "Code feature — declared in the repository" : "Composed in the dashboard"} · v${feature.manifest?.version ?? 1}`,
        actions: statusPill(feature.status),
        body: [
          el("p.prose", feature.description),
          el(
            "section.col",
            { style: { gap: "var(--s-2)" } },
            el("span.eyebrow", "Manifest"),
            el("div.code", JSON.stringify(feature.manifest, null, 2)),
          ),
          el(
            "section.col",
            { style: { gap: "var(--s-2)" } },
            el("span.eyebrow", "Per-organisation state"),
            el(
              "div.panel",
              ...orgs.map((org) => {
                const assignment = db.features.assignment(feature.id, org.id);
                return el(
                  "div.row",
                  { style: { gap: "var(--s-2)", padding: "var(--s-2) var(--s-3)", borderBottom: "1px solid var(--line-faint)" } },
                  el("span.org-mark", { style: { "--hue": hueOf(org.slug) } }, org.name.slice(0, 1)),
                  el("span.truncate", { style: { flex: "1 1 auto", fontSize: "var(--fs-12)" } }, org.name),
                  assignment?.enabled && Object.keys(feature.settings_schema ?? {}).length
                    ? el("button.btn.sm.ghost", { onclick: () => { close(); openFeatureSettings(feature, org); } }, icon("slidersH"), "Settings")
                    : null,
                  switchControl(Boolean(assignment?.enabled), (value) => toggleFeature(feature, org, value), { disabled: feature.status !== "published" }),
                );
              }),
            ),
          ),
        ],
        footer: [
          el("div.spacer"),
          el("button.btn.subtle", { onclick: () => close() }, "Close"),
          feature.origin === "composed" && el("button.btn.primary", { onclick: () => { close(); openBuilder(feature); } }, "Edit feature"),
        ],
      }),
      { width: "wide" },
    );
  }

  /* --- Per-organisation feature settings --------------------------------------- */

  function openFeatureSettings(feature, org) {
    const assignment = db.features.assignment(feature.id, org.id);
    const working = { ...(assignment?.settings ?? {}) };

    modal((close) => ({
      title: `${feature.name} settings`,
      subtitle: `${org.name} only. This form is generated from the feature's settings schema, so adding a setting never needs new dashboard code.`,
      body: Object.entries(feature.settings_schema ?? {}).map(([key, spec]) => {
        const label = spec.label ?? fmt.label(key);

        if (spec.type === "boolean") {
          return el("div.field", el("label", label), el("div.row", switchControl(Boolean(working[key]), (v) => (working[key] = v))));
        }
        if (spec.type === "select") {
          return el(
            "div.field",
            el("label", label),
            el("select.select", { onchange: (e) => (working[key] = e.target.value) }, ...(spec.options ?? []).map((o) => el("option", { value: o, selected: o === working[key] }, fmt.label(o)))),
          );
        }
        if (spec.type === "number") {
          return el("div.field", el("label", label), numberField(working[key] ?? spec.default, (v) => (working[key] = v), { min: spec.min ?? 0, max: spec.max ?? 100000, tagIcon: "hash" }), spec.min !== undefined && el("span.hint", `Between ${spec.min} and ${spec.max ?? "∞"}`));
        }
        return el("div.field", el("label", label), el("input.input", { value: working[key] ?? spec.default ?? "", oninput: (e) => (working[key] = e.target.value) }));
      }),
      footer: [
        el("div.spacer"),
        el("button.btn.subtle", { onclick: () => close() }, "Cancel"),
        el(
          "button.btn.primary",
          {
            onclick: () => {
              db.features.updateSettings(feature.id, org.id, working);
              close();
              toast("Settings saved", { tone: "success", detail: "Applied on the organisation's next layout fetch." });
              render();
            },
          },
          "Save settings",
        ),
      ],
    }));
  }

  /* --- Organisation settings ------------------------------------------------------ */

  function openOrgSettings(orgId = app.get("org")) {
    const org = db.orgs.get(orgId);
    if (!org) return;
    const working = { ...db.orgs.settings(orgId) };
    let secret = "";

    modal(
      (close) => ({
        title: `${org.name} settings`,
        subtitle: "App identity, contact details, locale, quotas and integration credentials.",
        body: [
          section(
            "Identity",
            el(
              "div.col",
              { style: { gap: "var(--s-2)" } },
              fieldRow("App name", el("input.input", { value: working.appName ?? "", oninput: (e) => (working.appName = e.target.value) })),
              fieldRow(
                "Default theme",
                el(
                  "select.select",
                  { onchange: (e) => (working.defaultTheme = e.target.value) },
                  ...["field-light", "night-ops", "maple", "slate", "high-contrast", "midnight"].map((t) => el("option", { value: t, selected: t === working.defaultTheme }, fmt.label(t))),
                ),
              ),
            ),
            { open: true },
          ),
          section(
            "Contact and legal",
            el(
              "div.col",
              { style: { gap: "var(--s-2)" } },
              fieldRow("Support email", el("input.input", { value: working.supportEmail ?? "", oninput: (e) => (working.supportEmail = e.target.value) })),
              fieldRow("Support phone", el("input.input", { value: working.supportPhone ?? "", oninput: (e) => (working.supportPhone = e.target.value) })),
              fieldRow("Terms URL", el("input.input", { value: working.legalUrl ?? "", oninput: (e) => (working.legalUrl = e.target.value) })),
              fieldRow("Privacy URL", el("input.input", { value: working.privacyUrl ?? "", oninput: (e) => (working.privacyUrl = e.target.value) })),
            ),
            { open: true },
          ),
          section(
            "Locale and limits",
            el(
              "div.col",
              { style: { gap: "var(--s-2)" } },
              fieldRow("Locale", el("input.input", { value: working.locale ?? "", oninput: (e) => (working.locale = e.target.value) })),
              fieldRow("Timezone", el("input.input", { value: working.timezone ?? "", oninput: (e) => (working.timezone = e.target.value) })),
              fieldRow("Max users", numberField(working.maxUsers ?? 25, (v) => (working.maxUsers = v), { min: 1, max: 10000, tagIcon: "users" })),
              fieldRow("Max records", numberField(working.maxRecords ?? 20000, (v) => (working.maxRecords = v), { min: 100, max: 5000000, tagIcon: "appdata" })),
            ),
          ),
          section(
            "Notifications",
            el(
              "div.col",
              { style: { gap: "var(--s-2)" } },
              fieldRow("Push", el("div.row", switchControl(Boolean(working.notifyPush), (v) => (working.notifyPush = v)))),
              fieldRow("Email", el("div.row", switchControl(Boolean(working.notifyEmail), (v) => (working.notifyEmail = v)))),
              fieldRow("SMS", el("div.row", switchControl(Boolean(working.notifySms), (v) => (working.notifySms = v)))),
            ),
          ),
          section(
            "Integration credentials",
            el(
              "div.col",
              { style: { gap: "var(--s-2)" } },
              el("div.callout.warning", icon("shield"), el("div", el("b", "Write-only."), " Credentials are encrypted at rest and never returned by any API response, including this one. Leave blank to keep the existing value.")),
              fieldRow("API secret", el("input.input", { type: "password", placeholder: "••••••••••••", oninput: (e) => (secret = e.target.value) })),
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
                db.orgs.updateSettings(orgId, working);
                if (secret) db.audit("org.secret", "Organisation", `rotated an integration credential for ${org.name}`, { entityId: orgId });
                close();
                toast("Settings saved", { tone: "success", detail: secret ? "Credential stored write-only." : null });
              },
            },
            "Save settings",
          ),
        ],
      }),
      { width: "wide" },
    );
  }

  /* --- Feature builder -------------------------------------------------------------- */

  function openBuilder(existing = null) {
    modal(
      (close) => {
        let step = 0;
        const draft = {
          name: existing?.name ?? "",
          key: existing?.key ?? "",
          icon: existing?.icon ?? "package",
          description: existing?.description ?? "",
          screens: [...(existing?.manifest?.screens ?? [])],
          collections: [...(existing?.manifest?.collections ?? [])],
          navigation: [...(existing?.manifest?.navigation ?? [])],
          permissions: existing?.manifest?.permissions ?? { view: ["app_user"], manage: ["org_admin"] },
          settings_schema: { ...(existing?.settings_schema ?? {}) },
          depends_on: [...(existing?.depends_on ?? [])],
        };

        const STEPS = ["Identity", "Screens", "Data", "Navigation", "Permissions", "Settings", "Dependencies", "Review"];
        const stepBox = el("div.col", { style: { gap: "var(--s-3)", minHeight: "300px" } });
        const footerBox = el("div.row", { style: { width: "100%", gap: "var(--s-2)" } });

        const allScreens = db.designs.list().flatMap((design) =>
          db.designs.versions(design.id).flatMap((version) =>
            (version.document?.screens ?? []).map((screen) => ({
              id: screen.id,
              label: `${design.name} · ${screen.name}`,
              route: screen.route,
            })),
          ),
        );

        function paint() {
          mountTo(
            stepBox,
            el(
              "div.tabstrip",
              { style: { marginBottom: "var(--s-2)" } },
              ...STEPS.map((name, i) =>
                el(
                  "button",
                  { type: "button", "aria-selected": String(i === step), onclick: () => { step = i; paint(); } },
                  el("span", `${i + 1}. ${name}`),
                ),
              ),
            ),
            stepContent(),
          );

          mountTo(
            footerBox,
            buildableChecklist(),
            el("div.spacer"),
            step > 0 && el("button.btn.subtle", { onclick: () => { step -= 1; paint(); } }, icon("chevronLeft"), "Back"),
            step < STEPS.length - 1
              ? el("button.btn.primary", { onclick: () => { step += 1; paint(); } }, "Next", icon("chevronRight"))
              : el(
                  "button.btn.primary",
                  {
                    onclick: () => {
                      if (!draft.name.trim()) return toast("Name the feature", { tone: "warning" });
                      const manifest = {
                        key: draft.key || slug(draft.name),
                        version: (existing?.manifest?.version ?? 0) + 1,
                        screens: draft.screens,
                        routes: draft.screens.map((id) => ({ path: allScreens.find((s) => s.id === id)?.route ?? "/", screen: id })),
                        collections: draft.collections,
                        navigation: draft.navigation,
                        permissions: draft.permissions,
                        dependsOn: draft.depends_on,
                        settingsSchema: draft.settings_schema,
                      };

                      if (existing) db.features.update(existing.id, { ...draft, manifest, settings_schema: draft.settings_schema });
                      else db.features.create({ ...draft, manifest });

                      close();
                      toast(existing ? "Feature saved as a draft" : `${draft.name} created as a draft`, {
                        tone: "success",
                        detail: "Publish it to make it toggleable per organisation.",
                      });
                      render();
                    },
                  },
                  existing ? "Save draft" : "Create feature",
                ),
          );
        }

        function stepContent() {
          switch (step) {
            case 0:
              return el(
                "div.col",
                { style: { gap: "var(--s-3)" } },
                el("div.field", el("label", "Name"), el("input.input", { value: draft.name, placeholder: "Inspections", oninput: (e) => { draft.name = e.target.value; draft.key = slug(e.target.value); } })),
                el("div.field", el("label", "Description"), el("textarea.textarea", { rows: 2, value: draft.description, oninput: (e) => (draft.description = e.target.value) })),
                el(
                  "div.field",
                  el("label", "Icon"),
                  el(
                    "div.preset-row",
                    ...["package", "gift", "calendarClock", "shield", "dollar", "star", "mapPin", "bell", "file", "zap", "target", "cloud"].map((name) =>
                      el(
                        "button",
                        {
                          type: "button",
                          class: `preset-chip${draft.icon === name ? " active" : ""}`,
                          onclick: () => {
                            draft.icon = name;
                            paint();
                          },
                        },
                        icon(name, 13),
                      ),
                    ),
                  ),
                ),
              );

            case 1:
              return el(
                "div.col",
                { style: { gap: "var(--s-2)" } },
                el("span.hint", "Pick screens already built in the Design Studio, or create a new one there and come back."),
                el(
                  "div.source-tree",
                  { style: { maxHeight: "240px" } },
                  ...allScreens.map((screen) =>
                    el(
                      "button.source-field",
                      {
                        style: { fontFamily: "var(--font-sans)", fontSize: "var(--fs-12)", height: "28px" },
                        onclick: () => {
                          draft.screens = draft.screens.includes(screen.id) ? draft.screens.filter((s) => s !== screen.id) : [...draft.screens, screen.id];
                          paint();
                        },
                      },
                      icon(draft.screens.includes(screen.id) ? "checkCircle" : "device", 12),
                      el("span.truncate", screen.label),
                      el("span.value", screen.route),
                    ),
                  ),
                ),
                el("button.btn.subtle.sm", { style: { width: "fit-content" }, onclick: () => { close(); go("studio"); } }, icon("studio"), "Open the Design Studio"),
              );

            case 2:
              return el(
                "div.col",
                { style: { gap: "var(--s-2)" } },
                el("span.hint", "Collections this feature reads and writes. They become bindable sources on its screens."),
                el(
                  "div.source-tree",
                  ...db.entities.list().map((collection) =>
                    el(
                      "button.source-field",
                      {
                        style: { fontFamily: "var(--font-sans)", fontSize: "var(--fs-12)", height: "28px" },
                        onclick: () => {
                          draft.collections = draft.collections.includes(collection.key) ? draft.collections.filter((c) => c !== collection.key) : [...draft.collections, collection.key];
                          paint();
                        },
                      },
                      icon(draft.collections.includes(collection.key) ? "checkCircle" : collection.origin === "native" ? "db" : "package", 12),
                      el("span.truncate", collection.name),
                      el("span.value", collection.key),
                    ),
                  ),
                ),
                el("button.btn.subtle.sm", { style: { width: "fit-content" }, onclick: () => { close(); go("appdata", { create: "1" }); } }, icon("plus"), "Create a collection"),
              );

            case 3:
              return el(
                "div.col",
                { style: { gap: "var(--s-3)" } },
                el("span.hint", "Where this feature appears in the app's navigation."),
                ...draft.navigation.map((entry, index) =>
                  el(
                    "div.action-card",
                    el("div.action-card-head", icon("nav", 12), el("span.spacer", `Entry ${index + 1}`), el("button.btn.sm.icon.ghost", { onclick: () => { draft.navigation.splice(index, 1); paint(); } }, icon("close"))),
                    el(
                      "div.action-card-body",
                      fieldRow("Label", el("input.input", { value: entry.label ?? "", oninput: (e) => (entry.label = e.target.value) })),
                      fieldRow("Route", el("input.input", { value: entry.route ?? "", oninput: (e) => (entry.route = e.target.value) })),
                      fieldRow("Position", numberField(entry.position ?? 1, (v) => (entry.position = v), { min: 1, max: 8, tagIcon: "hash" })),
                    ),
                  ),
                ),
                el("button.btn.subtle.sm", { style: { width: "fit-content" }, onclick: () => { draft.navigation.push({ label: draft.name, icon: draft.icon, route: `/${draft.key || "feature"}`, position: draft.navigation.length + 1 }); paint(); } }, icon("plus"), "Add a nav entry"),
              );

            case 4:
              return el(
                "div.col",
                { style: { gap: "var(--s-3)" } },
                el("span.hint", "Enforced on the server on every endpoint. Client-side checks only hide buttons."),
                ...["view", "manage"].map((action) =>
                  el(
                    "div.field",
                    el("label", action === "view" ? "Who can see it" : "Who can manage it"),
                    el(
                      "div.preset-row",
                      ...["app_user", "designer", "viewer", "org_admin", "super_admin"].map((role) =>
                        el(
                          "button",
                          {
                            type: "button",
                            class: `preset-chip${draft.permissions[action]?.includes(role) ? " active" : ""}`,
                            onclick: () => {
                              const list = draft.permissions[action] ?? [];
                              draft.permissions[action] = list.includes(role) ? list.filter((r) => r !== role) : [...list, role];
                              paint();
                            },
                          },
                          fmt.label(role),
                        ),
                      ),
                    ),
                  ),
                ),
              );

            case 5:
              return el(
                "div.col",
                { style: { gap: "var(--s-2)" } },
                el("span.hint", "Options each client can configure. These render automatically as a form on the toggle screen."),
                ...Object.entries(draft.settings_schema).map(([key, spec]) =>
                  el(
                    "div.action-card",
                    el("div.action-card-head", icon("slidersH", 12), el("span.spacer", key), el("button.btn.sm.icon.ghost", { onclick: () => { delete draft.settings_schema[key]; paint(); } }, icon("close"))),
                    el(
                      "div.action-card-body",
                      fieldRow("Label", el("input.input", { value: spec.label ?? "", oninput: (e) => (spec.label = e.target.value) })),
                      fieldRow("Type", el("select.select", { onchange: (e) => { spec.type = e.target.value; paint(); } }, ...["boolean", "number", "text", "select"].map((t) => el("option", { value: t, selected: t === spec.type }, fmt.label(t))))),
                      fieldRow("Default", el("input.input", { value: String(spec.default ?? ""), oninput: (e) => (spec.default = spec.type === "number" ? Number(e.target.value) : spec.type === "boolean" ? e.target.value === "true" : e.target.value) })),
                    ),
                  ),
                ),
                el(
                  "button.btn.subtle.sm",
                  {
                    style: { width: "fit-content" },
                    onclick: () => {
                      const key = `setting${Object.keys(draft.settings_schema).length + 1}`;
                      draft.settings_schema[key] = { type: "boolean", default: false, label: "New setting" };
                      paint();
                    },
                  },
                  icon("plus"),
                  "Add a setting",
                ),
              );

            case 6:
              return el(
                "div.col",
                { style: { gap: "var(--s-2)" } },
                el("span.hint", "Features that must be on before this one can be enabled."),
                el(
                  "div.preset-row",
                  ...db.features
                    .list()
                    .filter((f) => f.key !== draft.key)
                    .map((feature) =>
                      el(
                        "button",
                        {
                          type: "button",
                          class: `preset-chip${draft.depends_on.includes(feature.key) ? " active" : ""}`,
                          onclick: () => {
                            draft.depends_on = draft.depends_on.includes(feature.key) ? draft.depends_on.filter((k) => k !== feature.key) : [...draft.depends_on, feature.key];
                            paint();
                          },
                        },
                        icon(feature.icon ?? "box", 11),
                        feature.name,
                      ),
                    ),
                ),
              );

            default:
              return el(
                "div.col",
                { style: { gap: "var(--s-3)" } },
                el("div.code", JSON.stringify({ key: draft.key, name: draft.name, icon: draft.icon, screens: draft.screens, collections: draft.collections, navigation: draft.navigation, permissions: draft.permissions, dependsOn: draft.depends_on, settingsSchema: draft.settings_schema }, null, 2)),
                el("div.callout", icon("info"), el("div", "Saving creates a draft. Features version and publish exactly like designs: draft, validate, publish, roll back. A published feature is never edited in place.")),
              );
          }
        }

        /** The honest part: what can and cannot be assembled from here. */
        function buildableChecklist() {
          const checks = [
            { ok: draft.name.trim().length > 0, label: "Named" },
            { ok: draft.screens.length > 0, label: "Has at least one screen" },
            { ok: draft.collections.length > 0, label: "Has data" },
            { ok: draft.navigation.length > 0, label: "Reachable from navigation" },
          ];
          const failing = checks.filter((c) => !c.ok);

          if (!failing.length) {
            return el("span.row", { style: { gap: "5px", fontSize: "var(--fs-11)", color: "var(--success)" } }, icon("checkCircle", 12), "Buildable here, no developer needed");
          }

          return el(
            "button.btn.sm.ghost",
            {
              style: { color: "var(--warning)" },
              onclick: () => {
                const request = [
                  `Feature request: ${draft.name || "(unnamed)"}`,
                  "",
                  "Blocked in the dashboard on:",
                  ...failing.map((c) => `- ${c.label}`),
                  "",
                  "Everything else is composed and ready.",
                ].join("\n");
                navigator.clipboard?.writeText(request);
                toast("Developer request copied", { tone: "info", detail: "Paste it into an issue rather than leaving a half-built feature." });
              },
            },
            icon("alert"),
            `${failing.length} step${failing.length === 1 ? "" : "s"} outstanding`,
          );
        }

        paint();

        return {
          title: existing ? `Edit ${existing.name}` : "New feature",
          subtitle: "A guided flow, not a blank canvas.",
          body: stepBox,
          footer: footerBox,
        };
      },
      { width: "xwide" },
    );
  }

  render();
  if (params.create) openBuilder();

  return unregister;
}
