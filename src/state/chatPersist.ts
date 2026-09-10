/** Chat session persistence. Transcripts embed data-URL images (hundreds of
 *  KB each), which overflow localStorage — so they live in IndexedDB. */
import type { SessionEvent } from "../agent/types";

const DB_NAME = "mrs";
const STORE = "kv";
const KEY = "chat";
/** Keep the most recent events only — bounds both storage and re-render cost. */
const MAX_EVENTS = 200;

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") return resolve(null);
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function loadChat(): Promise<SessionEvent[]> {
  const db = await openDb();
  if (!db) return [];
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(KEY);
      req.onsuccess = () => {
        const val = req.result as unknown;
        resolve(Array.isArray(val) ? (val as SessionEvent[]).slice(-MAX_EVENTS) : []);
      };
      req.onerror = () => resolve([]);
    } catch {
      resolve([]);
    }
  });
}

export async function saveChat(events: SessionEvent[]): Promise<void> {
  const db = await openDb();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(events.slice(-MAX_EVENTS), KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}
