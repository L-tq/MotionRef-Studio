/** Central app store (zustand): scene doc + history, editor state, settings,
 *  projects and the agent session log. */
import { create } from "zustand";
import {
  cloneDoc,
  createEmptyDocument,
  newId,
  randomPaletteColor,
  specOf,
  activeCameraOf,
  activeActionOfOwner,
  actionsOfOwner,
  defaultActionName,
  defaultCollectionName,
  type ActionDesc,
  type CameraActionDesc,
  type CameraKey,
  type GeometryType,
  type KeyVec3,
  type ObjectActionDesc,
  type SceneDocument,
  type TransformKey,
  type Vec3,
} from "../core/types";
import { evaluate, evalCameraById } from "../core/animation";
import type { GizmoMode } from "../core/engine";
import { validateSceneDocument, SCENE_FORMAT, PROJECT_FORMAT } from "../core/validate";
import { clampAspect } from "../core/cameraMath";
import { listSessions, putSession, type ChatSessionRecord } from "./chatPersist";
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

/** What a keyframe edit addresses: an object or a scene camera, optionally
 *  one specific action of that owner (default: the owner's ACTIVE action). */
export type KeyTarget = { objectId: string; actionId?: string } | { cameraId: string; actionId?: string };

type KeyChan = "position" | "rotation" | "scale" | "target" | "fov";

/** The key list a KeyTarget addresses inside a draft doc: the keys of the
 *  owner's resolved action (explicit actionId wins, else the ACTIVE action).
 *  Undefined when the owner has no matching action. */
function targetActionKeys(draft: SceneDocument, target: KeyTarget): TransformKey[] | CameraKey[] | undefined {
  const owner = "cameraId" in target ? { cameraId: target.cameraId } : { objectId: target.objectId };
  const act = activeActionOfOwner(draft, owner, target.actionId);
  return act?.keys;
}

/** Resolve — or lazily create — the action a key WRITE addresses (Blender
 *  auto-creates an action on the first key). Returns null when the owner
 *  itself does not exist. */
function ensureTargetAction(draft: SceneDocument, target: KeyTarget): ActionDesc | null {
  if ("cameraId" in target) {
    const cam = draft.cameras.find((c) => c.id === target.cameraId);
    if (!cam) return null;
    let act = activeActionOfOwner(draft, { cameraId: cam.id }, target.actionId);
    if (!act) {
      const created: CameraActionDesc = {
        id: newId("act"),
        name: defaultActionName(draft, { cameraId: cam.id }),
        kind: "camera",
        cameraId: cam.id,
        keys: [],
      };
      draft.actions.push(created);
      cam.activeActionId = created.id;
      act = created;
    }
    return act;
  }
  const obj = draft.objects.find((o) => o.id === target.objectId);
  if (!obj) return null;
  let act = activeActionOfOwner(draft, { objectId: obj.id }, target.actionId);
  if (!act) {
    const created: ObjectActionDesc = {
      id: newId("act"),
      name: defaultActionName(draft, { objectId: obj.id }),
      kind: "object",
      objectId: obj.id,
      keys: [],
    };
    draft.actions.push(created);
    obj.activeActionId = created.id;
    act = created;
  }
  return act;
}

/** Null out one axis of a key's vector (or the whole fov); drops the component
 *  when its last axis goes away. Mutates the (draft) key. */
function nullKeyAxis(k: TransformKey & CameraKey, chan: KeyChan, index: number) {
  if (chan === "fov") {
    k.fov = undefined;
    return;
  }
  const v = k[chan];
  if (!v) return;
  const next: KeyVec3 = [...v];
  next[index] = null;
  if (next.every((x) => x === null)) k[chan] = undefined;
  else k[chan] = next;
}

