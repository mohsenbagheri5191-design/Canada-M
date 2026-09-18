/**
 * Boot.
 *
 * The order matters and is not obvious, so it is written out:
 *
 *   1. Preview first. A preview link must work for somebody with no account,
 *      so it cannot wait on a session check.
 *   2. Session. No session means the sign-in screen and nothing else.
 *   3. Layout, from cache if there is one, so the first paint does not wait on
 *      the network.
 *   4. Router, over the screens the layout actually contains.
 *   5. Telemetry last, because nothing else should depend on it.
 */

import { el, defaultTheme } from "./shared.js";
import { getUser, onAuthChange, signOut, select } from "./supabase.js";
import { createApp, notice, button } from "./app.js";
import { createRouter } from "./runtime/router.js";
import { createLayoutProvider } from "./runtime/layout.js";
import { createDataProvider } from "./runtime/data.js";
import { createActions } from "./runtime/actions.js";
import { createTelemetry } from "./runtime/telemetry.js";
import { applyTheme } from "./runtime/theme.js";
import { previewToken, resolvePreview, PREVIEW_REASONS } from "./runtime/preview.js";
import { signInScreen } from "./screens/signin.js";

const root = document.getElementById("app");

// Something readable is on screen before any await resolves. A white page while
// IndexedDB opens is indistinguishable from a broken app.
applyTheme(defaultTheme());

let app = null;
let telemetry = null;
let provider = null;
let profile = null;
let data = null;
let actions = null;

const router = createRouter({ onNavigate: (screen, meta) => app?.paint(screen, meta) });

/* ---------------------------------------------------------------------------
   Modes
   --------------------------------------------------------------------------- */

async function startPreview(token) {
  document.body.dataset.mode = "preview";

  // No telemetry in preview, and the provider is never constructed: there is
  // no session to resolve a layout for.
  telemetry = createTelemetry({ enabled: false });
  app = createApp({ root, router, telemetry, onRetry: () => location.reload() });

  try {
    const layout = await resolvePreview(token);
    // A preview has no session, so it has no readable sources: resolve_preview
    // returns a layout only. Bound lists render their empty state, which is the
    // honest thing to show a reviewer who is not in the tenant.
    app.setRuntime({ data: createDataProvider({ dataSources: [] }), actions: null });
    app.setLayout(layout);
    app.showBanner("preview", `Preview · ${layout.designName}${layout.versionNumber ? ` v${layout.versionNumber}` : ""} · read only`);
    router.start();
  } catch (error) {
    app.replaceWith(
      notice({
        glyph: "alertCircle",
        tone: "danger",
        title: "Preview unavailable",
        body: PREVIEW_REASONS[error.reason] ?? PREVIEW_REASONS.invalid,
      }),
    );
  }
}

function startSignIn() {
  document.body.dataset.mode = "signin";
  applyTheme(defaultTheme());
  root.replaceChildren(signInScreen({ onSignedIn: () => start() }));
}

async function startApp() {
  document.body.dataset.mode = "app";

  telemetry = createTelemetry({ enabled: true });
  const stopTelemetry = telemetry.start();

  app = createApp({
    root,
    router,
    telemetry,
    onSignOut: () => leave(),
    onRetry: () => provider?.revalidate({ force: true }),
  });

  provider = createLayoutProvider({
    onChange: (layout) => {
      // The allowlist travels with the layout, so the provider is rebuilt
      // whenever it changes — a feature switched off must take its data source
      // away at the same moment it takes its screens away.
      data = createDataProvider({
        dataSources: layout.dataSources ?? [],
        onChange: () => app.redraw(),
        onError: (error, source) => console.warn(`[app] source "${source?.id}" failed`, error),
      });
      actions = createActions({
        data,
        telemetry,
        onError: (error) => console.warn("[app] write failed", error),
      });

      app.setRuntime({ data, actions });
      app.setLayout(layout, { userRole: profile?.role ?? null });
      app.paint(router.active, { reason: "match" });
    },
    onError: (error) => {
      console.warn("[app] layout revalidation failed", error);
      // Only worth telling the user if there is nothing on screen; otherwise
      // they are looking at a perfectly good cached layout.
      if (!provider?.current) app.showBanner("warn", "Could not reach the server.");
      else app.showBanner("warn", "Showing the last layout you downloaded.");
    },
  });

  // The role gates which screens the router will show. Fetching it is allowed
  // to fail — the user then sees the ungated screens, which is the safe
  // direction to be wrong in, since the database is what protects the data.
  try {
    const rows = await select("app_users", `id=eq.${getUser().id}&select=role,full_name,organization_id&limit=1`);
    profile = rows?.[0] ?? null;
  } catch {
    profile = null;
  }
  app.setProfile(profile);

  await provider.load();
  router.start();

  // Coming back to the foreground is the moment a publish is most likely to
  // have happened since the app was last looked at.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") provider.revalidate();
  });

  addEventListener("online", () => provider.revalidate({ force: true }));
  addEventListener("offline", () => app.showBanner("warn", "Offline. Showing the layout you already have."));

  return () => {
    stopTelemetry();
    router.stop();
  };
}

async function leave() {
  await telemetry?.flush();
  data?.clear();
  await provider?.forget();
  await signOut();
  location.hash = "";
  start();
}

/* ---------------------------------------------------------------------------
   Entry
   --------------------------------------------------------------------------- */

async function start() {
  const token = previewToken();
  if (token) return startPreview(token);
  if (!getUser()) return startSignIn();

  try {
    return await startApp();
  } catch (error) {
    console.error("[app] failed to start", error);
    root.replaceChildren(
      notice({
        glyph: "alertCircle",
        tone: "danger",
        title: "The app could not start",
        body: error?.message ?? "",
        action: el("div.notice-actions", button("Try again", () => location.reload()), button("Sign out", () => leave(), "subtle")),
      }),
    );
  }
}

// A sign-out from anywhere — including a refresh that failed — returns to the
// sign-in screen rather than leaving a dead shell on screen.
onAuthChange((session) => {
  if (!session && document.body.dataset.mode === "app") startSignIn();
});

start();
