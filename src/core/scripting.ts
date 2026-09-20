/** The Scripting API exposed to agent/user code inside the sandbox.
 *
 *  This module is THREE-free and DOM-free so it runs identically in the
 *  Web Worker sandbox and on the main thread (script console).
 *
 *  Two target flavors:
 *   - persistent (worker / script console): mutations write the SceneDocument.
 *   - overlay: created by animation.ts FrameApi during evaluation instead.
 */
import type { ActionOwner, CameraState, ConstraintDesc, ConstraintKey, ConstraintParams, ConstraintType, GeometryType, KeyVec3, SceneDocument, TransformKey, Vec3 } from "./types";
import { CONSTRAINT_NEEDS_TARGET, CONSTRAINT_TYPES, activeActionOfOwner, activeCameraOf, defaultActionName, defaultCollectionName, defaultMarkerName, isDescendantOf, isGeometryType, newId, specOf, type ActionDesc, type CameraActionDesc, type ObjectActionDesc } from "./types";
import { baseWorldOf, matDecompose, matFromTRS, matInvert, matMultiply } from "./xform";

export interface ScriptTarget {
  /** Mutating handles over a SceneDocument owned by the caller. */
  add(obj: {
    type: GeometryType;
    name?: string;
    params?: Record<string, number>;
    /** LOCAL pose (relative to parentId when given; world for root objects). */
    position?: Vec3;
    rotation?: Vec3;
    scale?: Vec3;
    color?: string;
    visible?: boolean;
    /** Outliner collection (must exist, see addCollection). */
    collectionId?: string;
    /** Parent object (Blender parenting); the new object's pose is LOCAL to it. */
    parentId?: string;
    /** Collection to instance (type:"instance" only; must exist). */
    instanceOf?: string;
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
      /** Outliner collection; null moves the object back to the root. */
      collectionId?: string | null;
    },
  ): void;
  remove(id: string): void;
  clear(): void;
  get(): SceneDocument;
  /** Parent an object (Blender Ctrl+P). keep:"world" (default) re-bakes the
   *  child's local TRS from the base poses so nothing moves; keep:"local"
   *  keeps the stored local pose (the child jumps into the parent's space).
   *  parentId null unparents (same keep rule). */
  setParent(childId: string, parentId: string | null, keep?: "world" | "local"): void;
  /** Add a constraint to an object's stack (evaluated every frame after
   *  animation). child_of bakes its inverse from the current base poses.
   *  Returns the constraint id. */
  addConstraint(
    objectId: string,
    c: { type: ConstraintType; name?: string; targetId?: string; influence?: number; params?: ConstraintParams },
  ): string;
  /** Patch a constraint (name/enabled/influence/targetId/params overlay).
   *  setInverse re-bakes a child_of offset from the current base poses. */
  updateConstraint(
    objectId: string,
    id: string,
    patch: { name?: string; enabled?: boolean; influence?: number; targetId?: string; params?: ConstraintParams },
    setInverse?: boolean,
  ): void;
  /** Replace a constraint's influence/u key track. */
  constraintKeys(objectId: string, id: string, keys: ConstraintKey[]): void;
  /** Remove a constraint from an object's stack. */
  removeConstraint(objectId: string, id: string): void;
  /** Create an Outliner collection (Blender-style grouping); returns its id. */
  addCollection(name?: string): string;
  /** Patch the ACTIVE camera's base pose. */
  setCamera(patch: Partial<CameraState>): void;
  /** Add a scene camera; returns its id. */
  addCamera(cam: { name?: string; position?: Vec3; target?: Vec3; fov?: number; farClip?: number }): string;
  /** Patch a camera's name/base pose/fov/far clip. */
  updateCamera(id: string, patch: { name?: string; position?: Vec3; target?: Vec3; fov?: number; farClip?: number }): void;
  /** Delete a camera and its keys (the last camera cannot be removed). */
  removeCamera(id: string): void;
  /** Make this camera the active one (what preview/export renders). */
  setActiveCamera(id: string): void;
  /** Add a camera-cut marker at time t; from t on, that camera renders until
   *  the next marker. Returns the marker id. */
  addMarker(marker: { name?: string; t: number; cameraId: string }): string;
  /** Patch a marker's name/time/camera. */
  updateMarker(id: string, patch: { name?: string; t?: number; cameraId?: string }): void;
  /** Delete a marker. */
  removeMarker(id: string): void;
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

function checkFarClip(v: number | undefined, what: string): void {
  if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v) || v <= 0))
    throw new Error(`${what} must be a number > 0 (far clip distance)`);
}

