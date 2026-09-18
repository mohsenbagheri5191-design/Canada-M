/**
 * Path events, batched.
 *
 * This is what fills the dashboard's Paths tab. It is also the easiest part of
 * a client to get wrong in a way that hurts the user rather than the data, so
 * the rules here are all about staying out of the way:
 *
 *   · Never block a navigation on a network call. Events queue and flush later.
 *   · Never grow without bound. A device offline for a day must not accumulate
 *     a megabyte of queued screen views; the queue is capped and drops the
 *     oldest, because recent behaviour is the part anyone looks at.
 *   · Never retry forever. A flush that fails puts its events back once; a
 *     second failure drops them. Telemetry is not worth a retry storm.
 *   · Never send in preview. A stakeholder clicking through a draft is not a
 *     user, and counting them corrupts the only numbers the tab reports.
 */

import { insert, getUser } from "../supabase.js";
import { config } from "../config.js";

const sessionId = `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;

export function createTelemetry({ enabled = true } = {}) {
  let queue = [];
  let timer = null;
  let context = { designVersionId: null, organizationId: null };
  let enteredAt = 0;
  let currentPath = null;

  const flushable = () => enabled && queue.length > 0 && getUser();

  function schedule() {
    if (!enabled || timer) return;
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, config.telemetryFlushMs);
  }

  function push(event) {
    if (!enabled) return;
    const user = getUser();
    if (!user) return;

    queue.push({
      tries: 0,
      row: {
        user_id: user.id,
        organization_id: context.organizationId,
        design_version_id: context.designVersionId,
        session_id: sessionId,
        occurred_at: new Date().toISOString(),
        ...event,
      },
    });

    if (queue.length > config.telemetryMaxQueue) {
      queue = queue.slice(-config.telemetryMaxQueue);
    }

    if (queue.length >= config.telemetryBatchSize) flush();
    else schedule();
  }

  async function flush({ keepalive = false } = {}) {
    if (!flushable()) return;

    // The queue holds { row, tries } rather than rows, because the retry count
    // must not travel to the server: an extra key on the payload is a column
    // PostgREST does not know and rejects the whole batch over.
    const batch = queue;
    queue = [];
    clearTimeout(timer);
    timer = null;

    try {
      await insert("path_events", batch.map((e) => e.row), { keepalive });
    } catch {
      // One retry, by putting them back at the front. If the next flush fails
      // too they are gone — a queue that never empties is worse than a gap in
      // a chart.
      const again = batch.filter((e) => e.tries < 1).map((e) => ({ row: e.row, tries: e.tries + 1 }));
      if (again.length) {
        queue = [...again, ...queue].slice(-config.telemetryMaxQueue);
        schedule();
      }
    }
  }

  return {
    sessionId,

    /** Called whenever the resolved layout changes. */
    setContext({ designVersionId = null, organizationId = null } = {}) {
      context = { designVersionId, organizationId };
    },

    /**
     * A screen was shown. Records the dwell time on the one being left, which
     * is the only place the previous screen's duration is knowable.
     */
    screenView(path, { screenId = null } = {}) {
      if (currentPath && currentPath !== path) {
        push({ route_path: currentPath, event: "exit", dwell_ms: Math.max(0, Date.now() - enteredAt) });
      }
      currentPath = path;
      enteredAt = Date.now();
      push({ route_path: path, event: "view", node_id: screenId, metadata: {} });
    },

    /** A node was tapped. */
    tap(nodeId, { nodeType = null } = {}) {
      push({ route_path: currentPath, event: "tap", node_id: nodeId, metadata: nodeType ? { type: nodeType } : {} });
    },

    /** A screen failed to render. Worth knowing about more than any tap. */
    renderError(path, message) {
      push({ route_path: path, event: "error", metadata: { message: String(message).slice(0, 500) } });
    },

    flush,

    /**
     * Wire the page lifecycle.
     *
     * `visibilitychange` to hidden is the reliable signal on mobile — `unload`
     * and `beforeunload` do not fire when the OS kills a backgrounded tab, so
     * a flush that waits for them loses the end of most sessions.
     */
    start() {
      if (!enabled) return () => {};

      const onHide = () => {
        if (document.visibilityState !== "hidden") return;
        if (currentPath) {
          push({ route_path: currentPath, event: "exit", dwell_ms: Math.max(0, Date.now() - enteredAt) });
        }
        flush({ keepalive: true });
      };

      document.addEventListener("visibilitychange", onHide);
      addEventListener("pagehide", onHide);

      return () => {
        document.removeEventListener("visibilitychange", onHide);
        removeEventListener("pagehide", onHide);
        clearTimeout(timer);
      };
    },
  };
}
