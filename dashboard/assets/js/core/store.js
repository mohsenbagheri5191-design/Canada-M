/**
 * State, history and the event bus.
 *
 * Two primitives:
 *   Store    an observable value with path subscriptions
 *   History  an undo/redo stack of labelled document snapshots
 *
 * History keeps whole snapshots rather than patches. A layout document is
 * capped at 500 nodes per screen, so a snapshot is tens of kilobytes; 100 of
 * them is cheaper than the complexity of a patch engine, and it can never
 * desynchronise from the document the way a bad inverse patch can.
 */

/* ---------------------------------------------------------------------------
   Event bus
   --------------------------------------------------------------------------- */

const listeners = new Map();

export const bus = {
  on(event, handler) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(handler);
    return () => listeners.get(event)?.delete(handler);
  },

  emit(event, payload) {
    const set = listeners.get(event);
    if (!set) return;
    for (const handler of Array.from(set)) {
      try {
        handler(payload);
      } catch (error) {
        console.error(`[bus] handler for "${event}" threw`, error);
      }
    }
  },
};

/* ---------------------------------------------------------------------------
   Store
   --------------------------------------------------------------------------- */

export class Store {
  #state;
  #subs = new Set();
  #depth = 0;
  #dirty = false;

  constructor(initial = {}) {
    this.#state = initial;
  }

  get state() {
    return this.#state;
  }

  /** Read a dotted path, e.g. store.get("studio.selection.0"). */
  get(path, fallback) {
    const value = readPath(this.#state, path);
    return value === undefined ? fallback : value;
  }

  /**
   * Mutate. The mutator receives the live state object; batched so a mutator
   * that calls set() again only produces one notification.
   */
  set(mutator) {
    this.#depth += 1;
    try {
      if (typeof mutator === "function") mutator(this.#state);
      else Object.assign(this.#state, mutator);
      this.#dirty = true;
    } finally {
      this.#depth -= 1;
      if (this.#depth === 0 && this.#dirty) {
        this.#dirty = false;
        this.#notify();
      }
    }
  }

  subscribe(handler) {
    this.#subs.add(handler);
    return () => this.#subs.delete(handler);
  }

  #notify() {
    for (const handler of Array.from(this.#subs)) {
      try {
        handler(this.#state);
      } catch (error) {
        console.error("[store] subscriber threw", error);
      }
    }
  }
}

function readPath(root, path) {
  if (!path) return root;
  let node = root;
  for (const key of String(path).split(".")) {
    if (node === null || node === undefined) return undefined;
    node = node[key];
  }
  return node;
}

/* ---------------------------------------------------------------------------
   History
   --------------------------------------------------------------------------- */

export class History {
  #past = [];
  #future = [];
  #limit;
  #onChange;

  constructor({ limit = 100, onChange } = {}) {
    this.#limit = limit;
    this.#onChange = onChange;
  }

  get canUndo() {
    return this.#past.length > 1;
  }

  get canRedo() {
    return this.#future.length > 0;
  }

  /** Labels newest-first, for the history panel. */
  get entries() {
    return this.#past.map((e, i) => ({ label: e.label, at: e.at, index: i })).reverse();
  }

  get depth() {
    return this.#past.length;
  }

  /** Seed the stack. Discards everything already on it. */
  reset(snapshot, label = "Opened") {
    this.#past = [{ label, at: Date.now(), snapshot: clone(snapshot) }];
    this.#future = [];
    this.#onChange?.(this);
  }

  /**
   * Record a new state.
   *
   * `coalesceKey` merges consecutive commits that share a key inside a short
   * window, so dragging a slider produces one undo step rather than ninety.
   */
  commit(snapshot, label, { coalesceKey = null, window = 600 } = {}) {
    const head = this.#past[this.#past.length - 1];

    if (
      coalesceKey &&
      head &&
      head.coalesceKey === coalesceKey &&
      Date.now() - head.at < window
    ) {
      head.snapshot = clone(snapshot);
      head.at = Date.now();
      head.label = label;
      this.#future = [];
      this.#onChange?.(this);
      return;
    }

    this.#past.push({ label, at: Date.now(), snapshot: clone(snapshot), coalesceKey });
    if (this.#past.length > this.#limit) this.#past.shift();
    this.#future = [];
    this.#onChange?.(this);
  }

  undo() {
    if (!this.canUndo) return null;
    this.#future.push(this.#past.pop());
    this.#onChange?.(this);
    const head = this.#past[this.#past.length - 1];
    return { snapshot: clone(head.snapshot), label: head.label };
  }

  redo() {
    if (!this.canRedo) return null;
    const entry = this.#future.pop();
    this.#past.push(entry);
    this.#onChange?.(this);
    return { snapshot: clone(entry.snapshot), label: entry.label };
  }

  /** Jump to an absolute point in the stack, from the history panel. */
  jumpTo(index) {
    if (index < 0 || index >= this.#past.length) return null;
    while (this.#past.length - 1 > index) this.#future.push(this.#past.pop());
    while (this.#past.length - 1 < index && this.#future.length) this.#past.push(this.#future.pop());
    this.#onChange?.(this);
    const head = this.#past[this.#past.length - 1];
    return { snapshot: clone(head.snapshot), label: head.label };
  }

  /** The label of the step undo would take you back past. */
  get undoLabel() {
    return this.canUndo ? this.#past[this.#past.length - 1].label : null;
  }

  get redoLabel() {
    return this.canRedo ? this.#future[this.#future.length - 1].label : null;
  }
}

/** structuredClone where available, JSON otherwise. */
export function clone(value) {
  if (value === null || typeof value !== "object") return value;
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

/* ---------------------------------------------------------------------------
   Persistence
   Every write goes through here so a real API swap touches one file.
   --------------------------------------------------------------------------- */

const NS = "cs.dashboard.v1";

export const persist = {
  read(key, fallback = null) {
    try {
      const raw = localStorage.getItem(`${NS}.${key}`);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },

  write(key, value) {
    try {
      localStorage.setItem(`${NS}.${key}`, JSON.stringify(value));
      return true;
    } catch (error) {
      console.warn("[persist] write failed", error);
      return false;
    }
  },

  remove(key) {
    try {
      localStorage.removeItem(`${NS}.${key}`);
    } catch {
      /* storage unavailable; the session simply does not persist */
    }
  },

  clearAll() {
    try {
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith(NS)) localStorage.removeItem(key);
      }
    } catch {
      /* ignore */
    }
  },
};
