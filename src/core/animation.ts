/** Deterministic animation evaluator: SceneDocument + time -> posed scene state.
 *
 *  Pipeline per frame:
 *    1. Start from base object poses / base camera.
 *    2. Apply keyframe interpolation (each owner's ACTIVE action).
 *    3. Run onFrame overlay hooks in registration order (procedural motion).
 *    4. Compose the parenting hierarchy and apply object constraints
 *       (Blender order: animation first, constraints after).
 *
 *  Object poses are LOCAL (relative to the parent; == world for root objects);
 *  the composed `world` pose and `worldMats` are filled by pass 4.
 *
 *  This module is THREE-free so it can also run inside the sandbox worker.
 */
import type {
  CameraDesc,
  CameraKey,
  CameraState,
  ConstraintDesc,
  ConstraintKey,
  Interp,
  SceneDocument,
  TransformKey,
  Vec3,
} from "./types";
import { activeCameraIdAt, cameraFarClip, cameraKeysOf, constraintChannels, objectKeysOf, DEFAULT_FAR_CLIP } from "./types";
import {
  axisQuat,
  eulerFromQuat,
  matDecompose,
  matFromTRS,
  matIdentity,
  matInvert,
  matMultiply,
  quatConjugate,
  quatFromEuler,
  quatMultiply,
  quatOfMat,
  quatSlerp,
  samplePolyline,
  transformPoint,
  vlerp,
  type Mat4,
} from "./xform";

export interface EvaluatedObject {
  id: string;
  /** LOCAL pose relative to the parent (== world for roots): what keys and
   *  hooks produce and what constraints write. Keyframes record these. */
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
  /** Composed WORLD pose (parent chain applied). Rendering uses this. */
  world: { position: Vec3; rotation: Vec3; scale: Vec3 };
  color: string;
  visible: boolean;
}

/** A channel an onFrame hook may override on an object. */
export type HookChan = "position" | "rotation" | "scale" | "color" | "visible";

export interface EvaluatedState {
  time: number;
  objects: Map<string, EvaluatedObject>;
  camera: CameraState;
  /** Which scene camera `camera` is (marker at/before t, else the manual
   *  active camera) — lets the UI show the live camera without re-resolving. */
  cameraId: string;
  /** Object id -> channels the onFrame hooks overrode at this time. A hooked
   *  channel is script-owned: the hook re-applies it on every evaluate, so
   *  manual edits to it can never stick (and must not be recorded as keys). */
  hooked: Map<string, Set<HookChan>>;
  /** Object id -> channels constraints wrote at this time (same ownership
   *  rule as `hooked`: re-applied every frame, not editable/keyable). */
  constrained: Map<string, Set<HookChan>>;
  /** World matrix per object (parent chain composed, constraints applied).
   *  Used by the renderer (instance expansion) and gizmo world→local math. */
  worldMats: Map<string, Mat4>;
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
    world: {
      position: [...base.position] as Vec3,
      rotation: [...base.rotation] as Vec3,
      scale: [...base.scale] as Vec3,
    },
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
    farClip: cameraFarClip(base),
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
  if (!cam) return { position: [0, 0, 0], target: [0, 0, 0], fov: 45, farClip: DEFAULT_FAR_CLIP };
  return evalCameraDesc(cam, cameraKeysOf(doc, cam.id), t);
}

/** Evaluated pose of the LIVE camera at time t (what preview/export renders):
 *  the camera bound by the latest marker at/before t, else the manual
 *  active camera. */
