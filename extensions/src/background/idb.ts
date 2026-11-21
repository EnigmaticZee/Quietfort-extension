// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Minimal promise wrapper around one IndexedDB object store (key → value).
// Used for binary data that is too big or too frequent for storage.local
// (the hashed protection host sets). If IndexedDB is unavailable (some
// private-browsing modes), values are kept in memory for this session.

const DB = 'adblocker';
const STORE = 'kv';

let dbPromise: Promise<IDBDatabase | null> | null = null;
const memory = new Map<string, unknown>();

function open(): Promise<IDBDatabase | null> {
  if (!dbPromise) {
    dbPromise = new Promise<IDBDatabase | null>((resolve) => {
      let req: IDBOpenDBRequest;
      try {
        req = indexedDB.open(DB, 1);
      } catch {
        resolve(null);
        return;
      }
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => {
        const db = req.result;
        // Another context upgraded / deleted the database: reopen next time.
        db.onversionchange = () => {
          db.close();
          dbPromise = null;
        };
        resolve(db);
      };
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    });
  }
  return dbPromise;
}

function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | null): Promise<T | undefined> {
  return open().then(
    (db) =>
      new Promise<T | undefined>((resolve, reject) => {
        if (!db) {
          resolve(undefined);
          return;
        }
        const tx = db.transaction(STORE, mode);
        const req = fn(tx.objectStore(STORE));
        let value: T | undefined;
        if (req) req.onsuccess = () => (value = req.result);
        tx.oncomplete = () => resolve(value);
        tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
        tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
      }),
  );
}

export async function idbGet<T>(key: string): Promise<T | undefined> {
  const db = await open();
  if (!db) return memory.get(key) as T | undefined;
  return run<T>('readonly', (s) => s.get(key) as IDBRequest<T>);
}

export async function idbSet(key: string, value: unknown): Promise<void> {
  const db = await open();
  if (!db) {
    memory.set(key, value);
    return;
  }
  await run('readwrite', (s) => s.put(value, key));
}

export async function idbDelete(keys: string[]): Promise<void> {
  if (!keys.length) return;
  const db = await open();
  if (!db) {
    for (const k of keys) memory.delete(k);
    return;
  }
  await run('readwrite', (s) => {
    for (const k of keys) s.delete(k);
    return null;
  });
}

export async function idbKeys(): Promise<string[]> {
  const db = await open();
  if (!db) return [...memory.keys()];
  return ((await run<IDBValidKey[]>('readonly', (s) => s.getAllKeys())) ?? []).map(String);
}
