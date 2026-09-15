/** The Scripting API exposed to agent/user code inside the sandbox.
 *
 *  This module is THREE-free and DOM-free so it runs identically in the
 *  Web Worker sandbox and on the main thread (script console).
 *
 *  Two target flavors:
 *   - persistent (worker / script console): mutations write the SceneDocument.
 *   - overlay: created by animation.ts FrameApi during evaluation instead.
 */
import type { ActionOwner, CameraState, GeometryType, KeyVec3, SceneDocument, TransformKey, Vec3 } from "./types";
import { activeActionOfOwner, activeCameraOf, defaultActionName, isGeometryType, newId, specOf, type ActionDesc, type CameraActionDesc, type ObjectActionDesc } from "./types";

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
  /** Patch the ACTIVE camera's base pose. */
  setCamera(patch: Partial<CameraState>): void;
  /** Add a scene camera; returns its id. */
  addCamera(cam: { name?: string; position?: Vec3; target?: Vec3; fov?: number }): string;
  /** Patch a camera's name/base pose/fov. */
  updateCamera(id: string, patch: { name?: string; position?: Vec3; target?: Vec3; fov?: number }): void;
  /** Delete a camera and its keys (the last camera cannot be removed). */
  removeCamera(id: string): void;
  /** Make this camera the active one (what preview/export renders). */
  setActiveCamera(id: string): void;
  /** Create an empty action for an object/camera and make it active; returns its id. */
  createAction(owner: ActionOwner, name?: string): string;
  renameAction(id: string, name: string): void;
  /** Copy an action; the copy becomes its owner's active action. Returns the copy's id. */
  duplicateAction(id: string): string;
  /** Delete an action and its keyframes. */
  removeAction(id: string): void;
  /** Make this action the active one for its owner. */
  setActiveAction(id: string): void;
  addCameraKeys(
    keys: Array<{ t: number; position?: Vec3; target?: Vec3; fov?: number; interp?: string }>,
    cameraId?: string,
    actionId?: string,
  ): void;
  addKeyframes(id: string, keys: TransformKey[], actionId?: string): void;
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

