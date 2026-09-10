/** The Scripting API exposed to agent/user code inside the sandbox.
 *
 *  This module is THREE-free and DOM-free so it runs identically in the
 *  Web Worker sandbox and on the main thread (script console).
 *
 *  Two target flavors:
 *   - persistent (worker / script console): mutations write the SceneDocument.
 *   - overlay: created by animation.ts FrameApi during evaluation instead.
 */
import type { CameraState, GeometryType, SceneDocument, TransformKey, Vec3 } from "./types";
import { isGeometryType, newId, specOf } from "./types";

export interface ScriptTarget {
  /** Mutating handles over a SceneDocument owned by the caller. */
  add(obj: {
    type: GeometryType;
    name?: string;
    params?: Record<string, number>;
    position?: Vec3;
    rotation?: Vec3;
    scale?: Vec3;
    color?: string;
    visible?: boolean;
  }): string;
  update(
    id: string,
    patch: {
      name?: string;
      params?: Record<string, number>;
      position?: Vec3;
      rotation?: Vec3;
      scale?: Vec3;
      color?: string;
      visible?: boolean;
    },
  ): void;
  remove(id: string): void;
  clear(): void;
  get(): SceneDocument;
  setCamera(patch: Partial<CameraState>): void;
  addCameraKeys(keys: Array<{ t: number; position?: Vec3; target?: Vec3; fov?: number; interp?: string }>): void;
  addKeyframes(id: string, keys: TransformKey[]): void;
  setDuration(seconds: number): void;
  setFps(fps: number): void;
  setAspect(ratio: number): void;
  addOnFrame(source: string): void;
}

const COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

function isVec3(v: unknown): v is Vec3 {
  return (
    Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === "number" && Number.isFinite(n))
  );
}

function checkColor(color: string): string {
  if (!COLOR_RE.test(color)) throw new Error(`Invalid color "${color}" — use hex like "#ff8800"`);
  return color;
}

function checkVec3(v: Vec3, what: string): void {
  if (!isVec3(v)) throw new Error(`${what} must be [x, y, z] numbers`);
}

