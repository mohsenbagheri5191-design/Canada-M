/**
 * The router.
 *
 * Routes are not in the code — they are in the layout document, which means the
 * set of reachable screens changes when a design is published, with no release.
 * That is the point of the whole system, and it is also why this file is more
 * careful than a router over a fixed table would need to be.
 *
 * Three things it has to get right:
 *
 *   · The current route can vanish. A publish that removes a screen, or a
 *     feature switched off mid-session stripping one, leaves the user standing
 *     on a path that no longer exists. Falling back to the entry screen is the
 *     only safe answer; erroring strands them.
 *
 *   · `requiresRole` is a display rule, not a security boundary. It hides a
 *     screen the user's role should not see, but the data behind it is protected
 *     by row-level security in the database. Hiding is not defending, and this
 *     file is not what stops anyone reading anything.
 *
 *   · Hash routing, so the app works from a file:// build, a static host and an
 *     embedded webview without server rewrites.
 */

const normalise = (path) => {
  const trimmed = String(path ?? "").trim().replace(/[?#].*$/, "");
  if (!trimmed || trimmed === "/") return "/";
  return `/${trimmed.replace(/^\/+|\/+$/g, "")}`;
};

/** The path currently in the address bar. */
export const currentPath = () => normalise(location.hash.replace(/^#/, ""));

export function createRouter({ onNavigate = () => {} } = {}) {
  let screens = [];
  let role = null;
  let active = null;

  const visible = () => screens.filter((s) => !s.requiresRole || s.requiresRole === role);

  const entry = () => visible().find((s) => s.isEntry) ?? visible()[0] ?? null;

  const match = (path) => visible().find((s) => normalise(s.route) === normalise(path)) ?? null;

  function resolve() {
    const path = currentPath();
    const screen = path === "/" ? entry() : match(path);

    if (!screen) {
      const fallback = entry();
      if (!fallback) {
        // No screen is reachable at all. That is a real state — every screen
        // gated behind a role the user does not have — and the shell renders
        // it rather than the router inventing one.
        active = null;
        onNavigate(null, { path, reason: "empty" });
        return;
      }

      // A path that exists in the document but not in the visible set was
      // gated by role; anything else is simply gone.
      const reason = screens.some((s) => normalise(s.route) === path) ? "forbidden" : "unknown";

      // Replace rather than push: a dead path should not sit in history where
      // Back returns the user straight to it.
      location.replace(`#${normalise(fallback.route)}`);
      active = fallback;
      onNavigate(fallback, { path, reason });
      return;
    }

    const previous = active;
    active = screen;
    onNavigate(screen, { path, previous, reason: "match" });
  }

  const onHashChange = () => resolve();

  return {
    get active() {
      return active;
    },

    get screens() {
      return visible();
    },

    /** Point the router at a new document. Safe to call on every publish. */
    setScreens(next, { userRole = null } = {}) {
      screens = Array.isArray(next) ? next : [];
      role = userRole;
      resolve();
    },

    navigate(path, { replace = false } = {}) {
      const target = `#${normalise(path)}`;
      if (location.hash === target) return resolve();
      if (replace) location.replace(target);
      else location.hash = target;
    },

    start() {
      addEventListener("hashchange", onHashChange);
      resolve();
    },

    stop() {
      removeEventListener("hashchange", onHashChange);
    },
  };
}
