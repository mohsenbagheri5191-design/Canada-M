/**
 * The shell.
 *
 * Everything visible is either the renderer's output or one of the few states
 * the renderer cannot express: signing in, a screen that failed, no reachable
 * screen, offline. Those are written here as plain DOM rather than as layout
 * documents, because a state whose job is to appear when the layout system is
 * broken cannot itself depend on the layout system.
 */

import { el, renderScreen, icon } from "./shared.js";
import { applyTheme } from "./runtime/theme.js";
import { currentPath } from "./runtime/router.js";

/* ---------------------------------------------------------------------------
   States the renderer cannot express
   --------------------------------------------------------------------------- */

function notice({ glyph, title, body, action = null, tone = "text" }) {
  return el(
    "div.notice",
    el("div.notice-mark", { dataset: { tone } }, icon(glyph, 26)),
    el("h1.notice-title", title),
    body ? el("p.notice-body", body) : null,
    action,
  );
}

const button = (label, onclick, variant = "primary") =>
  el("button.app-btn", { type: "button", dataset: { variant }, onclick }, label);

/* ---------------------------------------------------------------------------
   The screen host
   --------------------------------------------------------------------------- */

/**
 * Render one screen inside an error boundary.
 *
 * The shared renderer already refuses to throw for a single bad component: with
 * `editable: false` an unknown type renders nothing and a component that throws
 * is dropped. What it cannot catch is a failure above that — a malformed screen
 * object, a theme missing something the surface resolver dereferences, a root
 * that is not a node. Those take the whole screen down, and on a phone that is
 * a white page with no way back.
 *
 * So the boundary is here, per screen: a failure shows what failed and offers
 * the two things that actually recover it — try again, or go to the entry
 * screen — and leaves the rest of the app navigable.
 */
export function renderScreenSafely(screen, { theme, scope, onError, onRetry, onHome }) {
  try {
    const node = renderScreen(screen, { theme, scope, editable: false });

    // A screen that renders to nothing is not an error, but it is indistinguishable
    // from one for the person holding the phone. Say so rather than showing a
    // blank page they will assume is still loading.
    if (!node.firstChild) {
      return notice({
        glyph: "box",
        title: "Nothing on this screen",
        body: `"${screen?.name ?? "This screen"}" has no content in the published design.`,
        action: onHome ? button("Go to the start", onHome, "subtle") : null,
      });
    }
    return node;
  } catch (error) {
    console.error("[app] screen failed to render", screen?.id, error);
    onError?.(error);

    return notice({
      glyph: "alertCircle",
      tone: "danger",
      title: "This screen could not be shown",
      body: error?.message ? String(error.message) : "Something in the published design is not renderable.",
      action: el(
        "div.notice-actions",
        onRetry ? button("Try again", onRetry) : null,
        onHome ? button("Go to the start", onHome, "subtle") : null,
      ),
    });
  }
}

/* ---------------------------------------------------------------------------
   Chrome
   --------------------------------------------------------------------------- */

/** A tab bar built from the document's own screens, not from a component. */
function tabBar(screens, activeRoute, navigate) {
  if (screens.length < 2) return null;

  const bar = el("nav.tabbar", { "aria-label": "Sections" });
  for (const screen of screens.slice(0, 5)) {
    const active = screen.route === activeRoute;
    bar.appendChild(
      el(
        "button.tab",
        {
          type: "button",
          dataset: { active: String(active) },
          "aria-current": active ? "page" : null,
          onclick: () => navigate(screen.route),
        },
        el("span.tab-glyph", icon(screen.glyph || "square", 19)),
        el("span.tab-label", screen.name ?? screen.route),
      ),
    );
  }
  return bar;
}

/* ---------------------------------------------------------------------------
   The app
   --------------------------------------------------------------------------- */