/** Create the `api` object bound to a ScriptTarget. */
export function createScriptingAPI(target: ScriptTarget, log: (...args: unknown[]) => void) {
  const countFor = (type: GeometryType): number =>
    target.get().objects.filter((o) => o.type === type).length + 1;

  const api = {
    /** Add an object; returns its id. */
    add(opts: {
      type: GeometryType;
      name?: string;
      params?: Record<string, number>;
      position?: Vec3;
      rotation?: Vec3;
      scale?: Vec3;
      color?: string;
      visible?: boolean;
    }): string {
      if (!opts || typeof opts !== "object") throw new Error("api.add expects an options object");
      if (!isGeometryType(opts.type))
        throw new Error(`Unknown geometry type "${String(opts.type)}"`);
      if (opts.position) checkVec3(opts.position, "position");
      if (opts.rotation) checkVec3(opts.rotation, "rotation");
      if (opts.scale) checkVec3(opts.scale, "scale");
      if (opts.color) checkColor(opts.color);
      return target.add(opts);
    },

    /** Patch an object's persistent properties. */
    update(
      id: string,
      patch: {
        name?: string;
        params?: Record<string, number>;
        position?: Vec3;
        rotation?: Vec3;
        scale?: Vec3;
        color?: string;
        visible?: boolean;
      },
    ): void {
      if (typeof id !== "string") throw new Error("api.update expects (id, patch)");
      if (patch?.position) checkVec3(patch.position, "position");
      if (patch?.rotation) checkVec3(patch.rotation, "rotation");
      if (patch?.scale) checkVec3(patch.scale, "scale");
      if (patch?.color) checkColor(patch.color);
      target.update(id, patch);
    },

    /** Remove an object by id. */
    remove(id: string): void {
      target.remove(id);
    },

    /** Remove all objects, keyframes and camera keys. */
    clear(): void {
      target.clear();
    },

    /** Full scene document (read-only snapshot). */
    get(): SceneDocument {
      return target.get();
    },

    /** Find an object id by exact name or unique partial match. */
    find(name: string): string | null {
      if (typeof name !== "string") throw new Error("api.find expects a name string");
      const doc = target.get();
      const exact = doc.objects.find((o) => o.name === name);
      if (exact) return exact.id;
      const lower = name.toLowerCase();
      const partials = doc.objects.filter((o) => o.name.toLowerCase().includes(lower));
      if (partials.length === 1) return partials[0].id;
      if (partials.length > 1)
        throw new Error(`api.find("${name}") is ambiguous: ${partials.map((o) => o.name).join(", ")}`);
      return null;
    },

    /** Set the base camera pose (used when no camera keyframes exist). */
    setCamera(patch: { position?: Vec3; target?: Vec3; fov?: number }): void {
      if (patch?.position) checkVec3(patch.position, "camera position");
      if (patch?.target) checkVec3(patch.target, "camera target");
      if (patch?.fov !== undefined && (typeof patch.fov !== "number" || patch.fov <= 0 || patch.fov >= 180))
        throw new Error("camera fov must be a number in (0, 180)");
      target.setCamera(patch ?? {});
    },

    /** Append camera keyframes: {t, position, target, fov, interp?}. */
    addCameraKeys(
      keys: Array<{ t: number; position?: Vec3; target?: Vec3; fov?: number; interp?: string }>,
    ): void {
      if (!Array.isArray(keys)) throw new Error("api.addCameraKeys expects an array of keys");
      for (const k of keys) {
        if (typeof k?.t !== "number" || !Number.isFinite(k.t) || k.t < 0)
          throw new Error(`Camera key needs a numeric t >= 0, got ${String(k?.t)}`);
        if (k.position) checkVec3(k.position, "key position");
        if (k.target) checkVec3(k.target, "key target");
        if (k.fov !== undefined && (typeof k.fov !== "number" || k.fov <= 0 || k.fov >= 180))
          throw new Error(`Camera key fov must be in (0, 180), got ${String(k.fov)}`);
      }
      target.addCameraKeys(keys);
    },

    /** Append object keyframes: {t, position?, rotation?, scale?, color?, visible?, interp?}. */
    keyframes(id: string, keys: TransformKey[]): void {
      if (typeof id !== "string" || !Array.isArray(keys))
        throw new Error("api.keyframes expects (id, keys[])");
      for (const k of keys) {
        if (typeof k?.t !== "number" || !Number.isFinite(k.t) || k.t < 0)
          throw new Error(`Key needs a numeric t >= 0, got ${String(k?.t)}`);
        if (k.position) checkVec3(k.position, "key position");
        if (k.rotation) checkVec3(k.rotation, "key rotation");
        if (k.scale) checkVec3(k.scale, "key scale");
        if (k.color) checkColor(k.color);
        if (k.interp && !["linear", "step", "smooth"].includes(k.interp))
          throw new Error(`interp must be linear|step|smooth, got "${k.interp}"`);
      }
      target.addKeyframes(id, keys);
    },

    /** Clip duration in seconds. */
    setDuration(seconds: number): void {
      if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0 || seconds > 300)
        throw new Error("duration must be a number in (0, 300] seconds");
      target.setDuration(seconds);
    },

    /** Export frame rate (does not affect playback smoothness). */
    setFps(fps: number): void {
      if (typeof fps !== "number" || !Number.isInteger(fps) || fps < 1 || fps > 120)
        throw new Error("fps must be an integer in [1, 120]");
      target.setFps(fps);
    },

    /** Camera framing aspect ratio (width / height, e.g. 16/9 or 9/16). */
    setAspect(ratio: number): void {
      if (typeof ratio !== "number" || !Number.isFinite(ratio) || ratio < 0.2 || ratio > 5)
        throw new Error("aspect must be a number in [0.2, 5] (width / height, e.g. 16/9)");
      target.setAspect(ratio);
    },

    /** Register a procedural hook run every frame: (t, frameApi, state) => {...}.
     *  frameApi.update(id, patch) / frameApi.camera(patch) affect the current
     *  frame only; the persistent document is not modified. The hook is stored
     *  as source text and re-created on reload, so it must be self-contained:
     *  resolve ids fresh each frame via frameApi.find, keep counters on the
     *  `state` object, never reference outer variables. */
    onFrame(fn: (t: number, frameApi: unknown, state: Record<string, unknown>) => void): void {
      if (typeof fn !== "function") throw new Error("api.onFrame expects a function");
      target.addOnFrame(fn.toString());
    },

    /** Names & ids of every object (quick overview). */
    list(): Array<{ id: string; name: string; type: GeometryType }> {
      return target.get().objects.map((o) => ({ id: o.id, name: o.name, type: o.type }));
    },

    /** Geometry parameter spec for a type (valid param keys + ranges). */
    params(type: GeometryType): Record<string, number> {
      if (!isGeometryType(type)) throw new Error(`Unknown geometry type "${String(type)}"`);
      return { ...specOf(type).defaults };
    },

    /** Generate a unique name for a type, e.g. uniqueName("box") -> "Box 3". */
    uniqueName(type: GeometryType): string {
      if (!isGeometryType(type)) throw new Error(`Unknown geometry type "${String(type)}"`);
      const spec = specOf(type);
      return `${spec.label} ${countFor(type)}`;
    },

    log: (...args: unknown[]) => log(...args),
  };
  return api;
}

