/** Central app store (zustand): scene doc + history, editor state, settings,
 *  projects and the agent session log. */
import { create } from "zustand";
import {
  cloneDoc,
  createEmptyDocument,
  newId,
  randomPaletteColor,
  specOf,
  type GeometryType,
  type SceneDocument,
  type TransformKey,
} from "../core/types";
import { evaluate } from "../core/animation";
import type { GizmoMode } from "../core/engine";
import { validateSceneDocument } from "../core/validate";
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

const SETTINGS_KEY = "mrs.settings";
const PROJECTS_KEY = "mrs.projects";

function loadSettings(): LlmSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return { ...DEFAULT_LLM_SETTINGS, ...(JSON.parse(raw) as Partial<LlmSettings>) };
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

  // Config
  settings: LlmSettings;

  // Projects
  projects: ProjectEntry[];

  // Agent session
  session: SessionEvent[];
  agentState: AgentState;
  agentStep: number;
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
  clearTrack(objectId: string): void;
  applyDoc(doc: SceneDocument, label: string): void;

  // Camera / timeline
  commitCamera(patch: { position?: [number, number, number]; target?: [number, number, number]; fov?: number }): void;
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

  // Settings
  saveSettings(patch: Partial<LlmSettings>): void;

  // Projects
  refreshProjects(): void;
  saveProject(): void;
  loadProject(id: string): void;
  deleteProject(id: string): void;

  // Session log
  sessionPush(event: SessionEvent): void;
  sessionPatch(id: string, patch: Partial<SessionEvent>): void;
  sessionClear(): void;
  setAgentState(state: AgentState): void;
  setAgentStep(step: number): void;
  showToast(message: string): void;
}

const HISTORY_LIMIT = 60;
const COALESCE_MS = 700;

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

  settings: loadSettings(),
  projects: loadProjects(),

  session: [],
  agentState: "idle",
  agentStep: 0,

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
    if (hasTrack || state.autoKey) {
      state.mutateDoc("pose", (draft) => {
        const keys = (draft.tracks[id] ??= []);
        const t = +state.playhead.toFixed(4);
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
    if (hasKeys || state.autoKey) {
      state.mutateDoc("camera", (draft) => {
        const t = +state.playhead.toFixed(4);
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
    const entry: ProjectEntry = {
      id: newId("p"),
      name: state.doc.name || "Untitled",
      savedAt: Date.now(),
      doc: cloneDoc(state.doc),
    };
    const projects = [entry, ...state.projects].slice(0, 50);
    try {
      localStorage.setItem(PROJECTS_KEY, JSON.stringify(projects));
    } catch {
      state.showToast("localStorage full — export JSON instead");
      return;
    }
    set({ projects });
    get().showToast("notice.projectSaved");
  },

  loadProject(id) {
    const entry = get().projects.find((p) => p.id === id);
    if (!entry) return;
    get().mutateDoc("load-project", (draft) => {
      Object.assign(draft, cloneDoc(entry.doc));
    });
    set({ playhead: 0, playing: false, selection: [], projectsOpen: false });
  },

  deleteProject(id) {
    const projects = get().projects.filter((p) => p.id !== id);
    try {
      localStorage.setItem(PROJECTS_KEY, JSON.stringify(projects));
    } catch {
      /* ignore */
    }
    set({ projects });
  },

  // --- session log ------------------------------------------------------------------

  sessionPush(event) {
    set((s) => ({ session: [...s.session, event] }));
  },

  sessionPatch(id, patch) {
    set((s) => ({
      session: s.session.map((e) => (eventById(e, id) ? ({ ...e, ...patch } as SessionEvent) : e)),
    }));
  },

  sessionClear() {
    set({ session: [] });
  },

  setAgentState(agentState) {
    set({ agentState });
  },

  setAgentStep(agentStep) {
    set({ agentStep });
  },

  showToast(message) {
    set({ toast: message });
    setTimeout(() => {
      if (get().toast === message) set({ toast: null });
    }, 2600);
  },
}));

/** Convenience selector: is the LLM usable right now? */
export function llmReady(): boolean {
  return isConfigured(useStore.getState().settings);
}
