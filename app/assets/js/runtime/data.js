/**
 * Data sources.
 *
 * A screen declares what it needs:
 *
 *   screen.sources = [
 *     { id: "dueToday", from: "tasks", where: [["status","neq","done"]],
 *       order: "due_at.asc", limit: 20 }
 *   ]
 *
 * and the rows land at `scope.query.dueToday`, where a binding can reach them.
 *
 * The important part is what this file refuses to do.
 *
 * A layout document is data. It is authored in a dashboard, stored in a table,
 * and handed to the app by a server — which means it must be treated as
 * untrusted input, not as code the app wrote. If `from` were passed through to
 * a URL, a document could name any table the caller's own row-level security
 * happens to permit. For an ordinary user that is bounded. For an org admin it
 * includes `org_settings`, whose `secrets` column is the one thing in this
 * system that must never reach a client.
 *
 * So `from` is resolved against the allowlist the *server* sent alongside the
 * layout, `select` is restricted to the columns that allowlist names, and the
 * filter operators are a fixed set. A source the server did not offer does not
 * become a request — it becomes an empty result and a console warning.
 *
 * This is what the Design Studio already tells the person binding a property:
 * "the document never carries a URL; the server resolves a source id to an
 * endpoint, so a design cannot make the app call somewhere new."
 */

import { select as restSelect } from "../supabase.js";

/** The only filter operators a document may use. PostgREST has many more. */
const OPERATORS = new Set(["eq", "neq", "gt", "gte", "lt", "lte", "like", "ilike", "is", "in", "cs", "not.is"]);

const IDENT = /^[a-z_][a-z0-9_]*$/i;

/**
 * Turn one declared source into a PostgREST query string, or throw with a
 * reason worth logging. Every identifier is checked against the allowlist
 * rather than escaped, because escaping is a way of allowing something through
 * carefully and the goal here is not to allow it at all.
 */
export function buildQuery(source, entity) {
  const columns = Array.isArray(entity.columns) ? entity.columns : [];
  if (!columns.length) throw new Error(`source "${source.id}": the server offered no readable columns`);

  const wanted = Array.isArray(source.select) && source.select.length ? source.select : columns;
  const unknown = wanted.filter((c) => !columns.includes(c));
  if (unknown.length) throw new Error(`source "${source.id}": column(s) not offered by the server: ${unknown.join(", ")}`);

  const params = new URLSearchParams();
  params.set("select", wanted.join(","));

  for (const clause of source.where ?? []) {
    const [column, op, value] = Array.isArray(clause) ? clause : [clause.column, clause.op, clause.value];
    if (!columns.includes(column)) throw new Error(`source "${source.id}": filter on unoffered column "${column}"`);
    if (!OPERATORS.has(op)) throw new Error(`source "${source.id}": operator "${op}" is not permitted`);
    params.append(column, `${op}.${value}`);
  }

  if (source.order) {
    // "column.asc" / "column.desc.nullslast"
    const [column, ...rest] = String(source.order).split(".");
    if (!columns.includes(column)) throw new Error(`source "${source.id}": order by unoffered column "${column}"`);
    const direction = rest.join(".") || "asc";
    if (!/^(asc|desc)(\.nulls(first|last))?$/.test(direction)) throw new Error(`source "${source.id}": bad order "${source.order}"`);
    params.set("order", `${column}.${direction}`);
  }

  // Always bounded. A screen that forgets a limit should not be able to pull a
  // tenant's entire task history onto a phone.
  const limit = Math.min(Math.max(Number(source.limit) || 50, 1), 200);
  params.set("limit", String(limit));

  return params.toString();
}

/**
 * A data provider bound to one resolved layout.
 *
 * Results are held per source id and handed to the renderer through
 * `scope.query`. Fetching is per screen, on navigation, so a five-screen design
 * does not make five round trips on open.
 */
