/** Central app store (zustand): scene doc + history, editor state, settings,
 *  projects and the agent session log. */
import { create } from "zustand";
import {
  cloneDoc,
  createEmptyDocument,
  newId,
  randomPaletteColor,
  specOf,
  type CameraKey,
  type GeometryType,
  type SceneDocument,
  type TransformKey,
  type Vec3,
} from "../core/types";
import { evaluate, evalCamera } from "../core/animation";
import type { GizmoMode } from "../core/engine";
import { validateSceneDocument } from "../core/validate";
import { clampAspect } from "../core/cameraMath";
import { putSession } from "./chatPersist";
import {
  DEFAULT_LLM_SETTINGS,
  isConfigured,
  type AgentState,
  type LlmSettings,
  type SessionEvent,
} from "../agent/types";

export interface ProjectEntry {
  id: string;
  name: string;
  savedAt: number;
  doc: SceneDocument;
}

/** Lightweight task metadata (transcripts live in IndexedDB, see chatPersist). */
export interface TaskMeta {
  id: string;
  name: string;
  projectId: string | null;
  createdAt: number;
  updatedAt: number;
}

/** User-resizable panel geometry (px) + timeline zoom + panel visibility. */
export interface LayoutState {
  leftW: number;
  rightW: number;
  timelineH: number;
  inspH: number;
  /** Left / right / bottom panels can be collapsed via the viewport's
   *  triangle tabs; sizes are kept so reopening restores the layout. */
  leftOpen: boolean;
  rightOpen: boolean;
  timelineOpen: boolean;
  /** Timeline pixels per second. Null until the user zooms; the timeline
   *  then starts fitted to the current width. */
  timelineZoom: number | null;
  /** Bottom-panel editor type: keyframe rows or the curve graph editor. */
  timelineMode?: "tracks" | "graph";
}

export const DEFAULT_LAYOUT: LayoutState = {
  leftW: 236,
  rightW: 384,
  timelineH: 232,
  inspH: 320,
  leftOpen: true,
  rightOpen: true,
  timelineOpen: true,
  timelineZoom: null,
};

const SETTINGS_KEY = "mrs.settings";
const PROJECTS_KEY = "mrs.projects";
const LAYOUT_KEY = "mrs.layout";
const CURRENT_PROJECT_KEY = "mrs.currentProject";

function loadCurrentProjectId(): string | null {
  try {
    return localStorage.getItem(CURRENT_PROJECT_KEY);
  } catch {
    return null;
  }
}

/** One entry in the message center (toasts + background errors are logged). */
export interface AppMessage {
  id: string;
  kind: "info" | "warn" | "error";
  text: string;
  time: number;
  /** How many times this consecutive message repeated. */
  count: number;
}

function loadSettings(): LlmSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const parsed = { ...DEFAULT_LLM_SETTINGS, ...(JSON.parse(raw) as Partial<LlmSettings>) };
      // Migration: 24 was the old default; users who never touched it get the
      // new default of 100.
      if (parsed.maxSteps === 24) parsed.maxSteps = DEFAULT_LLM_SETTINGS.maxSteps;
      return parsed;
    }
  } catch {
    /* ignore */
  }
  return { ...DEFAULT_LLM_SETTINGS };
}

function loadProjects(): ProjectEntry[] {
  try {
    const raw = localStorage.getItem(PROJECTS_KEY);
    if (raw) {
      const list = JSON.parse(raw) as ProjectEntry[];
      if (Array.isArray(list)) return list.slice(0, 50);
    }
  } catch {
    /* ignore */
  }
  return [];
}

function loadLayout(): LayoutState {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (raw) return { ...DEFAULT_LAYOUT, ...(JSON.parse(raw) as Partial<LayoutState>) };
  } catch {
    /* ignore */
  }
  return { ...DEFAULT_LAYOUT };
}

export interface AppState {
  // Scene
  doc: SceneDocument;
  past: string[];
  future: string[];
  lastHistoryLabel: string | null;
  lastHistoryAt: number;

