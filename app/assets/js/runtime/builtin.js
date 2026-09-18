/**
 * The layout that ships with the build.
 *
 * `private.resolve_layout` ends its chain with a step called "App built-in
 * static layout" and returns `screens: []`. That step is only true if the app
 * actually has one. Without this file a user with no assignment — a brand-new
 * tenant, an organisation whose only published design was rolled back — opens
 * the app to a blank screen, and the resolver's last line of defence is a
 * comment rather than a behaviour.
 *
 * So this is deliberately plain and deliberately complete: a working task and
 * note app that needs no network beyond the data calls, using only components
 * from the shared registry, so it renders through exactly the same path as a
 * published design.
 */

const n = (type, props = {}, children = null) => ({ type, props, ...(children ? { children } : {}) });
const pad = (t, r = t, b = t, l = r) => ({ top: t, right: r, bottom: b, left: l });

let counter = 0;
const withIds = (node) => {
  node.id = `builtin_${counter++}`;
  (node.children ?? []).forEach(withIds);
  return node;
};

const page = (children) =>
  n(
    "Stack",
    {
      direction: "vertical",
      gap: 18,
      padding: pad(18, 16, 28, 16),
      background: "{{theme.colors.background}}",
      size: { width: "fill", height: "fill" },
    },
    children,
  );

/**
 * The projections from table columns to component props.
 *
 * Written out rather than inferred, because `tasks.status` is
 * todo/in_progress/blocked/review/done and a TaskRow state is
 * open/doing/done/blocked. Neither vocabulary should bend to the other: the
 * table's belongs to the domain and the component's belongs to the interface,
 * and this is the seam where they meet.
 */
const TASK_MAP = {
  title: "title",
  note: "notes",
  state: {
    from: "status",
    values: { todo: "open", in_progress: "doing", review: "doing", blocked: "blocked", done: "done" },
    fallback: "open",
  },
  priority: {
    from: "priority",
    values: { low: "low", normal: "none", high: "high", urgent: "urgent" },
    fallback: "none",
  },
  due: { from: "due_at", format: "date" },
};

const NOTE_MAP = {
  title: "title",
  body: "body",
  pinned: "pinned",
  meta: { from: "updated_at", format: "date" },
  tags: "labels",
};

const PROJECT_MAP = {
  name: "name",
  client: "description",
  status: { from: "status", values: { planning: "Planning", active: "On track", on_hold: "On hold", done: "Done", cancelled: "Cancelled" } },
  statusTone: { from: "status", values: { planning: "info", active: "success", on_hold: "warning", done: "neutral", cancelled: "danger" }, fallback: "neutral" },
  due: { from: "due_on", format: "date" },
};

/**
 * Screens are built fresh on each call because the renderer stamps ids and the
 * caller may hold more than one copy (the live document and a preview).
 */
export function builtinLayout() {
  counter = 0;

  return {
    designVersionId: null,
    designName: "Built-in",
    versionNumber: 0,
    schemaVersion: 1,
    builtIn: true,
    features: [],
    strippedScreens: [],
    settings: { appName: "Workspace" },
    theme: { palette: "graphite", style: "flat" },
    screens: [
      {
        id: "builtin_today",
        name: "Today",
        route: "/today",
        glyph: "listChecks",
        isEntry: true,
        requiresRole: null,
        sources: [
          { id: "open", from: "tasks", where: [["status", "neq", "done"]], order: "due_at.asc.nullslast", limit: 25 },
          { id: "done", from: "tasks", where: [["status", "eq", "done"]], order: "completed_at.desc", limit: 10 },
        ],
        root: withIds(
          page([
            n("Header", { title: "Today", showBack: false, showAvatar: true, size: { height: 52 } }),
            n("TaskList", {
              title: "Open",
              showCount: true,
              countMode: "total",
              showProgress: false,
              items: { $bind: "query.open", map: TASK_MAP },
              emptyText: "Nothing open. Good.",
            }),
            n("TaskList", {
              title: "Recently done",
              showCount: false,
              showProgress: false,
              items: { $bind: "query.done", map: TASK_MAP },
              emptyText: "Nothing finished yet",
            }),
          ]),
        ),
      },
      {
        id: "builtin_projects",
        name: "Projects",
        route: "/projects",
        glyph: "layers",
        isEntry: false,
        requiresRole: null,
        sources: [{ id: "projects", from: "projects", order: "due_on.asc.nullslast", limit: 25 }],
        root: withIds(
          page([
            n("Header", { title: "Projects", showBack: false, showAvatar: true, size: { height: 52 } }),
            n("Repeater", {
              source: "query.projects",
              component: "ProjectCard",
              map: PROJECT_MAP,
              props: { showRing: false },
              gap: 10,
              emptyText: "No projects yet",
            }),
          ]),
        ),
      },
      {
        id: "builtin_notes",
        name: "Notes",
        route: "/notes",
        glyph: "note",
        isEntry: false,
        requiresRole: null,
        sources: [{ id: "notes", from: "notes", order: "pinned.desc", limit: 30 }],
        root: withIds(
          page([
            n("Header", { title: "Notes", showBack: false, showAvatar: true, size: { height: 52 } }),
            n("Repeater", {
              source: "query.notes",
              component: "NoteCard",
              map: NOTE_MAP,
              props: { excerptLines: 3, showAccentBar: false },
              gap: 10,
              emptyText: "No notes yet",
            }),
          ]),
        ),
      },
    ],
    trace: [{ step: "App built-in static layout", detail: "shipped with the build", hit: true }],
  };
}
