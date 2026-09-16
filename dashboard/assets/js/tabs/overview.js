/**
 * Overview — the admin home. Scannable in five seconds.
 */

import { el } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { fmt, hueOf } from "../core/util.js";
import { kpi, barChart, avatar, pill, emptyState } from "../core/ui.js";
import { registerCommands } from "../core/shell.js";

export function mount(host, { db, go, setCrumbs, app }) {
  setCrumbs([{ label: "Overview" }]);

  const metrics = db.metrics();
  const audit = db.audit_.list(14);
  const orgId = app.get("org");
  const org = db.orgs.get(orgId);

  const unregister = registerCommands([
    { id: "ov.reseed", label: "Reset all demo data", glyph: "refresh", group: "Overview", run: () => db.reseed() },
  ]);

  const scroll = el(
    "div.page-scroll",
    /* --- Head ---------------------------------------------------------- */
    el(
      "div.page-head",
      el(
        "div.col",
        el("h1", "Overview"),
        el("div.sub", `${org ? org.name : "All organisations"} · ${fmt.plural(metrics.appUsers, "app user")} across ${fmt.plural(metrics.activeOrgs, "active organisation")}`),
      ),
      el("div.spacer"),
      el("div.row", el("span.dot.live"), el("span.dim", { style: { fontSize: "var(--fs-11)" } }, "Layout API healthy")),
    ),

    /* --- KPI strip ----------------------------------------------------- */
    el(
      "div.grid-kpi.stagger",
      ...[
        kpi({ label: "Users", value: fmt.number(metrics.users), hint: `${metrics.appUsers} on the app`, glyph: "users" }),
        kpi({ label: "Active, 7 days", value: fmt.number(metrics.activeUsers), delta: 9, spark: metrics.adoption.slice(-12).map((d) => d.value), glyph: "activity" }),
        kpi({ label: "Organisations", value: fmt.number(metrics.orgs), hint: `${metrics.activeOrgs} active`, glyph: "org" }),
        kpi({ label: "Published designs", value: fmt.number(metrics.published), hint: `${metrics.drafts} draft${metrics.drafts === 1 ? "" : "s"} awaiting publish`, glyph: "library" }),
        kpi({
          label: "Renderer errors, 24h",
          value: fmt.number(metrics.errors),
          hint: metrics.errors === 0 ? "No fallbacks triggered" : "Fallback layout served",
          glyph: "alert",
          tone: metrics.errors > 0 ? "var(--warning)" : null,
        }),
        kpi({ label: "Records", value: fmt.compact(metrics.records), hint: `${metrics.collections} collections`, glyph: "appdata" }),
      ].map((node, i) => {
        node.style.setProperty("--i", i);
        return node;
      }),
    ),

    /* --- Quick actions -------------------------------------------------- */
    el(
      "section.col",
      { style: { gap: "var(--s-3)" } },
      el("h2.eyebrow", "Start something"),
      el(
        "div",
        { style: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: "var(--s-3)" } },
        quickAction("plus", "New design", "Open a blank canvas", () => go("library", { create: "1" })),
        quickAction("user", "Invite a user", "Create an account and send a link", () => go("paths", { create: "1" })),
        quickAction("assignments", "New assignment", "Bind a version to an audience", () => go("assignments", { create: "1" })),
        quickAction("appdata", "New collection", "Invent a data type with no migration", () => go("appdata", { create: "1" })),
      ),
    ),

    /* --- Adoption + health ---------------------------------------------- */
    el(
      "div.grid-2-wide",
      el(
        "section.panel",
        el(
          "div.panel-head",
          el("h2", "Adoption"),
          el("span.dim", { style: { fontSize: "var(--fs-11)" } }, "Unique users per day, last 30"),
          el("div.spacer"),
          pill(`${fmt.number(metrics.adoption.at(-1)?.value ?? 0)} today`, "accent"),
        ),
        el("div.panel-body", barChart(metrics.adoption, { height: 170, labelEvery: 6 })),
      ),
      el(
        "section.panel",
        el("div.panel-head", el("h2", "Health")),
        el(
          "div.panel-body",
          { style: { paddingTop: "var(--s-1)", paddingBottom: "var(--s-1)" } },
          healthRow("Layout API p95", fmt.ms(metrics.health.layoutP95), metrics.health.layoutP95 < 150 ? "success" : "warning", metrics.health.layoutP95 < 150 ? "Under the 150ms target" : "Above target"),
          healthRow("Cache hit rate", fmt.percent(metrics.health.cacheHit, 1), metrics.health.cacheHit > 0.9 ? "success" : "warning"),
          healthRow("Renderer error rate", fmt.percent(metrics.health.rendererErrorRate, 2), metrics.health.rendererErrorRate < 0.01 ? "success" : "danger"),
          healthRow("Last failed publish", metrics.health.lastFailedPublish ? fmt.relative(metrics.health.lastFailedPublish) : "None", "success"),
        ),
      ),
    ),

    /* --- Activity ------------------------------------------------------- */
    el(
      "section.panel",
      el(
        "div.panel-head",
        el("h2", "Activity"),
        el("div.spacer"),
        el("button.btn.sm.ghost", { onclick: () => go("paths") }, "Open audit log", icon("chevronRight")),
      ),
      audit.length
        ? el(
            "div.panel-body.flush.stagger",
            ...audit.map((entry, i) => {
              const node = el(
                "div.activity-item",
                avatar(entry.actor_name, { hue: hueOf(entry.actor_id) }),
                el("div.text", el("b", entry.actor_name), " ", entry.phrase, "."),
                pill(entry.entity_type),
                el("span.when", fmt.relative(entry.occurred_at)),
              );
              node.style.setProperty("--i", i);
              return node;
            }),
          )
        : emptyState("activity", "No activity yet", "Administrative actions appear here as they happen."),
    ),
  );

  host.appendChild(scroll);
  return unregister;
}

function quickAction(glyph, title, description, onClick) {
  return el(
    "button.quick-action",
    { type: "button", onclick: onClick },
    el("span.mark", icon(glyph)),
    el("span", el("b", title), el("small", description)),
  );
}

function healthRow(label, value, tone, note) {
  return el(
    "div.health-row",
    el(`span.dot.${tone}`),
    el("span.label", label, note && el("span", { style: { color: "var(--text-tertiary)", marginLeft: "6px", fontSize: "var(--fs-11)" } }, note)),
    el("span.value", value),
  );
}
