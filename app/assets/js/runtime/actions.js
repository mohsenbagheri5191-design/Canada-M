/**
 * Writes.
 *
 * Only one shape so far, because only one is honest: toggling a task's done
 * state. Everything else in the app reads.
 *
 * Two rules, and both exist because of the same constraint — the layout
 * document decides what is on screen, and the layout document is untrusted
 * input:
 *
 *   · A write names a source id and a column, and both are checked against the
 *     allowlist the server sent. `canWrite` is the server's answer to "may this
 *     role change this column", not the client's guess.
 *
 *   · The change is applied locally first and reverted if the server refuses.
 *     A checkbox that waits for a round trip feels broken on a phone; row-level
 *     security is what actually decides, and it decides on the server either
 *     way, so optimism here costs nothing but a rollback.
 *
 * `tasks_completed_check` is the reason this is not a one-column update. The
 * table requires that `status = 'done'` and `completed_at is not null` agree,
 * so a write that set only one of them would be refused by the database. The
 * two move together here.
 */

import { update } from "../supabase.js";
import { isRefusal } from "./outbox.js";

/** Map a component's task state back to the column the table actually uses. */
const TO_STATUS = { open: "todo", doing: "in_progress", blocked: "blocked", review: "review", done: "done" };

export function createActions({ data, outbox = null, onError = () => {}, telemetry = null }) {
  /**
   * Write one row, or queue it if the server was simply unreachable.
   *
   * The optimistic change stays on screen in that case: it is going to be sent,
   * so taking it away and putting it back when the signal returns would be a
   * worse lie than leaving it. Only an actual refusal rolls back.
   */
  async function writeRow(sourceId, rowId, patch, { rollback, describe }) {
    const table = data.table(sourceId);
    const query = `id=eq.${encodeURIComponent(rowId)}`;

    try {
      await update(table, query, patch);
      return { ok: true };
    } catch (error) {
      if (!isRefusal(error) && outbox) {
        const queued = await outbox.enqueue({ table, query, patch, describe });
        if (queued) return { ok: true, queued: true };
      }
      rollback();
      onError(error);
      return { ok: false, reason: isRefusal(error) ? "refused" : "unreachable", error };
    }
  }

  return {
    /**
     * Toggle a task between done and not-done.
     *
     * @param {string} sourceId  the screen source the row came from
     * @param {string} rowId     the task id
     * @param {boolean} done     the state being moved to
     */
    async setTaskDone(sourceId, rowId, done) {
      const table = data.table(sourceId);
      if (!table) return { ok: false, reason: "unknown-source" };

      if (!data.canWrite(sourceId, "status") || !data.canWrite(sourceId, "completed_at")) {
        // Not an error the user caused, and not one worth a dialogue: the row
        // simply is not theirs to change, and the UI should not have offered.
        return { ok: false, reason: "read-only" };
      }

      const patch = done
        ? { status: "done", completed_at: new Date().toISOString() }
        : { status: TO_STATUS.open, completed_at: null };

      const rollback = data.patchRow(sourceId, rowId, patch);
      if (!rollback) return { ok: false, reason: "row-gone" };

      const result = await writeRow(sourceId, rowId, patch, {
        rollback,
        describe: done ? "Completing a task" : "Reopening a task",
      });
      if (result.ok) telemetry?.tap(rowId, { nodeType: done ? "task.complete" : "task.reopen" });
      return result;
    },

    /** Pin or unpin a note. */
    async setNotePinned(sourceId, rowId, pinned) {
      const table = data.table(sourceId);
      if (!table) return { ok: false, reason: "unknown-source" };
      if (!data.canWrite(sourceId, "pinned")) return { ok: false, reason: "read-only" };

      const rollback = data.patchRow(sourceId, rowId, { pinned });
      if (!rollback) return { ok: false, reason: "row-gone" };

      const result = await writeRow(sourceId, rowId, { pinned }, {
        rollback,
        describe: pinned ? "Pinning a note" : "Unpinning a note",
      });
      if (result.ok) telemetry?.tap(rowId, { nodeType: pinned ? "note.pin" : "note.unpin" });
      return result;
    },
  };
}