export function createApp({ root, router, telemetry, onSignOut, onRetry }) {
  // Set after construction and replaced whenever the layout's allowlist
  // changes, so they are held in a variable rather than destructured — a getter
  // on the argument object would be read once, at destructuring time, and
  // capture the undefined that existed before the first layout arrived.
  let data = null;
  let actions = null;
  const stage = el("main.stage", { id: "stage" });
  const banners = el("div.banners");
  const chrome = el("div.chrome");

  root.replaceChildren(banners, stage, chrome);

  let layout = null;
  let banner = null;

  /**
   * Taps are delegated from the stage rather than bound per node.
   *
   * The registry's components are pure functions of props — they have to be,
   * because the studio renders them too and a component that opened a socket
   * would do it inside the editor. So a component marks a control with
   * `data-action` and the row it belongs to with `data-row`, and the meaning of
   * that mark lives here, where the network does.
   */
  async function onStageActivate(event) {
    const control = event.target.closest?.("[data-action]");
    if (!control || !actions) return;

    const host = control.closest("[data-row]");
    const rowId = host?.dataset.row;
    const sourceId = host?.dataset.source;
    if (!rowId || !sourceId) return;

    event.preventDefault();
    control.setAttribute("aria-busy", "true");

    const pressed = control.getAttribute("aria-pressed") === "true";
    const result =
      control.dataset.action === "task.toggle"
        ? await actions.setTaskDone(sourceId, rowId, !pressed)
        : control.dataset.action === "note.pin"
          ? await actions.setNotePinned(sourceId, rowId, !pressed)
          : { ok: false, reason: "unknown-action" };

    control.removeAttribute("aria-busy");

    if (!result.ok && result.reason === "refused") {
      showBanner("warn", "That change could not be saved.");
    } else if (!result.ok && result.reason === "read-only") {
      showBanner("info", "You do not have permission to change that.");
    }
  }

  stage.addEventListener("click", onStageActivate);
  stage.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    if (!event.target.closest?.("[data-action]")) return;
    onStageActivate(event);
  });

  function showBanner(kind, text, action = null) {
    if (banner?.kind === kind && banner?.text === text) return;
    banner = { kind, text };
    banners.replaceChildren(
      el(
        "div.banner",
        { dataset: { kind } },
        el("span.banner-text", text),
        action,
        el("button.banner-close", { type: "button", "aria-label": "Dismiss", onclick: clearBanner }, icon("close", 13)),
      ),
    );
  }

  function clearBanner() {
    banner = null;
    banners.replaceChildren();
  }

  function paint(screen, meta = {}) {
    if (!layout) return;

    if (!screen) {
      stage.replaceChildren(
        notice({
          glyph: "lock",
          title: "Nothing to show",
          body: "No screen in this design is available to your account.",
          action: onSignOut ? button("Sign out", onSignOut, "subtle") : null,
        }),
      );
      chrome.replaceChildren();
      return;
    }

    if (meta.reason === "unknown" || meta.reason === "forbidden") {
      // The user asked for a path that is gone or gated. The router has already
      // moved them to the entry screen; say why so it is not a silent jump.
      showBanner(
        "info",
        meta.reason === "forbidden"
          ? "That screen is not available to your account."
          : "That screen is no longer part of this app.",
      );
    }

    draw(screen, { resetScroll: true });

    chrome.replaceChildren(tabBar(router.screens, screen.route, (path) => router.navigate(path)) ?? el("span"));
    telemetry?.screenView(screen.route, { screenId: screen.id });

    // Rows arrive after the first paint. The screen is already on screen with
    // its empty states showing, which is the right thing to look at while a
    // query runs — better than a spinner that hides the shape of the page.
    data?.loadFor(screen);
  }

  /**
   * Paint the active screen from the current layout and data.
   *
   * Separate from `paint` so a data update can redraw without re-running
   * navigation: re-recording a screen view every time a checkbox flips would
   * make the Paths tab count taps as visits.
   */
  function draw(screen, { resetScroll = false } = {}) {
    if (!layout || !screen) return;
    const offset = stage.scrollTop;

    const body = renderScreenSafely(screen, {
      theme: layout.theme,
      scope: {
        user: profile ?? {},
        org: layout.settings ?? {},
        route: { params: {} },
        query: data?.query() ?? {},
      },
      onError: (error) => telemetry?.renderError(screen.route, error?.message ?? "render failed"),
      onRetry,
      onHome: () => router.navigate("/", { replace: true }),
    });

    stage.replaceChildren(body);
    stage.scrollTop = resetScroll ? 0 : offset;
  }

  let profile = null;

  return {
    /** The signed-in user, for `scope.user` in bindings. */
    setProfile(next) {
      profile = next;
    },

    /** The data provider and writes for the current layout's allowlist. */
    setRuntime({ data: nextData = null, actions: nextActions = null } = {}) {
      data = nextData;
      actions = nextActions;
    },

    /** Redraw the active screen in place, without re-recording a screen view. */
    redraw() {
      draw(router.active);
    },

    /** Point the app at a resolved layout. Safe to call on every revalidation. */
    setLayout(next, { userRole = null } = {}) {
      const changed = layout && layout.designVersionId !== next.designVersionId;
      layout = next;

      applyTheme(next.theme);
      telemetry?.setContext({
        designVersionId: next.designVersionId,
        organizationId: next.organization?.id ?? null,
      });

      router.setScreens(next.screens, { userRole });

      if (changed) {
        showBanner("info", next.builtIn ? "Using the built-in layout." : `Updated to ${next.designName || "a new design"}.`);
      }
    },

    paint,
    showBanner,
    clearBanner,

    /** The full-screen states that replace everything. */
    replaceWith(node) {
      banners.replaceChildren();
      chrome.replaceChildren();
      stage.replaceChildren(node);
    },

    get path() {
      return currentPath();
    },
  };
}

export { notice, button };