export type ScriptingAPI = ReturnType<typeof createScriptingAPI>;

/** Build a ScriptTarget bound to a SceneDocument the caller owns (worker mirror). */
export function createScriptTarget(doc: SceneDocument): ScriptTarget {
  const assertObj = (id: string) => {
    const obj = doc.objects.find((o) => o.id === id);
    if (!obj) throw new Error(`No object with id "${id}"`);
    return obj;
  };
  return {
    add(opts) {
      const spec = specOf(opts.type);
      const id = newId();
      doc.objects.push({
        id,
        name: opts.name ?? `${spec.label} ${doc.objects.filter((o) => o.type === opts.type).length + 1}`,
        type: opts.type,
        params: { ...spec.defaults, ...(opts.params ?? {}) },
        position: opts.position ? [...opts.position] : [0, 0.5, 0],
        rotation: opts.rotation ? [...opts.rotation] : [0, 0, 0],
        scale: opts.scale ? [...opts.scale] : [1, 1, 1],
        color: opts.color ?? "#7c5cff",
        visible: opts.visible ?? true,
      });
      return id;
    },
    update(id, patch) {
      const obj = assertObj(id);
      if (patch.name !== undefined) obj.name = String(patch.name);
      if (patch.params) obj.params = { ...obj.params, ...patch.params };
      if (patch.position) obj.position = [...patch.position];
      if (patch.rotation) obj.rotation = [...patch.rotation];
      if (patch.scale) obj.scale = [...patch.scale];
      if (patch.color) obj.color = patch.color;
      if (patch.visible !== undefined) obj.visible = !!patch.visible;
    },
    remove(id) {
      const n = doc.objects.length;
      doc.objects = doc.objects.filter((o) => o.id !== id);
      delete doc.tracks[id];
      if (doc.objects.length === n) throw new Error(`No object with id "${id}"`);
    },
    clear() {
      doc.objects = [];
      doc.tracks = {};
      doc.cameraKeys = [];
      doc.onFrameScripts = [];
    },
    get() {
      return doc;
    },
    setCamera(patch) {
      if (patch.position) doc.camera.position = [...patch.position];
      if (patch.target) doc.camera.target = [...patch.target];
      if (patch.fov !== undefined) doc.camera.fov = patch.fov;
    },
    addCameraKeys(keys) {
      const prev = doc.cameraKeys.length ? doc.cameraKeys[doc.cameraKeys.length - 1] : null;
      for (const k of keys) {
        doc.cameraKeys.push({
          t: k.t,
          position: k.position ? [...k.position] : prev ? [...prev.position] : [...doc.camera.position],
          target: k.target ? [...k.target] : prev ? [...prev.target] : [...doc.camera.target],
          fov: k.fov ?? prev?.fov ?? doc.camera.fov,
          interp: (k.interp as TransformKey["interp"]) ?? "linear",
        });
      }
      doc.cameraKeys.sort((a, b) => a.t - b.t);
    },
    addKeyframes(id, keys) {
      assertObj(id);
      const prev = (doc.tracks[id] ?? []).slice(-1)[0] ?? null;
      const merged = (doc.tracks[id] ?? []).slice();
      for (const k of keys) {
        merged.push({
          t: k.t,
          position: k.position ? [...k.position] : prev?.position,
          rotation: k.rotation ? [...k.rotation] : prev?.rotation,
          scale: k.scale ? [...k.scale] : prev?.scale,
          color: k.color ?? prev?.color,
          visible: k.visible ?? prev?.visible,
          interp: k.interp ?? "linear",
        });
      }
      merged.sort((a, b) => a.t - b.t);
      doc.tracks[id] = merged;
    },
    setDuration(seconds) {
      doc.duration = seconds;
    },
    setFps(fps) {
      doc.fps = fps;
    },
    setAspect(ratio) {
      doc.aspect = ratio;
    },
    addOnFrame(source) {
      doc.onFrameScripts.push(source);
    },
  };
}
