/**
 * A stand-in for the Supabase endpoints, serving the exact payloads the live
 * database returned. The environment blocks outbound *.supabase.co, so this is
 * how the client gets exercised over a real network path against real data.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

import { ROOT } from "./lib.mjs";
const PORT = Number(process.env.STUB_PORT ?? 8791);

// Captured verbatim from private.resolve_layout / public.resolve_preview.
const LAYOUT_MAYA = {
  theme: { colors: { text: "#101418", primary: "#1f6feb", background: "#f7f8f9" } },
  screens: [
    { id: "scr_home", name: "Home", route: "/home", isEntry: true, root: { id: "n1", type: "Stack", props: { gap: 16, direction: "vertical" }, children: [] } },
    { id: "scr_notes", name: "Notes", route: "/notes", root: { id: "n2", type: "Stack", props: { gap: 12, direction: "vertical" }, children: [] } },
  ],
  features: ["notes"],
  settings: { locale: "en-CA", appName: "Northstar Projects", timezone: "America/Toronto" },
  designName: "Northstar Workspace",
  organization: { id: "11111111-1111-1111-1111-111111111111" },
  schemaVersion: 1,
  versionNumber: 1,
  designVersionId: "66666666-6666-6666-6666-666666666666",
  strippedScreens: ["scr_timesheets"],
  trace: [{ step: "Organisation-scope assignment", detail: "priority 10", hit: true }],
};

const LAYOUT_DANIEL = {
  designVersionId: null,
  screens: [],
  trace: [
    { step: "User-scope assignment", detail: "none", hit: false },
    { step: "Organisation-scope assignment", detail: "none", hit: false },
    { step: "Organisation default published design", detail: "none", hit: false },
    { step: "Global fallback design", detail: "none", hit: false },
    { step: "App built-in static layout", detail: "shipped with the build", hit: true },
  ],
};

const PREVIEW_LIVE = JSON.parse(await readFile(new URL("./fixtures/preview-live.json", import.meta.url), "utf8"));
const DATA_SOURCES = JSON.parse(await readFile(new URL("./fixtures/data-sources.json", import.meta.url), "utf8"));
const ROWS = JSON.parse(await readFile(new URL("./fixtures/rows.json", import.meta.url), "utf8"));
// The live v3 design exactly as resolve_layout returns it for a Northstar user:
// a *published* design with bound sources. The other two users cover the
// skeletal design and the built-in fallback; neither binds data through the
// published path, which is how a bug that emptied every bound list on a
// published design shipped with every suite green.
const LAYOUT_PUBLISHED = JSON.parse(await readFile(new URL("./fixtures/layout-published.json", import.meta.url), "utf8"));

const USERS = {
  "maya@northstar.ca": { id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", role: "app_user", full_name: "Maya Chen", organization_id: "11111111-1111-1111-1111-111111111111", password: "correct-horse", layout: { ...LAYOUT_MAYA, dataSources: DATA_SOURCES } },
  "daniel@brightroof.ca": { id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", role: "app_user", full_name: "Daniel Roy", organization_id: "22222222-2222-2222-2222-222222222222", password: "correct-horse", layout: { ...LAYOUT_DANIEL, dataSources: DATA_SOURCES } },
  "lee@northstar.ca": { id: "cccccccc-cccc-cccc-cccc-cccccccccccc", role: "app_user", full_name: "Lee Park", organization_id: "11111111-1111-1111-1111-111111111111", password: "correct-horse", layout: LAYOUT_PUBLISHED },
};

/**
 * What the app sent, so the test can assert on the requests it built rather
 * than only on what came back.
 */
export const received = { pathEvents: [], rejectedEvents: [], queries: [], writes: [], layoutCalls: 0, previewCalls: 0 };

/** path_events_event_check, as of migration 20261015134216. */
const PATH_EVENT_TYPES = new Set(["view", "exit", "action", "error"]);
/** path_events' NOT NULL columns that have no default the client can lean on in a batch. */
const PATH_EVENT_NOT_NULL = ["user_id", "route_path", "event", "metadata"];

let mode = { failLayout: false, failWrites: false, offline: false };

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml" };

const body = (req) =>
  new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); }
    });
  });

const send = (res, status, payload) => {
  res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*" });
  res.end(JSON.stringify(payload));
};

