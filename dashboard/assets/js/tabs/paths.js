/**
 * Paths — per-user visibility into route, assigned design and real journey.
 *
 * The question this tab answers is "why is this user seeing this", and it
 * answers it with the actual resolution trace rather than a summary.
 */

import { el, mount as mountTo } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { fmt, hueOf, sortBy, downloadFile, toCsv, groupBy } from "../core/util.js";
import {
  searchField,
  emptyState,
  statusPill,
  pill,
  avatar,
  menu,
  modal,
  confirm,
  toast,
  drawer,
  metaRow,
  segmented,
  switchControl,
} from "../core/ui.js";
import { registerCommands } from "../core/shell.js";
import { ROLES } from "../data/db.js";
import { walk } from "../render/renderer.js";

export function mount(host, { db, go, setCrumbs, params, app }) {
  setCrumbs([{ label: "Paths" }]);

  const state = { q: "", org: "", role: "", status: "", sort: "name", dir: "asc" };

  const body = el("div.page-scroll");
  const toolbar = el("div.toolbar");
  host.appendChild(el("div.page", toolbar, body));

  const unregister = registerCommands([
    { id: "paths.newuser", label: "Create a user", glyph: "user", group: "Users", run: () => openUserDialog() },
    { id: "paths.import", label: "Import users from CSV", glyph: "upload", group: "Users", run: () => openImport() },
    { id: "paths.export", label: "Export the user list", glyph: "download", group: "Users", run: () => exportCsv() },
  ]);

  mountTo(
    toolbar,
    searchField("Search name or email", (value) => {
      state.q = value;
      renderTable();
    }, { width: 260 }),
    el("div.vr"),
    selectFilter("", "All organisations", db.orgs.list().map((o) => ({ value: o.id, label: o.name })), (v) => {
      state.org = v;
      renderTable();
    }),
    selectFilter("", "Any role", ROLES.map((r) => ({ value: r.value, label: r.label })), (v) => {
      state.role = v;
      renderTable();
    }),
    selectFilter("", "Any status", ["active", "invited", "suspended"].map((s) => ({ value: s, label: fmt.label(s) })), (v) => {
      state.status = v;
      renderTable();
    }),
    el("div.spacer"),
    el("button.btn.sm.ghost", { onclick: () => openImport() }, icon("upload"), "Import"),
    el("button.btn.sm.ghost", { onclick: () => exportCsv() }, icon("download"), "Export"),
    el("button.btn.primary.sm", { onclick: () => openUserDialog() }, icon("plus"), "New user"),
  );

  function selectFilter(value, placeholder, options, onChange) {
    return el(
      "select.select",
      { style: { width: "auto" }, onchange: (event) => onChange(event.target.value) },
      el("option", { value: "" }, placeholder),
      ...options.map((o) => el("option", { value: o.value, selected: o.value === value }, o.label)),
    );
  }

  /* --- Data ---------------------------------------------------------------- */

  function users() {
    let rows = db.users.list({ org: state.org || null, role: state.role || null, status: state.status || null, q: state.q });
    rows = rows.map((user) => {
      const resolution = db.assignments.resolve(user.id);
      const design = resolution.version ? db.designs.get(resolution.version.design_id) : null;
      const entry = resolution.version?.document?.screens?.find((s) => s.isEntry);
      return {
        user,
        org: db.orgs.get(user.organization_id),
        version: resolution.version,
        design,
        entryRoute: entry?.route ?? "—",
        rule: resolution.rule,
      };
    });

    const key = { name: (r) => r.user.full_name, email: (r) => r.user.email, org: (r) => r.org?.name ?? "", role: (r) => r.user.role, status: (r) => r.user.status, seen: (r) => r.user.last_login_at ?? "", sessions: (r) => r.user.session_count }[state.sort] ?? ((r) => r.user.full_name);
    return sortBy(rows, key, state.dir);
  }

  /* --- Render ---------------------------------------------------------------- */

  const tableHost = el("section.panel");

  function render() {
    const all = db.users.list();
    const appUsers = all.filter((u) => u.role === "app_user");

    mountTo(
      body,
      el(
        "div.page-head",
        el("div.col", el("h1", "Paths"), el("div.sub", "Every account, the design it resolves to, and the route it actually takes.")),
        el("div.spacer"),
        el(
          "div.inline-stats",
          el("div.inline-stat", el("b", String(all.length)), el("span", "accounts")),
          el("div.inline-stat", el("b", String(appUsers.length)), el("span", "app users")),
          el("div.inline-stat", el("b", String(all.filter((u) => u.status === "invited").length)), el("span", "invited")),
        ),
      ),
      flowPanel(),
      tableHost,
    );
    renderTable();
  }

  function renderTable() {
    const rows = users();

    if (!rows.length) {
      mountTo(tableHost, emptyState("users", "No accounts match", "Clear a filter, or create the first account.", el("button.btn.primary", { onclick: () => openUserDialog() }, icon("plus"), "New user")));
      return;
    }

    const th = (label, key, extra = "") =>
      el(
        `th${extra}`,
        {
          class: `sortable${extra ? extra.replace(/\./g, " ") : ""}`,
          "aria-sort": state.sort === key ? (state.dir === "asc" ? "ascending" : "descending") : null,
          onclick: () => {
            if (state.sort === key) state.dir = state.dir === "asc" ? "desc" : "asc";
            else {
              state.sort = key;
              state.dir = "asc";
            }
            renderTable();
          },
        },
        label,
        el("span.sort-caret", icon("chevronUp", 10)),
      );

    mountTo(
      tableHost,
      el("div.panel-head", el("h2", "Accounts"), el("div.spacer"), el("span.dim", { style: { fontSize: "var(--fs-11)" } }, `${rows.length} shown`)),
      el(
        "div.table-wrap",
        { style: { maxHeight: "calc(100vh - 430px)" } },
        el(
          "table.data",
          el("thead", el("tr", th("Name", "name"), th("Email", "email"), th("Organisation", "org"), th("Role", "role"), th("Status", "status"), el("th", "Resolved design"), el("th", "Entry route"), th("Last seen", "seen"), th("Sessions", "sessions", ".num-cell"), el("th.tight", ""))),
          el(
            "tbody",
            ...rows.map((row) =>
              el(
                "tr.clickable",
                { onclick: () => openUserPanel(row.user.id) },
                el("td.primary-cell", el("div.row", { style: { gap: "var(--s-2)" } }, avatar(row.user.full_name, { size: "sm", hue: hueOf(row.user.id) }), el("span.truncate", row.user.full_name || "—"))),
                el("td", row.user.email),
                el("td", row.org?.name ?? "Platform"),
                el("td", pill(fmt.label(row.user.role), row.user.role === "super_admin" ? "accent" : "")),
                el("td", statusPill(row.user.status)),
                el("td", row.design ? `${row.design.name} v${row.version.version_number}` : el("span.dim", "static fallback")),
                el("td", el("code", { style: { fontSize: "var(--fs-11)" } }, row.entryRoute)),
                el("td", row.user.last_login_at ? fmt.relative(row.user.last_login_at) : el("span.dim", "never")),
                el("td.num-cell", fmt.number(row.user.session_count)),
                el(
                  "td.tight",
                  el(
                    "div.row-actions",
                    el(
                      "button.btn.sm.icon.ghost",
                      {
                        "data-tip": "Actions",
                        onclick: (event) => {
                          event.stopPropagation();
                          openUserMenu(event.currentTarget, row.user);
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

  /* --- Aggregate flow --------------------------------------------------------- */

  function flowPanel() {
    const flow = db.paths.flow();
    const top = flow.edges.slice(0, 8);
    const max = top[0]?.count ?? 1;
    const totalVisits = flow.visits.reduce((sum, v) => sum + v.count, 0) || 1;

    return el(
      "section.panel",
      el("div.panel-head", el("h2", "Most common paths"), el("div.spacer"), el("span.dim", { style: { fontSize: "var(--fs-11)" } }, "Screen-to-screen transitions, last 14 days")),
      el(
        "div.panel-body",
        { style: { display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: "var(--s-5)" } },
        el(
          "div.col",
          { style: { gap: "2px" } },
          ...(top.length
            ? top.map((edge, i) => {
                const dropOff = 1 - edge.count / (flow.visits.find((v) => v.route === edge.from)?.count ?? edge.count);
                return el(
                  "div.flow-row",
                  el("span.from", edge.from),
                  icon("arrowRight", 11),
                  el("span.to", edge.to),
                  el("span.bar", el("i", { style: { width: `${(edge.count / max) * 100}%`, animationDelay: `${i * 24}ms` } })),
                  el("span.count", fmt.number(edge.count)),
                  el("span", { style: { width: "48px", textAlign: "right", fontSize: "var(--fs-11)", color: dropOff > 0.5 ? "var(--warning)" : "var(--text-tertiary)" } }, `${Math.round(dropOff * 100)}%`),
                );
              })
            : [el("span.dim", { style: { fontSize: "var(--fs-12)" } }, "No telemetry yet.")]),
          top.length && el("span.dim", { style: { fontSize: "var(--fs-11)", marginTop: "var(--s-2)" } }, "The last column is drop-off: the share of sessions that reached the first screen but did not continue to the second."),
        ),
        el(
          "div.col",
          { style: { gap: "var(--s-2)" } },
          el("span.eyebrow", "Screen visits"),
          ...flow.visits.slice(0, 8).map((visit) =>
            el(
              "div.flow-row",
              el("span.from", { style: { width: "96px" } }, visit.route),
              el("span.bar", el("i", { style: { width: `${(visit.count / (flow.visits[0]?.count ?? 1)) * 100}%` } })),
              el("span.count", fmt.percent(visit.count / totalVisits, 0)),
            ),
          ),
        ),
      ),
    );
  }

  /* --- User detail ------------------------------------------------------------- */

  function openUserPanel(userId) {
    const user = db.users.get(userId);
    if (!user) return;

    const resolution = db.assignments.resolve(userId);
    const version = resolution.version;
    const design = version ? db.designs.get(version.design_id) : null;
    const org = db.orgs.get(user.organization_id);
    const events = db.paths.userEvents(userId, 40);

    drawer(
      (close) => ({
        leading: avatar(user.full_name, { size: "lg", hue: hueOf(user.id) }),
        title: user.full_name || user.email,
        subtitle: `${user.email} · ${org?.name ?? "Platform"}`,
        actions: el(
          "div.row",
          { style: { gap: "4px" } },
          el(
            "button.btn.sm.subtle",
            {
              "data-tip": "Open the app exactly as this user sees it",
              onclick: () => {
                close();
                openImpersonate(user, version);
              },
            },
            icon("impersonate"),
            "Impersonate",
          ),
          el("button.btn.sm.icon.ghost", { onclick: (event) => openUserMenu(event.currentTarget, user) }, icon("more")),
        ),
        body: [
          /* 1. Resolved path */
          el(
            "section.col",
            { style: { gap: "var(--s-2)" } },
            el("span.eyebrow", "1 · Resolved path"),
            el(
              "div.panel",
              el(
                "div.panel-body",
                { style: { display: "flex", flexDirection: "column", gap: "var(--s-2)" } },
                metaRow("Design", design ? `${design.name} v${version.version_number}` : "Built-in static layout"),
                metaRow("Entry route", el("code", version?.document?.screens?.find((s) => s.isEntry)?.route ?? "—")),
                metaRow(
                  "Winning rule",
                  resolution.rule
                    ? `${resolution.rule.scope === "organization" ? "Organisation" : "User"} scope, priority ${resolution.rule.priority}`
                    : "No explicit rule — fell through to a default",
                ),
                metaRow("Status", statusPill(user.status)),
              ),
            ),
            el("span.field-label", "Rule chain, in order"),
            el(
              "div.panel",
              { style: { padding: "var(--s-3)" } },
              ...resolution.trace.map((step) =>
                el(
                  `div.trace-step.${step.hit ? "hit" : "miss"}`,
                  el("span.trace-mark", icon("check", 10)),
                  el("div.body", el("b", step.step), el("span", step.detail ?? "")),
                  step.hit ? pill("matched", "success") : pill("skipped"),
                ),
              ),
            ),
          ),

          /* 2. Route map */
          el(
            "section.col",
            { style: { gap: "var(--s-2)" } },
            el("span.eyebrow", "2 · Route map"),
            version ? routeMap(version, user) : el("div.callout", icon("info"), el("div", "No server-driven design resolves for this user, so the app falls back to its built-in layout.")),
          ),

          /* 3. Journey */
          el(
            "section.col",
            { style: { gap: "var(--s-2)" } },
            el(
              "div.row",
              el("span.eyebrow", "3 · Journey"),
              el("div.spacer"),
              el(
                "button.btn.sm.ghost",
                {
                  onclick: () => {
                    downloadFile(
                      `journey-${user.email}.csv`,
                      toCsv(
                        [
                          { key: "occurred_at", label: "When" },
                          { key: "event", label: "Event" },
                          { key: "route_path", label: "Route" },
                        ],
                        events,
                      ),
                    );
                    toast("Journey exported", { tone: "success" });
                  },
                },
                icon("download"),
                "CSV",
              ),
            ),
            events.length
              ? el(
                  "div.panel",
                  { style: { padding: "var(--s-2) var(--s-3)", maxHeight: "300px", overflow: "auto" } },
                  ...events.map((event) =>
                    el(
                      "div.journey-row",
                      { dataset: { event: event.event } },
                      el("span.kind", icon(event.event === "error" ? "alert" : event.event === "action" ? "bolt" : "eye")),
                      el("code", event.route_path),
                      el("span.dim", { style: { fontSize: "var(--fs-11)" } }, event.event === "error" ? event.metadata?.message ?? "error" : fmt.duration(event.metadata?.dwell_ms ?? 0)),
                      el("div.spacer"),
                      el("span.dim", { style: { fontSize: "var(--fs-11)" } }, fmt.relative(event.occurred_at)),
                    ),
                  ),
                )
              : el("div.callout", icon("activity"), el("div", "No telemetry for this account yet. Events arrive batched from the app on route change and tracked actions.")),
          ),
        ],
        footer: [
          el("span.dim", { style: { fontSize: "var(--fs-11)" } }, `Created ${fmt.date(user.created_at)}`),
          el("div.spacer"),
          el("button.btn.subtle", { onclick: () => close() }, "Close"),
          el("button.btn.primary", { onclick: () => { close(); openUserDialog(user); } }, "Edit user"),
        ],
      }),
      { width: "wide" },
    );
  }

  function routeMap(version, user) {
    const screens = version.document.screens ?? [];

    // Which screens are reachable from the entry, following navigate actions.
    const edges = new Map();
    for (const screen of screens) {
      const targets = new Set();
      walk(screen.root, (node) => {
        for (const chain of Object.values(node.actions ?? {})) {
          for (const step of Array.isArray(chain) ? chain : [chain]) {
            if (step.type === "navigate" && step.to) targets.add(step.to);
          }
        }
        return true;
      });
      edges.set(screen.route, targets);
    }

    const entry = screens.find((s) => s.isEntry) ?? screens[0];
    const reachable = new Set();
    const queue = entry ? [entry.route] : [];
    while (queue.length) {
      const route = queue.shift();
      if (reachable.has(route)) continue;
      reachable.add(route);
      for (const next of edges.get(route) ?? []) queue.push(next);
    }

    return el(
      "div.panel",
      el(
        "div.panel-body",
        el(
          "div.route-graph",
          ...screens.map((screen) => {
            const isReachable = reachable.has(screen.route);
            const outbound = (edges.get(screen.route) ?? new Set()).size;
            const blocked = screen.requiresRole && screen.requiresRole !== user.role;

            return el(
              "div",
              {
                class: `route-node${screen.isEntry ? " entry" : ""}${!isReachable && !screen.isEntry ? " orphan" : ""}${blocked ? " blocked" : ""}`,
                "data-tip": blocked ? `Requires ${fmt.label(screen.requiresRole)}` : !isReachable && !screen.isEntry ? "No inbound navigation reaches this screen" : outbound === 0 ? "Dead end: no outbound action" : null,
              },
              el("div.row", { style: { gap: "5px" } }, icon(screen.isEntry ? "target" : "device", 12), el("b", screen.name)),
              el("code", screen.route),
              el(
                "div.row",
                { style: { gap: "4px", marginTop: "3px" } },
                screen.isEntry && pill("entry", "success"),
                blocked && pill("blocked", "danger"),
                !isReachable && !screen.isEntry && pill("orphan", "warning"),
                outbound === 0 && !screen.isEntry && pill("dead end", "warning"),
                screen.requiresRole && pill(fmt.label(screen.requiresRole)),
              ),
            );
          }),
        ),
        el(
          "div.row",
          { style: { gap: "var(--s-3)", marginTop: "var(--s-3)", fontSize: "var(--fs-11)", color: "var(--text-tertiary)" } },
          el("span.row", { style: { gap: "4px" } }, el("span.dot.success"), "entry"),
          el("span.row", { style: { gap: "4px" } }, el("span.dot.warning"), "orphan or dead end"),
          el("span.row", { style: { gap: "4px" } }, el("span.dot.danger"), "blocked by role"),
        ),
      ),
    );
  }

  function openImpersonate(user, version) {
    const screen = version?.document?.screens?.find((s) => s.isEntry) ?? version?.document?.screens?.[0];
    db.audit("user.impersonate", "User", `previewed the app as ${user.full_name}`, { entityId: user.id });

    modal(
      () => ({
        title: `Preview as ${user.full_name}`,
        subtitle: "Read-only, watermarked, and written to the audit log.",
        body: el(
          "div.col",
          { style: { gap: "var(--s-3)", alignItems: "center" } },
          el("div.callout.warning", { style: { width: "100%" } }, icon("shield"), el("div", el("b", "Impersonation preview."), " Nothing you do here writes to this account. The action has been recorded against your own.")),
          screen
            ? (() => {
                const frame = el("div", {
                  style: {
                    position: "relative",
                    width: "300px",
                    height: "560px",
                    border: "1px solid var(--line)",
                    borderRadius: "22px",
                    overflow: "hidden",
                    background: "var(--bg-sunken)",
                  },
                });
                import("../studio/canvas.js").then(({ renderMiniature }) => {
                  frame.appendChild(renderMiniature(screen, version.theme, { fit: "width" }));
                  frame.appendChild(
                    el("div", {
                      style: {
                        position: "absolute",
                        inset: 0,
                        display: "grid",
                        placeItems: "center",
                        pointerEvents: "none",
                        color: "var(--warning)",
                        fontSize: "22px",
                        fontWeight: "700",
                        letterSpacing: "0.22em",
                        opacity: 0.28,
                        transform: "rotate(-22deg)",
                      },
                    }, "PREVIEW"),
                  );
                });
                return frame;
              })()
            : el("div.callout", icon("info"), el("div", "This user resolves to the app's built-in static layout, which is not server-driven.")),
        ),
      }),
      { width: "" },
    );
  }

  /* --- User CRUD ----------------------------------------------------------------- */

  function openUserMenu(anchor, user) {
    menu(
      anchor,
      [
        { label: "Open detail", icon: "trace", onSelect: () => openUserPanel(user.id) },
        { label: "Edit", icon: "edit", onSelect: () => openUserDialog(user) },
        "-",
        {
          label: user.status === "suspended" ? "Reactivate" : "Suspend",
          icon: user.status === "suspended" ? "unlock" : "lock",
          onSelect: () => {
            db.users.update(user.id, { status: user.status === "suspended" ? "active" : "suspended" });
            toast(user.status === "suspended" ? "Account reactivated" : "Account suspended", { tone: "info" });
            renderTable();
          },
        },
        {
          label: "Force a password reset",
          icon: "key",
          onSelect: () => {
            db.audit("user.password_reset", "User", `forced a password reset for ${user.full_name}`, { entityId: user.id });
            toast("Reset required at next sign-in", { tone: "success" });
          },
        },
        {
          label: "Revoke all sessions",
          icon: "logout",
          onSelect: () => {
            db.audit("user.revoke_sessions", "User", `revoked all sessions for ${user.full_name}`, { entityId: user.id });
            toast("Sessions revoked", { tone: "success", detail: "Refresh tokens are invalidated immediately." });
          },
        },
        "-",
        {
          label: "Delete",
          icon: "trash",
          tone: "danger",
          onSelect: async () => {
            const ok = await confirm({
              title: `Delete ${user.full_name}?`,
              message: "Soft delete with a 30-day restore window. Any personal assignment override is removed straight away.",
              confirmLabel: "Delete account",
              tone: "danger",
            });
            if (!ok) return;
            db.users.remove(user.id);
            toast("Account deleted", { tone: "info", detail: "Restorable for 30 days." });
            renderTable();
          },
        },
      ],
      { minWidth: 220 },
    );
  }

  function openUserDialog(existing = null) {
    modal((close) => {
      const draft = {
        email: existing?.email ?? "",
        full_name: existing?.full_name ?? "",
        organization_id: existing?.organization_id ?? app.get("org"),
        role: existing?.role ?? "app_user",
        invite: true,
      };
      let tempPassword = generatePassword();
      const passwordBox = el("div.field", { hidden: true });

      function paintPassword() {
        passwordBox.hidden = draft.invite;
        mountTo(
          passwordBox,
          el("label", "Temporary password"),
          el(
            "div.row",
            { style: { gap: "var(--s-2)" } },
            el("input.input", { value: tempPassword, readOnly: true, spellcheck: false, style: { fontFamily: "var(--font-mono)" } }),
            el(
              "button.btn.subtle",
              {
                onclick: () => {
                  tempPassword = generatePassword();
                  paintPassword();
                },
              },
              icon("refresh"),
              "New",
            ),
            el(
              "button.btn.subtle",
              {
                onclick: () => {
                  navigator.clipboard?.writeText(tempPassword);
                  toast("Password copied", { tone: "success", duration: 1600 });
                },
              },
              icon("copy"),
            ),
          ),
          el("span.hint", "Shown once. The account must change it at first sign-in."),
        );
      }
      paintPassword();

      return {
        title: existing ? "Edit user" : "New user",
        subtitle: existing ? existing.email : "There is no self-signup. Admins create every account.",
        body: [
          el("div.field", el("label", "Email"), el("input.input", { type: "email", value: draft.email, disabled: Boolean(existing), oninput: (e) => (draft.email = e.target.value) })),
          el("div.field", el("label", "Full name"), el("input.input", { value: draft.full_name, oninput: (e) => (draft.full_name = e.target.value) })),
          el(
            "div.field-grid-2",
            el(
              "div.field",
              el("label", "Organisation"),
              el(
                "select.select",
                { onchange: (e) => (draft.organization_id = e.target.value) },
                ...db.orgs.list().map((o) => el("option", { value: o.id, selected: o.id === draft.organization_id }, o.name)),
              ),
            ),
            el(
              "div.field",
              el("label", "Role"),
              el(
                "select.select",
                {
                  onchange: (event) => {
                    draft.role = event.target.value;
                    roleHint.textContent = ROLES.find((r) => r.value === draft.role)?.description ?? "";
                  },
                },
                ...ROLES.map((r) => el("option", { value: r.value, selected: r.value === draft.role }, r.label)),
              ),
            ),
          ),
          (roleHint = el("span.hint", ROLES.find((r) => r.value === draft.role)?.description ?? "")),
          !existing &&
            el(
              "div.field",
              el("label", "How they get in"),
              segmented(
                [
                  { value: "invite", label: "Send an invite link", icon: "mail" },
                  { value: "password", label: "Set a temporary password", icon: "key" },
                ],
                "invite",
                (value) => {
                  draft.invite = value === "invite";
                  paintPassword();
                },
                { block: true },
              ),
              el("span.hint", draft.invite ? "Single-use link, valid 72 hours." : ""),
            ),
          passwordBox,
        ],
        footer: [
          el("div.spacer"),
          el("button.btn.subtle", { onclick: () => close() }, "Cancel"),
          el(
            "button.btn.primary",
            {
              onclick: () => {
                if (!draft.email.includes("@")) return toast("Enter a valid email", { tone: "warning" });
                if (existing) {
                  db.users.update(existing.id, { full_name: draft.full_name, role: draft.role, organization_id: draft.organization_id });
                  toast("User updated", { tone: "success" });
                } else {
                  const user = db.users.create(draft);
                  toast(`${user.full_name || user.email} created`, {
                    tone: "success",
                    detail: draft.invite ? "Invite sent, valid 72 hours." : "Hand them the temporary password yourself.",
                  });
                }
                close();
                renderTable();
              },
            },
            existing ? "Save changes" : "Create user",
          ),
        ],
      };
    });
  }

  let roleHint;

  function generatePassword() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
    return Array.from({ length: 16 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  }

  /* --- Import and export ----------------------------------------------------------- */

  function openImport() {
    modal((close) => {
      let parsed = [];
      const preview = el("div.col", { style: { gap: "2px", maxHeight: "220px", overflow: "auto" } });

      const paint = () => {
        if (!parsed.length) {
          mountTo(preview, el("span.dim", { style: { fontSize: "var(--fs-12)" } }, "Paste rows above to see the dry run."));
          return;
        }
        mountTo(
          preview,
          ...parsed.map((row) =>
            el(
              "div.import-row",
              { dataset: { kind: row.reason ? "reject" : "create" } },
              icon(row.reason ? "xCircle" : "plus", 11),
              el("span.truncate", `${row.email}${row.full_name ? ` · ${row.full_name}` : ""}`),
              el("div.spacer"),
              el("span", row.reason ?? "create"),
            ),
          ),
        );
      };
      paint();

      return {
        title: "Import users",
        subtitle: "Paste CSV as email,name,role. Nothing is written until you commit.",
        body: [
          el("textarea.textarea", {
            rows: 6,
            placeholder: "maya.chen@northstar.ca,Maya Chen,app_user\ndaniel.kim@northstar.ca,Daniel Kim,designer",
            style: { fontFamily: "var(--font-mono)", fontSize: "var(--fs-11)" },
            oninput: (event) => {
              const existing = new Set(db.users.list().map((u) => u.email.toLowerCase()));
              parsed = event.target.value
                .split("\n")
                .map((line) => line.trim())
                .filter(Boolean)
                .map((line) => {
                  const [email = "", full_name = "", role = "app_user"] = line.split(",").map((c) => c.trim());
                  let reason = null;
                  if (!email.includes("@")) reason = "invalid email";
                  else if (existing.has(email.toLowerCase())) reason = "already exists";
                  else if (!ROLES.some((r) => r.value === role)) reason = `unknown role "${role}"`;
                  return { email, full_name, role, organization_id: app.get("org"), reason };
                });
              paint();
            },
          }),
          el("span.eyebrow", "Dry run"),
          preview,
        ],
        footer: [
          el("span.dim", { style: { fontSize: "var(--fs-11)" } }, `${parsed.filter((r) => !r.reason).length} to create, ${parsed.filter((r) => r.reason).length} rejected`),
          el("div.spacer"),
          el("button.btn.subtle", { onclick: () => close() }, "Cancel"),
          el(
            "button.btn.primary",
            {
              onclick: () => {
                const valid = parsed.filter((r) => !r.reason);
                if (!valid.length) return toast("Nothing valid to import", { tone: "warning" });
                db.users.createMany(valid);
                close();
                toast(`Imported ${fmt.plural(valid.length, "account")}`, { tone: "success", detail: "Invites queued." });
                renderTable();
              },
            },
            "Commit import",
          ),
        ],
      };
    });
  }

  function exportCsv() {
    const rows = users();
    downloadFile(
      `users-${new Date().toISOString().slice(0, 10)}.csv`,
      toCsv(
        [
          { key: "name", label: "Name", value: (r) => r.user.full_name },
          { key: "email", label: "Email", value: (r) => r.user.email },
          { key: "org", label: "Organisation", value: (r) => r.org?.name ?? "" },
          { key: "role", label: "Role", value: (r) => r.user.role },
          { key: "status", label: "Status", value: (r) => r.user.status },
          { key: "design", label: "Resolved design", value: (r) => (r.design ? `${r.design.name} v${r.version.version_number}` : "static") },
          { key: "route", label: "Entry route", value: (r) => r.entryRoute },
          { key: "seen", label: "Last seen", value: (r) => r.user.last_login_at ?? "" },
        ],
        rows,
      ),
    );
    toast(`Exported ${fmt.plural(rows.length, "row")}`, { tone: "success" });
  }

  render();
  if (params.create) openUserDialog();

  return unregister;
}
