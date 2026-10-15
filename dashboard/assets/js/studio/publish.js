/**
 * Validation and the publish pipeline.
 *
 * Validation runs against the document before anything leaves the studio, so
 * the mobile app never has to defend against a class of problem we could have
 * caught here. Publish is blocked on errors, allowed with warnings.
 */

import { el, mount } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { getDef } from "../data/registry.js";
import { walk, countNodes, maxDepth, LIMITS } from "../render/renderer.js";
import { contrastGrade, fmt } from "../core/util.js";
import { modal, toast, confirm } from "../core/ui.js";
import { renderMiniature } from "./canvas.js";

/**
 * @returns {{errors: object[], warnings: object[], stats: object}}
 */
export function validateDocument(doc, theme) {
  const errors = [];
  const warnings = [];

  const routes = new Map();
  let totalNodes = 0;
  let deepest = 0;

  const entryScreens = doc.screens.filter((s) => s.isEntry);
  if (entryScreens.length === 0) {
    errors.push({ code: "no-entry", title: "No entry screen", detail: "One screen must be marked as the entry point, or the app has nowhere to land." });
  } else if (entryScreens.length > 1) {
    errors.push({ code: "many-entry", title: "More than one entry screen", detail: `${entryScreens.map((s) => s.name).join(", ")} are all marked as entry. Exactly one is allowed.` });
  }

  for (const screen of doc.screens) {
    // Route rules
    if (!screen.route || !screen.route.startsWith("/")) {
      errors.push({ code: "bad-route", title: `"${screen.name}" has no valid path`, detail: "A screen path must begin with a slash, for example /jobs." });
    } else if (routes.has(screen.route)) {
      errors.push({ code: "dupe-route", title: `Duplicate path ${screen.route}`, detail: `Used by both "${routes.get(screen.route)}" and "${screen.name}". Resolution would be ambiguous.` });
    } else {
      routes.set(screen.route, screen.name);
    }

    const nodes = countNodes(screen.root);
    const depth = maxDepth(screen.root);
    totalNodes += nodes;
    deepest = Math.max(deepest, depth);

    if (nodes > LIMITS.nodes) {
      errors.push({ code: "node-cap", title: `"${screen.name}" exceeds the node cap`, detail: `${nodes} nodes against a limit of ${LIMITS.nodes}. Split the screen or simplify it.` });
    }
    if (depth > LIMITS.depth) {
      errors.push({ code: "depth-cap", title: `"${screen.name}" is nested too deeply`, detail: `Depth ${depth} against a limit of ${LIMITS.depth}.` });
    }

    // Node-level checks
    walk(screen.root, (node) => {
      const def = getDef(node.type);
      if (!def) {
        errors.push({ code: "unknown-type", title: `Unknown component "${node.type}"`, detail: `On "${screen.name}". The app cannot render it, so it would silently disappear.`, nodeId: node.id, screenId: screen.id });
        return true;
      }

      for (const [key, value] of Object.entries(node.props ?? {})) {
        if (value && typeof value === "object" && Object.hasOwn(value, "$bind")) {
          if (!value.$bind) {
            errors.push({ code: "empty-bind", title: `Empty binding on ${def.label}`, detail: `Property "${key}" is bound to nothing.`, nodeId: node.id, screenId: screen.id });
          } else if (value.fallback === undefined) {
            warnings.push({ code: "no-fallback", title: `No fallback for ${def.label}.${key}`, detail: `Bound to ${value.$bind}. If it resolves empty the element renders blank.`, nodeId: node.id, screenId: screen.id });
          }
        }
      }

      // Navigation that points nowhere is the classic dead link.
      for (const chain of Object.values(node.actions ?? {})) {
        for (const step of Array.isArray(chain) ? chain : [chain]) {
          if (step.type === "navigate" && !doc.screens.some((s) => s.route === step.to)) {
            errors.push({ code: "dead-link", title: `Dead link on ${def.label}`, detail: `Navigates to "${step.to}", which no screen serves.`, nodeId: node.id, screenId: screen.id });
          }
        }
      }

      if (def.acceptsChildren && !(node.children ?? []).length && node.id !== screen.root.id) {
        warnings.push({ code: "empty-container", title: `Empty ${def.label}`, detail: `On "${screen.name}". It renders as nothing.`, nodeId: node.id, screenId: screen.id });
      }

      return true;
    });
  }

  // Theme contrast, checked here so a design cannot ship unreadable text.
  const contrastPairs = [
    ["text", "background", "Body text"],
    ["textSecondary", "background", "Secondary text"],
    ["onPrimary", "primary", "Text on primary buttons"],
  ];
  for (const [fg, bg, label] of contrastPairs) {
    const grade = contrastGrade(theme?.colors?.[fg], theme?.colors?.[bg]);
    if (!grade.passes) {
      errors.push({ code: "contrast", title: `${label} fails WCAG AA`, detail: `${grade.text}:1 against its background; 4.5:1 is the minimum.` });
    }
  }
  const tertiary = contrastGrade(theme?.colors?.textTertiary, theme?.colors?.background);
  if (!tertiary.passes) {
    warnings.push({ code: "contrast-soft", title: "Tertiary text is below AA", detail: `${tertiary.text}:1. Acceptable for decorative labels, not for anything a user must read.` });
  }

  return {
    errors,
    warnings,
    stats: { screens: doc.screens.length, nodes: totalNodes, depth: deepest, routes: routes.size },
  };
}

