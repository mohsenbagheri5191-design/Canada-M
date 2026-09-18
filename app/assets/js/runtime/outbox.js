/**
 * The outbox.
 *
 * Writes already apply locally before the server answers, which is what makes
 * a checkbox feel like a checkbox. Offline, that optimism was a lie: the change
 * appeared, the request failed, and the rollback took it away again — so the
 * one situation where a technician most needs to tick something off is the one
 * where ticking it off did nothing.
 *
 * The outbox closes that. A write that fails for a reason that might pass later
 * is kept and retried; a write the server actively refused is not.
 *
 * That distinction is the whole design:
 *
 *   · A network failure, a timeout, a 5xx, a 429 — the server never decided.
 *     Queue it. It will very likely succeed in a minute.
 *   · A 401, 403 or 404 — the server decided, and the answer is no. Retrying
 *     cannot change a permission, and a queue that keeps trying just produces
 *     the same refusal for the rest of the session. Roll back and say so.
 *
 * Entries survive a reload because they live in IndexedDB, which is the point:
 * a phone that loses signal in a basement and gets closed in a van should still
 * deliver its work when it next sees a network.
 */

import * as cache from "./cache.js";
import { update, getUser } from "../supabase.js";

const KEY = (userId) => `outbox:${userId}`;
const MAX_ENTRIES = 200;
const MAX_ATTEMPTS = 8;

/** Did the server decide, or did the request simply not arrive? */
export function isRefusal(error) {
  const status = error?.status;
  // No status at all means fetch itself failed: DNS, offline, TLS, aborted.
  if (!status) return false;
  return status === 400 || status === 401 || status === 403 || status === 404 || status === 409 || status === 422;
}

/** Exponential, capped, so a long outage does not become a busy loop. */
const backoffMs = (attempts) => Math.min(60_000, 1000 * 2 ** Math.min(attempts, 6));

export function createOutbox({ onChange = () => {}, onDrop = () => {} } = {}) {
  let entries = [];
  let loaded = false;
  let timer = null;
  let draining = false;

  const userId = () => getUser()?.id ?? null;

  async function load() {
    if (loaded) return entries;
    const id = userId();
    entries = id ? ((await cache.get(KEY(id))) ?? []) : [];
    loaded = true;
    return entries;
  }

  async function persist() {
    const id = userId();
    if (id) await cache.set(KEY(id), entries);
    onChange(entries.length);
  }

  function schedule(delay = 1000) {
    clearTimeout(timer);
    timer = setTimeout(() => drain(), delay);
  }

  /**
   * Try everything queued, oldest first, stopping at the first entry that is
   * still unreachable — order matters when two writes touch the same row, and
   * skipping ahead would apply them out of sequence.
   */
  async function drain() {
    if (draining || !navigator.onLine) return { sent: 0, kept: entries.length };
    await load();
    if (!entries.length) return { sent: 0, kept: 0 };

    draining = true;
    let sent = 0;

    try {
      while (entries.length) {
        const entry = entries[0];

        // Still backing off. Come back when it is due — without this the queue
        // stalls until something unrelated happens to trigger a drain, which on
        // a phone left in a pocket may be never.
        if (entry.nextAt && entry.nextAt > Date.now()) {
          schedule(Math.max(250, entry.nextAt - Date.now()));
          break;
        }

        try {
          await update(entry.table, entry.query, entry.patch);
          entries.shift();
          sent += 1;
        } catch (error) {
          if (isRefusal(error)) {
            // The server said no. Keeping it would mean asking the same
            // question forever.
            entries.shift();
            onDrop(entry, error);
            continue;
          }

          entry.attempts = (entry.attempts ?? 0) + 1;
          if (entry.attempts >= MAX_ATTEMPTS) {
            entries.shift();
            onDrop(entry, error);
            continue;
          }

          entry.nextAt = Date.now() + backoffMs(entry.attempts);
          schedule(backoffMs(entry.attempts));
          break;
        }
      }
    } finally {
      draining = false;
      await persist();
    }

    return { sent, kept: entries.length };
  }

  return {
    get length() {
      return entries.length;
    },

    load,

    /** Queue a write for later. Returns false if the queue is full. */
    async enqueue({ table, query, patch, describe = "" }) {
      await load();
      if (entries.length >= MAX_ENTRIES) return false;

      // A newer write to the same row supersedes an older one rather than
      // stacking: three taps on one checkbox should send one final state, not
      // three conflicting updates in a row.
      const existing = entries.findIndex((e) => e.table === table && e.query === query);
      if (existing !== -1) {
        entries[existing] = { ...entries[existing], patch: { ...entries[existing].patch, ...patch }, describe };
      } else {
        entries.push({ table, query, patch, describe, queuedAt: Date.now(), attempts: 0 });
      }

      await persist();
      schedule(500);
      return true;
    },

    drain,

    /** Wire the signals that mean "try again now". */
    start() {
      const retry = () => drain();
      addEventListener("online", retry);
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") retry();
      });
      load().then(() => {
        onChange(entries.length);
        if (entries.length) schedule(800);
      });

      return () => {
        removeEventListener("online", retry);
        clearTimeout(timer);
      };
    },

    /** Forget everything. Used on sign-out, where the queue is not portable. */
    async clear() {
      entries = [];
      const id = userId();
      if (id) await cache.remove(KEY(id));
      onChange(0);
    },
  };
}
