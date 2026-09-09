/** Deterministic animation evaluator: SceneDocument + time -> posed scene state.
 *
 *  Pipeline per frame:
 *    1. Start from base object poses / base camera.
 *    2. Apply keyframe interpolation (tracks / cameraKeys).
 *    3. Run onFrame overlay hooks in registration order (procedural motion).
 *
 *  This module is THREE-free so it can also run inside the sandbox worker.
 */
import type {
  CameraKey,
  CameraState,
  Interp,
  SceneDocument,
  TransformKey,
  Vec3,
} from "./types";

export interface EvaluatedObject {
  id: string;
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
  color: string;
  visible: boolean;
}

export interface EvaluatedState {
  time: number;
  objects: Map<string, EvaluatedObject>;
  camera: CameraState;
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

function evalObjectTrack(base: import("./types").ObjectDesc, keys: TransformKey[], t: number): EvaluatedObject {
  if (keys.length === 0) {
    return {
      id: base.id,
      position: [...base.position] as Vec3,
      rotation: [...base.rotation] as Vec3,
      scale: [...base.scale] as Vec3,
      color: base.color,
      visible: base.visible,
    };
  }
  const seg = segment(keys, t);
  const out: EvaluatedObject = {
    id: base.id,
    position: [...base.position] as Vec3,
    rotation: [...base.rotation] as Vec3,
    scale: [...base.scale] as Vec3,
    color: base.color,
    visible: base.visible,
  };
  if (!seg) return out;
  const { a, b, u } = seg;
  if (a.position && b.position) lerpVec3(a.position, b.position, u, out.position);
  if (a.rotation && b.rotation) lerpVec3(a.rotation, b.rotation, u, out.rotation);
  if (a.scale && b.scale) lerpVec3(a.scale, b.scale, u, out.scale);
  if (a.color && b.color) out.color = lerpColor(a.color, b.color, u);
  if (a.visible !== undefined && b.visible !== undefined) out.visible = u < 1 ? a.visible : b.visible;
  return out;
}

// --- camera evaluation ---------------------------------------------------------

export function evalCamera(doc: SceneDocument, t: number): CameraState {
  const keys = doc.cameraKeys;
  if (keys.length === 0) {
    return {
      position: [...doc.camera.position] as Vec3,
      target: [...doc.camera.target] as Vec3,
      fov: doc.camera.fov,
    };
  }
  const seg = segment(keys, t);
  if (!seg) {
    return {
      position: [...doc.camera.position] as Vec3,
      target: [...doc.camera.target] as Vec3,
      fov: doc.camera.fov,
    };
  }
  const { a, b, u } = seg;
  const pos = [0, 0, 0] as Vec3;
  const tgt = [0, 0, 0] as Vec3;
  lerpVec3(a.position, b.position, u, pos);
  lerpVec3(a.target, b.target, u, tgt);
  return { position: pos, target: tgt, fov: lerp(a.fov, b.fov, u) };
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

type HookFn = (t: number, api: FrameApi) => void;

const hookCache = new Map<string, HookFn>();

export function compileHook(source: string): HookFn | null {
  if (hookCache.has(source)) return hookCache.get(source) ?? null;
  try {
    // eslint-disable-next-line no-new-func
    const factory = new Function("return (" + source + ")") as () => HookFn;
    const fn = factory();
    if (typeof fn === "function") {
      hookCache.set(source, fn);
      return fn;
    }
  } catch {
    /* fall through */
  }
  return null;
}

export interface HookError {
  index: number;
  message: string;
}

function runHooks(state: EvaluatedState, doc: SceneDocument, t: number): HookError[] {
  const errors: HookError[] = [];
  doc.onFrameScripts.forEach((source, index) => {
    const fn = compileHook(source);
    if (!fn) {
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
        if (!o) throw new Error(`onFrame: unknown object id "${id}"`);
        if (patch.position) o.position = [...patch.position] as Vec3;
        if (patch.rotation) o.rotation = [...patch.rotation] as Vec3;
        if (patch.scale) o.scale = [...patch.scale] as Vec3;
        if (patch.color !== undefined) o.color = patch.color;
        if (patch.visible !== undefined) o.visible = patch.visible;
      },
      camera: (patch) => {
        if (patch.position) state.camera.position = [...patch.position] as Vec3;
        if (patch.target) state.camera.target = [...patch.target] as Vec3;
        if (patch.fov !== undefined) state.camera.fov = patch.fov;
      },
    };
    try {
      fn(t, api);
    } catch (err) {
      errors.push({ index, message: err instanceof Error ? err.message : String(err) });
    }
  });
  return errors;
}

// --- main entry ----------------------------------------------------------------

export function evaluate(doc: SceneDocument, time: number, errorsOut?: HookError[]): EvaluatedState {
  const t = Math.min(Math.max(time, 0), Math.max(doc.duration, 0));
  const state: EvaluatedState = {
    time: t,
    objects: new Map(),
    camera: evalCamera(doc, t),
  };
  for (const obj of doc.objects) {
    state.objects.set(obj.id, evalObjectTrack(obj, doc.tracks[obj.id] ?? [], t));
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
