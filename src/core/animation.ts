/** Deterministic animation evaluator: SceneDocument + time -> posed scene state.
 *
 *  Pipeline per frame:
 *    1. Start from base object poses / base camera.
 *    2. Apply keyframe interpolation (each owner's ACTIVE action).
 *    3. Run onFrame overlay hooks in registration order (procedural motion).
 *
 *  This module is THREE-free so it can also run inside the sandbox worker.
 */
import type {
  CameraDesc,
  CameraKey,
  CameraState,
  Interp,
  SceneDocument,
  TransformKey,
  Vec3,
} from "./types";
import { activeCameraOf, cameraKeysOf, objectKeysOf } from "./types";

export interface EvaluatedObject {
  id: string;
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
  color: string;
  visible: boolean;
}

/** A channel an onFrame hook may override on an object. */
export type HookChan = "position" | "rotation" | "scale" | "color" | "visible";

export interface EvaluatedState {
  time: number;
  objects: Map<string, EvaluatedObject>;
  camera: CameraState;
  /** Object id -> channels the onFrame hooks overrode at this time. A hooked
   *  channel is script-owned: the hook re-applies it on every evaluate, so
   *  manual edits to it can never stick (and must not be recorded as keys). */
  hooked: Map<string, Set<HookChan>>;
}

// --- interpolation helpers ---------------------------------------------------

function smoothstep(u: number): number {
  return u * u * (3 - 2 * u);
}

function lerp(a: number, b: number, u: number): number {
  return a + (b - a) * u;
}

function lerpVec3(a: Vec3, b: Vec3, u: number, out: Vec3): Vec3 {
  out[0] = lerp(a[0], b[0], u);
  out[1] = lerp(a[1], b[1], u);
  out[2] = lerp(a[2], b[2], u);
  return out;
}

