/**
 * Reading values out of the data scope, and projecting rows into component
 * shapes.
 *
 * This lives in its own file for a boring but load-bearing reason: the renderer
 * imports the registry, so the registry cannot import the renderer. Both of them
 * need to read a dotted path and project a row — the renderer to resolve a
 * bound prop, the `Repeater` component to expand a source into children — and
 * the alternative to one shared module is two implementations that format a
 * date differently the first time anyone touches one of them.
 */

/**
 * Read a dotted path out of an object.
 * Scopes: user, org, route, query.<sourceId>, state, theme.
 */
export function readScope(path, scope) {
  if (!path) return undefined;
  let node = scope;
  for (const key of String(path).split(".")) {
    if (node === null || node === undefined) return undefined;
    node = node[key];
  }
  return node;
}

export const FORMATTERS = {
  none: (v) => v,
  text: (v) => String(v ?? ""),
  currency: (v) => (Number.isFinite(Number(v)) ? new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD" }).format(Number(v)) : v),
  number: (v) => (Number.isFinite(Number(v)) ? new Intl.NumberFormat("en-CA").format(Number(v)) : v),
  percent: (v) => (Number.isFinite(Number(v)) ? `${Math.round(Number(v) * 100)}%` : v),
  date: (v) => {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? v : d.toLocaleDateString("en-CA", { month: "short", day: "numeric", year: "numeric" });
  },
  time: (v) => {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? v : d.toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit" });
  },
  uppercase: (v) => String(v ?? "").toUpperCase(),
};

export const formatterNames = Object.keys(FORMATTERS);

/**
 * Project a row from a data source into the shape a component expects.
 *
 * A mapping entry is a column name, or `{ from, format, values, fallback }`,
 * where `values` translates a domain enum into the component's vocabulary —
 * `tasks.status` is todo/in_progress/blocked/review/done and a TaskRow state is
 * open/doing/done/blocked. Neither vocabulary should bend to the other: one
 * belongs to the domain and one to the interface, and this is where they meet.
 *
 * The row's identity survives as `$row`/`$source`. Without it a component can
 * render a task but has no way to say which task was tapped, and the runtime
 * would have to match on title — which stops working the moment two things are
 * called "Follow up".
 */
export function projectRow(row, map, source = null) {
  const out = { $row: row?.id ?? null, $source: source };

  for (const [key, spec] of Object.entries(map ?? {})) {
    const rule = typeof spec === "string" ? { from: spec } : (spec ?? {});
    let value = readScope(rule.from, row);

    if (rule.values && Object.hasOwn(rule.values, String(value))) value = rule.values[String(value)];

    if (value === undefined || value === null || value === "") {
      out[key] = rule.fallback ?? "";
      continue;
    }

    const format = FORMATTERS[rule.format] || FORMATTERS.none;
    try {
      out[key] = format(value);
    } catch {
      out[key] = rule.fallback ?? String(value);
    }
  }
  return out;
}

/** "query.dueToday" → "dueToday", so a projected row knows where it came from. */
export const sourceIdFromPath = (path) => (String(path).startsWith("query.") ? String(path).slice(6) : null);
