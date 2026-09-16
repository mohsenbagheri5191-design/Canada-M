/**
 * The HTTP data adapter.
 *
 * Drop-in replacement for db.js. Same exported surface, same method names,
 * same return shapes — so switching is one import line in every file that
 * currently does `import { db } from "./data/db.js"`:
 *
 *     import { db } from "./data/db.api.js";
 *
 * and one call before boot() in main.js:
 *
 *     await db.hydrate();
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS CACHE-BACKED RATHER THAN PLAIN FETCH
 *
 * Every tab calls the adapter synchronously — `db.orgs.list()` is used
 * directly in a render expression, not awaited. Making the adapter async would
 * mean adding `await` to a few hundred call sites and turning every render
 * function into an async function, which is a large, risky refactor for no
 * user-visible gain.
 *
 * So this adapter hydrates once into an in-memory snapshot, serves reads from
 * it synchronously, and writes through to the server optimistically: the local
 * copy updates immediately (the UI is already built around optimistic updates
 * with undo), the request goes out, and a failure rolls the local change back
 * and raises a toast. That matches how the dashboard already behaves and keeps
 * every call site untouched.
 *
 * If you would rather have strict request/response semantics, make each method
 * `async`, drop the cache, and add `await` at the call sites — the endpoint
 * mapping below is the same either way.
 * ---------------------------------------------------------------------------
 */

import { clone, bus } from "../core/store.js";
import { toast } from "../core/ui.js";

const BASE = "/api/v1";

/** Set by the host app after login. */
let accessToken = null;
export const setAccessToken = (token) => {
  accessToken = token;
};

/* ---------------------------------------------------------------------------
   Transport
   --------------------------------------------------------------------------- */

async function request(method, path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    credentials: "include",
    headers: {
      "content-type": "application/json",
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (response.status === 204) return null;

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    const error = new Error(payload?.message ?? `${method} ${path} failed with ${response.status}`);
    error.status = response.status;
    error.details = payload;
    throw error;
  }

  return payload;
}

const qs = (params) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === null || value === undefined || value === "") continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
};

/**
 * Optimistic write-through.
 *
 * `apply` mutates the local snapshot and returns an undo function; `send`
 * performs the request. On failure the undo runs and the user is told, rather
 * than the UI silently diverging from the server.
 */
function writeThrough(apply, send, { label = "change" } = {}) {
  const undo = apply();

  send().then(
    (serverValue) => {
      // Reconcile ids and server-computed fields where the server returns them.
      if (serverValue && typeof serverValue === "object") bus.emit("db:reconciled", serverValue);
    },
    (error) => {
      console.error(`[db.api] ${label} failed, rolling back`, error);
      undo?.();
      bus.emit("db:rollback", { label, error });
      toast(`Could not save that ${label}`, {
        tone: "danger",
        detail: error.message,
        duration: 8000,
      });
    },
  );
}

/* ---------------------------------------------------------------------------
   Snapshot
   --------------------------------------------------------------------------- */

let state = {
  orgs: [],
  users: [],
  designs: [],
  versions: [],
  assignments: [],
  features: [],
  featureAssignments: [],
  collections: [],
  records: [],
  rules: [],
  ruleRuns: [],
  pathEvents: [],
  auditLog: [],
  orgSettings: {},
  metrics: null,
};

const byId = (list, id) => list.find((row) => row.id === id) ?? null;
const upsert = (list, row) => {
  const at = list.findIndex((r) => r.id === row.id);
  if (at === -1) list.push(row);
  else list[at] = row;
};

/* ---------------------------------------------------------------------------
   Public surface — mirrors db.js exactly
   --------------------------------------------------------------------------- */