/* ---------------------------------------------------------------------------
   Publish panel
   --------------------------------------------------------------------------- */

export function openPublishPanel(editor, { onPublished } = {}) {
  const result = validateDocument(editor.doc, editor.theme);
  const impact = editor.publishImpact();
  let label = editor.version.label === "Working draft" ? "" : editor.version.label;

  modal(
    (close) => {
      const blocked = result.errors.length > 0;

      return {
        title: blocked ? "Publish blocked" : "Publish this version",
        subtitle: blocked
          ? `${fmt.plural(result.errors.length, "problem")} must be fixed first.`
          : `${editor.design.name} v${editor.version.version_number} becomes live on the next app fetch.`,
        body: [
          /* --- Impact --------------------------------------------------- */
          !blocked &&
            el(
              "div.callout.accent",
              icon("users"),
              el(
                "div",
                impact.users > 0
                  ? [
                      el("b", `This will change the app for ${fmt.plural(impact.users, "user")} across ${fmt.plural(impact.orgs, "organisation")}.`),
                      el("div", { style: { marginTop: "3px" } }, "Rollout completes within the cache TTL, under 60 seconds."),
                    ]
                  : [
                      el("b", "No user sees this version yet."),
                      el(
                        "div",
                        { style: { marginTop: "3px" } },
                        impact.designUsers > 0
                          ? `${fmt.plural(impact.designUsers, "user")} across ${fmt.plural(impact.designOrgs, "organisation")} are on an earlier version of this design. Publishing does not move them — repoint their assignment to this version when you are ready.`
                          : "Nothing is assigned to this design at all, so publishing is safe and changes nothing until you create an assignment.",
                      ),
                    ],
              ),
              impact.users === 0 &&
                impact.designUsers > 0 &&
                el("button.btn.sm.subtle", { onclick: () => { close(); window.location.hash = "#/assignments"; } }, "Open assignments"),
            ),

          /* --- Before and after ----------------------------------------- */
          el(
            "div",
            { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--s-3)" } },
            thumbPane("Currently live", editor.livePreview(), editor.theme),
            thumbPane("This version", editor.screenForThumb(), editor.theme, true),
          ),

          /* --- Validation ------------------------------------------------ */
          el(
            "div.col",
            { style: { gap: "var(--s-2)" } },
            el(
              "div.row",
              el("span.eyebrow", "Validation"),
              el("div.spacer"),
              el("span.dim", { style: { fontSize: "var(--fs-11)" } }, `${result.stats.screens} screens · ${result.stats.nodes} nodes · depth ${result.stats.depth}`),
            ),
            ...(result.errors.length
              ? result.errors.map((issue) => issueRow("error", issue, editor, close))
              : []),
            ...result.warnings.slice(0, 6).map((issue) => issueRow("warn", issue, editor, close)),
            !result.errors.length && !result.warnings.length
              ? issueRow("ok", { title: "Everything checks out", detail: "Routes unique, no dead links, every component known, contrast passes AA." })
              : null,
            result.warnings.length > 6 &&
              el("span.dim", { style: { fontSize: "var(--fs-11)" } }, `and ${result.warnings.length - 6} more warnings`),
          ),

          /* --- Label ------------------------------------------------------ */
          !blocked &&
            el(
              "div.field",
              el("label", "Version label (optional)"),
              el("input.input", {
                placeholder: "e.g. bigger CTA on the job card",
                value: label,
                oninput: (event) => {
                  label = event.target.value;
                },
              }),
              el("span.hint", "Shown in version history and the compare view. Worth writing."),
            ),
        ],
        footer: [
          el("span.dim", { style: { fontSize: "var(--fs-11)" } }, blocked ? "Fix the errors above to continue." : "Published versions are immutable. Editing one forks a new draft."),
          el("div.spacer"),
          el("button.btn.subtle", { onclick: () => close() }, "Cancel"),
          el(
            "button.btn.primary",
            {
              disabled: blocked,
              onclick: () => {
                editor.publish(label);
                close();
                onPublished?.();
              },
            },
            icon("publish"),
            "Publish",
          ),
        ],
      };
    },
    { width: "wide" },
  );
}

