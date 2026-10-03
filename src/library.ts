// ---------------------------------------------------------------------------
// My creations: every scene you've made, kept in the browser (IndexedDB) so
// they can be browsed and reopened without going through files. IndexedDB
// rather than localStorage: it holds far more than localStorage's few
// megabytes, and the thumbnails would fill that quickly.

export interface Creation<T = unknown> {
  id: string;
  /** set when renamed; otherwise it's named after its creatures */
  name?: string;
  created: number;
  updated: number;
  /** small preview image (data URL) */
  thumb?: string;
  data: T;
}

const DB_NAME = 'critterkiln';
const STORE = 'creations';

let dbPromise: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('The library is open in an older tab'));
  });
  // a failed open (private window, storage blocked) can be tried again later
  dbPromise.catch(() => (dbPromise = null));
  return dbPromise;
}

async function run<R>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<R>): Promise<R> {
  const tx = (await db()).transaction(STORE, mode);
  const req = fn(tx.objectStore(STORE));
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = tx.onabort = () => reject(tx.error ?? req.error);
  });
}

/** Newest first. */
export async function listCreations<T>(): Promise<Creation<T>[]> {
  const all = await run('readonly', (s) => s.getAll() as IDBRequest<Creation<T>[]>);
  return all.sort((a, b) => b.updated - a.updated);
}

export function getCreation<T>(id: string): Promise<Creation<T> | undefined> {
  return run('readonly', (s) => s.get(id) as IDBRequest<Creation<T> | undefined>);
}

export async function putCreation<T>(c: Creation<T>): Promise<void> {
  await run('readwrite', (s) => s.put(c));
}

export async function deleteCreation(id: string): Promise<void> {
  await run('readwrite', (s) => s.delete(id));
}

/** Ask the browser not to clear the library when space runs low (granted quietly, or not at all). */
export function keepStorage() {
  navigator.storage?.persist?.().catch(() => {});
}