const tokenFor = (user) => `stub.${Buffer.from(JSON.stringify({ sub: user.id })).toString("base64url")}`;
const userFromAuth = (req) => {
  const raw = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  if (!raw.startsWith("stub.")) return null;
  try {
    const { sub } = JSON.parse(Buffer.from(raw.slice(5), "base64url").toString());
    return Object.values(USERS).find((u) => u.id === sub) ?? null;
  } catch { return null; }
};

export const server = createServer(async (req, res) => {
  // The origin comes from the request, not from the module's PORT constant:
  // a test may listen on a different port, and the config injected below has
  // to point at the port the browser actually connected to.
  const origin = `http://${req.headers.host ?? `localhost:${PORT}`}`;
  const url = new URL(req.url, origin);
  const path = url.pathname;

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "authorization, apikey, content-type, prefer",
      "access-control-allow-methods": "GET, POST, PATCH, OPTIONS",
    });
    return res.end();
  }

  /* --- Test control ------------------------------------------------------ */
  if (path === "/__stub/mode") {
    mode = { ...mode, ...(await body(req)) };
    return send(res, 200, mode);
  }
  if (path === "/__stub/received") return send(res, 200, received);
  if (path === "/__stub/reset") {
    received.pathEvents = [];
    received.rejectedEvents = [];
    received.queries = [];
    received.writes = [];
    received.layoutCalls = 0;
    received.previewCalls = 0;
    mode = { failLayout: false, failWrites: false, offline: false };
    return send(res, 200, { ok: true });
  }

  /* --- Auth -------------------------------------------------------------- */
  if (path === "/auth/v1/token") {
    const grant = url.searchParams.get("grant_type");
    const payload = await body(req);

    if (grant === "password") {
      const user = USERS[String(payload.email ?? "").toLowerCase()];
      if (!user || user.password !== payload.password) {
        return send(res, 400, { error: "invalid_grant", error_description: "Invalid login credentials" });
      }
      return send(res, 200, {
        access_token: tokenFor(user), refresh_token: `r.${user.id}`, expires_in: 3600,
        user: { id: user.id, email: Object.keys(USERS).find((k) => USERS[k] === user) },
      });
    }

    if (grant === "refresh_token") {
      const user = Object.values(USERS).find((u) => `r.${u.id}` === payload.refresh_token);
      if (!user) return send(res, 400, { error: "invalid_grant" });
      return send(res, 200, {
        access_token: tokenFor(user), refresh_token: `r.${user.id}`, expires_in: 3600,
        user: { id: user.id, email: Object.keys(USERS).find((k) => USERS[k] === user) },
      });
    }
    return send(res, 400, { error: "unsupported_grant_type" });
  }

  if (path === "/auth/v1/logout") return send(res, 204, {});

  /* --- PostgREST --------------------------------------------------------- */
  if (path === "/rest/v1/rpc/resolve_my_layout") {
    received.layoutCalls += 1;
    if (mode.failLayout) return send(res, 503, { message: "stub: layout unavailable" });
    const user = userFromAuth(req);
    if (!user) return send(res, 401, { message: "JWT expired" });
    return send(res, 200, user.layout);
  }

  if (path === "/rest/v1/rpc/resolve_preview") {
    received.previewCalls += 1;
    const { p_token } = await body(req);
    if (p_token === "tok_live_verify_0001") return send(res, 200, PREVIEW_LIVE);
    if (p_token === "tok_expired_verify_01") return send(res, 200, { error: "expired" });
    if (p_token === "tok_revoked_verify_01") return send(res, 200, { error: "revoked" });
    return send(res, 200, { error: "invalid" });
  }

  const TABLES = new Set(["tasks", "notes", "projects"]);
  const table = path.startsWith("/rest/v1/") ? path.slice("/rest/v1/".length) : null;

  if (TABLES.has(table) && req.method === "GET") {
    const user = userFromAuth(req);
    if (!user) return send(res, 401, { message: "JWT expired" });
    received.queries.push({ table, query: url.search.replace(/^\?/, "") });

    let rows = [...(ROWS[table] ?? [])];

    for (const [key, raw] of url.searchParams) {
      if (["select", "order", "limit", "offset"].includes(key)) continue;
      const [op, ...rest] = raw.split(".");
      const value = rest.join(".");
      if (op === "eq") rows = rows.filter((r) => String(r[key]) === value);
      else if (op === "neq") rows = rows.filter((r) => String(r[key]) !== value);
      else if (op === "is") rows = rows.filter((r) => (value === "null" ? r[key] === null : r[key] !== null));
    }

    const order = url.searchParams.get("order");
    if (order) {
      const [col, dir = "asc"] = order.split(".");
      rows.sort((a, b) => {
        const x = a[col] ?? "";
        const y = b[col] ?? "";
        return (x < y ? -1 : x > y ? 1 : 0) * (dir.startsWith("desc") ? -1 : 1);
      });
    }

    const limit = Number(url.searchParams.get("limit") ?? 50);
    rows = rows.slice(0, limit);

    const select = (url.searchParams.get("select") ?? "*").split(",");
    if (!select.includes("*")) {
      rows = rows.map((r) => Object.fromEntries(select.filter((c) => c in r).map((c) => [c, r[c]])));
    }
    return send(res, 200, rows);
  }

  if (TABLES.has(table) && req.method === "PATCH") {
    const user = userFromAuth(req);
    if (!user) return send(res, 401, { message: "JWT expired" });
    const patch = await body(req);
    const idFilter = (url.searchParams.get("id") ?? "").replace(/^eq\./, "");
    received.writes.push({ table, id: idFilter, patch });

    // Two different failures: one where the server decided, one where it never
    // answered. The client must treat them differently.
    // res.destroy() aborts the socket; req.destroy() only ends the request
    // stream, which leaves the client waiting rather than failing.
    if (mode.offline) { res.destroy(); return; }
    if (mode.failWrites) return send(res, 403, { message: "stub: refused" });

    const row = (ROWS[table] ?? []).find((r) => r.id === idFilter);
    if (row) Object.assign(row, patch);
    return send(res, 204, {});
  }

  if (path === "/rest/v1/app_users") {
    const user = userFromAuth(req);
    if (!user) return send(res, 401, { message: "JWT expired" });
    return send(res, 200, [{ role: user.role, full_name: user.full_name, organization_id: user.organization_id }]);
  }

  if (path === "/rest/v1/path_events" && req.method === "POST") {
    const user = userFromAuth(req);
    if (!user) return send(res, 401, { message: "JWT expired" });
    const rows = [].concat(await body(req));
    // The same CHECK the table has. Accepting any word here is how the app
    // shipped sending "tap" and "exit" while the database refused both, and
    // with them every batch they were part of.
    const bad = rows.find((r) => !PATH_EVENT_TYPES.has(r?.event));
    if (bad) {
      received.rejectedEvents.push(`event "${bad.event}"`);
      return send(res, 400, { code: "23514", message: 'new row for relation "path_events" violates check constraint "path_events_event_check"' });
    }
    // PostgREST inserts a batch with one column list, so a key present on any
    // row is a column for every row, and a row without it supplies null. The
    // NOT NULL columns then refuse the whole batch.
    const columns = new Set(rows.flatMap((r) => Object.keys(r ?? {})));
    const missing = PATH_EVENT_NOT_NULL.find((c) => columns.has(c) && rows.some((r) => r?.[c] == null));
    if (missing) {
      received.rejectedEvents.push(`null ${missing}`);
      return send(res, 400, { code: "23502", message: `null value in column "${missing}" of relation "path_events" violates not-null constraint` });
    }
    received.pathEvents.push(...rows);
    return send(res, 201, {});
  }

  /* --- Static ------------------------------------------------------------ */
  const file = normalize(join(ROOT, decodeURIComponent(path === "/" ? "/app/index.html" : path)));
  if (!file.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end("no");
  }

  try {
    let content = await readFile(file);
    const type = MIME[extname(file)] ?? "application/octet-stream";

    // Point the app at this stub instead of the live project, without editing
    // anything in the repository.
    if (file.endsWith("app/index.html")) {
      content = String(content).replace(
        "<head>",
        `<head><script>window.__APP_CONFIG__={supabaseUrl:"${origin}",supabaseKey:"stub-anon-key",telemetryFlushMs:400,telemetryBatchSize:3};</script>`,
      );
    }

    res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
    res.end(content);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  }
});

if (import.meta.url === `file://${process.argv[1]}`) {
  server.listen(PORT, () => console.log(`stub on http://localhost:${PORT}`));
}
