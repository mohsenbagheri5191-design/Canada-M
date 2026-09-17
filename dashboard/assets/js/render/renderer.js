/**
 * The layout renderer.
 *
 * This is the piece the mobile app embeds verbatim. Given a screen node, a
 * theme and a data scope it returns DOM. It is deliberately defensive:
 *
 *   - an unknown component type renders nothing and logs once
 *   - a render function that throws is caught and replaced with a marker
 *   - a binding that cannot resolve falls back rather than blanking the screen
 *   - depth and node budgets are enforced so a malformed document cannot hang
 *
 * A bad design must never brick the app. That rule lives here.
 */

import { el } from "../core/dom.js";
import { getDef, resolveToken } from "../data/registry.js";
import { createSurfaceResolver } from "../data/styles.js";

export const LIMITS = { depth: 20, nodes: 500 };

/**
 * Breakpoints, narrowest first. A wider breakpoint inherits every value the
 * narrower ones set, so an override only has to carry what actually differs.
 */
export const BREAKPOINTS = [
  { key: "base", label: "Base", glyph: "smartphone", hint: "All sizes" },
  { key: "md", label: "Tablet", glyph: "tablet", hint: "768px and up" },
  { key: "lg", label: "Desktop", glyph: "monitor", hint: "1024px and up" },
];

/**
 * Merge a node's prop layers into the values to render.
 *
 *   registry defaults → node.props → responsive[base…active] → states[active]
 *
 * Both the renderer and the inspector go through this, so what the canvas
 * draws and what the Style panel reports can never disagree.
 */
export function layeredProps(node, def, { breakpoint = "base", state = "default" } = {}) {
  let props = { ...(def?.props ?? {}), ...(node.props ?? {}) };

  if (breakpoint && breakpoint !== "base") {
    const upTo = BREAKPOINTS.findIndex((b) => b.key === breakpoint);
    for (let i = 1; i <= upTo; i += 1) {
      const layer = node.responsive?.[BREAKPOINTS[i].key];
      if (layer) props = { ...props, ...layer };
    }
  }

  if (state && state !== "default") {
    const layer = node.states?.[state];
    if (layer) props = { ...props, ...layer };
  }

  return props;
}

/**
 * Where a given prop's value actually comes from, for the inspector's
 * inherited-versus-overridden marker.
 */
export function propOrigin(node, key, { breakpoint = "base", state = "default" } = {}) {
  if (state !== "default" && node.states?.[state] && key in node.states[state]) return "state";
  if (breakpoint !== "base" && node.responsive?.[breakpoint] && key in node.responsive[breakpoint]) return "breakpoint";

  if (breakpoint !== "base") {
    const upTo = BREAKPOINTS.findIndex((b) => b.key === breakpoint);
    for (let i = upTo - 1; i >= 1; i -= 1) {
      if (node.responsive?.[BREAKPOINTS[i].key] && key in node.responsive[BREAKPOINTS[i].key]) return "inherited-breakpoint";
    }
  }

  return "base";
}

const warned = new Set();