function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [1, 1, 1];
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function rgbToHex(rgb: [number, number, number]): string {
  const c = (v: number) =>
    Math.round(Math.min(1, Math.max(0, v)) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${c(rgb[0])}${c(rgb[1])}${c(rgb[2])}`;
}

function lerpColor(a: string, b: string, u: number): string {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  return rgbToHex([lerp(ca[0], cb[0], u), lerp(ca[1], cb[1], u), lerp(ca[2], cb[2], u)]);
}

function easingFor(interp: Interp | undefined): (u: number) => number {
  switch (interp) {
    case "step":
      return () => 0;
    case "smooth":
      return smoothstep;
    default:
      return (u) => u;
  }
}

interface KeyLike {
  t: number;
  interp?: Interp;
}

/** Find the key pair surrounding time t and the eased progress between them. */
function segment<K extends KeyLike>(keys: K[], t: number): { a: K; b: K; u: number } | null {
  if (keys.length === 0) return null;
  if (t <= keys[0].t) return { a: keys[0], b: keys[0], u: 0 };
  const last = keys[keys.length - 1];
  if (t >= last.t) return { a: last, b: last, u: 0 };
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i];
    const b = keys[i + 1];
    if (t >= a.t && t <= b.t) {
      const span = b.t - a.t;
      const u = span <= 1e-9 ? 0 : (t - a.t) / span;
      return { a, b, u: easingFor(b.interp)(u) };
    }
  }
  return null;
}

// --- object evaluation --------------------------------------------------------

type VecComp = "position" | "rotation" | "scale" | "target";

/** Interpolate ONE axis of a vector component over the keys that key it
 *  (null = axis not keyed here). Returns null when no key defines the axis. */
function evalAxis(keys: Array<TransformKey & CameraKey>, comp: VecComp, axis: number, t: number): number | null {
  const pts = keys.filter((k) => {
    const v = k[comp];
    return v && v[axis] !== null && v[axis] !== undefined;
  });
  const seg = segment(pts, t);
  if (!seg) return null;
  const a = seg.a[comp]![axis] as number;
  const b = seg.b[comp]![axis] as number;
  return lerp(a, b, seg.u);
}

function evalObjectTrack(base: import("./types").ObjectDesc, rawKeys: TransformKey[], t: number): EvaluatedObject {
  const keys = rawKeys as Array<TransformKey & CameraKey>;
  const out: EvaluatedObject = {
    id: base.id,
    position: [...base.position] as Vec3,
    rotation: [...base.rotation] as Vec3,
    scale: [...base.scale] as Vec3,
    color: base.color,
    visible: base.visible,
  };
  // Keys may be partial — per component AND per axis (the graph editor splits
  // shared full-pose keys) — so every axis interpolates over just the keys
  // that key it, falling back to the base pose.
  (["position", "rotation", "scale"] as const).forEach((comp) => {
    for (let axis = 0; axis < 3; axis++) {
      const v = evalAxis(keys, comp, axis, t);
      if (v !== null) out[comp][axis] = v;
    }
  });
  const segCol = segment(keys.filter((k) => k.color !== undefined), t);
  if (segCol) out.color = lerpColor(segCol.a.color!, segCol.b.color!, segCol.u);
  const segVis = segment(keys.filter((k) => k.visible !== undefined), t);
  if (segVis) out.visible = segVis.u < 1 ? segVis.a.visible! : segVis.b.visible!;
  return out;
}

// --- camera evaluation ---------------------------------------------------------

/** Interpolate one camera's keys (position/target per axis, fov scalar) over
 *  its base pose. Keys are pre-filtered to the camera. */
function evalCameraDesc(base: CameraDesc, keys: CameraKey[], t: number): CameraState {
  const raw = keys as Array<TransformKey & CameraKey>;
  const out: CameraState = {
    position: [...base.position] as Vec3,
    target: [...base.target] as Vec3,
    fov: base.fov,
  };
  (["position", "target"] as const).forEach((comp) => {
    for (let axis = 0; axis < 3; axis++) {
      const v = evalAxis(raw, comp, axis, t);
      if (v !== null) out[comp][axis] = v;
    }
  });
  const segFov = segment(raw.filter((k) => k.fov !== undefined), t);
  if (segFov) out.fov = lerp(segFov.a.fov!, segFov.b.fov!, segFov.u);
  return out;
}

/** Evaluated pose of ANY camera by id at time t (its ACTIVE action's keys). */
export function evalCameraById(doc: SceneDocument, cameraId: string, t: number): CameraState {
  const cam = doc.cameras.find((c) => c.id === cameraId) ?? doc.cameras[0];
  if (!cam) return { position: [0, 0, 0], target: [0, 0, 0], fov: 45 };
  return evalCameraDesc(cam, cameraKeysOf(doc, cam.id), t);
}

/** Evaluated pose of the ACTIVE scene camera (what preview/export renders). */
export function evalCamera(doc: SceneDocument, t: number): CameraState {
  return evalCameraById(doc, activeCameraOf(doc).id, t);
}

// --- onFrame hooks -------------------------------------------------------------

export interface FrameApiObjectPatch {
  position?: Vec3;
  rotation?: Vec3;
  scale?: Vec3;
  color?: string;
  visible?: boolean;
}

export interface FrameApi {
  /** Read the currently evaluated state (before this hook's mutations). */
  get(): EvaluatedState;
  /** Find an object id by exact or partial name. */
  find(name: string): string | null;
  /** Patch the evaluated pose of an object for THIS frame only. */
  update(id: string, patch: FrameApiObjectPatch): void;
  /** Patch the evaluated camera for THIS frame only. */
  camera(patch: Partial<CameraState>): void;
}

/** Hook signature: (t, frameApi, state). `state` is a per-hook persistent
 *  object — hooks are stored as source text and re-created (e.g. after a
 *  page reload), so closures over outer variables do NOT survive; anything
 *  that must persist across frames or reloads lives on `state`. */
type HookFn = (t: number, api: FrameApi, state: Record<string, unknown>) => void;

interface CompiledHook {
  fn: HookFn;
  state: Record<string, unknown>;
}

const hookCache = new Map<string, CompiledHook>();

function getHook(source: string): CompiledHook | null {
  const cached = hookCache.get(source);
  if (cached) return cached;
  try {
    // eslint-disable-next-line no-new-func
    const factory = new Function("return (" + source + ")") as () => HookFn;
    const fn = factory();
    if (typeof fn === "function") {
      const entry: CompiledHook = { fn, state: {} };
      hookCache.set(source, entry);
      return entry;
    }
  } catch {
    /* fall through */
  }
  return null;
}

export function compileHook(source: string): HookFn | null {
  return getHook(source)?.fn ?? null;
}

export interface HookError {
  index: number;
  message: string;
}

function runHooks(state: EvaluatedState, doc: SceneDocument, t: number): HookError[] {
  const errors: HookError[] = [];
  const hooked: EvaluatedState["hooked"] = new Map();
  const touch = (id: string, chan: HookChan) => {
    let set = hooked.get(id);
    if (!set) hooked.set(id, (set = new Set()));
    set.add(chan);
  };
  doc.onFrameScripts.forEach((source, index) => {
    const hook = getHook(source);
    if (!hook) {
      errors.push({ index, message: "Invalid onFrame hook source" });
      return;
    }
    const api: FrameApi = {
      get: () => state,
      find: (name) => {
        const lower = name.toLowerCase();
        for (const obj of doc.objects) {
          if (obj.name === name || obj.name.toLowerCase().includes(lower)) return obj.id;
        }
        return null;
      },
      update: (id, patch) => {
        const o = state.objects.get(id);
        // Unknown id (object deleted, stale reference) — frame overlays are
        // best-effort; a missing target is a silent no-op, never a crash.
        if (!o) return;
        if (patch.position) { o.position = [...patch.position] as Vec3; touch(id, "position"); }
        if (patch.rotation) { o.rotation = [...patch.rotation] as Vec3; touch(id, "rotation"); }
        if (patch.scale) { o.scale = [...patch.scale] as Vec3; touch(id, "scale"); }
        if (patch.color !== undefined) { o.color = patch.color; touch(id, "color"); }
        if (patch.visible !== undefined) { o.visible = patch.visible; touch(id, "visible"); }
      },
      camera: (patch) => {
        if (patch.position) state.camera.position = [...patch.position] as Vec3;
        if (patch.target) state.camera.target = [...patch.target] as Vec3;
        if (patch.fov !== undefined) state.camera.fov = patch.fov;
      },
    };
    try {
      hook.fn(t, api, hook.state);
    } catch (err) {
      let message = err instanceof Error ? err.message : String(err);
      if (err instanceof ReferenceError) {
        message +=
          " — onFrame hooks must be self-contained: outer variables (e.g. from execute_code) do not exist here. Use the 3rd arg: (t, f, state) => { state.x ??= f.find(\"Name\"); ... }";
      }
      errors.push({ index, message });
    }
  });
  state.hooked = hooked;
  return errors;
}

// --- main entry ----------------------------------------------------------------

export function evaluate(doc: SceneDocument, time: number, errorsOut?: HookError[]): EvaluatedState {
  const t = Math.min(Math.max(time, 0), Math.max(doc.duration, 0));
  const state: EvaluatedState = {
    time: t,
    objects: new Map(),
    camera: evalCamera(doc, t),
    hooked: new Map(),
  };
  for (const obj of doc.objects) {
    state.objects.set(obj.id, evalObjectTrack(obj, objectKeysOf(doc, obj.id), t));
  }
  const errors = runHooks(state, doc, t);
  if (errorsOut) errorsOut.push(...errors);
  return state;
}

/** Helper for sorting/normalizing key lists. */
export function sortKeys<K extends { t: number }>(keys: K[]): K[] {
  return keys.sort((a, b) => a.t - b.t);
}

export function sortCameraKeys(keys: CameraKey[]): CameraKey[] {
  return sortKeys(keys);
}