export function evalCamera(doc: SceneDocument, t: number): CameraState {
  return evalCameraById(doc, activeCameraIdAt(doc, t), t);
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
  /** Read the currently evaluated state (before this hook's mutations).
   *  Object position/rotation/scale are LOCAL to the object's parent; the
   *  composed `world` pose is alongside. */
  get(): EvaluatedState;
  /** Find an object id by exact or partial name. */
  find(name: string): string | null;
  /** Patch the evaluated LOCAL pose of an object for THIS frame only. */
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

// --- hierarchy + constraints (Blender order: animation, then constraints) --------

/** Sample one channel of a constraint's mini key track (influence / u).
 *  Returns null when no key defines the channel (use the static value). */
function sampleConstraintChannel(keys: ConstraintKey[] | undefined, chan: "influence" | "u", t: number): number | null {
  if (!keys?.length) return null;
  const pts = keys.filter((k) => typeof k[chan] === "number") as Array<ConstraintKey & { influence: number; u: number }>;
  if (!pts.length) return null;
  const seg = segment(pts, t);
  if (!seg) return null;
  return lerp(seg.a[chan], seg.b[chan], seg.u);
}

const LIMIT_DEFAULTS: Record<"limit_location" | "limit_rotation" | "limit_scale", { min: Vec3; max: Vec3 }> = {
  limit_location: { min: [-1, -1, -1], max: [1, 1, 1] },
  limit_rotation: { min: [0, 0, 0], max: [Math.PI / 2, Math.PI / 2, Math.PI / 2] },
  limit_scale: { min: [0.1, 0.1, 0.1], max: [1, 1, 1] },
};

interface SolveCtx {
  state: EvaluatedState;
  doc: SceneDocument;
  t: number;
  /** Working world matrices: final for objects already visited (topo order),
   *  provisional (keys+hooks only) for objects not yet visited. */
  worldMats: Map<string, Mat4>;
}

/** Read the target's current world matrix (final if already solved — e.g. an
 *  ancestor —, provisional otherwise). Null when the target is missing. */
function targetWorld(ctx: SolveCtx, c: ConstraintDesc): Mat4 | null {
  if (!c.targetId) return null;
  const m = ctx.worldMats.get(c.targetId);
  if (!m) return null;
  const holder = ctx.state.objects.get(c.targetId);
  if (!holder) return null;
  return m;
}

function influenceOf(c: ConstraintDesc, t: number): number {
  return sampleConstraintChannel(c.keys, "influence", t) ?? c.influence ?? 1;
}

function matFromFlat16(flat: number[] | undefined): Mat4 {
  if (!flat || flat.length !== 16) return matIdentity();
  return flat;
}

/** Apply one constraint to the owner's LOCAL pose. `myWorld` is the owner's
 *  world matrix BEFORE this constraint (recompose happens after the stack). */
function applyConstraint(c: ConstraintDesc, ev: EvaluatedObject, parentWorld: Mat4, myWorld: Mat4, ctx: SolveCtx): void {
  const p = c.params;
  const influence = influenceOf(c, ctx.t);
  if (influence <= 0) return;
  const parentWorldInv = matInvert(parentWorld);
  const parentQuat = quatOfMat(parentWorld);

  switch (c.type) {
    case "track_to": {
      const tw = targetWorld(ctx, c);
      if (!tw) return;
      const myPos: Vec3 = [myWorld[12], myWorld[13], myWorld[14]];
      const dir: Vec3 = [tw[12] - myPos[0], tw[13] - myPos[1], tw[14] - myPos[2]];
      if (Math.hypot(dir[0], dir[1], dir[2]) < 1e-9) return;
      const desiredLocal = quatMultiply(quatConjugate(parentQuat), axisQuat(p.axis ?? "+z", dir, [0, 1, 0]));
      ev.rotation = eulerFromQuat(quatSlerp(quatFromEuler(ev.rotation), desiredLocal, influence));
      return;
    }
    case "follow_path": {
      const pts = p.points;
      if (!pts || pts.length < 2) return;
      const u = sampleConstraintChannel(c.keys, "u", ctx.t) ?? p.u ?? 0;
      const sample = samplePolyline(pts, u);
      const localPos = transformPoint(parentWorldInv, sample.point);
      ev.position = vlerp(ev.position, localPos, influence);
      if (p.followRotation) {
        const desiredLocal = quatMultiply(quatConjugate(parentQuat), axisQuat(p.axis ?? "+z", sample.tangent, [0, 1, 0]));
        ev.rotation = eulerFromQuat(quatSlerp(quatFromEuler(ev.rotation), desiredLocal, influence));
      }
      return;
    }
    case "child_of": {
      const tw = targetWorld(ctx, c);
      if (!tw) return;
      const desiredWorld = matMultiply(matFromFlat16(p.inverse), tw);
      const desired = matDecompose(matMultiply(parentWorldInv, desiredWorld));
      if (p.useLoc !== false) ev.position = vlerp(ev.position, desired.position, influence);
      if (p.useRot !== false) ev.rotation = eulerFromQuat(quatSlerp(quatFromEuler(ev.rotation), quatFromEuler(desired.rotation), influence));
      if (p.useScale) ev.scale = vlerp(ev.scale, desired.scale, influence);
      return;
    }
    case "limit_location":
    case "limit_rotation":
    case "limit_scale": {
      const chan = c.type === "limit_location" ? "position" : c.type === "limit_rotation" ? "rotation" : "scale";
      const defs = LIMIT_DEFAULTS[c.type];
      const useMin = p.useMin ?? [true, true, true];
      const useMax = p.useMax ?? [true, true, true];
      const out = [...ev[chan]] as Vec3;
      for (let i = 0; i < 3; i++) {
        const lo = Math.min(p.min?.[i] ?? defs.min[i], p.max?.[i] ?? defs.max[i]);
        const hi = Math.max(p.min?.[i] ?? defs.min[i], p.max?.[i] ?? defs.max[i]);
        let v = out[i];
        if (useMin[i]) v = Math.max(v, lo);
        if (useMax[i]) v = Math.min(v, hi);
        out[i] = lerp(out[i], v, influence);
      }
      ev[chan] = out;
      return;
    }
    case "copy_location":
    case "copy_rotation":
    case "copy_scale": {
      const tw = targetWorld(ctx, c);
      if (!tw) return;
      const chan = c.type === "copy_location" ? "position" : c.type === "copy_rotation" ? "rotation" : "scale";
      const axes = p.axes ?? [true, true, true];
      const invert = p.invert ? -1 : 1;
      const mine = matDecompose(myWorld);
      const theirs = matDecompose(tw);
      if (chan === "rotation") {
        // Euler-component blend in world space, then back to local.
        const blended: Vec3 = [0, 0, 0];
        for (let i = 0; i < 3; i++) {
          const want = axes[i] ? theirs.rotation[i] * invert : mine.rotation[i];
          blended[i] = lerp(mine.rotation[i], want, influence);
        }
        const localQuat = quatMultiply(quatConjugate(parentQuat), quatFromEuler(blended));
        ev.rotation = eulerFromQuat(localQuat);
      } else {
        const worldVals = [...(chan === "position" ? mine.position : mine.scale)] as Vec3;
        for (let i = 0; i < 3; i++) {
          const theirsV = (chan === "position" ? theirs.position : theirs.scale)[i];
          const want = axes[i] ? theirsV * invert : worldVals[i];
          worldVals[i] = lerp(worldVals[i], want, influence);
        }
        if (chan === "position") {
          ev.position = transformPoint(parentWorldInv, worldVals);
        } else {
          // Scale blends in local space directly (world scale == local scale
          // for uniform parent scales; good enough for blockout references).
          ev.scale = worldVals;
        }
      }
      return;
    }
    case "transformation": {
      const tv = targetLocalChannel(ctx, c, p.from ?? "position.x");
      if (tv === null) return;
      const to = p.to ?? "position.y";
      const [comp, axisStr] = to.split(".") as ["position" | "rotation" | "scale", string];
      const axis = axisStr === "x" ? 0 : axisStr === "y" ? 1 : 2;
      const want = (p.offset ?? 0) + (p.factor ?? 1) * tv;
      const out = [...ev[comp]] as Vec3;
      out[axis] = lerp(out[axis], want, influence);
      ev[comp] = out;
      return;
    }
  }
}

/** LOCAL channel value of the constraint target (post keys/hooks, and post
 *  constraints when the target was visited earlier in topo order). */
function targetLocalChannel(ctx: SolveCtx, c: ConstraintDesc, address: string): number | null {
  if (!c.targetId) return null;
  const target = ctx.state.objects.get(c.targetId);
  if (!target) return null;
  const [comp, axisStr] = address.split(".") as ["position" | "rotation" | "scale", string];
  const axis = axisStr === "x" ? 0 : axisStr === "y" ? 1 : 2;
  return target[comp][axis];
}

/** Compose the parent hierarchy and apply every object's constraint stack.
 *  Single pass in topological (parent-first) order: an object always reads
 *  its parent's FINAL world matrix; constraint targets later in the order
 *  still carry their provisional (pre-constraint) matrices — avoid mutually
 *  constrained pairs (same caveat as Blender's dependency graph, simplified). */
function solveHierarchy(state: EvaluatedState, doc: SceneDocument, t: number): void {
  const byId = new Map(doc.objects.map((o) => [o.id, o] as const));
  // Topological order: emit an object only after its parent chain.
  const order: import("./types").ObjectDesc[] = [];
  const emitted = new Set<string>();
  const emit = (o: import("./types").ObjectDesc, guard: Set<string>) => {
    if (emitted.has(o.id) || guard.has(o.id)) return; // guard: cyclic docs
    guard.add(o.id);
    const parent = o.parentId ? byId.get(o.parentId) : undefined;
    if (parent) emit(parent, guard);
    emitted.add(o.id);
    order.push(o);
  };
  for (const o of doc.objects) emit(o, new Set());

  const worldMats = state.worldMats;
  const constrained = state.constrained;
  const mark = (id: string, chans: Array<"position" | "rotation" | "scale">) => {
    let set = constrained.get(id);
    if (!set) constrained.set(id, (set = new Set()));
    for (const ch of chans) set.add(ch);
  };

  // Provisional pass: world matrices from keys+hooks only, for EVERY object,
  // so a constraint can read a target that appears later in the order.
  for (const obj of order) {
    const ev = state.objects.get(obj.id);
    if (!ev) continue;
    const localMat = matFromTRS(ev.position, ev.rotation, ev.scale);
    const parentWorld = obj.parentId ? worldMats.get(obj.parentId) : undefined;
    worldMats.set(obj.id, parentWorld ? matMultiply(parentWorld, localMat) : localMat);
  }

  // Constraint pass (topo order): each object reads its parent's FINAL matrix
  // and its targets' current (final-or-provisional) matrices.
  for (const obj of order) {
    const ev = state.objects.get(obj.id);
    if (!ev) continue;
    const parentWorld = obj.parentId ? worldMats.get(obj.parentId) : undefined;

    if (obj.constraints?.some((c) => c.enabled !== false)) {
      for (const c of obj.constraints ?? []) {
        if (c.enabled === false) continue;
        applyConstraint(c, ev, parentWorld ?? matIdentity(), worldMats.get(obj.id)!, { state, doc, t, worldMats });
        mark(obj.id, constraintChannels(c));
      }
      // Recompose after the stack so descendants and the stored world matrix
      // reflect the constrained pose.
      const localMat = matFromTRS(ev.position, ev.rotation, ev.scale);
      const world = parentWorld ? matMultiply(parentWorld, localMat) : localMat;
      worldMats.set(obj.id, world);
    }

    const world = worldMats.get(obj.id)!;
    if (parentWorld) {
      const d = matDecompose(world);
      ev.world = { position: d.position, rotation: d.rotation, scale: d.scale };
    } else {
      ev.world = { position: ev.position, rotation: ev.rotation, scale: ev.scale };
    }
  }
}

// --- main entry ----------------------------------------------------------------

export function evaluate(doc: SceneDocument, time: number, errorsOut?: HookError[]): EvaluatedState {
  const t = Math.min(Math.max(time, 0), Math.max(doc.duration, 0));
  const cameraId = activeCameraIdAt(doc, t);
  const state: EvaluatedState = {
    time: t,
    objects: new Map(),
    camera: evalCameraById(doc, cameraId, t),
    cameraId,
    hooked: new Map(),
    constrained: new Map(),
    worldMats: new Map(),
  };
  for (const obj of doc.objects) {
    state.objects.set(obj.id, evalObjectTrack(obj, objectKeysOf(doc, obj.id), t));
  }
  const errors = runHooks(state, doc, t);
  if (errorsOut) errorsOut.push(...errors);
  solveHierarchy(state, doc, t);
  return state;
}

/** Helper for sorting/normalizing key lists. */
export function sortKeys<K extends { t: number }>(keys: K[]): K[] {
  return keys.sort((a, b) => a.t - b.t);
}

export function sortCameraKeys(keys: CameraKey[]): CameraKey[] {
  return sortKeys(keys);
}
