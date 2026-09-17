/** Workspace project store — projects live as JSON bundle files the external
 *  agent can see and version in its own workspace.
 *
 *  Layout:
 *    <workspace>/<Name>.mrsproj.json   one project bundle per file
 *    <workspace>/.motionref/index.json id → {name, path, savedAt}
 *
 *  The bundle shape is the existing export format (motionref-studio/project
 *  v1) with `sessions: []` — chat transcripts stay browser-owned (IndexedDB),
 *  keyed by the stable project id inside the bundle. */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { cloneDoc, createEmptyDocument, type SceneDocument } from "../src/core/types";
import { validateSceneDocument, PROJECT_FORMAT } from "../src/core/validate";
import type { ProjectInfo } from "../src/shared/protocol";
import { writeJsonAtomic } from "./util";

export const PROJECT_EXT = ".mrsproj.json";

interface IndexEntry {
  id: string;
  name: string;
  path: string;
  savedAt: number;
}

interface Bundle {
  format: string;
  version: number;
  exportedAt: number;
  project: { id: string; name: string };
  doc: SceneDocument;
  sessions: unknown[];
}

function slugify(name: string): string {
  const slug = name
    .trim()
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return slug || "untitled";
}

export class ProjectStore {
  readonly workspace: string;
  private index: IndexEntry[] = [];
  private listeners = new Set<() => void>();

  constructor(workspace: string) {
    this.workspace = path.resolve(workspace);
    fs.mkdirSync(this.workspace, { recursive: true });
    this.loadIndex();
    // Absorb orphaned bundle files in the workspace root (e.g. the agent
    // dropped one there, or the index was deleted).
    this.absorbOrphans();
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  private indexPath(): string {
    return path.join(this.workspace, ".motionref", "index.json");
  }

  private loadIndex(): void {
    try {
      const raw = fs.readFileSync(this.indexPath(), "utf8");
      const parsed = JSON.parse(raw) as { projects?: IndexEntry[] };
      this.index = Array.isArray(parsed.projects) ? parsed.projects.filter((e) => e && typeof e.path === "string") : [];
    } catch {
      this.index = [];
    }
  }

  private saveIndex(): void {
    writeJsonAtomic(this.indexPath(), { projects: this.index });
    this.emit();
  }

  private absorbOrphans(): void {
    let changed = false;
    for (const file of fs.readdirSync(this.workspace, { withFileTypes: true })) {
      if (!file.isFile() || !file.name.endsWith(PROJECT_EXT)) continue;
      const full = path.join(this.workspace, file.name);
      if (this.index.some((e) => path.resolve(e.path) === full)) continue;
      const bundle = this.readBundle(full);
      const name = bundle?.project.name ?? file.name.replace(PROJECT_EXT, "");
      this.index.push({
        id: bundle?.project.id ?? randomUUID(),
        name,
        path: full,
        savedAt: fs.statSync(full).mtimeMs,
      });
      changed = true;
    }
    if (changed) this.saveIndex();
  }

  private readBundle(file: string): Bundle | null {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<Bundle>;
      if (parsed.format !== PROJECT_FORMAT || !parsed.doc) return null;
      return {
        format: parsed.format,
        version: parsed.version ?? 1,
        exportedAt: parsed.exportedAt ?? Date.now(),
        project: { id: parsed.project?.id ?? randomUUID(), name: parsed.project?.name ?? "Untitled" },
        doc: parsed.doc,
        sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
      };
    } catch {
      return null;
    }
  }

  list(): ProjectInfo[] {
    // Keep only entries whose file still exists; prune deleted-on-disk files.
    const alive = this.index.filter((e) => fs.existsSync(e.path));
    if (alive.length !== this.index.length) {
      this.index = alive;
      this.saveIndex();
    }
    return [...alive].sort((a, b) => b.savedAt - a.savedAt).map((e) => ({ ...e }));
  }

  byId(id: string): ProjectInfo | null {
    return this.list().find((p) => p.id === id) ?? null;
  }

  /** Create a new project bound to a file (default: workspace root). */
  create(name: string, dir?: string): ProjectInfo {
    const baseDir = dir ? path.resolve(dir) : this.workspace;
    fs.mkdirSync(baseDir, { recursive: true });
    let file = path.join(baseDir, `${slugify(name)}${PROJECT_EXT}`);
    for (let n = 2; fs.existsSync(file); n++) {
      file = path.join(baseDir, `${slugify(name)}-${n}${PROJECT_EXT}`);
    }
    const info: IndexEntry = { id: randomUUID(), name, path: file, savedAt: Date.now() };
    this.index.push(info);
    this.writeBundle(info, createEmptyDocument(name));
    this.saveIndex();
    return { ...info };
  }

  private writeBundle(info: IndexEntry, doc: SceneDocument): void {
    const bundle: Bundle = {
      format: PROJECT_FORMAT,
      version: 1,
      exportedAt: Date.now(),
      project: { id: info.id, name: info.name },
      doc: cloneDoc(doc),
      sessions: [],
    };
    writeJsonAtomic(info.path, bundle);
    info.savedAt = Date.now();
  }

  /** Persist the current doc into a project (creating the entry on first
   *  save of a scratch scene, mirroring the browser store's saveProject). */
  save(current: ProjectInfo | null, doc: SceneDocument, rename?: string, dir?: string): ProjectInfo {
    let entry = current ? this.index.find((e) => e.id === current.id) : undefined;
    if (!entry) {
      const name = rename || doc.name || "Untitled";
      entry = this.createEntryFor(name, dir);
    } else if (rename && rename.trim() && rename !== entry.name) {
      entry.name = rename;
    }
    entry.name = entry.name || doc.name || "Untitled";
    this.writeBundle(entry, doc);
    this.saveIndex();
    return { ...entry };
  }

  private createEntryFor(name: string, dir?: string): IndexEntry {
    const baseDir = dir ? path.resolve(dir) : this.workspace;
    fs.mkdirSync(baseDir, { recursive: true });
    let file = path.join(baseDir, `${slugify(name)}${PROJECT_EXT}`);
    for (let n = 2; fs.existsSync(file); n++) {
      file = path.join(baseDir, `${slugify(name)}-${n}${PROJECT_EXT}`);
    }
    const entry: IndexEntry = { id: randomUUID(), name, path: file, savedAt: Date.now() };
    this.index.push(entry);
    return entry;
  }

  /** Read a project's doc. Falls back to the raw doc if validation migrates
   *  it (same policy as the browser loadProject). */
  open(idOrPath: string): { info: ProjectInfo; doc: SceneDocument } | { error: string } {
    const info = this.byId(idOrPath) ?? this.list().find((p) => path.resolve(p.path) === path.resolve(idOrPath));
    if (!info) return { error: `unknown project "${idOrPath}"` };
    const bundle = this.readBundle(info.path);
    if (!bundle) return { error: `project file unreadable: ${info.path}` };
    const result = validateSceneDocument(bundle.doc);
    if ("error" in result) return { error: result.error };
    return { info, doc: result.doc };
  }

  remove(id: string): boolean {
    const idx = this.index.findIndex((e) => e.id === id);
    if (idx < 0) return false;
    const [entry] = this.index.splice(idx, 1);
    try {
      fs.rmSync(entry.path);
    } catch {
      /* already gone */
    }
    this.saveIndex();
    return true;
  }
}
