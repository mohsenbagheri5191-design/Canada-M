/**
 * The layout provider.
 *
 * One rule decides everything here: **the app renders from cache first, always,
 * and revalidates behind that**. A technician opening the app in a basement
 * should see yesterday's layout instantly, not a spinner that resolves into an
 * error. A layout is not data — it is the shape of the application — so serving
 * a stale one is correct in a way that serving stale records would not be.
 *
 * The cache key includes the user id. Signing out and in as somebody else must
 * not serve the previous tenant's layout, and a key of "layout" would do
 * exactly that on a shared device.
 */

import { rpc, getUser } from "../supabase.js";
import * as cache from "./cache.js";
import { config } from "../config.js";
import { builtinLayout } from "./builtin.js";
import { normaliseTheme } from "./theme.js";

const key = (userId) => `layout:${userId}`;

/** What the app actually renders from. */
function shape(payload, { source, fetchedAt }) {
  const screens = Array.isArray(payload?.screens) ? payload.screens : [];

  // designVersionId null with no screens is the resolver saying "nothing is
  // assigned — use the layout you shipped with". It is a successful answer,
  // not a failure, and it is the only case where the app substitutes its own.
  if (!payload || (payload.designVersionId === null && screens.length === 0)) {
    const builtin = builtinLayout();
    return {
      ...builtin,
      theme: normaliseTheme(builtin.theme),
      // The screens are the app's own, but everything about *this user* still
      // comes from the server. The built-in layout binds to tasks and notes
      // like any other design, so dropping the allowlist here would leave it
      // rendering empty states against data the user can plainly read.
      features: payload?.features ?? builtin.features,
      dataSources: payload?.dataSources ?? [],
      organization: payload?.organization ?? null,
      settings: payload?.settings ?? builtin.settings,
      trace: payload?.trace ?? builtin.trace,
      source,
      fetchedAt,
    };
  }

  return {
    designVersionId: payload.designVersionId ?? null,
    designName: payload.designName ?? "",
    versionNumber: payload.versionNumber ?? null,
    schemaVersion: payload.schemaVersion ?? 1,
    builtIn: false,
    features: payload.features ?? [],
    strippedScreens: payload.strippedScreens ?? [],
    settings: payload.settings ?? {},
    organization: payload.organization ?? null,
    theme: normaliseTheme(payload.theme),
    screens,
    trace: payload.trace ?? [],
    source,
    fetchedAt,
  };
}

/**
 * A layout provider bound to the signed-in user.
 *
 * `onChange` fires whenever the layout the app should be showing changes —
 * once from cache, then again if the network returns something different.
 */
export function createLayoutProvider({ onChange = () => {}, onError = () => {} } = {}) {
  let current = null;
  let inFlight = null;

  const identity = () => getUser()?.id ?? null;

  const publish = (next) => {
    // A revalidation that produces the same version is not a change. Re-rendering
    // on it would discard scroll position and any open state for nothing.
    const same =
      current &&
      current.designVersionId === next.designVersionId &&
      current.versionNumber === next.versionNumber &&
      current.builtIn === next.builtIn;

    current = next;
    if (!same) onChange(next);
    return next;
  };

  async function fetchFresh() {
    const payload = await rpc("resolve_my_layout");
    const next = shape(payload, { source: "network", fetchedAt: Date.now() });
    const userId = identity();
    if (userId) {
      // Store the wire payload, not the shaped one: the shaping (theme merge,
      // built-in substitution) is build-specific, and a newer build must be
      // free to shape an old cached payload differently.
      await cache.set(key(userId), { payload, fetchedAt: next.fetchedAt });
    }
    return publish(next);
  }

  let lastFetchedAt = 0;

  /**
   * Revalidate, but never let a network failure replace a working layout.
   *
   * Unforced calls are throttled: the app revalidates every time it comes back
   * to the foreground, and a user flicking between apps should not produce a
   * request per flick.
   */
  function revalidate({ force = false } = {}) {
    if (!force && Date.now() - lastFetchedAt < config.layoutFreshMs) return Promise.resolve(current);

    inFlight ??= fetchFresh()
      .then((next) => {
        lastFetchedAt = Date.now();
        return next;
      })
      .catch((error) => {
        onError(error);
        return current;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  return {
    get current() {
      return current;
    },

    /**
     * Resolve the layout to render now.
     *
     * Cached: serve it immediately and revalidate behind it. A layout is the
     * shape of the application, so being current matters — every open checks.
     * Nothing cached: the network is the only answer, so wait for it — and if
     * it fails, fall back to the built-in layout rather than to nothing.
     */
    async load() {
      const userId = identity();
      const cached = userId ? await cache.get(key(userId)) : null;

      if (cached?.payload) {
        publish(shape(cached.payload, { source: "cache", fetchedAt: cached.fetchedAt ?? 0 }));
        revalidate({ force: true });
        return current;
      }

      try {
        return await fetchFresh();
      } catch (error) {
        onError(error);
        return publish(shape(null, { source: "builtin", fetchedAt: Date.now() }));
      }
    },

    revalidate,

    /** Drop this user's cached layout. Used on sign-out. */
    async forget() {
      const userId = identity();
      if (userId) await cache.remove(key(userId));
      current = null;
    },
  };
}

export { shape as shapeLayout };