/** True when a key carries no keyed data at all and can be dropped. */
function keyIsEmpty(k: TransformKey & CameraKey) {
  return (
    k.position === undefined && k.rotation === undefined && k.scale === undefined &&
    k.color === undefined && k.visible === undefined && k.target === undefined && k.fov === undefined
  );
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
  /** Bottom-panel editor type: keyframe rows, the curve graph editor, or the
   *  Blender-style action editor. */
  timelineMode?: "tracks" | "graph" | "actions";
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
      // Migration: "proxy" was the old default; saveSettings persists the whole
      // object, so untouched installs carry it and get the new "direct" default.
      if (parsed.connection === "proxy") parsed.connection = DEFAULT_LLM_SETTINGS.connection;
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
  /** Camera picked in the inspector/viewport for editing; null = follow the
   *  active camera. */
  camPanelSel: string | null;

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
  /** Copy the given objects (and their actions); the copies become the selection. */
  duplicateObjects(ids: string[]): void;
  /** Outliner collections (Blender-style). */
  addCollection(): void;
  renameCollection(id: string, name: string): void;
  /** Delete a collection; member objects return to the scene root. */
  deleteCollection(id: string): void;
  /** Move objects into a collection (null = scene root). */
  moveToCollection(ids: string[], collectionId: string | null): void;
  /** Show/hide every member of a collection. */
  setCollectionVisible(id: string, visible: boolean): void;
  commitPose(id: string, pose: Partial<Pick<TransformKey, "position" | "rotation" | "scale">>): void;
  setKeyAtPlayhead(id?: string): void;
  /** Insert a full camera key (evaluated pose) for the given camera at the playhead. */
  setCameraKeyAtPlayhead(cameraId?: string): void;
  retimeKey(target: KeyTarget, fromT: number, toT: number): void;
  deleteKey(target: KeyTarget, atT: number): void;
  /** Graph editor: remove the given channel axis at the given times from
   *  keys — a key left with no data is removed, other channels (and other
   *  axes of the same vector) keep their keys (unlike deleteKey, which always
   *  removes the whole shared key). */
  deleteKeyChans(
    target: KeyTarget,
    specs: Array<{ chan: "position" | "rotation" | "scale" | "target" | "fov"; index: number; t: number }>,
  ): void;
  /** Graph editor: move one channel axis in time, splitting the shared
   *  full-pose key so other channels/axes' keys stay where they are. */
  retimeKeyChan(
    target: KeyTarget,
    chan: "position" | "rotation" | "scale" | "target" | "fov",
    index: number,
    fromT: number,
    toT: number,
  ): void;
  /** Graph-editor edits: change channel values stored on one key. Vectors may
   *  carry nulls for axes this key does not key. */
  setKeyValues(
    target: KeyTarget,
    atT: number,
    patch: { position?: KeyVec3; rotation?: KeyVec3; scale?: KeyVec3; target?: KeyVec3; fov?: number },
  ): void;
  /** Insert a full keyframe (evaluated pose at t) into an object track or a camera. */
  insertKeyAt(target: KeyTarget, t: number): void;
  /** Graph editor: Gaussian-smooth exactly the selected curve points (σ in
   *  key count). `points` are channel-scoped — sibling channels of the same
   *  key and unselected keys keep their values. */
  smoothKeys(
    target: KeyTarget,
    points: Array<{ chan: "position" | "rotation" | "scale" | "target" | "fov"; index: number; t: number }>,
    sigma: number,
  ): void;
  clearTrack(objectId: string): void;
  applyDoc(doc: SceneDocument, label: string): void;

  // Actions (Blender-style Action Editor)
  /** Create an empty action for an object/camera and make it its active action. */
  createAction(target: KeyTarget, name?: string): void;
  renameAction(id: string, name: string): void;
  /** Copy an action (keys included); the copy becomes the owner's active action. */
  duplicateAction(id: string): void;
  /** Delete an action and its keyframes; the owner's active falls back to its first remaining action. */
  deleteAction(id: string): void;
  /** Make this action the active one for its owner (what plays/edits). */
  setActiveAction(id: string): void;

  // Cameras (Blender-style multi-camera)
  /** Add a scene camera above the active one; returns its id and selects it. */
  addCamera(): void;
  /** Delete a camera (and its keys); never removes the last one. */
  removeCamera(id: string): void;
  /** Make this camera the one previews/snapshots/exports render (Ctrl-click equivalent). */
  setActiveCamera(id: string): void;

  // Camera / timeline
  /** Edit a camera's pose/fov. With auto-key (or existing keys on that
   *  camera) this writes a key at the playhead; otherwise the base pose. */
  commitCamera(patch: { position?: [number, number, number]; target?: [number, number, number]; fov?: number }, cameraId?: string): void;
  setAspect(ratio: number): void;
  setDuration(d: number): void;
  setFps(f: number): void;

  // Playback / selection / view
  setPlayhead(t: number): void;
  play(): void;
  pause(): void;
  stop(): void;
  select(id: string | null, additive: boolean): void;
  /** Select a group of ids at once (Outliner collection rows). */
  selectMany(ids: string[], additive: boolean): void;
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
  /** Download: bundle the working scene + all this project's chat sessions into
   *  a portable JSON file. Returns the blob + filename, or an error string. */
  exportProjectBundle(): Promise<{ filename: string; blob: Blob } | { error: string }>;
  /** Upload: validate and restore an exported project bundle. Generates fresh
   *  project + session ids (collision-safe), inserts the scene as a new
   *  project, re-inserts the chat sessions, and binds the working scene. */
  importProjectBundle(parsed: unknown): Promise<{ ok: true; name: string } | { error: string }>;

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
  camPanelSel: null,

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
      draft.actions = draft.actions.filter((a) => !(a.kind === "object" && idSet.has(a.objectId)));
    });
    set((s) => ({ selection: s.selection.filter((id) => !idSet.has(id)) }));
  },

  duplicateObjects(ids) {
    if (!ids.length) return;
    const sources = get().doc.objects.filter((o) => ids.includes(o.id));
    if (!sources.length) return;
    const copyIds: string[] = [];
    get().mutateDoc("duplicate-object", (draft) => {
      for (const src of sources) {
        const copyId = newId();
        copyIds.push(copyId);
        const copy = JSON.parse(JSON.stringify(src)) as typeof src;
        copy.id = copyId;
        copy.name = `${src.name} copy`;
        copy.position = [src.position[0] + 1, src.position[1], src.position[2]];
        draft.objects.push(copy);
        // Copy the source object's actions (fresh ids); the duplicate's active
        // action is the copy of the source's active one.
        const srcActiveId = activeActionOfOwner(draft, { objectId: src.id })?.id ?? null;
        let copyActiveId: string | undefined;
        for (const a of draft.actions.slice()) {
          if (a.kind !== "object" || a.objectId !== src.id) continue;
          const copyAct = JSON.parse(JSON.stringify(a)) as ObjectActionDesc;
          copyAct.id = newId("act");
          copyAct.objectId = copyId;
          draft.actions.push(copyAct);
          if (a.id === srcActiveId) copyActiveId = copyAct.id;
        }
        if (copyActiveId) copy.activeActionId = copyActiveId;
        else delete copy.activeActionId;
      }
    });
    set({ selection: copyIds });
  },

  // --- Outliner collections (Blender-style) ----------------------------------

  addCollection() {
    get().mutateDoc("add-collection", (draft) => {
      draft.collections.push({ id: newId("col"), name: defaultCollectionName(draft) });
    });
  },

  renameCollection(id, name) {
    const clean = name.trim().slice(0, 80);
    if (!clean) return;
    get().mutateDoc("rename-collection", (draft) => {
      const col = draft.collections.find((c) => c.id === id);
      if (col) col.name = clean;
    });
  },

  /** Blender "Delete" on a collection: unlink it; members stay in the scene
   *  root (objects are NOT deleted). */
  deleteCollection(id) {
    get().mutateDoc("delete-collection", (draft) => {
      draft.collections = draft.collections.filter((c) => c.id !== id);
      for (const o of draft.objects) {
        if (o.collectionId === id) delete o.collectionId;
      }
    });
  },

  /** Move objects into a collection (null = back to the scene root). */
  moveToCollection(ids, collectionId) {
    if (!ids.length) return;
    const idSet = new Set(ids);
    get().mutateDoc("move-to-collection", (draft) => {
      const exists = collectionId !== null && draft.collections.some((c) => c.id === collectionId);
      for (const o of draft.objects) {
        if (!idSet.has(o.id)) continue;
        if (collectionId !== null && exists) o.collectionId = collectionId;
        else delete o.collectionId;
      }
    });
  },

  /** Show/hide every member of a collection (writes object.visible, which is
   *  what the viewport and render evaluate). */
  setCollectionVisible(id, visible) {
    get().mutateDoc("collection-visibility", (draft) => {
      for (const o of draft.objects) {
        if (o.collectionId === id) o.visible = visible;
      }
    });
  },

  /** Gizmo / inspector transform edit with auto-key semantics. */
  commitPose(id, pose) {
    const state = get();
    const obj = state.doc.objects.find((o) => o.id === id);
    if (!obj) return;
    const act = activeActionOfOwner(state.doc, { objectId: id });
    const keys = act && act.kind === "object" ? act.keys : undefined;
    const hasTrack = !!keys?.length;
    const t = +state.playhead.toFixed(4);
    const hasKeyAtT = !!keys?.some((k) => Math.abs(k.t - t) < 1e-4);
    // "Replace" mode only overwrites keys that already exist at the playhead;
    // "Add & Replace" (and plain keyed objects) may also insert new ones.
    const replaceOnly = state.autoKey && state.autoKeyMode === "replace";
    if (hasKeyAtT || (!replaceOnly && (hasTrack || state.autoKey))) {
      state.mutateDoc("pose", (draft) => {
        const target = ensureTargetAction(draft, { objectId: id });
        if (!target || target.kind !== "object") return;
        const list = target.keys;
        const existing = list.find((k) => Math.abs(k.t - t) < 1e-4);
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
        else list.push(merged);
        list.sort((a, b) => a.t - b.t);
      });
    } else {
      state.mutateDoc("pose", (draft) => {
        const target = draft.objects.find((o) => o.id === id);
        if (!target) return;
        if (pose.position) target.position = [...pose.position] as Vec3;
        if (pose.rotation) target.rotation = [...pose.rotation] as Vec3;
        if (pose.scale) target.scale = [...pose.scale] as Vec3;
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
      const act = ensureTargetAction(draft, { objectId: id });
      if (!act || act.kind !== "object") return;
      const keys = act.keys;
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

  setCameraKeyAtPlayhead(cameraIdArg) {
    const state = get();
    const cameraId = cameraIdArg ?? activeCameraOf(state.doc).id;
    const cam = evalCameraById(state.doc, cameraId, state.playhead);
    state.mutateDoc("cam-key", (draft) => {
      const act = ensureTargetAction(draft, { cameraId });
      if (!act || act.kind !== "camera") return;
      const t = +state.playhead.toFixed(4);
      const existing = act.keys.find((k) => Math.abs(k.t - t) < 1e-4);
      const entry = {
        t,
        cameraId,
        position: [...cam.position] as [number, number, number],
        target: [...cam.target] as [number, number, number],
        fov: cam.fov,
        interp: (existing?.interp ?? "linear") as "linear",
      };
      const idx = existing ? act.keys.indexOf(existing) : -1;
      if (idx >= 0) act.keys[idx] = entry;
      else act.keys.push(entry);
      act.keys.sort((a, b) => a.t - b.t);
    });
  },

  retimeKey(target, fromT, toT) {
    const clamped = Math.min(Math.max(+toT.toFixed(4), 0), get().doc.duration);
    get().mutateDoc("retime-key", (draft) => {
      const keys = targetActionKeys(draft, target);
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
      const keys = targetActionKeys(draft, target);
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

  deleteKeyChans(target, specs) {
    if (!specs.length) return;
    const want = specs.map((s) => ({ chan: s.chan, index: s.index, t: +s.t.toFixed(4) }));
    get().mutateDoc("delete-key", (draft) => {
      const keys = targetActionKeys(draft, target);
      if (!keys?.length) return;
      for (const { chan, index, t } of want) {
        const idx = keys.findIndex((k) => Math.abs(k.t - t) < 1e-4);
        if (idx < 0) continue;
        const k = keys[idx] as TransformKey & CameraKey;
        if (chan === "fov" ? k.fov === undefined : !k[chan] || k[chan]![index] == null) continue;
        nullKeyAxis(k, chan, index);
        if (keyIsEmpty(k)) keys.splice(idx, 1);
      }
    });
  },

  retimeKeyChan(target, chan, index, fromT, toT) {
    const from = +fromT.toFixed(4);
    const to = Math.min(Math.max(+toT.toFixed(4), 0), get().doc.duration);
    if (Math.abs(to - from) < 1e-6) return;
    get().mutateDoc("retime-key", (draft) => {
      const keys = targetActionKeys(draft, target);
      if (!keys?.length) return;
      const idx = keys.findIndex((k) => Math.abs(k.t - from) < 1e-4);
      if (idx < 0) return;
      const k = keys[idx] as TransformKey & CameraKey;
      let val: number;
      if (chan === "fov") {
        if (k.fov === undefined) return;
        val = k.fov;
      } else {
        const v = k[chan];
        if (!v || v[index] === null || v[index] === undefined) return;
        val = v[index];
      }
      nullKeyAxis(k, chan, index);
      if (keyIsEmpty(k)) keys.splice(idx, 1);
      const ks = keys as Array<TransformKey & CameraKey>;
      const dst = ks.find((kk) => Math.abs(kk.t - to) < 1e-4);
      if (dst) {
        if (chan === "fov") dst.fov = val;
        else {
          if (!dst[chan]) dst[chan] = [null, null, null];
          dst[chan][index] = val;
        }
      } else {
        const entry = { t: to, cameraId: k.cameraId, interp: k.interp ?? "linear" } as TransformKey & CameraKey;
        if (chan === "fov") {
          entry.fov = val;
        } else {
          const v: KeyVec3 = [null, null, null];
          v[index] = val;
          entry[chan] = v;
        }
        keys.push(entry);
      }
      keys.sort((a, b) => a.t - b.t);
    });
  },

  clearTrack(objectId) {
    get().mutateDoc("clear-track", (draft) => {
      // Removes ALL of the object's actions — back to the unkeyed base pose.
      draft.actions = draft.actions.filter((a) => !(a.kind === "object" && a.objectId === objectId));
      const obj = draft.objects.find((o) => o.id === objectId);
      if (obj) delete obj.activeActionId;
    });
  },

  setKeyValues(target, atT, patch) {
    get().mutateDoc("edit-key", (draft) => {
      const keys = targetActionKeys(draft, target);
      if (!keys?.length) return;
      const key = keys.find((k) => Math.abs(k.t - atT) < 1e-4) as (TransformKey & CameraKey) | undefined;
      if (!key) return;
      if (patch.position) key.position = [...patch.position];
      if (patch.rotation) key.rotation = [...patch.rotation];
      if (patch.scale) key.scale = [...patch.scale];
      if (patch.target) key.target = [...patch.target];
      if (patch.fov !== undefined) key.fov = patch.fov;
    });
  },

  /** Gaussian-smooth the selected curve points (Blender "Smooth Keys"): each
   *  selected point's value becomes the Gaussian-weighted average of its own
   *  channel's values across the whole track, weighted by key-index distance
   *  with σ in key count. Only selected (channel, key) pairs are written. */
  smoothKeys(target, points, sigma) {
    if (!points.length || !(sigma > 0)) return;
    get().mutateDoc("smooth-keys", (draft) => {
      // Only this target's resolved action is the smoothing neighborhood.
      const keys = targetActionKeys(draft, target);
      if (!keys?.length) return;
      const weight = (i: number, j: number) => Math.exp(-0.5 * ((i - j) / sigma) ** 2);
      type Comp = "position" | "rotation" | "scale" | "target";
      const ks = keys as Array<TransformKey & CameraKey>;
      const readComp = (k: TransformKey & CameraKey, chan: Comp | "fov", index: number): number | undefined => {
        if (chan === "fov") return k.fov;
        const v = k[chan];
        const x = v ? v[index] : undefined;
        return x === undefined || x === null ? undefined : x;
      };
      // In-place writes: the elements are the same key objects the document
      // stores; `ks` is the action's own array.
      const writeComp = (i: number, chan: Comp | "fov", index: number, v: number) => {
        const k = ks[i];
        if (chan === "fov") {
          k.fov = v;
          return;
        }
        const cur = k[chan];
        const arr: KeyVec3 = cur ? [...cur] : [null, null, null];
        arr[index] = v;
        k[chan] = arr;
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
      const act = ensureTargetAction(draft, target);
      if (!act) return;
      if ("cameraId" in target) {
        if (act.kind !== "camera") return;
        if (act.keys.some((k) => Math.abs(k.t - time) < 1e-4)) return;
        const cam = evalCameraById(draft, target.cameraId, time);
        act.keys.push({ t: +time.toFixed(4), cameraId: target.cameraId, position: cam.position, target: cam.target, fov: cam.fov, interp: "linear" });
        act.keys.sort((a, b) => a.t - b.t);
      } else {
        if (act.kind !== "object") return;
        if (act.keys.some((k) => Math.abs(k.t - time) < 1e-4)) return;
        const pose = evaluate(draft, time).objects.get(target.objectId);
        if (!pose) return;
        act.keys.push({
          t: +time.toFixed(4),
          position: [...pose.position],
          rotation: [...pose.rotation],
          scale: [...pose.scale],
          color: pose.color,
          visible: pose.visible,
          interp: "linear",
        });
        act.keys.sort((a, b) => a.t - b.t);
      }
    });
  },

  // --- actions (Blender-style Action Editor) ---------------------------------

  createAction(target, name) {
    get().mutateDoc("create-action", (draft) => {
      if ("cameraId" in target) {
        const cam = draft.cameras.find((c) => c.id === target.cameraId);
        if (!cam) return;
        const act: CameraActionDesc = {
          id: newId("act"),
          name: name?.trim().slice(0, 80) || defaultActionName(draft, { cameraId: cam.id }),
          kind: "camera",
          cameraId: cam.id,
          keys: [],
        };
        draft.actions.push(act);
        cam.activeActionId = act.id;
      } else {
        const obj = draft.objects.find((o) => o.id === target.objectId);
        if (!obj) return;
        const act: ObjectActionDesc = {
          id: newId("act"),
          name: name?.trim().slice(0, 80) || defaultActionName(draft, { objectId: obj.id }),
          kind: "object",
          objectId: obj.id,
          keys: [],
        };
        draft.actions.push(act);
        obj.activeActionId = act.id;
      }
    });
  },

  renameAction(id, name) {
    const clean = name.trim().slice(0, 80);
    if (!clean) return;
    get().mutateDoc("rename-action", (draft) => {
      const act = draft.actions.find((a) => a.id === id);
      if (act) act.name = clean;
    });
  },

  duplicateAction(id) {
    get().mutateDoc("duplicate-action", (draft) => {
      const src = draft.actions.find((a) => a.id === id);
      if (!src) return;
      const copy = JSON.parse(JSON.stringify(src)) as ActionDesc;
      copy.id = newId("act");
      copy.name = `${src.name} copy`;
      draft.actions.push(copy);
      // Blender semantics: activating a duplicate links it to the owner.
      const owner = copy.kind === "object"
        ? draft.objects.find((o) => o.id === copy.objectId)
        : draft.cameras.find((c) => c.id === copy.cameraId);
      if (owner) owner.activeActionId = copy.id;
    });
  },

  deleteAction(id) {
    get().mutateDoc("delete-action", (draft) => {
      const src = draft.actions.find((a) => a.id === id);
      if (!src) return;
      draft.actions = draft.actions.filter((a) => a.id !== id);
      const owner = src.kind === "object"
        ? draft.objects.find((o) => o.id === src.objectId)
        : draft.cameras.find((c) => c.id === src.cameraId);
      if (owner && owner.activeActionId === id) {
        const first = draft.actions.find((a) => (src.kind === "object" ? a.kind === "object" && a.objectId === src.objectId : a.kind === "camera" && a.cameraId === src.cameraId));
        if (first) owner.activeActionId = first.id;
        else delete owner.activeActionId;
      }
    });
  },

  setActiveAction(id) {
    get().mutateDoc("set-active-action", (draft) => {
      const act = draft.actions.find((a) => a.id === id);
      if (!act) return;
      const owner = act.kind === "object"
        ? draft.objects.find((o) => o.id === act.objectId)
        : draft.cameras.find((c) => c.id === act.cameraId);
      if (owner) owner.activeActionId = id;
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

  commitCamera(patch, cameraIdArg) {
    const state = get();
    const cameraId = cameraIdArg ?? activeCameraOf(state.doc).id;
    const act = activeActionOfOwner(state.doc, { cameraId });
    const camKeys = act && act.kind === "camera" ? act.keys : [];
    const t = +state.playhead.toFixed(4);
    const hasKeyAtT = camKeys.some((k) => Math.abs(k.t - t) < 1e-4);
    const replaceOnly = state.autoKey && state.autoKeyMode === "replace";
    if (hasKeyAtT || (!replaceOnly && (camKeys.length > 0 || state.autoKey))) {
      state.mutateDoc("camera", (draft) => {
        const target = ensureTargetAction(draft, { cameraId });
        if (!target || target.kind !== "camera") return;
        const cam = evalCameraById(draft, cameraId, t);
        const existing = target.keys.find((k) => Math.abs(k.t - t) < 1e-4);
        const entry = {
          t,
          cameraId,
          position: (patch.position ?? [...cam.position]) as [number, number, number],
          target: (patch.target ?? [...cam.target]) as [number, number, number],
          fov: patch.fov ?? cam.fov,
          interp: (existing?.interp ?? "linear") as "linear",
        };
        const idx = existing ? target.keys.indexOf(existing) : -1;
        if (idx >= 0) target.keys[idx] = entry;
        else target.keys.push(entry);
        target.keys.sort((a, b) => a.t - b.t);
      });
    } else {
      state.mutateDoc("camera", (draft) => {
        const target = draft.cameras.find((c) => c.id === cameraId);
        if (!target) return;
        if (patch.position) target.position = [...patch.position];
        if (patch.target) target.target = [...patch.target];
        if (patch.fov !== undefined) target.fov = patch.fov;
      });
    }
  },

  addCamera() {
    const id = newId("cam");
    get().mutateDoc("add-camera", (draft) => {
      const src = activeCameraOf(draft);
      draft.cameras.push({
        id,
        name: `Camera ${draft.cameras.length + 1}`,
        // Spawn slightly above the active camera so the new frustum is visible.
        position: [src.position[0], src.position[1] + 1.5, src.position[2]],
        target: [...src.target],
        fov: src.fov,
      });
    });
    set({ camPanelSel: id });
  },

  removeCamera(id) {
    get().mutateDoc("remove-camera", (draft) => {
      if (draft.cameras.length <= 1) return;
      draft.cameras = draft.cameras.filter((c) => c.id !== id);
      draft.actions = draft.actions.filter((a) => !(a.kind === "camera" && a.cameraId === id));
      if (draft.activeCameraId === id) draft.activeCameraId = draft.cameras[0].id;
    });
    if (get().camPanelSel === id) set({ camPanelSel: null });
  },

  setActiveCamera(id) {
    get().mutateDoc("set-active-camera", (draft) => {
      if (draft.cameras.some((c) => c.id === id)) draft.activeCameraId = id;
    });
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

  selectMany(ids, additive) {
    set((s) => ({
      selection: additive ? [...new Set([...s.selection, ...ids])] : [...ids],
    }));
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
    try {
      localStorage.setItem(CURRENT_PROJECT_KEY, id);
    } catch {
      /* ignore */
    }
    // First save of an unsaved scene: adopt its scratch tasks into the new
    // project BEFORE binding the project id. Doing it first means the store
    // subscription that fires loadProjectTasks(projectId) finds the adopted
    // sessions already persisted — so the chat history is never wiped.
    if (!state.projectId) {
      const tasks = state.tasks;
      for (const meta of tasks) {
        state.registerTaskProject(meta.id, id);
        void putSession({
          id: meta.id,
          name: meta.name,
          projectId: id,
          createdAt: meta.createdAt,
          updatedAt: meta.updatedAt,
          events: state.taskEvents[meta.id] ?? [],
        });
      }
      // Relabel in-memory tasks to the new project, then bind — one store
      // update. No wipe: the tasks are already correct.
      set({ projects, projectId: id, tasks: tasks.map((m) => ({ ...m, projectId: id })) });
      return;
    }
    set({ projects, projectId: id });
    get().showToast("notice.projectSaved");
  },

  loadProject(id) {
    const entry = get().projects.find((p) => p.id === id);
    if (!entry) return;
    get().mutateDoc("load-project", (draft) => {
      // Normalize through the validator so pre-multi-camera projects (plain
      // `camera` + cameraId-less keys) migrate; fall back to the raw doc.
      const result = validateSceneDocument(cloneDoc(entry.doc));
      Object.assign(draft, "doc" in result ? result.doc : cloneDoc(entry.doc));
    });
    set({ playhead: 0, playing: false, selection: [], projectsOpen: false, camPanelSel: null });
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
    set({ projectId: id });
    try {
      if (id === null) localStorage.removeItem(CURRENT_PROJECT_KEY);
      else localStorage.setItem(CURRENT_PROJECT_KEY, id);
    } catch {
      /* ignore */
    }
  },

  async exportProjectBundle() {
    const state = get();
    const doc = cloneDoc(state.doc);
    let sessions: ChatSessionRecord[];
    try {
      sessions = await listSessions(state.projectId);
    } catch {
      sessions = [];
    }
    const bundle = {
      format: "motionref-studio/project",
      version: 1,
      exportedAt: Date.now(),
      project: { name: doc.name || "Untitled", projectId: state.projectId },
      doc,
      sessions,
    };
    const json = JSON.stringify(bundle);
    const filename = `${doc.name || "project"}.project.json`;
    return { filename, blob: new Blob([json], { type: "application/json" }) };
  },

  async importProjectBundle(parsed) {
    if (!parsed || typeof parsed !== "object") return { error: "not an object" };
    const b = parsed as Record<string, unknown>;
    // Distinguish the three failure modes so the user knows exactly where to
    // import: a scene-only JSON belongs in the toolbar's Import JSON button;
    // a non-JSON / unrecognized file is just invalid here.
    const fmt = b.format;
    if (fmt === SCENE_FORMAT) return { error: "scene-only" };
    if (fmt !== PROJECT_FORMAT) return { error: "unrecognized" };
    const docVal = b.doc;
    if (!docVal || typeof docVal !== "object") return { error: "missing scene" };
    const result = validateSceneDocument(docVal);
    if ("error" in result) return { error: result.error };
    const doc = result.doc;
    const rawSessions = b.sessions;
    if (!Array.isArray(rawSessions)) return { error: "missing sessions" };

    // Collision-safe restore: fresh project id + fresh session ids so re-imports
    // never overwrite an existing project's chat. Remap each session's projectId.
    const projectId = newId("p");
    const name = (b.project && typeof (b.project as Record<string, unknown>).name === "string")
      ? ((b.project as Record<string, string>).name) || doc.name || "Imported"
      : doc.name || "Imported";
    const remapped: ChatSessionRecord[] = [];
    for (const raw of rawSessions) {
      if (!raw || typeof raw !== "object") continue;
      const r = raw as Record<string, unknown>;
      if (typeof r.id !== "string" || !Array.isArray(r.events)) continue;
      remapped.push({
        id: newId("s"),
        name: typeof r.name === "string" ? r.name : "",
        projectId,
        createdAt: typeof r.createdAt === "number" ? r.createdAt : Date.now(),
        updatedAt: typeof r.updatedAt === "number" ? r.updatedAt : Date.now(),
        events: r.events as ChatSessionRecord["events"],
      });
    }

    const entry: ProjectEntry = { id: projectId, name, savedAt: Date.now(), doc: cloneDoc(doc) };
    const projects = [entry, ...get().projects.filter((p) => p.id !== projectId)].slice(0, 50);
    try {
      localStorage.setItem(PROJECTS_KEY, JSON.stringify(projects));
    } catch {
      get().showToast("error.storageFull");
      return { error: "storage full" };
    }

    await Promise.all(remapped.map((r) => putSession(r)));

    get().mutateDoc("import-project", (draft) => {
      Object.assign(draft, cloneDoc(doc));
    });
    set({ projects, selection: [], playhead: 0, playing: false, projectsOpen: false, camPanelSel: null });
    // Bind the working scene to the new project; the agentLoop subscription
    // fires loadProjectTasks(projectId), which reads the just-inserted sessions
    // from IndexedDB and populates the chat view.
    get().setProjectId(projectId);
    return { ok: true, name };
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