function thumbPane(title, screen, theme, highlight = false) {
  const frame = el("div", {
    style: {
      position: "relative",
      height: "210px",
      borderRadius: "var(--r-control)",
      border: `1px solid ${highlight ? "var(--accent-line)" : "var(--line)"}`,
      background: "var(--bg-sunken)",
      overflow: "hidden",
      display: "grid",
      placeItems: "center",
    },
  });

  if (screen) frame.appendChild(renderMiniature(screen, theme, { fit: "width" }));
  else frame.appendChild(el("span.dim", { style: { fontSize: "var(--fs-11)" } }, "Nothing published yet"));

  return el(
    "div.col",
    { style: { gap: "5px" } },
    el("span.eyebrow", title),
    frame,
  );
}

function issueRow(tone, issue, editor, close) {
  const glyph = tone === "error" ? "xCircle" : tone === "warn" ? "alert" : "checkCircle";

  return el(
    `div.validation-row.${tone}`,
    icon(glyph),
    el(
      "div",
      { style: { flex: "1 1 auto", minWidth: 0 } },
      el("b", issue.title),
      issue.detail && el("div", { style: { marginTop: "1px", opacity: 0.9 } }, issue.detail),
    ),
    issue.nodeId &&
      el(
        "button.btn.sm.ghost",
        {
          onclick: () => {
            close?.();
            editor.revealNode(issue.screenId, issue.nodeId);
          },
        },
        "Show",
      ),
  );
}

/* ---------------------------------------------------------------------------
   Version history
   --------------------------------------------------------------------------- */

export function openVersionHistory(editor, { onOpen } = {}) {
  const versions = editor.versions();

  modal(
    (close) =>
      ({
        title: "Version history",
        subtitle: `${editor.design.name} · ${fmt.plural(versions.length, "version")}`,
        body: el(
          "div.timeline-rail",
          ...versions
            .slice()
            .reverse()
            .map((version) => {
              const kind = version.status === "published" ? "publish" : version.status === "rolled_back" ? "rollback" : version.status === "draft" ? "draft" : "archived";
              const isCurrent = version.id === editor.version.id;

              return el(
                "div.timeline-entry",
                { dataset: { kind } },
                el(
                  "div.row",
                  { style: { gap: "var(--s-2)", alignItems: "baseline" } },
                  el("b", { style: { fontSize: "var(--fs-13)" } }, `v${version.version_number}`),
                  el("span", { style: { fontSize: "var(--fs-12)", color: "var(--text-secondary)" } }, version.label || "—"),
                  el(`span.pill.${version.status === "published" ? "success" : version.status === "draft" ? "warning" : ""}`, fmt.label(version.status)),
                  isCurrent && el("span.pill.accent", "Editing"),
                  el("div.spacer"),
                  el("span.dim", { style: { fontSize: "var(--fs-11)" } }, fmt.relative(version.published_at ?? version.created_at)),
                ),
                el(
                  "div.row",
                  { style: { gap: "var(--s-2)", marginTop: "var(--s-1)" } },
                  el(
                    "button.btn.sm.subtle",
                    {
                      disabled: isCurrent,
                      onclick: () => {
                        close();
                        onOpen?.(version.id);
                      },
                    },
                    "Open",
                  ),
                  version.status !== "draft" &&
                    el(
                      "button.btn.sm.ghost",
                      {
                        onclick: async () => {
                          const ok = await confirm({
                            title: `Restore v${version.version_number}?`,
                            message: "This forks a new draft from that version. Nothing live changes until you publish it.",
                            confirmLabel: "Fork a draft",
                          });
                          if (!ok) return;
                          close();
                          const forked = editor.forkFrom(version.id);
                          if (forked) onOpen?.(forked.id);
                        },
                      },
                      icon("gitBranch"),
                      "Fork a draft",
                    ),
                ),
              );
            }),
        ),
        footer: [
          el("div.spacer"),
          el("button.btn.subtle", { onclick: () => close() }, "Close"),
        ],
      }),
    { width: "wide" },
  );
}