  // Editor state
  selection: string[];
  playhead: number;
  playing: boolean;
  autoKey: boolean;
  /** Auto-key recording mode (Blender-style): "addReplace" inserts new keys
   *  on unkeyed playhead frames, "replace" only overwrites existing keys. */
  autoKeyMode: "addReplace" | "replace";
  gizmo: GizmoMode;
  showGrid: boolean;
  cameraPreview: boolean;

  // UI
  settingsOpen: boolean;
  onboarding: boolean;
  projectsOpen: boolean;
  exportOpen: boolean;
  lightbox: string | null;
  rightTab: "chat" | "script";
  toast: string | null;
  layout: LayoutState;
  messages: AppMessage[];
  unreadMessages: number;
  messagesOpen: boolean;

  // Config
  settings: LlmSettings;

  // Projects
  projects: ProjectEntry[];
  /** Project the working scene is bound to; null = unsaved/scratch. */
  projectId: string | null;

  // Agent tasks (per project; transcripts in taskEvents, chat UI reads the active one)
  tasks: TaskMeta[];
  taskEvents: Record<string, SessionEvent[]>;
  activeTaskId: string | null;
  taskStates: Record<string, AgentState>;
  taskSteps: Record<string, number>;
}

export interface AppActions {
  // History-wrapped doc mutation. Coalesces repeated identical labels.
  mutateDoc(label: string, fn: (draft: SceneDocument) => void, opts?: { history?: boolean }): void;
  undo(): void;
  redo(): void;

  // Scene ops
  addObject(type: GeometryType): void;
  deleteObjects(ids: string[]): void;
  duplicateObject(id: string): void;
  commitPose(id: string, pose: Partial<Pick<TransformKey, "position" | "rotation" | "scale">>): void;
  setKeyAtPlayhead(id?: string): void;
  setCameraKeyAtPlayhead(): void;
  retimeKey(target: { objectId: string } | { camera: true }, fromT: number, toT: number): void;
  deleteKey(target: { objectId: string } | { camera: true }, atT: number): void;
  /** Graph-editor edits: change channel values stored on one key. */
  setKeyValues(
    target: { objectId: string } | { camera: true },
    atT: number,
    patch: { position?: [number, number, number]; rotation?: [number, number, number]; scale?: [number, number, number]; target?: [number, number, number]; fov?: number },
  ): void;
  /** Insert a full keyframe (evaluated pose at t) into an object track or the camera. */
  insertKeyAt(target: { objectId: string } | { camera: true }, t: number): void;
  /** Graph editor: Gaussian-smooth exactly the selected curve points (σ in
   *  key count). `points` are channel-scoped — sibling channels of the same
   *  key and unselected keys keep their values. */
  smoothKeys(
    target: { objectId: string } | { camera: true },
    points: Array<{ chan: "position" | "rotation" | "scale" | "target" | "fov"; index: number; t: number }>,
    sigma: number,
  ): void;
  clearTrack(objectId: string): void;
  applyDoc(doc: SceneDocument, label: string): void;

  // Camera / timeline
  commitCamera(patch: { position?: [number, number, number]; target?: [number, number, number]; fov?: number }): void;
  setAspect(ratio: number): void;
  setDuration(d: number): void;
  setFps(f: number): void;

  // Playback / selection / view
  setPlayhead(t: number): void;
  play(): void;
  pause(): void;
  stop(): void;
  select(id: string | null, additive: boolean): void;
  setGizmo(mode: GizmoMode): void;
  setUi<K extends keyof AppState>(key: K, value: AppState[K]): void;
  setLayout(patch: Partial<LayoutState>): void;
  /** Log a message; returns true when it is a NEW entry (repeats only bump
   *  the counter). opts.toast also shows it as a transient toast. */
  pushMessage(kind: AppMessage["kind"], text: string, opts?: { toast?: boolean }): boolean;
  clearMessages(): void;

  // Settings
  saveSettings(patch: Partial<LlmSettings>): void;

  // Projects
  refreshProjects(): void;
  saveProject(): void;
  loadProject(id: string): void;
  deleteProject(id: string): void;
  /** Bind the working scene to a project (or none) and swap the task view. */
  setProjectId(id: string | null): void;

