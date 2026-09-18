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
        root: withIds(
          page([
            n("Header", { title: "Today", showBack: false, showAvatar: true, size: { height: 52 } }),
            n("TaskList", { title: "Due today", showCount: true, showProgress: true }),
            n("TaskList", {
              title: "Later",
              showProgress: false,
              items: [
                { title: "Plan the week", state: "open", priority: "none", due: "Mon", assignee: "" },
              ],
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
        root: withIds(
          page([
            n("Header", { title: "Projects", showBack: false, showAvatar: true, size: { height: 52 } }),
            n("SearchBar", { placeholder: "Search projects", showFilter: false }),
            n("ProjectCard", { showRing: false }),
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
        root: withIds(
          page([
            n("Header", { title: "Notes", showBack: false, showAvatar: true, size: { height: 52 } }),
            n("SearchBar", { placeholder: "Search notes", showFilter: false }),
            n("NoteCard", {}),
          ]),
        ),
      },
    ],
    trace: [{ step: "App built-in static layout", detail: "shipped with the build", hit: true }],
  };
}