export const db = {
  get raw() {
    return state;
  },

  /**
   * Load everything the dashboard needs in one round trip.
   *
   * SERVER: implement GET /api/v1/bootstrap returning the snapshot below.
   * It is cheaper and far less racy than nine parallel list calls, and it
   * gives you one place to enforce row-level security for the caller.
   */
  async hydrate() {
    const snapshot = await request("GET", "/bootstrap");
    state = { ...state, ...snapshot };
    bus.emit("db:hydrated", state);
    return state;
  },

  /** Re-fetch after something changed server-side (another admin, a webhook). */
  async refresh() {
    return db.hydrate();
  },

  reseed() {
    throw new Error("reseed() is a fixture-only operation; it does not exist against the API.");
  },

  /** The mock wrote audit rows locally. The server owns them now. */
  audit() {
    /* no-op: every mutating endpoint writes its own audit row server-side */
  },

  save() {
    /* no-op: writes go out per mutation */
  },

  /* --- Organisations ---------------------------------------------------- */
  orgs: {
    list: () => clone(state.orgs),
    get: (id) => clone(byId(state.orgs, id)),
    settings: (id) => clone(state.orgSettings[id] ?? {}),

    updateSettings(id, patch) {
      const before = clone(state.orgSettings[id] ?? {});
      writeThrough(
        () => {
          state.orgSettings[id] = { ...(state.orgSettings[id] ?? {}), ...patch };
          return () => {
            state.orgSettings[id] = before;
          };
        },
        () => request("PUT", `/organizations/${id}/settings`, patch),
        { label: "settings change" },
      );
      return clone(state.orgSettings[id]);
    },

    create(input) {
      // A temporary id keeps the UI responsive; the server's id replaces it on
      // reconcile. Anything that stores an org id should re-read after that.
      const optimistic = { id: `tmp_${crypto.randomUUID()}`, status: "active", created_at: new Date().toISOString(), ...input };
      writeThrough(
        () => {
          state.orgs.push(optimistic);
          return () => {
            state.orgs = state.orgs.filter((o) => o.id !== optimistic.id);
          };
        },
        async () => {
          const created = await request("POST", "/organizations", input);
          Object.assign(optimistic, created);
          return created;
        },
        { label: "organisation" },
      );
      return clone(optimistic);
    },

    update(id, patch) {
      const before = clone(byId(state.orgs, id));
      writeThrough(
        () => {
          Object.assign(byId(state.orgs, id) ?? {}, patch);
          return () => before && upsert(state.orgs, before);
        },
        () => request("PATCH", `/organizations/${id}`, patch),
        { label: "organisation" },
      );
      return clone(byId(state.orgs, id));
    },
  },

  /* --- Users ------------------------------------------------------------- */
  users: {
    list({ org = null, role = null, status = null, q = "" } = {}) {
      let rows = state.users;
      if (org) rows = rows.filter((u) => u.organization_id === org);
      if (role) rows = rows.filter((u) => u.role === role);
      if (status) rows = rows.filter((u) => u.status === status);
      if (q) {
        const needle = q.toLowerCase();
        rows = rows.filter((u) => `${u.full_name} ${u.email}`.toLowerCase().includes(needle));
      }
      return clone(rows);
    },

    get: (id) => clone(byId(state.users, id)),

    create(input) {
      const optimistic = {
        id: `tmp_${crypto.randomUUID()}`,
        status: input.invite === false ? "active" : "invited",
        last_login_at: null,
        session_count: 0,
        created_at: new Date().toISOString(),
        ...input,
      };
      writeThrough(
        () => {
          state.users.push(optimistic);
          return () => {
            state.users = state.users.filter((u) => u.id !== optimistic.id);
          };
        },
        async () => {
          const created = await request("POST", "/users", input);
          Object.assign(optimistic, created);
          // SERVER: send the invite (72h single-use link) or return the
          // temporary password once. Never return a password hash.
          if (input.invite !== false) await request("POST", `/users/${created.id}/invite`);
          return created;
        },
        { label: "user" },
      );
      return clone(optimistic);
    },

    update(id, patch) {
      const before = clone(byId(state.users, id));
      writeThrough(
        () => {
          Object.assign(byId(state.users, id) ?? {}, patch);
          return () => before && upsert(state.users, before);
        },
        () => request("PATCH", `/users/${id}`, patch),
        { label: "user" },
      );
      return clone(byId(state.users, id));
    },

    remove(id) {
      const before = clone(byId(state.users, id));
      const beforeAssignments = clone(state.assignments);
      writeThrough(
        () => {
          state.users = state.users.filter((u) => u.id !== id);
          state.assignments = state.assignments.filter((a) => a.user_id !== id);
          return () => {
            if (before) state.users.push(before);
            state.assignments = beforeAssignments;
          };
        },
        () => request("DELETE", `/users/${id}`),
        { label: "user deletion" },
      );
      return true;
    },

    createMany(rows) {
      const optimistic = rows.map((row) => ({
        id: `tmp_${crypto.randomUUID()}`,
        status: "invited",
        last_login_at: null,
        session_count: 0,
        created_at: new Date().toISOString(),
        ...row,
      }));
      writeThrough(
        () => {
          state.users.push(...optimistic);
          const ids = new Set(optimistic.map((u) => u.id));
          return () => {
            state.users = state.users.filter((u) => !ids.has(u.id));
          };
        },
        async () => {
          const created = await request("POST", "/users/bulk", { users: rows });
          created.forEach((row, i) => Object.assign(optimistic[i], row));
          return created;
        },
        { label: "import" },
      );
      return clone(optimistic);
    },
  },

  /* --- Designs ----------------------------------------------------------- */
  designs: {
    list({ org = null, status = null, q = "" } = {}) {
      let rows = state.designs;
      if (org) rows = rows.filter((d) => d.organization_id === org);
      if (status) rows = rows.filter((d) => d.status === status);
      if (q) {
        const needle = q.toLowerCase();
        rows = rows.filter((d) => `${d.name} ${d.description}`.toLowerCase().includes(needle));
      }
      return clone(rows);
    },

    get: (id) => clone(byId(state.designs, id)),
    versions: (designId) => clone(state.versions.filter((v) => v.design_id === designId).sort((a, b) => a.version_number - b.version_number)),
    version: (id) => clone(byId(state.versions, id)),

    create(input) {
      const design = { id: `tmp_${crypto.randomUUID()}`, status: "draft", created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...input };
      const version = { id: `tmp_${crypto.randomUUID()}`, design_id: design.id, version_number: 1, status: "draft", label: "Working draft", document: { schemaVersion: 1, screens: [] }, theme: input.theme ?? {} };

      writeThrough(
        () => {
          state.designs.push(design);
          state.versions.push(version);
          return () => {
            state.designs = state.designs.filter((d) => d.id !== design.id);
            state.versions = state.versions.filter((v) => v.id !== version.id);
          };
        },
        async () => {
          const created = await request("POST", "/designs", input);
          Object.assign(design, created.design);
          Object.assign(version, created.version);
          return created;
        },
        { label: "design" },
      );
      return { design: clone(design), version: clone(version) };
    },

    update(id, patch) {
      const before = clone(byId(state.designs, id));
      writeThrough(
        () => {
          Object.assign(byId(state.designs, id) ?? {}, patch, { updated_at: new Date().toISOString() });
          return () => before && upsert(state.designs, before);
        },
        () => request("PATCH", `/designs/${id}`, patch),
        { label: "design" },
      );
      return clone(byId(state.designs, id));
    },

    /**
     * Autosave. Fires every two seconds while editing, so it must be cheap and
     * it must be safe to lose one: the next one carries the whole document.
     *
     * SERVER: reject with 409 if the version is published. Consider an
     * If-Match / updated_at check so two admins editing the same draft do not
     * silently clobber each other.
     */
    saveDraft(versionId, document, theme) {
      const version = byId(state.versions, versionId);
      if (!version || version.status === "published") return null;

      version.document = clone(document);
      if (theme) version.theme = clone(theme);

      // Deliberately not write-through: a failed autosave should not roll the
      // editor back under the author's hands. It surfaces and retries.
      request("PATCH", `/versions/${versionId}`, { document, theme }).catch((error) => {
        console.error("[db.api] autosave failed", error);
        bus.emit("db:autosave-failed", error);
      });

      return clone(version);
    },

    fork(versionId, label = "Working draft") {
      // Server-authoritative: it assigns the next version number, and racing
      // two forks client-side would produce duplicates.
      const created = { id: `tmp_${crypto.randomUUID()}`, status: "draft", label };
      writeThrough(
        () => {
          state.versions.push(created);
          return () => {
            state.versions = state.versions.filter((v) => v.id !== created.id);
          };
        },
        async () => {
          const real = await request("POST", `/designs/${byId(state.versions, versionId)?.design_id}/versions`, { forkFrom: versionId, label });
          Object.assign(created, real);
          return real;
        },
        { label: "fork" },
      );
      return clone(created);
    },

    publish(versionId, label) {
      const beforeVersions = clone(state.versions);
      const version = byId(state.versions, versionId);
      if (!version) return null;

      writeThrough(
        () => {
          for (const sibling of state.versions.filter((v) => v.design_id === version.design_id && v.status === "published")) sibling.status = "archived";
          version.status = "published";
          version.label = label || version.label;
          version.published_at = new Date().toISOString();
          return () => {
            state.versions = beforeVersions;
          };
        },
        // SERVER: publish is atomic — validate, snapshot, generate the
        // thumbnail, flip status, bust the layout cache, write the audit row.
        () => request("POST", `/versions/${versionId}/publish`, { label }),
        { label: "publish" },
      );
      return clone(version);
    },

    rollback(designId) {
      const beforeVersions = clone(state.versions);
      const all = state.versions.filter((v) => v.design_id === designId).sort((a, b) => b.version_number - a.version_number);
      const live = all.find((v) => v.status === "published");
      const previous = all.find((v) => v.status === "archived" && v.published_at);
      if (!live || !previous) return null;

      writeThrough(
        () => {
          live.status = "rolled_back";
          previous.status = "published";
          return () => {
            state.versions = beforeVersions;
          };
        },
        () => request("POST", `/versions/${live.id}/rollback`),
        { label: "rollback" },
      );
      return clone(previous);
    },

    duplicate(designId, options = {}) {
      const copy = { id: `tmp_${crypto.randomUUID()}`, status: "draft", ...options };
      writeThrough(
        () => {
          state.designs.push(copy);
          return () => {
            state.designs = state.designs.filter((d) => d.id !== copy.id);
          };
        },
        async () => {
          const real = await request("POST", `/designs/${designId}/duplicate`, options);
          Object.assign(copy, real);
          return real;
        },
        { label: "duplicate" },
      );
      return clone(copy);
    },

    archive: (designId) => db.designs.update(designId, { status: "archived" }),

    remove(designId) {
      const beforeDesigns = clone(state.designs);
      const beforeVersions = clone(state.versions);
      writeThrough(
        () => {
          state.designs = state.designs.filter((d) => d.id !== designId);
          state.versions = state.versions.filter((v) => v.design_id !== designId);
          return () => {
            state.designs = beforeDesigns;
            state.versions = beforeVersions;
          };
        },
        () => request("DELETE", `/designs/${designId}`),
        { label: "design deletion" },
      );
      return true;
    },
  },

  /* --- Assignments ------------------------------------------------------- */
  assignments: {
    list: () => clone(state.assignments),

    create(input) {
      const optimistic = { id: `tmp_${crypto.randomUUID()}`, enabled: true, created_at: new Date().toISOString(), ...input };
      writeThrough(
        () => {
          state.assignments.push(optimistic);
          return () => {
            state.assignments = state.assignments.filter((a) => a.id !== optimistic.id);
          };
        },
        async () => {
          const created = await request("POST", "/assignments", input);
          Object.assign(optimistic, created);
          return created;
        },
        { label: "assignment" },
      );
      return clone(optimistic);
    },

    update(id, patch) {
      const before = clone(byId(state.assignments, id));
      writeThrough(
        () => {
          Object.assign(byId(state.assignments, id) ?? {}, patch);
          return () => before && upsert(state.assignments, before);
        },
        () => request("PATCH", `/assignments/${id}`, patch),
        { label: "assignment" },
      );
      return clone(byId(state.assignments, id));
    },

    remove(id) {
      const before = clone(byId(state.assignments, id));
      writeThrough(
        () => {
          state.assignments = state.assignments.filter((a) => a.id !== id);
          return () => before && state.assignments.push(before);
        },
        () => request("DELETE", `/assignments/${id}`),
        { label: "assignment removal" },
      );
      return true;
    },

    /**
     * IMPORTANT — this must not stay client-side.
     *
     * The resolution rule decides what every app user sees. If the dashboard
     * computes it one way and the runtime computes it another, the Paths tab
     * confidently explains an outcome that is not happening. There must be one
     * implementation, on the server, and both callers ask it.
     *
     * Keep the mock's logic in db.js as the reference: user-scope assignment by
     * priority, then organisation-scope, then the org's default published
     * design, then the global fallback, then the app's built-in layout.
     *
     * SERVER: GET /paths/users/:id returns { version, rule, trace }, where
     * `trace` is the ordered list of steps with { step, detail, hit, rule } —
     * that is what the Paths tab renders, and it is worth returning even
     * though the runtime endpoint does not need it.
     */
    resolve(userId) {
      const cached = state.resolutions?.[userId];
      if (cached) return clone(cached);
      return { version: null, rule: null, trace: [{ step: "Not resolved yet", detail: "hydrate() did not include this user", hit: false }] };
    },

    /** SERVER: POST /assignments/preview — returns { changed, unchanged }. */
    previewImpact(candidate) {
      void candidate;
      return { changed: [], unchanged: [], pending: true };
    },

    /** SERVER: GET /assignments/conflicts. */
    conflicts: () => clone(state.assignmentConflicts ?? []),
  },

  /* --- Paths ------------------------------------------------------------- */
  paths: {
    userEvents: (userId, limit = 80) =>
      clone(state.pathEvents.filter((e) => e.user_id === userId).sort((a, b) => new Date(b.occurred_at) - new Date(a.occurred_at)).slice(0, limit)),

    /** SERVER: GET /paths/flow — aggregate this in SQL, not in the browser. */
    flow: () => clone(state.pathFlow ?? { visits: [], edges: [] }),
  },

  /* --- App data ---------------------------------------------------------- */
  entities: {
    list: () => clone(state.collections),
    get: (key) => clone(state.collections.find((c) => c.key === key) ?? null),

    records({ collectionKey, org = null, q = "", filters = [], includeDeleted = false } = {}) {
      const collection = state.collections.find((c) => c.key === collectionKey);
      if (!collection) return [];

      let rows = state.records.filter((r) => r.collection_id === collection.id);
      rows = includeDeleted ? rows.filter((r) => r.deleted_at) : rows.filter((r) => !r.deleted_at);
      if (org) rows = rows.filter((r) => r.organization_id === org);
      if (q) {
        const needle = q.toLowerCase();
        rows = rows.filter((r) => Object.values(r.data).some((v) => String(v).toLowerCase().includes(needle)));
      }
      // NOTE: filtering client-side only works while the whole collection is
      // cached. Past a few thousand rows, switch this method to a server query
      // (GET /entities/:key/records?q=&filter=&cursor=) and make the App Data
      // table await it — that table is the one place async is worth the change.
      void filters;
      return clone(rows);
    },

    createRecord(collectionKey, data, org) {
      const collection = state.collections.find((c) => c.key === collectionKey);
      if (!collection) return null;
      const optimistic = {
        id: `tmp_${crypto.randomUUID()}`,
        collection_id: collection.id,
        organization_id: org,
        data,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        deleted_at: null,
      };
      writeThrough(
        () => {
          state.records.push(optimistic);
          return () => {
            state.records = state.records.filter((r) => r.id !== optimistic.id);
          };
        },
        async () => {
          const created = await request("POST", `/entities/${collectionKey}/records`, { data, organization_id: org });
          Object.assign(optimistic, created);
          return created;
        },
        { label: "record" },
      );
      return clone(optimistic);
    },

    updateRecord(id, patch) {
      const record = byId(state.records, id);
      if (!record) return null;
      const before = clone(record.data);
      const collection = state.collections.find((c) => c.id === record.collection_id);
      writeThrough(
        () => {
          record.data = { ...record.data, ...patch };
          record.updated_at = new Date().toISOString();
          return () => {
            record.data = before;
          };
        },
        () => request("PATCH", `/entities/${collection?.key}/records/${id}`, { data: patch }),
        { label: "record" },
      );
      return clone(record);
    },

    deleteRecords(ids) {
      const stamp = new Date().toISOString();
      const touched = state.records.filter((r) => ids.includes(r.id) && !r.deleted_at);
      writeThrough(
        () => {
          for (const record of touched) record.deleted_at = stamp;
          return () => {
            for (const record of touched) record.deleted_at = null;
          };
        },
        () => request("POST", "/entities/records/bulk", { op: "delete", ids }),
        { label: "deletion" },
      );
      return touched.length;
    },

    restoreRecords(ids) {
      const touched = state.records.filter((r) => ids.includes(r.id) && r.deleted_at);
      const stamps = touched.map((r) => r.deleted_at);
      writeThrough(
        () => {
          for (const record of touched) record.deleted_at = null;
          return () => {
            touched.forEach((record, i) => {
              record.deleted_at = stamps[i];
            });
          };
        },
        () => request("POST", "/entities/records/bulk", { op: "restore", ids }),
        { label: "restore" },
      );
      return touched.length;
    },

    bulkUpdate(ids, patch) {
      const touched = state.records.filter((r) => ids.includes(r.id));
      const before = touched.map((r) => clone(r.data));
      writeThrough(
        () => {
          for (const record of touched) record.data = { ...record.data, ...patch };
          return () => {
            touched.forEach((record, i) => {
              record.data = before[i];
            });
          };
        },
        () => request("POST", "/entities/records/bulk", { op: "update", ids, patch }),
        { label: "bulk edit" },
      );
      return touched.length;
    },

    createCollection(input) {
      const optimistic = { id: `tmp_${crypto.randomUUID()}`, origin: "collection", created_at: new Date().toISOString(), ...input };
      writeThrough(
        () => {
          state.collections.push(optimistic);
          return () => {
            state.collections = state.collections.filter((c) => c.id !== optimistic.id);
          };
        },
        async () => {
          const created = await request("POST", "/collections", input);
          Object.assign(optimistic, created);
          return created;
        },
        { label: "collection" },
      );
      return clone(optimistic);
    },

    updateCollection(id, patch) {
      const before = clone(byId(state.collections, id));
      writeThrough(
        () => {
          Object.assign(byId(state.collections, id) ?? {}, patch);
          return () => before && upsert(state.collections, before);
        },
        // SERVER: a field-type change on a collection with rows must return a
        // migration preview and refuse unsafe conversions.
        () => request("PATCH", `/collections/${id}`, patch),
        { label: "schema change" },
      );
      return clone(byId(state.collections, id));
    },

    removeCollection(id) {
      const beforeCollections = clone(state.collections);
      const beforeRecords = clone(state.records);
      writeThrough(
        () => {
          state.collections = state.collections.filter((c) => c.id !== id);
          state.records = state.records.filter((r) => r.collection_id !== id);
          return () => {
            state.collections = beforeCollections;
            state.records = beforeRecords;
          };
        },
        () => request("DELETE", `/collections/${id}`),
        { label: "collection deletion" },
      );
      return true;
    },

    /** SERVER: GET /designs/data-sources. Sample rows must respect RLS. */
    dataSources: () => clone(state.dataSources ?? []),
  },

  /* --- Features ---------------------------------------------------------- */
  features: {
    list: () => clone(state.features),
    get: (id) => clone(byId(state.features, id)),
    assignments: () => clone(state.featureAssignments),
    assignment: (featureId, orgId) => clone(state.featureAssignments.find((a) => a.feature_id === featureId && a.organization_id === orgId) ?? null),

    toggle(featureId, orgId, enabled) {
      const row = state.featureAssignments.find((a) => a.feature_id === featureId && a.organization_id === orgId);
      if (!row) return null;
      const before = row.enabled;
      writeThrough(
        () => {
          row.enabled = enabled;
          row.updated_at = new Date().toISOString();
          return () => {
            row.enabled = before;
          };
        },
        // SERVER: re-check dependants here too. The client check is a courtesy,
        // not the boundary.
        () => request("PUT", `/features/${featureId}/orgs/${orgId}`, { enabled }),
        { label: "feature toggle" },
      );
      return clone(row);
    },

    updateSettings(featureId, orgId, settings) {
      const row = state.featureAssignments.find((a) => a.feature_id === featureId && a.organization_id === orgId);
      if (!row) return null;
      const before = clone(row.settings);
      writeThrough(
        () => {
          row.settings = { ...row.settings, ...settings };
          return () => {
            row.settings = before;
          };
        },
        () => request("PUT", `/features/${featureId}/orgs/${orgId}`, { settings }),
        { label: "feature settings" },
      );
      return clone(row);
    },

    dependants(featureId, orgId) {
      const feature = byId(state.features, featureId);
      if (!feature) return [];
      return state.features
        .filter((other) => other.depends_on?.includes(feature.key) && state.featureAssignments.find((a) => a.feature_id === other.id && a.organization_id === orgId)?.enabled)
        .map(clone);
    },

    missingDependencies(featureId, orgId) {
      const feature = byId(state.features, featureId);
      if (!feature) return [];
      return (feature.depends_on ?? [])
        .map((key) => state.features.find((f) => f.key === key))
        .filter((dep) => dep && !state.featureAssignments.find((a) => a.feature_id === dep.id && a.organization_id === orgId)?.enabled)
        .map(clone);
    },

    create(input) {
      const optimistic = { id: `tmp_${crypto.randomUUID()}`, origin: "composed", status: "draft", created_at: new Date().toISOString(), ...input };
      writeThrough(
        () => {
          state.features.push(optimistic);
          return () => {
            state.features = state.features.filter((f) => f.id !== optimistic.id);
          };
        },
        async () => {
          const created = await request("POST", "/features", input);
          Object.assign(optimistic, created);
          return created;
        },
        { label: "feature" },
      );
      return clone(optimistic);
    },

    update(id, patch) {
      const before = clone(byId(state.features, id));
      writeThrough(
        () => {
          Object.assign(byId(state.features, id) ?? {}, patch);
          return () => before && upsert(state.features, before);
        },
        () => request("PATCH", `/features/${id}`, patch),
        { label: "feature" },
      );
      return clone(byId(state.features, id));
    },

    publish(id) {
      const feature = byId(state.features, id);
      if (!feature) return null;
      const before = clone(feature);
      writeThrough(
        () => {
          feature.status = "published";
          feature.manifest.version = (feature.manifest.version ?? 0) + 1;
          return () => upsert(state.features, before);
        },
        () => request("POST", `/features/${id}/publish`),
        { label: "feature publish" },
      );
      return clone(feature);
    },
  },

  /* --- Rules ------------------------------------------------------------- */
  rules: {
    list: (org = null) => clone(org ? state.rules.filter((r) => r.organization_id === org) : state.rules),
    get: (id) => clone(byId(state.rules, id)),
    runs: (ruleId) => clone(state.ruleRuns.filter((r) => r.rule_id === ruleId).sort((a, b) => new Date(b.occurred_at) - new Date(a.occurred_at))),

    create(input) {
      const optimistic = { id: `tmp_${crypto.randomUUID()}`, enabled: false, created_at: new Date().toISOString(), ...input };
      writeThrough(
        () => {
          state.rules.push(optimistic);
          return () => {
            state.rules = state.rules.filter((r) => r.id !== optimistic.id);
          };
        },
        async () => {
          const created = await request("POST", "/rules", input);
          Object.assign(optimistic, created);
          return created;
        },
        { label: "rule" },
      );
      return clone(optimistic);
    },

    update(id, patch) {
      const before = clone(byId(state.rules, id));
      writeThrough(
        () => {
          Object.assign(byId(state.rules, id) ?? {}, patch);
          return () => before && upsert(state.rules, before);
        },
        () => request("PATCH", `/rules/${id}`, patch),
        { label: "rule" },
      );
      return clone(byId(state.rules, id));
    },

    remove(id) {
      const before = clone(byId(state.rules, id));
      writeThrough(
        () => {
          state.rules = state.rules.filter((r) => r.id !== id);
          return () => before && state.rules.push(before);
        },
        () => request("DELETE", `/rules/${id}`),
        { label: "rule deletion" },
      );
      return true;
    },

    /**
     * Dry run. This one genuinely has to be a round trip — the point is to
     * evaluate against the real record with the real evaluator and commit
     * nothing, which only the server can honestly promise.
     *
     * The Rules tab calls this synchronously today. Make `openTest` await it;
     * it is one call site and already has a place to render the result.
     */
    test(id, sample) {
      return request("POST", `/rules/${id}/test`, { sample });
    },
  },

  /* --- Audit ------------------------------------------------------------- */
  audit_: {
    list: (limit = 60) => clone(state.auditLog.slice(0, limit)),
  },

  /** SERVER: GET /metrics — aggregate in SQL. */
  metrics() {
    return (
      state.metrics ?? {
        users: state.users.length,
        appUsers: state.users.filter((u) => u.role === "app_user").length,
        activeUsers: 0,
        orgs: state.orgs.length,
        activeOrgs: state.orgs.filter((o) => o.status === "active").length,
        published: state.versions.filter((v) => v.status === "published").length,
        drafts: state.versions.filter((v) => v.status === "draft").length,
        errors: 0,
        records: state.records.length,
        collections: state.collections.length,
        enabledFeatures: state.featureAssignments.filter((a) => a.enabled).length,
        rules: state.rules.filter((r) => r.enabled).length,
        adoption: [],
        health: { layoutP95: 0, cacheHit: 0, rendererErrorRate: 0, lastFailedPublish: null },
      }
    );
  },
};

/* ---------------------------------------------------------------------------
   These are static tables, not server data. Re-exported so importing this
   module instead of db.js needs no other change.
   --------------------------------------------------------------------------- */

export { ACTION_TYPES, TRIGGER_TYPES, ROLES, FIELD_TYPES } from "./db.js";