export function createDataProvider({ dataSources = [], onChange = () => {}, onError = () => {} } = {}) {
  const allow = new Map();
  for (const entity of dataSources) {
    if (entity?.id && IDENT.test(entity.id)) allow.set(entity.id, entity);
  }

  const results = new Map();
  const inFlight = new Map();

  /**
   * Which entity each loaded source came from.
   *
   * A screen names its sources for what they mean — "open", "done", "overdue" —
   * and several of them routinely read the same table. Permissions and the
   * table name live on the entity, so a write arriving with a source id has to
   * be resolved back through this before it can ask whether it is allowed.
   * Without it every write silently failed the permission check, because
   * "open" is not a key in the allowlist and never will be.
   */
  const origin = new Map();

  /** What the renderer reads. Always an object, never undefined. */
  const query = () => Object.fromEntries(results);

  const entityFor = (sourceId) => allow.get(origin.get(sourceId) ?? sourceId) ?? null;

  async function fetchSource(source) {
    const entity = allow.get(source.from);
    if (!entity) {
      // Not an exception: a source can legitimately disappear when a feature is
      // switched off, and the screen should render its empty state rather than
      // the app showing an error the user cannot act on.
      console.warn(`[data] source "${source.id}" wants "${source.from}", which the server did not offer`);
      results.set(source.id, []);
      return;
    }

    origin.set(source.id, entity.id);

    let queryString;
    try {
      queryString = buildQuery(source, entity);
    } catch (error) {
      console.warn(`[data] ${error.message}`);
      results.set(source.id, []);
      return;
    }

    try {
      const rows = await restSelect(entity.table, queryString);
      results.set(source.id, Array.isArray(rows) ? rows : []);
    } catch (error) {
      onError(error, source);
      // Keep whatever was there. A failed refresh should not blank a list the
      // user is looking at.
      if (!results.has(source.id)) results.set(source.id, []);
    }
  }

  return {
    query,

    /** The entities this user's app may read, for the Data panel and writes. */
    get entities() {
      return [...allow.values()];
    },

    /**
     * Is this column writable by this user, per the server's own answer?
     * Takes a source id or an entity id; both resolve to the same entity.
     */
    canWrite(sourceId, column) {
      const entity = entityFor(sourceId);
      return Array.isArray(entity?.writable) && entity.writable.includes(column);
    },

    table: (sourceId) => entityFor(sourceId)?.table ?? null,

    /**
     * Load everything a screen declares. Concurrent, because two lists on one
     * screen should not wait for each other, and de-duplicated so a fast
     * back-and-forth between tabs does not stack requests.
     */
    async loadFor(screen) {
      const sources = Array.isArray(screen?.sources) ? screen.sources : [];
      if (!sources.length) return query();

      const key = screen.id;
      if (inFlight.has(key)) return inFlight.get(key);

      const job = Promise.all(sources.map((s) => fetchSource(s)))
        .then(() => {
          onChange(query());
          return query();
        })
        .finally(() => inFlight.delete(key));

      inFlight.set(key, job);
      return job;
    },

    /**
     * Apply a change locally and tell the renderer, before the server has
     * answered. A checkbox that waits for a round trip feels broken on a phone;
     * one that flips immediately and reverts on failure does not.
     */
    patchRow(sourceId, rowId, patch) {
      const rows = results.get(sourceId);
      if (!Array.isArray(rows)) return null;
      const index = rows.findIndex((r) => r.id === rowId);
      if (index === -1) return null;

      const before = rows[index];
      const next = [...rows];
      next[index] = { ...before, ...patch };
      results.set(sourceId, next);
      onChange(query());

      // The caller keeps this to put things back if the write is refused.
      return () => {
        const current = results.get(sourceId) ?? [];
        const at = current.findIndex((r) => r.id === rowId);
        if (at === -1) return;
        const restored = [...current];
        restored[at] = before;
        results.set(sourceId, restored);
        onChange(query());
      };
    },

    /** Drop everything. Used on sign-out and when the layout changes. */
    clear() {
      results.clear();
      origin.clear();
      inFlight.clear();
    },
  };
}
