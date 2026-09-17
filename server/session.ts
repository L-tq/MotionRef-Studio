/** StudioSession — the server-side document authority.
 *
 *  Owns the current SceneDocument, a monotonic revision counter, and the
 *  undo/redo history. History semantics mirror the browser store exactly
 *  (JSON snapshots, limit 60, same-label coalescing within 700 ms) so undo
 *  feels identical in both deployment modes. Every commit is validated and
 *  broadcast to all connected clients. */
import { cloneDoc, createEmptyDocument, type SceneDocument } from "../src/core/types";
import { validateSceneDocument } from "../src/core/validate";
import type { ProjectInfo } from "../src/shared/protocol";

const HISTORY_LIMIT = 60;
const COALESCE_MS = 700;

export interface SessionEvents {
  /** Doc committed (validated); broadcast to all clients. */
  onDoc(rev: number, doc: SceneDocument, label: string, source: string): void;
  onHistory(canUndo: boolean, canRedo: boolean): void;
}

export type ApplyResult = { ok: true; rev: number } | { ok: false; error: string };

export class StudioSession {
  private doc: SceneDocument;
  private rev = 0;
  private past: string[] = [];
  private future: string[] = [];
  private lastLabel: string | null = null;
  private lastAt = 0;
  project: ProjectInfo | null = null;

  constructor(private events: SessionEvents) {
    this.doc = createEmptyDocument("Untitled");
  }

  getDoc(): SceneDocument {
    return this.doc;
  }

  getRev(): number {
    return this.rev;
  }

  canUndo(): boolean {
    return this.past.length > 0;
  }

  canRedo(): boolean {
    return this.future.length > 0;
  }

  /** Replace the whole doc (validated). Label coalescing mirrors the browser
   *  store: repeated identical labels within 700 ms merge into one entry. */
  apply(input: unknown, label: string, source: string, opts?: { history?: boolean }): ApplyResult {
    const result = validateSceneDocument(input);
    if ("error" in result) return { ok: false, error: result.error };
    this.commit(result.doc, label, source, opts);
    return { ok: true, rev: this.rev };
  }

  /** Mutate a draft and commit — convenience for server-side bookkeeping
   *  (project rebinding etc.). Throws nothing: fn errors abort silently. */
  mutate(label: string, source: string, fn: (draft: SceneDocument) => void): ApplyResult {
    const draft = cloneDoc(this.doc);
    try {
      fn(draft);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    return this.apply(draft, label, source);
  }

  private commit(doc: SceneDocument, label: string, source: string, opts?: { history?: boolean }): void {
    const useHistory = opts?.history !== false;
    if (useHistory) {
      const now = Date.now();
      const coalesce = this.lastLabel === label && now - this.lastAt < COALESCE_MS;
      this.past = coalesce ? this.past : [...this.past, JSON.stringify(this.doc)].slice(-HISTORY_LIMIT);
      this.lastLabel = label;
      this.lastAt = now;
    }
    this.doc = doc;
    this.future = [];
    this.rev++;
    this.events.onDoc(this.rev, this.doc, label, source);
    if (useHistory) this.events.onHistory(this.canUndo(), this.canRedo());
  }

  undo(source: string): boolean {
    if (!this.past.length) return false;
    const prev = JSON.parse(this.past[this.past.length - 1]) as SceneDocument;
    this.past = this.past.slice(0, -1);
    this.future = [JSON.stringify(this.doc), ...this.future].slice(0, HISTORY_LIMIT);
    this.doc = prev;
    this.lastLabel = null;
    this.rev++;
    this.events.onDoc(this.rev, this.doc, "undo", source);
    this.events.onHistory(this.canUndo(), this.canRedo());
    return true;
  }

  redo(source: string): boolean {
    if (!this.future.length) return false;
    const next = JSON.parse(this.future[0]) as SceneDocument;
    this.future = this.future.slice(1);
    this.past = [...this.past, JSON.stringify(this.doc)].slice(-HISTORY_LIMIT);
    this.doc = next;
    this.lastLabel = null;
    this.rev++;
    this.events.onDoc(this.rev, this.doc, "redo", source);
    this.events.onHistory(this.canUndo(), this.canRedo());
    return true;
  }

  /** Bind the session to a project (opening/creating) — swaps the doc
   *  without recording an undo entry across project boundaries. */
  loadProjectDoc(info: ProjectInfo, doc: SceneDocument, source: string): void {
    this.project = info;
    this.doc = doc;
    this.past = [];
    this.future = [];
    this.lastLabel = null;
    this.rev++;
    this.events.onDoc(this.rev, this.doc, "open-project", source);
    this.events.onHistory(false, false);
  }

  clearProject(source: string): void {
    this.project = null;
    this.doc = createEmptyDocument("Untitled");
    this.past = [];
    this.future = [];
    this.rev++;
    this.events.onDoc(this.rev, this.doc, "new-project", source);
    this.events.onHistory(false, false);
  }
}