function checkKeyVec3(v: KeyVec3, what: string): void {
  if (!v.every((n) => n === null || (typeof n === "number" && Number.isFinite(n))))
    throw new Error(`${what} must be [x, y, z] numbers (null = axis not keyed)`);
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

    /** Patch the ACTIVE camera's base pose (used when it has no keyframes). */
    setCamera(patch: { position?: Vec3; target?: Vec3; fov?: number }): void {
      if (patch?.position) checkVec3(patch.position, "camera position");
      if (patch?.target) checkVec3(patch.target, "camera target");
      if (patch?.fov !== undefined && (typeof patch.fov !== "number" || patch.fov <= 0 || patch.fov >= 180))
        throw new Error("camera fov must be a number in (0, 180)");
      target.setCamera(patch ?? {});
    },

    /** Add a scene camera; returns its id. setActiveCamera switches rendering to it. */
    addCamera(opts: { name?: string; position?: Vec3; target?: Vec3; fov?: number } = {}): string {
      if (opts.position) checkVec3(opts.position, "camera position");
      if (opts.target) checkVec3(opts.target, "camera target");
      if (opts.fov !== undefined && (typeof opts.fov !== "number" || opts.fov <= 0 || opts.fov >= 180))
        throw new Error("camera fov must be a number in (0, 180)");
      return target.addCamera(opts);
    },

    /** Patch an existing camera: name?, position?, target?, fov?. */
    updateCamera(id: string, patch: { name?: string; position?: Vec3; target?: Vec3; fov?: number }): void {
      if (typeof id !== "string") throw new Error("api.updateCamera expects (id, patch)");
      if (patch?.position) checkVec3(patch.position, "camera position");
      if (patch?.target) checkVec3(patch.target, "camera target");
      if (patch?.fov !== undefined && (typeof patch.fov !== "number" || patch.fov <= 0 || patch.fov >= 180))
        throw new Error("camera fov must be a number in (0, 180)");
      target.updateCamera(id, patch ?? {});
    },

    /** Remove a scene camera and its keyframes (the last camera is protected). */
    removeCamera(id: string): void {
      if (typeof id !== "string") throw new Error("api.removeCamera expects a camera id");
      target.removeCamera(id);
    },

    /** Set which camera preview/snapshot/export render. */
    setActiveCamera(id: string): void {
      if (typeof id !== "string") throw new Error("api.setActiveCamera expects a camera id");
      target.setActiveCamera(id);
    },

    /** Create an empty action for an object/camera and make it active; returns
     *  the action id. Only an owner's ACTIVE action evaluates/edits. */
    createAction(owner: { objectId?: string; cameraId?: string }, name?: string): string {
      if (!owner || typeof owner !== "object" || (owner.objectId === undefined && owner.cameraId === undefined))
        throw new Error('api.createAction expects an owner: { objectId: "..." } or { cameraId: "..." }');
      const normalized: ActionOwner = owner.objectId !== undefined ? { objectId: owner.objectId } : { cameraId: owner.cameraId! };
      return target.createAction(normalized, typeof name === "string" ? name : undefined);
    },

    /** Rename an action (id from api.get().actions). */
    renameAction(id: string, name: string): void {
      if (typeof id !== "string" || typeof name !== "string") throw new Error("api.renameAction expects (id, name)");
      target.renameAction(id, name);
    },

    /** Duplicate an action (keys included); the copy becomes active. Returns its id. */
    duplicateAction(id: string): string {
      if (typeof id !== "string") throw new Error("api.duplicateAction expects an action id");
      return target.duplicateAction(id);
    },

    /** Delete an action and its keyframes. */
    removeAction(id: string): void {
      if (typeof id !== "string") throw new Error("api.removeAction expects an action id");
      target.removeAction(id);
    },

    /** Make this action the active one for its owner (what plays). */
    setActiveAction(id: string): void {
      if (typeof id !== "string") throw new Error("api.setActiveAction expects an action id");
      target.setActiveAction(id);
    },

    /** Append camera keyframes: {t, position, target, fov, interp?}. Keys go to
     *  the given camera (or the ACTIVE camera), into that camera's ACTIVE
     *  action — or into `actionId` when passed. A missing action is created. */
    addCameraKeys(
      keys: Array<{ t: number; position?: Vec3; target?: Vec3; fov?: number; interp?: string }>,
      cameraId?: string,
      actionId?: string,
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
      target.addCameraKeys(keys, cameraId, actionId);
    },

    /** Append object keyframes: {t, position?, rotation?, scale?, color?,
     *  visible?, interp?}. Keys go to the object's ACTIVE action — or into
     *  `actionId` when passed. A missing action is created. */
    keyframes(id: string, keys: TransformKey[], actionId?: string): void {
      if (typeof id !== "string" || !Array.isArray(keys))
        throw new Error("api.keyframes expects (id, keys[])");
      for (const k of keys) {
        if (typeof k?.t !== "number" || !Number.isFinite(k.t) || k.t < 0)
          throw new Error(`Key needs a numeric t >= 0, got ${String(k?.t)}`);
        if (k.position) checkKeyVec3(k.position, "key position");
        if (k.rotation) checkKeyVec3(k.rotation, "key rotation");
        if (k.scale) checkKeyVec3(k.scale, "key scale");
        if (k.color) checkColor(k.color);
        if (k.interp && !["linear", "step", "smooth"].includes(k.interp))
          throw new Error(`interp must be linear|step|smooth, got "${k.interp}"`);
      }
      target.addKeyframes(id, keys, actionId);
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
  const assertAction = (id: string) => {
    const act = doc.actions.find((a) => a.id === id);
    if (!act) throw new Error(`No action with id "${id}"`);
    return act;
  };
  /** The camera/object action a key append should write into: an explicit
   *  actionId (when it belongs to the owner) wins, else the owner's ACTIVE
   *  action, else a fresh default action is created and activated. */
  const resolveKeyAction = (owner: ActionOwner, actionId?: string): ActionDesc => {
    let act = activeActionOfOwner(doc, owner, actionId);
    if (!act) {
      const created =
        "objectId" in owner
          ? ({
              id: newId("act"),
              name: defaultActionName(doc, owner),
              kind: "object",
              objectId: owner.objectId,
              keys: [],
            } as ObjectActionDesc)
          : ({
              id: newId("act"),
              name: defaultActionName(doc, owner),
              kind: "camera",
              cameraId: owner.cameraId,
              keys: [],
            } as CameraActionDesc);
      doc.actions.push(created);
      const ownerDesc =
        "objectId" in owner ? doc.objects.find((o) => o.id === owner.objectId) : doc.cameras.find((c) => c.id === owner.cameraId);
      if (ownerDesc) ownerDesc.activeActionId = created.id;
      act = created;
    }
    return act;
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
      doc.actions = doc.actions.filter((a) => !(a.kind === "object" && a.objectId === id));
      if (doc.objects.length === n) throw new Error(`No object with id "${id}"`);
    },
    clear() {
      doc.objects = [];
      doc.actions = [];
      doc.onFrameScripts = [];
    },
    get() {
      return doc;
    },
    setCamera(patch) {
      const cam = activeCameraOf(doc);
      if (patch.position) cam.position = [...patch.position];
      if (patch.target) cam.target = [...patch.target];
      if (patch.fov !== undefined) cam.fov = patch.fov;
    },
    addCamera(c) {
      const id = newId("cam");
      const src = activeCameraOf(doc);
      doc.cameras.push({
        id,
        name: c.name ?? `Camera ${doc.cameras.length + 1}`,
        position: c.position ? [...c.position] : [src.position[0], src.position[1] + 1.5, src.position[2]],
        target: c.target ? [...c.target] : [...src.target],
        fov: c.fov ?? src.fov,
      });
      return id;
    },
    updateCamera(id, patch) {
      const cam = doc.cameras.find((c) => c.id === id);
      if (!cam) throw new Error(`No camera with id "${id}"`);
      if (patch.name !== undefined) cam.name = String(patch.name);
      if (patch.position) cam.position = [...patch.position];
      if (patch.target) cam.target = [...patch.target];
      if (patch.fov !== undefined) cam.fov = patch.fov;
    },
    removeCamera(id) {
      if (doc.cameras.length <= 1) throw new Error("Cannot remove the last camera — a scene needs at least one");
      const n = doc.cameras.length;
      doc.cameras = doc.cameras.filter((c) => c.id !== id);
      doc.actions = doc.actions.filter((a) => !(a.kind === "camera" && a.cameraId === id));
      if (doc.activeCameraId === id) doc.activeCameraId = doc.cameras[0].id;
      if (doc.cameras.length === n) throw new Error(`No camera with id "${id}"`);
    },
    setActiveCamera(id) {
      if (!doc.cameras.some((c) => c.id === id)) throw new Error(`No camera with id "${id}"`);
      doc.activeCameraId = id;
    },
    createAction(owner, name) {
      if ("objectId" in owner) {
        const obj = assertObj(owner.objectId);
        const act: ObjectActionDesc = {
          id: newId("act"),
          name: (name ?? "").trim().slice(0, 80) || defaultActionName(doc, { objectId: obj.id }),
          kind: "object",
          objectId: obj.id,
          keys: [],
        };
        doc.actions.push(act);
        obj.activeActionId = act.id;
        return act.id;
      }
      {
        const cam = doc.cameras.find((c) => c.id === owner.cameraId);
        if (!cam) throw new Error(`No camera with id "${owner.cameraId}"`);
        const act: CameraActionDesc = {
          id: newId("act"),
          name: (name ?? "").trim().slice(0, 80) || defaultActionName(doc, { cameraId: cam.id }),
          kind: "camera",
          cameraId: cam.id,
          keys: [],
        };
        doc.actions.push(act);
        cam.activeActionId = act.id;
        return act.id;
      }
    },
    renameAction(id, name) {
      const act = assertAction(id);
      const clean = String(name).trim().slice(0, 80);
      if (clean) act.name = clean;
    },
    duplicateAction(id) {
      const src = assertAction(id);
      const copy = JSON.parse(JSON.stringify(src)) as ActionDesc;
      copy.id = newId("act");
      copy.name = `${src.name} copy`;
      doc.actions.push(copy);
      const owner =
        copy.kind === "object" ? doc.objects.find((o) => o.id === copy.objectId) : doc.cameras.find((c) => c.id === copy.cameraId);
      if (owner) owner.activeActionId = copy.id;
      return copy.id;
    },
    removeAction(id) {
      const src = assertAction(id);
      doc.actions = doc.actions.filter((a) => a.id !== id);
      const owner =
        src.kind === "object" ? doc.objects.find((o) => o.id === src.objectId) : doc.cameras.find((c) => c.id === src.cameraId);
      if (owner && owner.activeActionId === id) {
        const first = doc.actions.find((a) =>
          src.kind === "object" ? a.kind === "object" && a.objectId === src.objectId : a.kind === "camera" && a.cameraId === src.cameraId
        );
        if (first) owner.activeActionId = first.id;
        else delete owner.activeActionId;
      }
    },
    setActiveAction(id) {
      const act = assertAction(id);
      const owner =
        act.kind === "object" ? doc.objects.find((o) => o.id === act.objectId) : doc.cameras.find((c) => c.id === act.cameraId);
      if (!owner) throw new Error(`Action "${id}" has no owner`);
      owner.activeActionId = id;
    },
    addCameraKeys(keys, cameraId, actionId) {
      const camId = cameraId ?? activeCameraOf(doc).id;
      const base = doc.cameras.find((c) => c.id === camId);
      if (!base) throw new Error(`No camera with id "${camId}"`);
      const act = resolveKeyAction({ cameraId: camId }, actionId);
      if (act.kind !== "camera") throw new Error(`Action "${act.name}" is not a camera action`);
      const prev = act.keys.slice(-1)[0] ?? null;
      for (const k of keys) {
        act.keys.push({
          t: k.t,
          cameraId: camId,
          position: k.position ? [...k.position] : [...(prev?.position ?? base.position)],
          target: k.target ? [...k.target] : [...(prev?.target ?? base.target)],
          fov: k.fov ?? prev?.fov ?? base.fov,
          interp: (k.interp as TransformKey["interp"]) ?? "linear",
        });
      }
      act.keys.sort((a, b) => a.t - b.t);
    },
    addKeyframes(id, keys, actionId) {
      assertObj(id);
      const act = resolveKeyAction({ objectId: id }, actionId);
      if (act.kind !== "object") throw new Error(`Action "${act.name}" is not an object action`);
      const prev = act.keys.slice(-1)[0] ?? null;
      for (const k of keys) {
        act.keys.push({
          t: k.t,
          position: k.position ? [...k.position] : prev?.position,
          rotation: k.rotation ? [...k.rotation] : prev?.rotation,
          scale: k.scale ? [...k.scale] : prev?.scale,
          color: k.color ?? prev?.color,
          visible: k.visible ?? prev?.visible,
          interp: k.interp ?? "linear",
        });
      }
      act.keys.sort((a, b) => a.t - b.t);
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
