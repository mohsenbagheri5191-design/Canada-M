/**
 * Rules — simple automations.
 *
 * A trigger, some conditions and a short ordered list of actions. Deliberately
 * not a flowchart: no branching, no loops, no canvas to learn. The data model
 * can carry those later without a migration, which is the point of keeping the
 * shape structured rather than free-form.
 */

import { el, mount as mountTo } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { fmt } from "../core/util.js";
import {
  emptyState,
  pill,
  switchControl,
  menu,
  modal,
  confirm,
  toast,
  drawer,
  metaRow,
  searchField,
} from "../core/ui.js";
import { registerCommands } from "../core/shell.js";
import { ACTION_TYPES, TRIGGER_TYPES } from "../data/db.js";
import { comparators } from "../render/renderer.js";

export function mount(host, { db, go, setCrumbs, params, app }) {
  setCrumbs([{ label: "Rules" }]);

  let query = "";

  const body = el("div.page-scroll");
  const toolbar = el("div.toolbar");
  host.appendChild(el("div.page", toolbar, body));

  const unregister = registerCommands([
    { id: "rules.new", label: "New rule", glyph: "plus", group: "Rules", run: () => openEditor() },
  ]);

  mountTo(
    toolbar,
    searchField("Search rules", (value) => {
      query = value.toLowerCase();
      render();
    }, { width: 260 }),
    el("div.spacer"),
    el("button.btn.primary.sm", { onclick: () => openEditor() }, icon("plus"), "New rule"),
  );

  /* --- Render ---------------------------------------------------------------- */

  function render() {
    const rules = db.rules.list().filter((r) => r.name.toLowerCase().includes(query));
    const allRuns = rules.flatMap((r) => db.rules.runs(r.id));
    const failed = allRuns.filter((r) => r.status === "failed").length;

    mountTo(
      body,
      el(
        "div.page-head",
        el("div.col", el("h1", "Rules"), el("div.sub", "When something happens, check a condition, then run a short list of actions.")),
        el("div.spacer"),
        el(
          "div.inline-stats",
          el("div.inline-stat", el("b", String(rules.filter((r) => r.enabled).length)), el("span", "enabled")),
          el("div.inline-stat", el("b", String(allRuns.length)), el("span", "runs logged")),
          el("div.inline-stat", el("b", String(failed)), el("span", "failures")),
        ),
      ),
      el(
        "div.callout",
        icon("shield"),
        el(
          "div",
          el("b", "Safety is built in."),
          " Per-rule execution timeout, a cap on runs per hour per organisation, loop detection so a rule cannot trigger itself, exponential backoff on webhook failure, and auto-disable after five consecutive failures.",
        ),
      ),
      rules.length ? el("div.col", { style: { gap: "var(--s-3)" } }, ...rules.map(ruleCard)) : emptyState("rules", query ? "No rule matches" : "No rules yet", query ? "Try a different word." : "Automate the small repetitive things: a welcome email, an escalation, a scheduled follow-up.", el("button.btn.primary", { onclick: () => openEditor() }, icon("plus"), "New rule")),
    );
  }

  function ruleCard(rule) {
    const runs = db.rules.runs(rule.id);
    const recent = runs.slice(0, 12);
    const failing = runs.slice(0, 5).every((r) => r.status === "failed") && runs.length >= 5;
    const org = db.orgs.get(rule.organization_id);

    return el(
      "article.panel",
      el(
        "div.panel-head",
        el("span", { style: { display: "flex", color: rule.enabled ? "var(--accent)" : "var(--text-tertiary)" } }, icon("bolt", 14)),
        el("h2", rule.name),
        el("span.dim", { style: { fontSize: "var(--fs-11)" } }, org?.name ?? "All organisations"),
        rule.enabled ? null : pill(rule.disabled_reason ? "auto-disabled" : "off", rule.disabled_reason ? "danger" : ""),
        el("div.spacer"),
        el(
          "div.row",
          { style: { gap: "5px" } },
          ...recent
            .slice()
            .reverse()
            .map((run) =>
              el("span", {
                "data-tip": `${fmt.label(run.status)} · ${fmt.relative(run.occurred_at)} · ${fmt.duration(run.duration_ms)}`,
                style: {
                  width: "5px",
                  height: "14px",
                  borderRadius: "2px",
                  background: run.status === "success" ? "var(--success)" : run.status === "failed" ? "var(--danger)" : "var(--text-disabled)",
                  opacity: 0.85,
                },
              }),
            ),
        ),
        el("div.vr"),
        switchControl(rule.enabled, (value) => {
          db.rules.update(rule.id, { enabled: value, disabled_reason: value ? null : rule.disabled_reason });
          toast(value ? "Rule enabled" : "Rule disabled", { tone: "info", duration: 1800 });
          render();
        }),
        el("button.btn.sm.icon.ghost", { onclick: (event) => openRuleMenu(event.currentTarget, rule) }, icon("more")),
      ),
      el(
        "div.panel-body",
        { style: { display: "flex", flexDirection: "column", gap: "var(--s-3)" } },
        sentence(rule),
        failing &&
          el(
            "div.callout.danger",
            icon("alert"),
            el("div", el("b", "Auto-disabled after five consecutive failures."), " ", rule.disabled_reason ?? "", el("div", { style: { marginTop: "2px" } }, runs[0]?.error ?? "")),
          ),
        el(
          "div.row",
          { style: { gap: "var(--s-2)" } },
          el("button.btn.sm.subtle", { onclick: () => openTest(rule) }, icon("play"), "Test rule"),
          el("button.btn.sm.ghost", { onclick: () => openRuns(rule) }, icon("history"), `Run log (${runs.length})`),
          el("div.spacer"),
          el("span.dim", { style: { fontSize: "var(--fs-11)" } }, runs[0] ? `Last run ${fmt.relative(runs[0].occurred_at)}` : "Never run"),
        ),
      ),
    );
  }

  /** The rule as a sentence. Reading it out loud should describe what it does. */
  function sentence(rule) {
    const trigger = TRIGGER_TYPES.find((t) => t.value === rule.trigger.type);
    const conditions = rule.conditions?.all ?? [];

    return el(
      "div.rule-sentence",
      el("span.word", "When"),
      pill(trigger?.label ?? rule.trigger.type, "accent", "zap"),
      rule.trigger.collectionKey ? [el("span.word", "in"), pill(rule.trigger.collectionKey, "", "appdata")] : null,
      rule.trigger.field ? [el("span.word", "on field"), pill(rule.trigger.field)] : null,
      rule.trigger.cadence ? [el("span.word", "every"), pill(`${rule.trigger.cadence} ${rule.trigger.at ?? ""}`.trim(), "", "clock")] : null,
      conditions.length
        ? [
            el("span.word", "and"),
            ...conditions.flatMap((c, i) => [
              i > 0 ? el("span.word", "and") : null,
              pill(`${String(c.left).replace("$", "")} ${c.op} ${JSON.stringify(c.right)}`, "", "filter"),
            ]),
          ]
        : null,
      el("span.word", "then"),
      ...rule.actions.flatMap((action, i) => [
        i > 0 ? el("span.word", "then") : null,
        pill(ACTION_TYPES.find((a) => a.value === action.type)?.label ?? action.type, "success", ACTION_TYPES.find((a) => a.value === action.type)?.glyph ?? "bolt"),
      ]),
    );
  }

  function openRuleMenu(anchor, rule) {
    menu(
      anchor,
      [
        { label: "Edit", icon: "edit", onSelect: () => openEditor(rule) },
        { label: "Test rule", icon: "play", onSelect: () => openTest(rule) },
        { label: "Run log", icon: "history", onSelect: () => openRuns(rule) },
        "-",
        {
          label: "Duplicate",
          icon: "duplicate",
          onSelect: () => {
            db.rules.create({ ...rule, name: `${rule.name} copy` });
            toast("Rule duplicated as a draft", { tone: "success" });
            render();
          },
        },
        {
          label: "Delete",
          icon: "trash",
          tone: "danger",
          onSelect: async () => {
            const ok = await confirm({ title: `Delete "${rule.name}"?`, message: "The run log goes with it.", confirmLabel: "Delete rule", tone: "danger" });
            if (!ok) return;
            db.rules.remove(rule.id);
            render();
          },
        },
      ],
      { minWidth: 180 },
    );
  }

  /* --- Test run ---------------------------------------------------------------- */

  function openTest(rule) {
    const collectionKey = rule.trigger.collectionKey;
    const samples = collectionKey ? db.entities.records({ collectionKey }).slice(0, 12) : [];
    let sample = samples[0]?.data ?? {};

    modal(
      (close) => {
        const resultBox = el("div.col", { style: { gap: "var(--s-2)" } });

        const runTest = () => {
          const result = db.rules.test(rule.id, sample);
          mountTo(
            resultBox,
            el(
              "div.callout",
              { class: `callout ${result.wouldRun ? "success" : "warning"}` },
              icon(result.wouldRun ? "checkCircle" : "alert"),
              el("div", el("b", result.wouldRun ? "This rule would fire." : "This rule would not fire."), " ", result.note),
            ),
            el("span.eyebrow", "Conditions"),
            result.conditions.length
              ? el(
                  "div.col",
                  { style: { gap: "2px" } },
                  ...result.conditions.map((condition) =>
                    el(
                      "div.validation-row",
                      { class: `validation-row ${condition.passed ? "ok" : "error"}` },
                      icon(condition.passed ? "check" : "close"),
                      el("div", el("b", condition.expression), el("div", { style: { marginTop: "1px" } }, `actual: ${JSON.stringify(condition.actual)}`)),
                    ),
                  ),
                )
              : el("span.dim", { style: { fontSize: "var(--fs-12)" } }, "No conditions — this fires on every matching trigger."),
            el("span.eyebrow", "Actions that would run"),
            el(
              "div.col",
              { style: { gap: "2px" } },
              ...result.actions.map((action, i) =>
                el(
                  "div.row",
                  { style: { gap: "var(--s-2)", padding: "6px var(--s-2)", borderRadius: "var(--r-control)", background: "var(--bg-sunken)", fontSize: "var(--fs-12)" } },
                  el("span.dim", { style: { width: "14px" } }, `${i + 1}`),
                  icon(ACTION_TYPES.find((a) => a.value === action.type)?.glyph ?? "bolt", 13),
                  el("span.truncate", action.plan),
                  el("div.spacer"),
                  pill("not committed", "warning"),
                ),
              ),
            ),
          );
        };

        return {
          title: `Test "${rule.name}"`,
          subtitle: "Runs against a real record and shows exactly what would happen. Nothing is written or sent.",
          body: [
            samples.length
              ? el(
                  "div.field",
                  el("label", "Sample record"),
                  el(
                    "select.select",
                    {
                      onchange: (event) => {
                        sample = samples[Number(event.target.value)]?.data ?? {};
                        runTest();
                      },
                    },
                    ...samples.map((record, index) => {
                      const collection = db.entities.get(collectionKey);
                      return el("option", { value: String(index) }, String(record.data[collection?.title_field] ?? record.id));
                    }),
                  ),
                )
              : el("div.callout", icon("info"), el("div", "This trigger is not record-based, so the test runs against the current admin account instead.")),
            el("div.code", JSON.stringify(sample, null, 2)),
            resultBox,
          ],
          footer: [
            el("div.spacer"),
            el("button.btn.subtle", { onclick: () => close() }, "Close"),
            el("button.btn.primary", { onclick: () => runTest() }, icon("play"), "Run test"),
          ],
        };
      },
      { width: "wide" },
    );
  }

  /* --- Run log ------------------------------------------------------------------- */

  function openRuns(rule) {
    const runs = db.rules.runs(rule.id);

    drawer(
      (close) => ({
        leading: el("span.feature-mark", icon("history")),
        title: `${rule.name} — run log`,
        subtitle: `${fmt.plural(runs.length, "run")} · ${runs.filter((r) => r.status === "failed").length} failed`,
        body: [
          runs.length
            ? el(
                "div.panel",
                ...runs.map((run) =>
                  el(
                    "div.run-row",
                    { dataset: { status: run.status } },
                    el("span.status", fmt.label(run.status)),
                    el("span.dim", { style: { width: "72px", fontSize: "var(--fs-11)" } }, fmt.duration(run.duration_ms)),
                    el("span.truncate", { style: { flex: "1 1 auto", fontFamily: "var(--font-mono)", fontSize: "var(--fs-11)" } }, run.error ?? JSON.stringify(run.output ?? run.input)),
                    el("span.dim", { style: { fontSize: "var(--fs-11)" } }, fmt.relative(run.occurred_at)),
                    el(
                      "button.btn.sm.icon.ghost",
                      {
                        "data-tip": "Inspect",
                        onclick: () =>
                          modal(() => ({
                            title: `Run ${run.id}`,
                            subtitle: `${fmt.label(run.status)} · ${fmt.datetime(run.occurred_at)} · ${fmt.duration(run.duration_ms)}`,
                            body: [
                              el("span.eyebrow", "Input"),
                              el("div.code", JSON.stringify(run.input, null, 2)),
                              el("span.eyebrow", "Output"),
                              el("div.code", run.error ? run.error : JSON.stringify(run.output, null, 2)),
                            ],
                          })),
                      },
                      icon("expand"),
                    ),
                  ),
                ),
              )
            : emptyState("history", "No runs yet", "The log fills as the rule fires."),
        ],
        footer: [el("div.spacer"), el("button.btn.subtle", { onclick: () => close() }, "Close")],
      }),
      { width: "wide" },
    );
  }

  /* --- Editor --------------------------------------------------------------------- */

  function openEditor(existing = null) {
    modal(
      (close) => {
        const draft = existing
          ? structuredClone(existing)
          : {
              name: "",
              organization_id: app.get("org"),
              trigger: { type: "record.created", collectionKey: db.entities.list()[0]?.key ?? null },
              conditions: { all: [] },
              actions: [{ type: "notify_admin", params: { message: "" } }],
            };

        const sentenceBox = el("div.col", { style: { gap: "var(--s-3)" } });

        function paint() {
          const trigger = TRIGGER_TYPES.find((t) => t.value === draft.trigger.type);

          mountTo(
            sentenceBox,
            /* When */
            el(
              "div.rule-sentence",
              el("span.word", "When"),
              el(
                "select.select",
                {
                  onchange: (event) => {
                    draft.trigger = { type: event.target.value, collectionKey: draft.trigger.collectionKey };
                    paint();
                  },
                },
                ...TRIGGER_TYPES.map((t) => el("option", { value: t.value, selected: t.value === draft.trigger.type }, t.label)),
              ),
              trigger?.needsCollection &&
                el(
                  "select.select",
                  { onchange: (event) => (draft.trigger.collectionKey = event.target.value) },
                  ...db.entities.list().map((c) => el("option", { value: c.key, selected: c.key === draft.trigger.collectionKey }, c.name)),
                ),
              trigger?.needsField &&
                el("input.input", { placeholder: "field (optional)", value: draft.trigger.field ?? "", oninput: (e) => (draft.trigger.field = e.target.value || undefined) }),
              trigger?.needsSchedule &&
                el(
                  "select.select",
                  { onchange: (event) => (draft.trigger.cadence = event.target.value) },
                  ...["daily", "weekly", "monthly"].map((c) => el("option", { value: c, selected: c === draft.trigger.cadence }, c)),
                ),
              trigger?.needsSchedule && el("input.input", { placeholder: "07:00", value: draft.trigger.at ?? "", oninput: (e) => (draft.trigger.at = e.target.value) }),
            ),

            /* And */
            el(
              "div.col",
              { style: { gap: "var(--s-2)" } },
              el("span.field-label", "and all of these are true"),
              ...(draft.conditions.all ?? []).map((condition, index) =>
                el(
                  "div.rule-sentence",
                  el("span.word", index === 0 ? "and" : "and"),
                  el("input.input", { value: String(condition.left ?? "").replace(/^\$/, ""), placeholder: "record.status", oninput: (e) => (condition.left = `$${e.target.value}`) }),
                  el("select.select", { style: { minWidth: "90px" }, onchange: (e) => (condition.op = e.target.value) }, ...comparators.map((c) => el("option", { value: c, selected: c === condition.op }, c))),
                  el("input.input", { value: condition.right ?? "", placeholder: "value", oninput: (e) => (condition.right = e.target.value) }),
                  el("button.btn.sm.icon.ghost", { onclick: () => { draft.conditions.all.splice(index, 1); paint(); } }, icon("close")),
                ),
              ),
              el("button.btn.subtle.sm", { style: { width: "fit-content" }, onclick: () => { draft.conditions.all = [...(draft.conditions.all ?? []), { left: "$record.status", op: "==", right: "" }]; paint(); } }, icon("plus"), "Add a condition"),
            ),

            /* Then */
            el(
              "div.col",
              { style: { gap: "var(--s-2)" } },
              el("span.field-label", "then, in order"),
              ...draft.actions.map((action, index) =>
                el(
                  "div.action-card",
                  el(
                    "div.action-card-head",
                    el("span.dim", { style: { width: "14px" } }, `${index + 1}`),
                    el(
                      "select.select",
                      { style: { width: "auto", flex: "1 1 auto" }, onchange: (event) => { action.type = event.target.value; action.params = {}; paint(); } },
                      ...ACTION_TYPES.map((a) => el("option", { value: a.value, selected: a.value === action.type }, a.label)),
                    ),
                    draft.actions.length > 1 && el("button.btn.sm.icon.ghost", { onclick: () => { draft.actions.splice(index, 1); paint(); } }, icon("close")),
                  ),
                  el("div.action-card-body", ...actionParams(action)),
                ),
              ),
              el("button.btn.subtle.sm", { style: { width: "fit-content" }, onclick: () => { draft.actions.push({ type: "notify_admin", params: { message: "" } }); paint(); } }, icon("plus"), "Add an action"),
            ),
          );
        }

        function actionParams(action) {
          action.params = action.params ?? {};
          const text = (key, label, placeholder = "") =>
            el("div.field-row", el("span.field-label", label), el("input.input", { value: action.params[key] ?? "", placeholder, oninput: (e) => (action.params[key] = e.target.value) }));

          switch (action.type) {
            case "send_email":
              return [text("template", "Template", "welcome"), text("to", "To", "{{record.email}}")];
            case "send_push":
              return [text("message", "Message", "Your job is ready")];
            case "notify_admin":
              return [text("message", "Message", "Job {{record.reference}} is blocked")];
            case "create_record":
              return [
                el(
                  "div.field-row",
                  el("span.field-label", "Collection"),
                  el("select.select", { onchange: (e) => (action.params.collection = e.target.value) }, ...db.entities.list().map((c) => el("option", { value: c.key, selected: c.key === action.params.collection }, c.name))),
                ),
                text("data", "Data", "{ customer, due: +30d }"),
              ];
            case "update_record":
              return [text("collection", "Collection"), text("field", "Field"), text("value", "Value")];
            case "set_field":
              return [text("field", "Field", "priority"), text("value", "Value", "High")];
            case "call_webhook":
              return [
                text("url", "URL", "https://example.ca/hook"),
                el("div.field-row", el("span.field-label", "Method"), el("select.select", { onchange: (e) => (action.params.method = e.target.value) }, ...["POST", "PUT", "PATCH"].map((m) => el("option", { value: m, selected: m === action.params.method }, m)))),
                el("div.callout", icon("shield"), el("div", "Retried with exponential backoff. Five consecutive failures auto-disable the rule and notify an admin.")),
              ];
            case "toggle_feature":
              return [
                el("div.field-row", el("span.field-label", "Feature"), el("select.select", { onchange: (e) => (action.params.feature = e.target.value) }, ...db.features.list().map((f) => el("option", { value: f.key, selected: f.key === action.params.feature }, f.name)))),
                el("div.field-row", el("span.field-label", "State"), el("select.select", { onchange: (e) => (action.params.enabled = e.target.value === "on") }, el("option", { value: "on" }, "On"), el("option", { value: "off" }, "Off"))),
              ];
            default:
              return [];
          }
        }

        paint();

        return {
          title: existing ? "Edit rule" : "New rule",
          subtitle: "Reads as a sentence. No canvas to learn, and no arbitrary code, ever.",
          body: [
            el(
              "div.field-grid-2",
              el("div.field", el("label", "Name"), el("input.input", { value: draft.name, placeholder: "Escalate blocked jobs", oninput: (e) => (draft.name = e.target.value) })),
              el(
                "div.field",
                el("label", "Organisation"),
                el("select.select", { onchange: (e) => (draft.organization_id = e.target.value) }, ...db.orgs.list().map((o) => el("option", { value: o.id, selected: o.id === draft.organization_id }, o.name))),
              ),
            ),
            sentenceBox,
            el(
              "div.callout",
              icon("shield"),
              el("div", el("b", "Conditions reuse the renderer's comparison-only evaluator."), " Dot paths, comparisons and logical operators. No function calls, no property access on prototypes, nothing from the database is ever evaluated as code."),
            ),
          ],
          footer: [
            el("div.spacer"),
            el("button.btn.subtle", { onclick: () => close() }, "Cancel"),
            el(
              "button.btn.primary",
              {
                onclick: () => {
                  if (!draft.name.trim()) return toast("Name the rule", { tone: "warning" });
                  if (existing) db.rules.update(existing.id, draft);
                  else db.rules.create(draft);
                  close();
                  toast(existing ? "Rule saved" : `"${draft.name}" created`, {
                    tone: "success",
                    detail: existing ? null : "Created switched off. Test it, then enable it.",
                  });
                  render();
                },
              },
              existing ? "Save rule" : "Create rule",
            ),
          ],
        };
      },
      { width: "wide" },
    );
  }

  render();
  if (params.create) openEditor();

  return unregister;
}