/** Create the `api` object bound to a ScriptTarget. */
export function createScriptingAPI(target: ScriptTarget, log: (...args: unknown[]) => void) {
  const countFor = (type: GeometryType): number =>
    target.get().objects.filter((o) => o.type === type).length + 1;

  const api = {
    /** Add an object; returns its id. Position/rotation/scale are LOCAL to
     *  parentId when given (world otherwise). type:"empty" adds a non-rendering
     *  anchor; type:"instance" duplicates a whole collection (instanceOf). */
    add(opts: {
      type: GeometryType;
      name?: string;
      params?: Record<string, number>;
      position?: Vec3;
      rotation?: Vec3;
      scale?: Vec3;
      color?: string;
      visible?: boolean;
      collectionId?: string;
      parentId?: string;
      instanceOf?: string;
    }): string {
      if (!opts || typeof opts !== "object") throw new Error("api.add expects an options object");
      if (!isGeometryType(opts.type))
        throw new Error(`Unknown geometry type "${String(opts.type)}"`);
      if (opts.position) checkVec3(opts.position, "position");
      if (opts.rotation) checkVec3(opts.rotation, "rotation");
      if (opts.scale) checkVec3(opts.scale, "scale");
      if (opts.color) checkColor(opts.color);
      if (opts.collectionId !== undefined && typeof opts.collectionId !== "string")
        throw new Error("collectionId must be a collection id string (see api.addCollection)");
      if (opts.parentId !== undefined && typeof opts.parentId !== "string")
        throw new Error("parentId must be an object id string");
      if (opts.instanceOf !== undefined && typeof opts.instanceOf !== "string")
        throw new Error("instanceOf must be a collection id string");
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
        collectionId?: string | null;
      },
    ): void {
      if (typeof id !== "string") throw new Error("api.update expects (id, patch)");
      if (patch?.position) checkVec3(patch.position, "position");
      if (patch?.rotation) checkVec3(patch.rotation, "rotation");
      if (patch?.scale) checkVec3(patch.scale, "scale");
      if (patch?.color) checkColor(patch.color);
      if (patch?.collectionId !== undefined && patch.collectionId !== null && typeof patch.collectionId !== "string")
        throw new Error("collectionId must be a collection id string or null (see api.addCollection)");
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

    /** Parent an object to another (Blender Ctrl+P) or unparent (null).
     *  keep:"world" (default) keeps the object where it is by re-baking its
     *  local TRS; keep:"local" keeps the stored local values (it jumps). */
    setParent(childId: string, parentId: string | null, keep?: "world" | "local"): void {
      if (typeof childId !== "string") throw new Error("api.setParent expects (childId, parentId|null, keep?)");
      if (parentId !== null && typeof parentId !== "string") throw new Error("api.setParent: parentId must be an id string or null");
      if (keep !== undefined && keep !== "world" && keep !== "local") throw new Error('keep must be "world" or "local"');
      target.setParent(childId, parentId, keep);
    },

    /** Add a constraint to an object's stack (applied every frame after
     *  keyframes/hooks). Constraint types: track_to {axis}, follow_path
     *  {points, u, followRotation}, child_of, limit_location/rotation/scale
     *  {min, max, useMin, useMax}, copy_location/rotation/scale {axes,
     *  invert}, transformation {from, to, factor, offset}. Returns its id. */
    addConstraint(
      objectId: string,
      c: { type: string; name?: string; targetId?: string; influence?: number; params?: ConstraintParams },
    ): string {
      if (typeof objectId !== "string" || !c || typeof c !== "object") throw new Error("api.addConstraint expects (objectId, { type, ... })");
      if (typeof c.type !== "string" || !CONSTRAINT_TYPES.includes(c.type as ConstraintType)) {
        throw new Error(`Unknown constraint type "${String(c.type)}" — use one of ${CONSTRAINT_TYPES.join(", ")}`);
      }
      if (c.influence !== undefined && (typeof c.influence !== "number" || c.influence < 0 || c.influence > 1)) {
        throw new Error("influence must be a number in [0, 1]");
      }
      return target.addConstraint(objectId, {
        type: c.type as ConstraintType,
        name: typeof c.name === "string" ? c.name : undefined,
        targetId: typeof c.targetId === "string" ? c.targetId : undefined,
        influence: typeof c.influence === "number" ? c.influence : undefined,
        params: c.params ?? {},
      });
    },

    /** Patch a constraint: {name?, enabled?, influence?, targetId?, params?}.
     *  setInverse re-bakes a child_of offset from the current base poses. */
    updateConstraint(
      objectId: string,
      id: string,
      patch: { name?: string; enabled?: boolean; influence?: number; targetId?: string; params?: ConstraintParams },
      setInverse?: boolean,
    ): void {
      if (typeof objectId !== "string" || typeof id !== "string" || !patch || typeof patch !== "object")
        throw new Error("api.updateConstraint expects (objectId, id, patch, setInverse?)");
      if (patch.influence !== undefined && (typeof patch.influence !== "number" || patch.influence < 0 || patch.influence > 1)) {
        throw new Error("influence must be a number in [0, 1]");
      }
      target.updateConstraint(objectId, id, patch, setInverse);
    },

    /** Replace a constraint's key track: [{t, influence?, u?, interp?}].
     *  influence animates any constraint (e.g. child_of attach/detach);
     *  u animates follow_path traversal (0..1 along the path). */
    constraintKeys(objectId: string, id: string, keys: ConstraintKey[]): void {
      if (typeof objectId !== "string" || typeof id !== "string" || !Array.isArray(keys))
        throw new Error("api.constraintKeys expects (objectId, id, keys[])");
      for (const k of keys) {
        if (typeof k?.t !== "number" || !Number.isFinite(k.t) || k.t < 0)
          throw new Error(`Constraint key needs a numeric t >= 0, got ${String(k?.t)}`);
      }
      target.constraintKeys(objectId, id, keys);
    },

    /** Remove a constraint by id. */
    removeConstraint(objectId: string, id: string): void {
      if (typeof objectId !== "string" || typeof id !== "string") throw new Error("api.removeConstraint expects (objectId, id)");
      target.removeConstraint(objectId, id);
    },

    /** Create an Outliner collection (Blender-style grouping) and return its
     *  id. Assign objects with api.add({collectionId}) / api.update(id,
     *  {collectionId}); null in update moves an object back to the root. */
    addCollection(name?: string): string {
      if (name !== undefined && typeof name !== "string") throw new Error("api.addCollection expects an optional name string");
      return target.addCollection(name);
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
    setCamera(patch: { position?: Vec3; target?: Vec3; fov?: number; farClip?: number }): void {
      if (patch?.position) checkVec3(patch.position, "camera position");
      if (patch?.target) checkVec3(patch.target, "camera target");
      if (patch?.fov !== undefined && (typeof patch.fov !== "number" || patch.fov <= 0 || patch.fov >= 180))
        throw new Error("camera fov must be a number in (0, 180)");
      checkFarClip(patch?.farClip, "camera farClip");
      target.setCamera(patch ?? {});
    },

    /** Add a scene camera; returns its id. setActiveCamera switches rendering to it. */
    addCamera(opts: { name?: string; position?: Vec3; target?: Vec3; fov?: number; farClip?: number } = {}): string {
      if (opts.position) checkVec3(opts.position, "camera position");
      if (opts.target) checkVec3(opts.target, "camera target");
      if (opts.fov !== undefined && (typeof opts.fov !== "number" || opts.fov <= 0 || opts.fov >= 180))
        throw new Error("camera fov must be a number in (0, 180)");
      checkFarClip(opts.farClip, "camera farClip");
      return target.addCamera(opts);
    },

    /** Patch an existing camera: name?, position?, target?, fov?, farClip?. */
    updateCamera(id: string, patch: { name?: string; position?: Vec3; target?: Vec3; fov?: number; farClip?: number }): void {
      if (typeof id !== "string") throw new Error("api.updateCamera expects (id, patch)");
      if (patch?.position) checkVec3(patch.position, "camera position");
      if (patch?.target) checkVec3(patch.target, "camera target");
      if (patch?.fov !== undefined && (typeof patch.fov !== "number" || patch.fov <= 0 || patch.fov >= 180))
        throw new Error("camera fov must be a number in (0, 180)");
      checkFarClip(patch?.farClip, "camera farClip");
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

    /** Add a camera-cut marker: {t, cameraId, name?}. From t on (until the
     *  next marker) the given camera renders in preview/snapshot/export.
     *  Returns the marker id. */
    addMarker(marker: { name?: string; t: number; cameraId: string }): string {
      if (!marker || typeof marker !== "object") throw new Error("api.addMarker expects { t, cameraId, name? }");
      if (typeof marker.t !== "number" || !Number.isFinite(marker.t) || marker.t < 0)
        throw new Error(`Marker needs a numeric t >= 0, got ${String(marker.t)}`);
      if (typeof marker.cameraId !== "string") throw new Error("api.addMarker expects a cameraId string");
      return target.addMarker({ t: marker.t, cameraId: marker.cameraId, name: typeof marker.name === "string" ? marker.name : undefined });
    },

    /** Patch a marker: name?, t?, cameraId? (id from api.get().markers). */
    updateMarker(id: string, patch: { name?: string; t?: number; cameraId?: string }): void {
      if (typeof id !== "string" || !patch || typeof patch !== "object")
        throw new Error("api.updateMarker expects (id, patch)");
      if (patch.t !== undefined && (typeof patch.t !== "number" || !Number.isFinite(patch.t) || patch.t < 0))
        throw new Error(`Marker t must be a number >= 0, got ${String(patch.t)}`);
      target.updateMarker(id, patch);
    },

    /** Delete a camera-cut marker. */
    removeMarker(id: string): void {
      if (typeof id !== "string") throw new Error("api.removeMarker expects a marker id");
      target.removeMarker(id);
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
  const assertCollection = (id: string) => {
    const col = doc.collections.find((c) => c.id === id);
    if (!col) throw new Error(`No collection with id "${id}"`);
    return col;
  };
  const assertMarker = (id: string) => {
    const mk = doc.markers.find((m) => m.id === id);
    if (!mk) throw new Error(`No marker with id "${id}"`);
    return mk;
  };
  const assertCameraId = (id: string) => {
    if (!doc.cameras.some((c) => c.id === id)) throw new Error(`No camera with id "${id}"`);
    return id;
  };
  /** Bake a child_of offset matrix from the current base poses:
   *  inverse = ownerWorld × targetWorld⁻¹ (Blender "Set Inverse" — attaching
   *  does not move the owner; it follows the target's motion from now on). */
  const bakeChildOfInverse = (ownerId: string, targetId: string): number[] =>
    matMultiply(baseWorldOf(doc, ownerId), matInvert(baseWorldOf(doc, targetId)));
  const assertConstraint = (objectId: string, id: string): ConstraintDesc => {
    const obj = assertObj(objectId);
    const c = obj.constraints?.find((x) => x.id === id);
    if (!c) throw new Error(`No constraint with id "${id}" on object "${obj.name}"`);
    return c;
  };
  const MAX_CONSTRAINTS = 32;
  return {
    add(opts) {
      if (opts.type === "instance") {
        if (!opts.instanceOf || !doc.collections.some((c) => c.id === opts.instanceOf)) {
          throw new Error("api.add({type:\"instance\"}) needs instanceOf: an existing collection id (see api.get().collections)");
        }
        if (doc.objects.some((m) => m.type === "instance" && m.collectionId === opts.instanceOf)) {
          throw new Error("Cannot instance a collection that itself contains an instance (no recursive instancing)");
        }
      }
      if (opts.parentId !== undefined && opts.parentId !== null && !doc.objects.some((o) => o.id === opts.parentId)) {
        throw new Error(`parentId: no object with id "${opts.parentId}"`);
      }
      const spec = specOf(opts.type);
      const id = newId();
      const created = {
        id,
        name: opts.name ?? `${spec.label} ${doc.objects.filter((o) => o.type === opts.type).length + 1}`,
        type: opts.type,
        params: { ...spec.defaults, ...(opts.params ?? {}) },
        position: opts.position ? [...opts.position] : [0, 0.5, 0],
        rotation: opts.rotation ? [...opts.rotation] : [0, 0, 0],
        scale: opts.scale ? [...opts.scale] : [1, 1, 1],
        color: opts.color ?? "#7c5cff",
        visible: opts.visible ?? true,
      } as SceneDocument["objects"][number];
      if (opts.collectionId !== undefined) {
        assertCollection(opts.collectionId);
        created.collectionId = opts.collectionId;
      }
      if (opts.parentId) created.parentId = opts.parentId;
      if (opts.instanceOf) created.instanceOf = opts.instanceOf;
      doc.objects.push(created);
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
      if (patch.collectionId !== undefined) {
        if (patch.collectionId === null) delete obj.collectionId;
        else obj.collectionId = assertCollection(patch.collectionId).id;
      }
    },
    setParent(childId, parentId, keep = "world") {
      if (keep !== "world" && keep !== "local") throw new Error('keep must be "world" or "local"');
      const child = assertObj(childId);
      if (parentId === childId) throw new Error("An object cannot be its own parent");
      if (parentId) {
        const parent = assertObj(parentId);
        if (isDescendantOf(doc, parentId, childId)) {
          throw new Error(`Cannot parent to "${parent.name}" — it is a descendant of "${child.name}" (cycle)`);
        }
      }
      const childWorld = keep === "world" ? baseWorldOf(doc, childId) : null;
      if (parentId) {
        child.parentId = parentId;
        if (childWorld) {
          const local = matDecompose(matMultiply(matInvert(baseWorldOf(doc, parentId)), childWorld));
          child.position = local.position;
          child.rotation = local.rotation;
          child.scale = local.scale;
        }
      } else {
        if (childWorld && child.parentId) {
          const world = matDecompose(childWorld);
          child.position = world.position;
          child.rotation = world.rotation;
          child.scale = world.scale;
        }
        delete child.parentId;
      }
    },
    addConstraint(objectId, c) {
      const obj = assertObj(objectId);
      if (!CONSTRAINT_TYPES.includes(c.type)) {
        throw new Error(`Unknown constraint type "${String(c.type)}" — use one of ${CONSTRAINT_TYPES.join(", ")}`);
      }
      if (CONSTRAINT_NEEDS_TARGET.includes(c.type) && !c.targetId) {
        throw new Error(`${c.type} constraints need a targetId (the object to follow)`);
      }
      if (c.targetId !== undefined && !doc.objects.some((o) => o.id === c.targetId)) {
        throw new Error(`targetId: no object with id "${String(c.targetId)}"`);
      }
      if ((obj.constraints?.length ?? 0) >= MAX_CONSTRAINTS) {
        throw new Error(`Object "${obj.name}" already has ${MAX_CONSTRAINTS} constraints (max)`);
      }
      if (c.influence !== undefined && (typeof c.influence !== "number" || !Number.isFinite(c.influence))) {
        throw new Error("influence must be a number in [0, 1]");
      }
      const created: ConstraintDesc = {
        id: newId("cst"),
        type: c.type,
        name: c.name,
        enabled: true,
        // Out-of-range values clamp, matching updateConstraint + validator.
        influence: c.influence === undefined ? 1 : Math.min(1, Math.max(0, c.influence)),
        targetId: c.targetId,
        params: { ...(c.params ?? {}) },
      };
      if (c.type === "child_of" && c.targetId) {
        created.params.inverse = bakeChildOfInverse(objectId, c.targetId);
      }
      obj.constraints = [...(obj.constraints ?? []), created];
      return created.id;
    },
    updateConstraint(objectId, id, patch, setInverse) {
      const c = assertConstraint(objectId, id);
      if (patch.name !== undefined) c.name = String(patch.name);
      if (patch.enabled !== undefined) c.enabled = !!patch.enabled;
      if (patch.influence !== undefined) {
        if (typeof patch.influence !== "number" || !Number.isFinite(patch.influence)) {
          throw new Error("influence must be a number in [0, 1]");
        }
        c.influence = Math.min(1, Math.max(0, patch.influence));
      }
      if (patch.targetId !== undefined) {
        if (!doc.objects.some((o) => o.id === patch.targetId)) {
          throw new Error(`targetId: no object with id "${patch.targetId}"`);
        }
        c.targetId = patch.targetId;
      }
      if (patch.params) c.params = { ...c.params, ...patch.params };
      if (setInverse) {
        if (c.type !== "child_of") throw new Error("setInverse applies to child_of constraints only");
        if (!c.targetId) throw new Error("child_of needs a targetId before setting the inverse");
        c.params.inverse = bakeChildOfInverse(objectId, c.targetId);
      }
    },
    constraintKeys(objectId, id, keys) {
      const c = assertConstraint(objectId, id);
      if (keys.length > 256) throw new Error("A constraint can hold at most 256 keys");
      const clean = keys
        .filter((k) => k && typeof k === "object" && typeof k.t === "number" && Number.isFinite(k.t) && k.t >= 0)
        .map((k) => ({
          t: k.t,
          influence:
            typeof k.influence === "number" && Number.isFinite(k.influence) ? Math.min(1, Math.max(0, k.influence)) : undefined,
          u: typeof k.u === "number" && Number.isFinite(k.u) ? k.u : undefined,
          interp: k.interp ?? "linear",
        }))
        .sort((a, b) => a.t - b.t);
      c.keys = clean.length ? clean : undefined;
    },
    removeConstraint(objectId, id) {
      const obj = assertObj(objectId);
      if (!obj.constraints?.some((x) => x.id === id)) throw new Error(`No constraint with id "${id}" on object "${obj.name}"`);
      obj.constraints = obj.constraints.filter((x) => x.id !== id);
      if (!obj.constraints.length) delete obj.constraints;
    },
    remove(id) {
      const gone = doc.objects.find((o) => o.id === id);
      if (!gone) throw new Error(`No object with id "${id}"`);
      // Blender-like: children move up to the deleted object's parent,
      // keep-world (they must not jump to the scene origin).
      const byId = new Map(doc.objects.map((o) => [o.id, o] as const));
      for (const child of doc.objects) {
        if (child.parentId !== id) continue;
        const childWorld = baseWorldOf(doc, child.id);
        const newParent = gone.parentId && byId.has(gone.parentId) ? gone.parentId : null;
        const local = newParent
          ? matDecompose(matMultiply(matInvert(baseWorldOf(doc, newParent)), childWorld))
          : matDecompose(childWorld);
        child.position = local.position;
        child.rotation = local.rotation;
        child.scale = local.scale;
        if (newParent) child.parentId = newParent;
        else delete child.parentId;
      }
      doc.objects = doc.objects.filter((o) => o.id !== id);
      doc.actions = doc.actions.filter((a) => !(a.kind === "object" && a.objectId === id));
    },
    clear() {
      doc.objects = [];
      doc.actions = [];
      doc.onFrameScripts = [];
    },
    get() {
      return doc;
    },
    addCollection(name) {
      const id = newId("col");
      const clean = (name ?? "").trim().slice(0, 80);
      doc.collections.push({ id, name: clean || defaultCollectionName(doc) });
      return id;
    },
    setCamera(patch) {
      const cam = activeCameraOf(doc);
      if (patch.position) cam.position = [...patch.position];
      if (patch.target) cam.target = [...patch.target];
      if (patch.fov !== undefined) cam.fov = patch.fov;
      if (patch.farClip !== undefined) cam.farClip = patch.farClip;
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
        farClip: c.farClip ?? src.farClip,
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
      if (patch.farClip !== undefined) cam.farClip = patch.farClip;
    },
    removeCamera(id) {
      if (doc.cameras.length <= 1) throw new Error("Cannot remove the last camera — a scene needs at least one");
      const n = doc.cameras.length;
      doc.cameras = doc.cameras.filter((c) => c.id !== id);
      doc.actions = doc.actions.filter((a) => !(a.kind === "camera" && a.cameraId === id));
      doc.markers = doc.markers.filter((m) => m.cameraId !== id);
      if (doc.activeCameraId === id) doc.activeCameraId = doc.cameras[0].id;
      if (doc.cameras.length === n) throw new Error(`No camera with id "${id}"`);
    },
    setActiveCamera(id) {
      if (!doc.cameras.some((c) => c.id === id)) throw new Error(`No camera with id "${id}"`);
      doc.activeCameraId = id;
    },
    addMarker(marker) {
      const created = {
        id: newId("mk"),
        name: (marker.name ?? "").trim().slice(0, 80) || defaultMarkerName(doc),
        t: marker.t,
        cameraId: assertCameraId(marker.cameraId),
      };
      doc.markers.push(created);
      doc.markers.sort((a, b) => a.t - b.t);
      return created.id;
    },
    updateMarker(id, patch) {
      const mk = assertMarker(id);
      if (patch.name !== undefined) {
        const clean = String(patch.name).trim().slice(0, 80);
        if (clean) mk.name = clean;
      }
      if (patch.t !== undefined) {
        mk.t = patch.t;
        doc.markers.sort((a, b) => a.t - b.t);
      }
      if (patch.cameraId !== undefined) mk.cameraId = assertCameraId(patch.cameraId);
    },
    removeMarker(id) {
      assertMarker(id);
      doc.markers = doc.markers.filter((m) => m.id !== id);
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