  // Agent tasks
  /** Append an event to one task's transcript. */
  taskPush(taskId: string, event: SessionEvent): void;
  /** Patch one event inside a task's transcript. */
  taskPatch(taskId: string, eventId: string, patch: Partial<SessionEvent>): void;
  setActiveTask(taskId: string): void;
  setTaskState(taskId: string, state: AgentState): void;
  setTaskStep(taskId: string, step: number): void;
  /** Remember which project owns a task (used by persistence). */
  registerTaskProject(taskId: string, projectId: string | null): void;
  showToast(message: string): void;
}

const HISTORY_LIMIT = 60;
const COALESCE_MS = 700;

/** Owning project per task id — persistence must not depend on which project
 *  is currently open when the debounced save fires. */
const taskProjectOf = new Map<string, string | null>();

const taskSaveTimers = new Map<string, number>();

function scheduleTaskSave(taskId: string): void {
  window.clearTimeout(taskSaveTimers.get(taskId));
  taskSaveTimers.set(
    taskId,
    window.setTimeout(() => {
      taskSaveTimers.delete(taskId);
      const s = useStore.getState();
      const meta = s.tasks.find((m) => m.id === taskId);
      void putSession({
        id: taskId,
        name: meta?.name ?? "",
        projectId: taskProjectOf.get(taskId) ?? null,
        createdAt: meta?.createdAt ?? Date.now(),
        updatedAt: Date.now(),
        events: s.taskEvents[taskId] ?? [],
      });
      if (taskId === s.activeTaskId) {
        useStore.setState((st) => ({
          tasks: st.tasks.map((m) => (m.id === taskId ? { ...m, updatedAt: Date.now() } : m)),
        }));
      }
    }, 600),
  );
}

function eventById(e: SessionEvent, id: string): boolean {
  return e.id === id;
}