function warnOnce(key, message) {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[renderer] ${message}`);
}

/* ---------------------------------------------------------------------------
   Binding resolution
   --------------------------------------------------------------------------- */

/**
 * Read a dotted path out of the data scope.
 * Scopes: user, org, route, query.<sourceId>, state, theme.
 */
function readScope(path, scope) {
  if (!path) return undefined;
  let node = scope;
  for (const key of String(path).split(".")) {
    if (node === null || node === undefined) return undefined;
    node = node[key];
  }
  return node;
}

const FORMATTERS = {
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

/** Resolve one prop value, which may be a literal, a binding or a token. */
export function resolveValue(value, ctx) {
  if (value === null || value === undefined) return value;

  if (Array.isArray(value)) return value.map((v) => resolveValue(v, ctx));

  if (typeof value === "object") {
    if (Object.hasOwn(value, "$bind")) {
      const raw = readScope(value.$bind, ctx.scope);
      if (raw === undefined || raw === null || raw === "") return value.fallback ?? "";
      const format = FORMATTERS[value.format] || FORMATTERS.none;
      try {
        return format(raw);
      } catch {
        return value.fallback ?? String(raw);
      }
    }
    // Plain object prop (spacing, size, radius): resolve each member.
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolveValue(v, ctx);
    return out;
  }

  if (typeof value === "string") return resolveToken(value, ctx.theme);

  return value;
}

function resolveProps(props, ctx) {
  const out = {};
  for (const [key, value] of Object.entries(props ?? {})) out[key] = resolveValue(value, ctx);
  return out;
}

/* ---------------------------------------------------------------------------
   Condition evaluation
   A deliberately tiny language: dot paths, literals, comparisons and
   and/or/not. No function calls, no property access on prototypes, no `new`.
   Nothing from the database is ever passed to eval or Function.
   --------------------------------------------------------------------------- */

const COMPARATORS = {
  "==": (a, b) => a == b, // eslint-disable-line eqeqeq
  "!=": (a, b) => a != b, // eslint-disable-line eqeqeq
  ">": (a, b) => Number(a) > Number(b),
  ">=": (a, b) => Number(a) >= Number(b),
  "<": (a, b) => Number(a) < Number(b),
  "<=": (a, b) => Number(a) <= Number(b),
  contains: (a, b) => String(a ?? "").toLowerCase().includes(String(b ?? "").toLowerCase()),
  "starts with": (a, b) => String(a ?? "").toLowerCase().startsWith(String(b ?? "").toLowerCase()),
  "is empty": (a) => a === null || a === undefined || a === "" || (Array.isArray(a) && a.length === 0),
  "is not empty": (a) => !(a === null || a === undefined || a === "" || (Array.isArray(a) && a.length === 0)),
};

export const comparators = Object.keys(COMPARATORS);

/**
 * A condition is structured, not a string, so the builder UI and the evaluator
 * cannot disagree:
 *   { all: [ {left, op, right}, ... ] }   or   { any: [...] }
 */
export function evaluateCondition(condition, ctx) {
  if (!condition) return true;

  if (condition.all) return condition.all.every((c) => evaluateCondition(c, ctx));
  if (condition.any) return condition.any.some((c) => evaluateCondition(c, ctx));
  if (condition.not) return !evaluateCondition(condition.not, ctx);

  const { left, op = "==", right } = condition;
  const fn = COMPARATORS[op];
  if (!fn) return true;

  const a = typeof left === "string" && left.startsWith("$") ? readScope(left.slice(1), ctx.scope) : resolveValue(left, ctx);
  const b = typeof right === "string" && right.startsWith("$") ? readScope(right.slice(1), ctx.scope) : right;

  try {
    return Boolean(fn(a, b));
  } catch {
    return true;
  }
}

/* ---------------------------------------------------------------------------
   Node rendering
   --------------------------------------------------------------------------- */

/**
 * Render one node and its subtree.
 *
 * @param {object} node    layout document node
 * @param {object} ctx     { theme, scope, budget, onNode, editable, depth }
 */
export function renderNode(node, ctx, depth = 0) {
  if (!node || typeof node !== "object") return null;

  if (depth > LIMITS.depth) {
    warnOnce(`depth:${node.id}`, `depth cap of ${LIMITS.depth} exceeded at "${node.id}"; subtree dropped`);
    return null;
  }

  if (ctx.budget && ctx.budget.count >= LIMITS.nodes) {
    warnOnce("budget", `node cap of ${LIMITS.nodes} reached; remaining nodes dropped`);
    return null;
  }
  if (ctx.budget) ctx.budget.count += 1;

  if (node.hidden) return null;
  if (node.visibleIf && !evaluateCondition(node.visibleIf, ctx)) return null;

  const def = getDef(node.type);
  if (!def) {
    // Unknown type renders nothing and never throws. In the editor we leave a
    // visible marker so the author can see and fix it; in the app it vanishes.
    warnOnce(`type:${node.type}`, `unknown component type "${node.type}"; node "${node.id}" skipped`);
    return ctx.editable ? unknownMarker(node, ctx) : null;
  }

  const props = resolveProps(layeredProps(node, def, ctx), ctx);

  let children = [];
  if (def.acceptsChildren && Array.isArray(node.children)) {
    children = node.children.map((child) => renderNode(child, ctx, depth + 1)).filter(Boolean);
  }

  let dom;
  try {
    dom = def.render(props, ctx, children);
  } catch (error) {
    console.error(`[renderer] "${node.type}" (${node.id}) threw during render`, error);
    return ctx.editable ? errorMarker(node, ctx, error) : null;
  }

  if (!(dom instanceof Node)) {
    warnOnce(`nonnode:${node.type}`, `"${node.type}" did not return a DOM node`);
    return null;
  }

  dom.dataset.nodeId = node.id;
  dom.dataset.nodeType = node.type;
  if (node.locked) dom.dataset.locked = "true";
  if (node.disabledIf && evaluateCondition(node.disabledIf, ctx)) {
    dom.dataset.disabled = "true";
    dom.style.opacity = "0.45";
    dom.style.pointerEvents = "none";
  }

  ctx.onNode?.(node, dom);
  return dom;
}

function unknownMarker(node, ctx) {
  return el(
    "div",
    {
      dataset: { nodeId: node.id, nodeType: node.type, marker: "unknown" },
      style: {
        padding: "10px 12px",
        borderRadius: "10px",
        border: `1px dashed ${ctx.theme.colors.danger}`,
        background: `color-mix(in srgb, ${ctx.theme.colors.danger} 8%, transparent)`,
        color: ctx.theme.colors.danger,
        fontSize: "12px",
        fontFamily: "ui-monospace, monospace",
      },
    },
    `Unknown component: ${node.type}`,
  );
}

function errorMarker(node, ctx, error) {
  return el(
    "div",
    {
      dataset: { nodeId: node.id, nodeType: node.type, marker: "error" },
      style: {
        padding: "10px 12px",
        borderRadius: "10px",
        border: `1px dashed ${ctx.theme.colors.danger}`,
        background: `color-mix(in srgb, ${ctx.theme.colors.danger} 8%, transparent)`,
        color: ctx.theme.colors.danger,
        fontSize: "12px",
      },
    },
    `${node.type} failed to render: ${error.message}`,
  );
}

/**
 * Render a whole screen. Returns a scroll container holding the tree.
 */
export function renderScreen(screen, ctx) {
  const budget = { count: 0 };

  // Every component asks the theme's style for its surfaces rather than
  // hard-coding a shadow or a border, so switching style restyles the whole
  // design at once instead of one component at a time.
  const scoped = {
    breakpoint: "base",
    state: "default",
    ...ctx,
    budget,
    surface: ctx.surface ?? createSurfaceResolver(ctx.theme),
  };

  const host = el("div", {
    dataset: { screenId: screen?.id ?? "" },
    style: {
      display: "flex",
      flexDirection: "column",
      minHeight: "100%",
      background: ctx.theme.colors.background,
      color: ctx.theme.colors.text,
      fontFamily: ctx.theme.typography.fontFamily,
      fontSize: `${ctx.theme.typography.baseSize ?? 14}px`,
    },
  });

  if (!screen?.root) {
    host.appendChild(
      el("div", { style: { padding: "48px 24px", textAlign: "center", color: ctx.theme.colors.textTertiary, fontSize: "13px" } }, "This screen has no content yet."),
    );
    return host;
  }

  const tree = renderNode(screen.root, scoped, 0);
  if (tree) host.appendChild(tree);

  if (budget.count >= LIMITS.nodes) {
    host.appendChild(
      el("div", { style: { padding: "12px", color: ctx.theme.colors.warning, fontSize: "12px", textAlign: "center" } }, `Node cap reached (${LIMITS.nodes}). Some content was not rendered.`),
    );
  }

  return host;
}

/* ---------------------------------------------------------------------------
   Document traversal, shared by the editor
   --------------------------------------------------------------------------- */

/** Depth-first walk. Callback receives (node, parent, index, depth). */
export function walk(root, visit, parent = null, index = 0, depth = 0) {
  if (!root) return;
  if (visit(root, parent, index, depth) === false) return;
  const children = root.children;
  if (!Array.isArray(children)) return;
  children.forEach((child, i) => walk(child, visit, root, i, depth + 1));
}

export function findNode(root, id) {
  let found = null;
  walk(root, (node) => {
    if (node.id === id) {
      found = node;
      return false;
    }
    return true;
  });
  return found;
}

export function findParent(root, id) {
  let found = null;
  walk(root, (node, parent) => {
    if (node.id === id) {
      found = parent;
      return false;
    }
    return true;
  });
  return found;
}

/** The chain from root to the node, inclusive. Drives the layer breadcrumb. */
export function pathTo(root, id) {
  const chain = [];
  const search = (node) => {
    if (!node) return false;
    chain.push(node);
    if (node.id === id) return true;
    for (const child of node.children ?? []) if (search(child)) return true;
    chain.pop();
    return false;
  };
  search(root);
  return chain;
}

export function countNodes(root) {
  let count = 0;
  walk(root, () => {
    count += 1;
    return true;
  });
  return count;
}

export function maxDepth(root) {
  let max = 0;
  walk(root, (_n, _p, _i, depth) => {
    max = Math.max(max, depth);
    return true;
  });
  return max;
}

/** Deep-clone a subtree, assigning fresh ids. Used by duplicate and paste. */
export function cloneSubtree(node, makeId) {
  const copy = structuredClone(node);
  walk(copy, (n) => {
    n.id = makeId(n.type);
    return true;
  });
  return copy;
}
