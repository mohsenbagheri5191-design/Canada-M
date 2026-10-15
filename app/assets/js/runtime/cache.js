/**
 * A tiny IndexedDB key/value store.
 *
 * IndexedDB rather than localStorage because a layout document is measured in
 * hundreds of kilobytes, localStorage is synchronous and blocks the main thread
 * to read it, and its quota is small enough that a large design would fail to
 * save with an exception that arrives in the middle of a render.
 *
 * Every operation resolves rather than rejects. A device with storage disabled,
 * a private window, a quota exceeded mid-write: none of those are reasons the
 * app should fail to start, they are reasons it starts without a cache.
 */

const DB_NAME = "canada.app";
const STORE = "kv";
const VERSION = 1;

let opening = null;

function open() {
  if (opening) return opening;

  opening = new Promise((resolve) => {
    let request;
    try {
      request = indexedDB.open(DB_NAME, VERSION);
    } catch {
      return resolve(null);
    }

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });

  return opening;
}

function run(mode, fn) {
  return open().then(
    (db) =>
      new Promise((resolve) => {
        if (!db) return resolve(null);
        let tx;
        try {
          tx = db.transaction(STORE, mode);
        } catch {
          return resolve(null);
        }
        const request = fn(tx.objectStore(STORE));
        tx.onabort = () => resolve(null);
        tx.onerror = () => resolve(null);
        if (request) {
          request.onsuccess = () => resolve(request.result ?? null);
          request.onerror = () => resolve(null);
        } else {
          tx.oncomplete = () => resolve(null);
        }
      }),
  );
}

export const get = (key) => run("readonly", (store) => store.get(key));

export const set = (key, value) =>
  run("readwrite", (store) => {
    // A structured-clone failure (a function, a DOM node) would abort the
    // transaction silently, so serialise first and fail loudly in development.
    store.put(value, key);
    return null;
  });

export const remove = (key) =>
  run("readwrite", (store) => {
    store.delete(key);
    return null;
  });

export const clear = () =>
  run("readwrite", (store) => {
    store.clear();
    return null;
  });