export const useStore = create<AppState & AppActions>((set, get) => ({
  doc: createEmptyDocument(),
  past: [],
  future: [],
  lastHistoryLabel: null,
  lastHistoryAt: 0,

  selection: [],
  playhead: 0,
  playing: false,
  autoKey: true,
  autoKeyMode: "addReplace",
  gizmo: "select",
  showGrid: true,
  cameraPreview: false,

  settingsOpen: false,
  onboarding: false,
  projectsOpen: false,
  exportOpen: false,
  lightbox: null,
  rightTab: "chat",
  toast: null,
  layout: loadLayout(),
  messages: [],
  unreadMessages: 0,
  messagesOpen: false,

  settings: loadSettings(),
  projects: loadProjects(),
  projectId: loadCurrentProjectId(),

  tasks: [],
  taskEvents: {},
  activeTaskId: null,
  taskStates: {},
  taskSteps: {},

  // --- history ---------------------------------------------------------------

  mutateDoc(label, fn, opts) {
    const state = get();
    const draft = cloneDoc(state.doc);
    fn(draft);
    const useHistory = opts?.history !== false;
    if (useHistory) {
      const now = Date.now();
      const coalesce = state.lastHistoryLabel === label && now - state.lastHistoryAt < COALESCE_MS;
      const past = coalesce ? state.past : [...state.past, JSON.stringify(state.doc)].slice(-HISTORY_LIMIT);
      set({ doc: draft, past, future: [], lastHistoryLabel: label, lastHistoryAt: now });
    } else {
      set({ doc: draft, future: [] });
    }
  },

  undo() {
    const { past, future, doc } = get();
    if (!past.length) return;
    const prev = past[past.length - 1];
    set({
      doc: JSON.parse(prev) as SceneDocument,
      past: past.slice(0, -1),
      future: [JSON.stringify(doc), ...future].slice(0, HISTORY_LIMIT),
      lastHistoryLabel: null,
    });
  },

  redo() {
    const { past, future, doc } = get();
    if (!future.length) return;
    const next = future[0];
    set({
      doc: JSON.parse(next) as SceneDocument,
      past: [...past, JSON.stringify(doc)].slice(-HISTORY_LIMIT),
      future: future.slice(1),
      lastHistoryLabel: null,
    });
  },

  // --- scene ops ---------------------------------------------------------------

  addObject(type) {
    const spec = specOf(type);
    const id = newId();
    get().mutateDoc("add-object", (draft) => {
      const count = draft.objects.filter((o) => o.type === type).length + 1;
      draft.objects.push({
        id,
        name: `${spec.label} ${count}`,
        type,
        params: { ...spec.defaults },
        position: [0, spec.defaults.radius ?? Math.max(spec.defaults.height ?? 1, 0.5) * 0.6, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
        color: randomPaletteColor(),
        visible: true,
      });
    });
    set({ selection: [id] });
  },

  deleteObjects(ids) {
    if (!ids.length) return;
    const idSet = new Set(ids);
    get().mutateDoc("delete-object", (draft) => {
      draft.objects = draft.objects.filter((o) => !idSet.has(o.id));
      for (const id of ids) delete draft.tracks[id];
    });
    set((s) => ({ selection: s.selection.filter((id) => !idSet.has(id)) }));
  },

  duplicateObject(id) {
    const src = get().doc.objects.find((o) => o.id === id);
    if (!src) return;
    const copyId = newId();
    get().mutateDoc("duplicate-object", (draft) => {
      const copy = JSON.parse(JSON.stringify(src)) as typeof src;
      copy.id = copyId;
      copy.name = `${src.name} copy`;
      copy.position = [src.position[0] + 1, src.position[1], src.position[2]];
      draft.objects.push(copy);
      const track = draft.tracks[id];
      if (track) draft.tracks[copyId] = JSON.parse(JSON.stringify(track));
    });
    set({ selection: [copyId] });
  },

  /** Gizmo / inspector transform edit with auto-key semantics. */
  commitPose(id, pose) {
    const state = get();
    const obj = state.doc.objects.find((o) => o.id === id);
    if (!obj) return;
    const track = state.doc.tracks[id];
    const hasTrack = !!track?.length;
    const t = +state.playhead.toFixed(4);
    const hasKeyAtT = !!track?.some((k) => Math.abs(k.t - t) < 1e-4);
    // "Replace" mode only overwrites keys that already exist at the playhead;
    // "Add & Replace" (and plain keyed objects) may also insert new ones.
    const replaceOnly = state.autoKey && state.autoKeyMode === "replace";
    if (hasKeyAtT || (!replaceOnly && (hasTrack || state.autoKey))) {
      state.mutateDoc("pose", (draft) => {
        const keys = (draft.tracks[id] ??= []);
        const existing = keys.find((k) => Math.abs(k.t - t) < 1e-4);
        const basePose = {
          position: [...obj.position] as [number, number, number],
          rotation: [...obj.rotation] as [number, number, number],
          scale: [...obj.scale] as [number, number, number],
          color: obj.color,
          visible: obj.visible,
        };
        const current = existing ?? { t, ...basePose, interp: "linear" as const };
        const merged = { ...current, t, ...pose };
        if (existing) Object.assign(existing, merged);
        else keys.push(merged);
        keys.sort((a, b) => a.t - b.t);
      });
    } else {
      state.mutateDoc("pose", (draft) => {
        const target = draft.objects.find((o) => o.id === id);
        if (!target) return;
        if (pose.position) target.position = [...pose.position];
        if (pose.rotation) target.rotation = [...pose.rotation];
        if (pose.scale) target.scale = [...pose.scale];
      });
    }
  },

  setKeyAtPlayhead(idArg) {
    const state = get();
    const id = idArg ?? state.selection[0];
    if (!id) return;
    const ev = evaluate(state.doc, state.playhead).objects.get(id);
    const obj = state.doc.objects.find((o) => o.id === id);
    if (!ev || !obj) return;
    state.mutateDoc("set-key", (draft) => {
      const keys = (draft.tracks[id] ??= []);
      const t = +state.playhead.toFixed(4);
      const existing = keys.find((k) => Math.abs(k.t - t) < 1e-4);
      const entry: TransformKey = {
        t,
        position: [...ev.position] as [number, number, number],
        rotation: [...ev.rotation] as [number, number, number],
        scale: [...ev.scale] as [number, number, number],
        color: ev.color,
        visible: ev.visible,
        interp: existing?.interp ?? "linear",
      };
      const idx = existing ? keys.indexOf(existing) : -1;
      if (idx >= 0) keys[idx] = entry;
      else keys.push(entry);
      keys.sort((a, b) => a.t - b.t);
    });
  },

  setCameraKeyAtPlayhead() {
    const state = get();
    const cam = evaluate(state.doc, state.playhead).camera;
    state.mutateDoc("cam-key", (draft) => {
      const t = +state.playhead.toFixed(4);
      const existing = draft.cameraKeys.find((k) => Math.abs(k.t - t) < 1e-4);
      const entry = {
        t,
        position: [...cam.position] as [number, number, number],
        target: [...cam.target] as [number, number, number],
        fov: cam.fov,
        interp: (existing?.interp ?? "linear") as "linear",
      };
      const idx = existing ? draft.cameraKeys.indexOf(existing) : -1;
      if (idx >= 0) draft.cameraKeys[idx] = entry;
      else draft.cameraKeys.push(entry);
      draft.cameraKeys.sort((a, b) => a.t - b.t);
    });
  },

  retimeKey(target, fromT, toT) {
    const clamped = Math.min(Math.max(+toT.toFixed(4), 0), get().doc.duration);
    get().mutateDoc("retime-key", (draft) => {
      const keys = "camera" in target ? draft.cameraKeys : draft.tracks[target.objectId];
      if (!keys?.length) return;
      let best = -1;
      let bestD = Infinity;
      keys.forEach((k, i) => {
        const d = Math.abs(k.t - fromT);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      });
      if (best >= 0) {
        keys[best] = { ...keys[best], t: clamped };
        keys.sort((a, b) => a.t - b.t);
      }
    });
  },

  deleteKey(target, atT) {
    get().mutateDoc("delete-key", (draft) => {
      const keys = "camera" in target ? draft.cameraKeys : draft.tracks[target.objectId];
      if (!keys?.length) return;
      let best = -1;
      let bestD = Infinity;
      keys.forEach((k, i) => {
        const d = Math.abs(k.t - atT);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      });
      if (best >= 0) keys.splice(best, 1);
    });
  },

  clearTrack(objectId) {
    get().mutateDoc("clear-track", (draft) => {
      delete draft.tracks[objectId];
    });
  },

  setKeyValues(target, atT, patch) {
    get().mutateDoc("edit-key", (draft) => {
      if ("camera" in target) {
        const key = draft.cameraKeys.find((k) => Math.abs(k.t - atT) < 1e-4);
        if (!key) return;
        if (patch.position) key.position = [...patch.position];
        if (patch.target) key.target = [...patch.target];
        if (patch.fov !== undefined) key.fov = patch.fov;
      } else {
        const key = draft.tracks[target.objectId]?.find((k) => Math.abs(k.t - atT) < 1e-4);
        if (!key) return;
        if (patch.position) key.position = [...patch.position];
        if (patch.rotation) key.rotation = [...patch.rotation];
        if (patch.scale) key.scale = [...patch.scale];
      }
    });
  },

  /** Gaussian-smooth the selected curve points (Blender "Smooth Keys"): each
   *  selected point's value becomes the Gaussian-weighted average of its own
   *  channel's values across the whole track, weighted by key-index distance
   *  with σ in key count. Only selected (channel, key) pairs are written. */
  smoothKeys(target, points, sigma) {
    if (!points.length || !(sigma > 0)) return;
    get().mutateDoc("smooth-keys", (draft) => {
      const keys = "camera" in target ? draft.cameraKeys : draft.tracks[target.objectId];
      if (!keys?.length) return;
      const weight = (i: number, j: number) => Math.exp(-0.5 * ((i - j) / sigma) ** 2);
      type Comp = "position" | "rotation" | "scale" | "target";
      const ks = keys as Array<TransformKey & CameraKey>;
      const readComp = (k: TransformKey & CameraKey, chan: Comp | "fov", index: number): number | undefined => {
        if (chan === "fov") return k.fov;
        const v = k[chan];
        return v ? v[index] : undefined;
      };
      const writeComp = (i: number, chan: Comp | "fov", index: number, v: number) => {
        if (chan === "fov") {
          ks[i] = { ...ks[i], fov: v };
          return;
        }
        const arr = [...(ks[i][chan] as Vec3)] as Vec3;
        arr[index] = v;
        ks[i] = { ...ks[i], [chan]: arr };
      };
      // One weighted average per channel; every key defining that channel
      // (selected or not) contributes as a neighbor.
      const groups = new Map<string, Set<number>>();
      for (const p of points) {
        const gk = `${p.chan}.${p.index}`;
        if (!groups.has(gk)) groups.set(gk, new Set());
        groups.get(gk)!.add(+p.t.toFixed(4));
      }
      for (const [gk, times] of groups) {
        const split = gk.lastIndexOf(".");
        const chan = gk.slice(0, split) as Comp | "fov";
        const index = +gk.slice(split + 1);
        const defined: Array<{ i: number; v: number }> = [];
        ks.forEach((k, i) => {
          const v = readComp(k, chan, index);
          if (v !== undefined) defined.push({ i, v });
        });
        if (!defined.length) continue;
        for (const t of times) {
          const i = keys.findIndex((k) => Math.abs(k.t - t) < 1e-4);
          if (i < 0) continue;
          let wsum = 0;
          let acc = 0;
          for (const { i: j, v } of defined) {
            const w = weight(i, j);
            wsum += w;
            acc += w * v;
          }
          if (wsum > 1e-9) writeComp(i, chan, index, acc / wsum);
        }
      }
    });
  },

  insertKeyAt(target, t) {
    const state = get();
    const time = Math.min(Math.max(t, 0), state.doc.duration);
    state.mutateDoc("insert-key", (draft) => {
      if ("camera" in target) {
        const cam = evalCamera(draft, time);
        const existing = draft.cameraKeys.find((k) => Math.abs(k.t - time) < 1e-4);
        if (existing) return;
        draft.cameraKeys.push({ t: +time.toFixed(4), position: cam.position, target: cam.target, fov: cam.fov, interp: "linear" });
        draft.cameraKeys.sort((a, b) => a.t - b.t);
      } else {
        const obj = draft.objects.find((o) => o.id === target.objectId);
        if (!obj) return;
        const pose = evaluate(draft, time).objects.get(target.objectId);
        const existing = (draft.tracks[target.objectId] ?? []).find((k) => Math.abs(k.t - time) < 1e-4);
        if (existing || !pose) return;
        const keys = (draft.tracks[target.objectId] ??= []);
        keys.push({
          t: +time.toFixed(4),
          position: [...pose.position],
          rotation: [...pose.rotation],
          scale: [...pose.scale],
          color: pose.color,
          visible: pose.visible,
          interp: "linear",
        });
        keys.sort((a, b) => a.t - b.t);
      }
    });
  },

  applyDoc(doc, label) {
    const result = validateSceneDocument(doc);
    if ("error" in result) {
      get().showToast(result.error);
      return;
    }
    get().mutateDoc(label, (draft) => {
      Object.assign(draft, result.doc);
    });
  },

  commitCamera(patch) {
    const state = get();
    const hasKeys = state.doc.cameraKeys.length > 0;
    const t = +state.playhead.toFixed(4);
    const hasKeyAtT = state.doc.cameraKeys.some((k) => Math.abs(k.t - t) < 1e-4);
    const replaceOnly = state.autoKey && state.autoKeyMode === "replace";
    if (hasKeyAtT || (!replaceOnly && (hasKeys || state.autoKey))) {
      state.mutateDoc("camera", (draft) => {
        const cam = evaluate(draft, t).camera;
        const existing = draft.cameraKeys.find((k) => Math.abs(k.t - t) < 1e-4);
        const entry = {
          t,
          position: (patch.position ?? [...cam.position]) as [number, number, number],
          target: (patch.target ?? [...cam.target]) as [number, number, number],
          fov: patch.fov ?? cam.fov,
          interp: (existing?.interp ?? "linear") as "linear",
        };
        const idx = existing ? draft.cameraKeys.indexOf(existing) : -1;
        if (idx >= 0) draft.cameraKeys[idx] = entry;
        else draft.cameraKeys.push(entry);
        draft.cameraKeys.sort((a, b) => a.t - b.t);
      });
    } else {
      state.mutateDoc("camera", (draft) => {
        if (patch.position) draft.camera.position = [...patch.position];
        if (patch.target) draft.camera.target = [...patch.target];
        if (patch.fov !== undefined) draft.camera.fov = patch.fov;
      });
    }
  },

  setAspect(ratio) {
    if (!Number.isFinite(ratio)) return;
    get().mutateDoc("camera-aspect", (draft) => {
      draft.aspect = +clampAspect(ratio).toFixed(4);
    });
  },

  setDuration(d) {
    if (!Number.isFinite(d) || d <= 0 || d > 300) return;
    get().mutateDoc("duration", (draft) => {
      draft.duration = +d.toFixed(3);
    });
  },

  setFps(f) {
    if (!Number.isInteger(f) || f < 1 || f > 120) return;
    get().mutateDoc("fps", (draft) => {
      draft.fps = f;
    });
  },

  // --- playback / view ---------------------------------------------------------

  setPlayhead(t) {
    const doc = get().doc;
    set({ playhead: Math.min(Math.max(+t.toFixed(4), 0), doc.duration) });
  },

  play() {
    set((s) => ({ playing: true, playhead: s.playhead >= s.doc.duration - 1e-4 ? 0 : s.playhead }));
  },

  pause() {
    set({ playing: false });
  },

  stop() {
    set({ playing: false, playhead: 0 });
  },

  select(id, additive) {
    if (id === null) {
      set({ selection: [] });
      return;
    }
    set((s) => {
      if (additive) {
        return s.selection.includes(id)
          ? { selection: s.selection.filter((x) => x !== id) }
          : { selection: [...s.selection, id] };
      }
      return { selection: [id] };
    });
  },

  setGizmo(mode) {
    set({ gizmo: mode });
  },

  setUi(key, value) {
    set({ [key]: value } as Partial<AppState>);
  },

  setLayout(patch) {
    const layout = { ...get().layout, ...patch };
    set({ layout });
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
    } catch {
      /* ignore */
    }
  },

  pushMessage(kind, text, opts) {
    const msgs = get().messages;
    const [last, ...rest] = msgs;
    if (last && last.kind === kind && last.text === text) {
      set({ messages: [{ ...last, count: last.count + 1, time: Date.now() }, ...rest] });
      return false;
    }
    const s = get();
    const entry: AppMessage = { id: newId("m"), kind, text, time: Date.now(), count: 1 };
    set({
      messages: [entry, ...msgs].slice(0, 100),
      unreadMessages: s.messagesOpen ? s.unreadMessages : s.unreadMessages + 1,
    });
    if (opts?.toast) {
      set({ toast: text });
      setTimeout(() => {
        if (get().toast === text) set({ toast: null });
      }, 2600);
    }
    return true;
  },

  clearMessages() {
    set({ messages: [], unreadMessages: 0 });
  },

  // --- settings ------------------------------------------------------------------

  saveSettings(patch) {
    const next = { ...get().settings, ...patch };
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
    set({ settings: next });
  },

  // --- projects -------------------------------------------------------------------

  refreshProjects() {
    set({ projects: loadProjects() });
  },

  saveProject() {
    const state = get();
    // Save updates the bound project in place; a new/unsaved scene gets an id
    // and becomes bound so later saves keep updating the same project (and its
    // task list stays attached).
    const id = state.projectId ?? newId("p");
    const entry: ProjectEntry = {
      id,
      name: state.doc.name || "Untitled",
      savedAt: Date.now(),
      doc: cloneDoc(state.doc),
    };
    const projects = [entry, ...state.projects.filter((p) => p.id !== id)].slice(0, 50);
    try {
      localStorage.setItem(PROJECTS_KEY, JSON.stringify(projects));
    } catch {
      state.showToast("error.storageFull");
      return;
    }
    set({ projects, projectId: id });
    try {
      localStorage.setItem(CURRENT_PROJECT_KEY, id);
    } catch {
      /* ignore */
    }
    // First save of an unsaved scene: adopt its scratch tasks into the new
    // project so the task context is saved (and later loaded) with it.
    if (!state.projectId) {
      const s2 = get();
      for (const meta of s2.tasks) {
        s2.registerTaskProject(meta.id, id);
        void putSession({
          id: meta.id,
          name: meta.name,
          projectId: id,
          createdAt: meta.createdAt,
          updatedAt: meta.updatedAt,
          events: s2.taskEvents[meta.id] ?? [],
        });
      }
      if (s2.tasks.length > 0) {
        set((st) => ({ tasks: st.tasks.map((m) => ({ ...m, projectId: id })) }));
      }
    }
    get().showToast("notice.projectSaved");
  },

  loadProject(id) {
    const entry = get().projects.find((p) => p.id === id);
    if (!entry) return;
    get().mutateDoc("load-project", (draft) => {
      Object.assign(draft, cloneDoc(entry.doc));
    });
    set({ playhead: 0, playing: false, selection: [], projectsOpen: false });
    get().setProjectId(id);
  },

  deleteProject(id) {
    const projects = get().projects.filter((p) => p.id !== id);
    try {
      localStorage.setItem(PROJECTS_KEY, JSON.stringify(projects));
    } catch {
      /* ignore */
    }
    set({ projects });
    // If the deleted project is bound, fall back to the scratch space.
    if (get().projectId === id) get().setProjectId(null);
  },

  setProjectId(id) {
    set({ projectId: id, tasks: [], activeTaskId: null, taskEvents: {}, taskStates: {}, taskSteps: {} });
    try {
      if (id === null) localStorage.removeItem(CURRENT_PROJECT_KEY);
      else localStorage.setItem(CURRENT_PROJECT_KEY, id);
    } catch {
      /* ignore */
    }
  },

  // --- agent tasks ------------------------------------------------------------------

  taskPush(taskId, event) {
    set((s) => ({ taskEvents: { ...s.taskEvents, [taskId]: [...(s.taskEvents[taskId] ?? []), event] } }));
    scheduleTaskSave(taskId);
  },

  taskPatch(taskId, eventId, patch) {
    set((s) => ({
      taskEvents: {
        ...s.taskEvents,
        [taskId]: (s.taskEvents[taskId] ?? []).map((e) => (eventById(e, eventId) ? ({ ...e, ...patch } as SessionEvent) : e)),
      },
    }));
    scheduleTaskSave(taskId);
  },

  setActiveTask(taskId) {
    set({ activeTaskId: taskId });
  },

  setTaskState(taskId, state) {
    set((s) => ({ taskStates: { ...s.taskStates, [taskId]: state } }));
  },

  setTaskStep(taskId, step) {
    set((s) => ({ taskSteps: { ...s.taskSteps, [taskId]: step } }));
  },

  registerTaskProject(taskId, projectId) {
    taskProjectOf.set(taskId, projectId);
  },

  showToast(message) {
    // Every toast is also archived in the message center.
    const kind: AppMessage["kind"] = message.startsWith("error.") ? "error" : "info";
    get().pushMessage(kind, message, { toast: true });
  },
}));

