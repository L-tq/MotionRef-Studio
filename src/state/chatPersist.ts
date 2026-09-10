/** Chat session persistence — multiple named sessions in IndexedDB.
 *
 *  Transcripts embed data-URL images (hundreds of KB each), which overflow
 *  localStorage — so sessions live in IndexedDB (store "sessions", DB "mrs").
 *  Only a pointer to the active session id goes to localStorage so boot is
 *  synchronous where it matters. The legacy single-transcript key ("kv"/"chat")
 *  is migrated into a session record on first run.
 */
import { newId } from "../core/types";
import type { SessionEvent } from "../agent/types";

const DB_NAME = "mrs";
const DB_VERSION = 2;
const KV_STORE = "kv";
const SESSIONS_STORE = "sessions";
const CURRENT_KEY = "mrs.chat.current";
/** Keep the most recent events only — bounds both storage and re-render cost. */
const MAX_EVENTS = 200;

export interface ChatSessionRecord {
  id: string;
  /** Display name; empty string → UI shows a localized default. */
  name: string;
  /** Owning project id; null = scratch space (unsaved/new projects). */
  projectId: string | null;
  createdAt: number;
  updatedAt: number;
  events: SessionEvent[];
}

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") return resolve(null);
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(KV_STORE)) db.createObjectStore(KV_STORE);
        if (!db.objectStoreNames.contains(SESSIONS_STORE)) db.createObjectStore(SESSIONS_STORE, { keyPath: "id" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
    tx.onabort = () => resolve();
  });
}

/** All session records of one project (or the scratch space), most recently
 *  updated first. Omit `projectId` to list every record. Records saved before
 *  projects existed count as scratch. */
export async function listSessions(projectId?: string | null): Promise<ChatSessionRecord[]> {
  const db = await openDb();
  if (!db) return [];
  return new Promise((resolve) => {
    try {
      const req = db.transaction(SESSIONS_STORE, "readonly").objectStore(SESSIONS_STORE).getAll();
      req.onsuccess = () => {
        const rows = (req.result ?? []) as ChatSessionRecord[];
        resolve(
          rows
            .filter((r) => r && typeof r.id === "string" && Array.isArray(r.events))
            .filter((r) => projectId === undefined || (r.projectId ?? null) === projectId)
            .map((r) => ({ ...r, projectId: r.projectId ?? null, events: r.events.slice(-MAX_EVENTS) }))
            .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)),
        );
      };
      req.onerror = () => resolve([]);
    } catch {
      resolve([]);
    }
  });
}

export async function getSession(id: string): Promise<ChatSessionRecord | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const req = db.transaction(SESSIONS_STORE, "readonly").objectStore(SESSIONS_STORE).get(id);
      req.onsuccess = () => resolve((req.result as ChatSessionRecord | undefined) ?? null);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function putSession(record: ChatSessionRecord): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    const rec = { ...record, events: record.events.slice(-MAX_EVENTS) };
    const tx = db.transaction(SESSIONS_STORE, "readwrite");
    tx.objectStore(SESSIONS_STORE).put(rec);
    await txDone(tx);
  } catch {
    /* storage unavailable — chat stays in memory */
  }
}

export async function deleteSessionRecord(id: string): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction(SESSIONS_STORE, "readwrite");
    tx.objectStore(SESSIONS_STORE).delete(id);
    await txDone(tx);
  } catch {
    /* ignore */
  }
}

export function loadCurrentSessionId(): string | null {
  try {
    return localStorage.getItem(CURRENT_KEY);
  } catch {
    return null;
  }
}

export function saveCurrentSessionId(id: string): void {
  try {
    localStorage.setItem(CURRENT_KEY, id);
  } catch {
    /* ignore */
  }
}

/** One-time migration: the pre-multi-session transcript (kv/"chat") becomes a
 *  real session record so nothing the user said is lost on upgrade. */
export async function migrateLegacyChat(): Promise<void> {
  try {
    const existing = await listSessions();
    if (existing.length > 0) return;
    const db = await openDb();
    if (!db) return;
    const legacy = await new Promise<SessionEvent[]>((resolve) => {
      try {
        const req = db.transaction(KV_STORE, "readonly").objectStore(KV_STORE).get("chat");
        req.onsuccess = () => {
          const val = req.result as unknown;
          resolve(Array.isArray(val) ? (val as SessionEvent[]) : []);
        };
        req.onerror = () => resolve([]);
      } catch {
        resolve([]);
      }
    });
    if (legacy.length > 0) {
      const now = Date.now();
      await putSession({ id: newId("s"), name: "", projectId: null, createdAt: now, updatedAt: now, events: legacy });
    }
  } catch {
    /* migration is best-effort */
  }
}