/** Convenience selector: is the LLM usable right now? */
export function llmReady(): boolean {
  return isConfigured(useStore.getState().settings);
}

// --- working-scene autosave ---------------------------------------------------
// A reload/crash should never silently destroy the user's scene: persist the
// current document (debounced) and restore it on boot.

const AUTOSAVE_KEY = "mrs.autosave";

(function restoreAutosave(): void {
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    if (!raw) return;
    const result = validateSceneDocument(JSON.parse(raw) as unknown);
    if ("doc" in result && result.doc.objects.length > 0) {
      useStore.setState({ doc: result.doc });
    }
  } catch {
    /* corrupt autosave — start fresh */
  }
})();

let autosaveTimer: number | undefined;
useStore.subscribe((state, prev) => {
  if (state.doc === prev.doc) return;
  window.clearTimeout(autosaveTimer);
  autosaveTimer = window.setTimeout(() => {
    try {
      localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(state.doc));
    } catch {
      /* storage full — manual Save/Export still work */
    }
  }, 800);
});

// Chat transcript autosave lives in agent/agentLoop.ts: the persisted sessions
// and the provider wire log must be updated together.

// Dev-only guard: this module cannot be hot-swapped in isolation. The render
// engine captures the store once at mount, so a hot update that replaces only
// one side would split the app across two instances (UI reading the new store,
// engine still rendering the old one — "cleared hierarchy but models still
// visible"). A full reload keeps them consistent. Stripped from production.
if (import.meta.hot) import.meta.hot.accept(() => window.location.reload());
