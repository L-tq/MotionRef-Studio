/** Strict validation for SceneDocuments coming from untrusted sources
 *  (agent tool calls, JSON imports). Returns a normalized document or a
 *  human-readable error string. */
import { CONSTRAINT_NEEDS_TARGET, CONSTRAINT_TYPES, createEmptyDocument, isGeometryType, newId, specOf, DEFAULT_CAMERA_ID, clampFarClip, type ActionDesc, type CameraActionDesc, type CameraDesc, type CameraKey, type CollectionDesc, type ConstraintDesc, type ConstraintKey, type ConstraintParams, type KeyVec3, type ObjectActionDesc, type ObjectDesc, type SceneDocument, type TrackAxis, type TransformKey, type Vec3 } from "./types";
import { clampAspect } from "./cameraMath";

/** Marker strings written at the top of exported files so an importer can
 *  tell the two kinds apart and refuse the wrong one with a clear message. */
export const SCENE_FORMAT = "motionref-studio/scene";
export const PROJECT_FORMAT = "motionref-studio/project";

/** Sniff the `format` field of a parsed JSON object so importers can refuse
 *  the wrong file kind with actionable guidance instead of a confusing
 *  structural validation error. */
export function detectBundleFormat(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== "object") return null;
  const fmt = (parsed as Record<string, unknown>).format;
  return typeof fmt === "string" ? fmt : null;
}

const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

function fail(what: string): string {
  return what;
}

function asVec3(v: unknown, what: string): [number, number, number] | string {
  if (!Array.isArray(v) || v.length !== 3 || !v.every((n) => typeof n === "number" && Number.isFinite(n))) {
    return `${what} must be [x, y, z]`;
  }
  return [v[0], v[1], v[2]];
}

/** Key vectors additionally allow `null` per axis (= axis not keyed here). */
function asKeyVec3(v: unknown, what: string): Vec3 | KeyVec3 | string {
  if (!Array.isArray(v) || v.length !== 3) return `${what} must be [x, y, z]`;
  for (const n of v) {
    if (n !== null && (typeof n !== "number" || !Number.isFinite(n))) return `${what} must be [x, y, z]`;
  }
  return [v[0], v[1], v[2]];
}

const INTERPS = ["linear", "step", "smooth"];

/** Camera far clip: optional positive number, clamped to the supported
 *  range; absent = default. Returns the value or an error message. */
function cameraFarClipOf(v: unknown, what: string): number | undefined | string {
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return `${what} must be a number > 0`;
  return clampFarClip(v);
}

// --- constraints -------------------------------------------------------------------

const TRACK_AXES = ["+x", "-x", "+y", "-y", "+z", "-z"];
const CHAN_RE = /^(position|rotation|scale)\.[xyz]$/;
const MAX_CONSTRAINTS_PER_OBJECT = 32;
const MAX_CONSTRAINT_KEYS = 256;
const MAX_PATH_POINTS = 256;

function bool3(v: unknown): [boolean, boolean, boolean] | null {
  if (!Array.isArray(v) || v.length !== 3 || !v.every((x) => typeof x === "boolean")) return null;
  return [!!v[0], !!v[1], !!v[2]];
}

function fin(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Normalize one constraint. Target existence is checked in a later pass
 *  (targets may be declared after the owner in the objects array). */
function cleanConstraint(input: unknown, what: string): ConstraintDesc | string {
  if (!input || typeof input !== "object") return `${what} must be an object`;
  const c = input as Record<string, unknown>;
  const type = String(c.type);
  if (!CONSTRAINT_TYPES.includes(type as ConstraintDesc["type"])) return `${what}.type "${type}" is not a known constraint`;
  const params: ConstraintParams = {};
  const p = (c.params ?? {}) as Record<string, unknown>;
  if (p.axis !== undefined && !TRACK_AXES.includes(String(p.axis))) return `${what}.params.axis must be one of ${TRACK_AXES.join(", ")}`;
  if (p.axis !== undefined) params.axis = p.axis as TrackAxis;
  if (p.points !== undefined) {
    if (!Array.isArray(p.points) || p.points.length < 2) return `${what}.params.points needs at least 2 waypoints`;
    if (p.points.length > MAX_PATH_POINTS) return `${what}.params.points: too many waypoints (max ${MAX_PATH_POINTS})`;
    const pts: Vec3[] = [];
    for (const [i, pt] of (p.points as unknown[]).entries()) {
      const v = asVec3(pt, `${what}.params.points[${i}]`);
      if (typeof v === "string") return v;
      pts.push(v);
    }
    params.points = pts;
  }
  const u = fin(p.u);
  if (p.u !== undefined && u === undefined) return `${what}.params.u must be a number`;
  if (u !== undefined) params.u = u;
  if (p.followRotation !== undefined) params.followRotation = !!p.followRotation;
  if (p.inverse !== undefined) {
    if (Array.isArray(p.inverse) && p.inverse.length === 16 && p.inverse.every((n) => typeof n === "number" && Number.isFinite(n))) {
      params.inverse = p.inverse.map((n) => n as number);
    } // else: malformed → solver falls back to identity
  }
  if (p.useLoc !== undefined) params.useLoc = !!p.useLoc;
  if (p.useRot !== undefined) params.useRot = !!p.useRot;
  if (p.useScale !== undefined) params.useScale = !!p.useScale;
  for (const key of ["min", "max"] as const) {
    if (p[key] !== undefined) {
      const v = asVec3(p[key], `${what}.params.${key}`);
      if (typeof v === "string") return v;
      params[key] = v;
    }
  }
  if (p.useMin !== undefined) {
    const b = bool3(p.useMin);
    if (!b) return `${what}.params.useMin must be [bool, bool, bool]`;
    params.useMin = b;
  }
  if (p.useMax !== undefined) {
    const b = bool3(p.useMax);
    if (!b) return `${what}.params.useMax must be [bool, bool, bool]`;
    params.useMax = b;
  }
  if (p.axes !== undefined) {
    const b = bool3(p.axes);
    if (!b) return `${what}.params.axes must be [bool, bool, bool]`;
    params.axes = b;
  }
  if (p.invert !== undefined) params.invert = !!p.invert;
  for (const key of ["from", "to"] as const) {
    if (p[key] !== undefined) {
      const s = String(p[key]);
      if (!CHAN_RE.test(s)) return `${what}.params.${key} must look like "position.y" / "rotation.x" / "scale.z"`;
      params[key] = s;
    }
  }
  const factor = fin(p.factor);
  if (p.factor !== undefined && factor === undefined) return `${what}.params.factor must be a number`;
  if (factor !== undefined) params.factor = factor;
  const offset = fin(p.offset);
  if (p.offset !== undefined && offset === undefined) return `${what}.params.offset must be a number`;
  if (offset !== undefined) params.offset = offset;

  let influence = 1;
  if (c.influence !== undefined) {
    const v = fin(c.influence);
    if (v === undefined) return `${what}.influence must be a number`;
    influence = Math.min(1, Math.max(0, v));
  }
  let keys: ConstraintKey[] | undefined;
  if (c.keys !== undefined) {
    if (!Array.isArray(c.keys)) return `${what}.keys must be an array`;
    if (c.keys.length > MAX_CONSTRAINT_KEYS) return `${what}.keys: too many keys (max ${MAX_CONSTRAINT_KEYS})`;
    keys = [];
    for (const [i, k] of (c.keys as unknown[]).entries()) {
      if (!k || typeof k !== "object") return `${what}.keys[${i}] must be an object`;
      const kk = k as Record<string, unknown>;
      const t = fin(kk.t);
      if (t === undefined || t < 0) return `${what}.keys[${i}].t must be a number >= 0`;
      const entry: ConstraintKey = { t, interp: INTERPS.includes(String(kk.interp)) ? (kk.interp as "linear") : "linear" };
      if (kk.influence !== undefined) {
        const v = fin(kk.influence);
        if (v === undefined) return `${what}.keys[${i}].influence must be a number`;
        entry.influence = Math.min(1, Math.max(0, v));
      }
      if (kk.u !== undefined) {
        const v = fin(kk.u);
        if (v === undefined) return `${what}.keys[${i}].u must be a number`;
        entry.u = v;
      }
      keys.push(entry);
    }
    keys.sort((a, b) => a.t - b.t);
  }
  return {
    id: typeof c.id === "string" && c.id ? c.id.slice(0, 64) : newId("cst"),
    type: type as ConstraintDesc["type"],
    name: typeof c.name === "string" && c.name.trim() ? c.name.slice(0, 80) : undefined,
    enabled: c.enabled === undefined ? true : !!c.enabled,
    influence,
    targetId: typeof c.targetId === "string" && c.targetId ? c.targetId : undefined,
    params,
    keys,
  };
}

/** Normalize one object keyframe; returns the key or an error string. */
function cleanObjectKey(k: Record<string, unknown>, what: string): TransformKey | string {
  if (typeof k.t !== "number" || !Number.isFinite(k.t) || k.t < 0) {
    return `${what}.t must be a number >= 0`;
  }
  const entry: Record<string, unknown> = { t: k.t, interp: INTERPS.includes(String(k.interp)) ? k.interp : "linear" };
  for (const prop of ["position", "rotation", "scale"] as const) {
    if (k[prop] !== undefined) {
      const v = asKeyVec3(k[prop], `${what}.${prop}`);
      if (typeof v === "string") return v;
      entry[prop] = v;
    }
  }
  if (typeof k.color === "string" && HEX_RE.test(k.color)) entry.color = k.color;
  if (typeof k.visible === "boolean") entry.visible = k.visible;
  return entry as unknown as TransformKey;
}

/** Normalize one camera keyframe, pinned to its owning camera; key or error. */
function cleanCameraKey(k: Record<string, unknown>, cameraId: string, what: string): CameraKey | string {
  if (typeof k.t !== "number" || !Number.isFinite(k.t) || k.t < 0) {
    return `${what}.t must be a number >= 0`;
  }
  let position: Vec3 | KeyVec3 | undefined;
  if (k.position !== undefined) {
    const p = asKeyVec3(k.position, `${what}.position`);
    if (typeof p === "string") return p;
    position = p;
  }
  let target: Vec3 | KeyVec3 | undefined;
  if (k.target !== undefined) {
    const tg = asKeyVec3(k.target, `${what}.target`);
    if (typeof tg === "string") return tg;
    target = tg;
  }
  let fov: number | undefined;
  if (k.fov !== undefined) {
    if (typeof k.fov !== "number" || k.fov <= 0 || k.fov >= 180) return `${what}.fov must be in (0, 180)`;
    fov = k.fov;
  }
  return { t: k.t, cameraId, position, target, fov, interp: INTERPS.includes(String(k.interp)) ? (k.interp as "linear") : "linear" };
}

export function validateSceneDocument(input: unknown): { doc: SceneDocument } | { error: string } {
  if (!input || typeof input !== "object") return { error: fail("document must be an object") };
  const raw = input as Record<string, unknown>;
  const doc = createEmptyDocument(typeof raw.name === "string" ? raw.name.slice(0, 120) : "Untitled");

  if (typeof raw.background === "string" && HEX_RE.test(raw.background)) doc.background = raw.background;
  if (typeof raw.duration === "number" && Number.isFinite(raw.duration)) doc.duration = Math.min(Math.max(raw.duration, 0.1), 300);
  if (typeof raw.fps === "number" && Number.isFinite(raw.fps)) doc.fps = Math.min(Math.max(Math.round(raw.fps), 1), 120);
  if (typeof raw.aspect === "number" && Number.isFinite(raw.aspect)) doc.aspect = +clampAspect(raw.aspect).toFixed(4);
  // 3D cursor (pivot for the "cursor" rotation mode); missing → scene origin.
  if (raw.cursor !== undefined) {
    const c = asVec3(raw.cursor, "cursor");
    if (typeof c === "string") return { error: c };
    doc.cursor = c;
  }

  // Cameras (Blender-style multi-camera). Legacy documents only carry the
  // single `camera` base pose — synthesize one CameraDesc from it so old
  // saves/imports keep working, with their id = DEFAULT_CAMERA_ID.
  const cameras: CameraDesc[] = [];
  if (raw.cameras !== undefined) {
    if (!Array.isArray(raw.cameras)) return { error: "cameras must be an array" };
    if (raw.cameras.length > 64) return { error: "too many cameras (max 64)" };
    const seenCam = new Set<string>();
    for (const [i, c] of raw.cameras.entries()) {
      if (!c || typeof c !== "object") return { error: `cameras[${i}] must be an object` };
      const cam = c as Record<string, unknown>;
      const p = asVec3(cam.position ?? [8, 6, 10], `cameras[${i}].position`);
      if (typeof p === "string") return { error: p };
      const tg = asVec3(cam.target ?? [0, 1, 0], `cameras[${i}].target`);
      if (typeof tg === "string") return { error: tg };
      let fov = 45;
      if (cam.fov !== undefined) {
        if (typeof cam.fov !== "number" || cam.fov <= 0 || cam.fov >= 180) return { error: `cameras[${i}].fov must be in (0, 180)` };
        fov = cam.fov;
      }
      let id = typeof cam.id === "string" && cam.id ? cam.id.slice(0, 64) : "";
      if (!id || seenCam.has(id)) id = `cam${i}_${Math.random().toString(36).slice(2, 8)}`;
      seenCam.add(id);
      const farClip = cameraFarClipOf(cam.farClip, `cameras[${i}].farClip`);
      if (typeof farClip === "string") return { error: farClip };
      cameras.push({
        id,
        name: typeof cam.name === "string" && cam.name.trim() ? cam.name.slice(0, 80) : `Camera ${i + 1}`,
        position: p,
        target: tg,
        fov,
        farClip,
      });
    }
  }
  if (cameras.length === 0) {
    const legacy = raw.camera && typeof raw.camera === "object" ? (raw.camera as Record<string, unknown>) : {};
    const p = asVec3(legacy.position ?? [8, 6, 10], "camera.position");
    if (typeof p === "string") return { error: p };
    const tg = asVec3(legacy.target ?? [0, 1, 0], "camera.target");
    if (typeof tg === "string") return { error: tg };
    let fov = 45;
    if (legacy.fov !== undefined) {
      if (typeof legacy.fov !== "number" || legacy.fov <= 0 || legacy.fov >= 180) return { error: "camera.fov must be in (0, 180)" };
      fov = legacy.fov;
    }
    const legacyFarClip = cameraFarClipOf(legacy.farClip, "camera.farClip");
    if (typeof legacyFarClip === "string") return { error: legacyFarClip };
    cameras.push({ id: DEFAULT_CAMERA_ID, name: "Camera", position: p, target: tg, fov, farClip: legacyFarClip });
  }
  doc.cameras = cameras;
  doc.activeCameraId =
    typeof raw.activeCameraId === "string" && cameras.some((c) => c.id === raw.activeCameraId)
      ? raw.activeCameraId
      : cameras[0].id;
  const cameraIds = new Set(cameras.map((c) => c.id));

  // Timeline markers bound to cameras (Blender-style camera cuts). Markers
  // whose camera is gone are dropped silently, like orphan actions.
  if (raw.markers !== undefined) {
    if (!Array.isArray(raw.markers)) return { error: "markers must be an array" };
    if (raw.markers.length > 128) return { error: "too many markers (max 128)" };
    const seenMk = new Set<string>();
    for (const [i, m] of raw.markers.entries()) {
      if (!m || typeof m !== "object") return { error: `markers[${i}] must be an object` };
      const mk = m as Record<string, unknown>;
      if (typeof mk.t !== "number" || !Number.isFinite(mk.t) || mk.t < 0) {
        return { error: `markers[${i}].t must be a number >= 0` };
      }
      const cameraId = typeof mk.cameraId === "string" && cameraIds.has(mk.cameraId) ? mk.cameraId : "";
      if (!cameraId) continue;
      let id = typeof mk.id === "string" && mk.id ? mk.id.slice(0, 64) : "";
      if (!id || seenMk.has(id)) id = `mk${i}_${Math.random().toString(36).slice(2, 8)}`;
      seenMk.add(id);
      doc.markers.push({
        id,
        name: typeof mk.name === "string" && mk.name.trim() ? mk.name.slice(0, 80) : `Marker ${i + 1}`,
        t: mk.t,
        cameraId,
      });
    }
    doc.markers.sort((a, b) => a.t - b.t);
  }

  // Collections (Blender-style Outliner grouping; flat, single-level). Parsed
  // before objects so object membership can be checked against real ids.
  const collections: CollectionDesc[] = [];
  if (raw.collections !== undefined) {
    if (!Array.isArray(raw.collections)) return { error: "collections must be an array" };
    if (raw.collections.length > 256) return { error: "too many collections (max 256)" };
    const seenCol = new Set<string>();
    for (const [i, c] of raw.collections.entries()) {
      if (!c || typeof c !== "object") return { error: `collections[${i}] must be an object` };
      const col = c as Record<string, unknown>;
      let id = typeof col.id === "string" && col.id ? col.id.slice(0, 64) : "";
      if (!id || seenCol.has(id)) id = `col${i}_${Math.random().toString(36).slice(2, 8)}`;
      seenCol.add(id);
      collections.push({
        id,
        name: typeof col.name === "string" && col.name.trim() ? col.name.slice(0, 80) : `Collection ${i + 1}`,
        hidden: col.hidden === true ? true : undefined,
      });
    }
  }
  doc.collections = collections;
  const collectionIds = new Set(collections.map((c) => c.id));

  // Objects
    if (raw.objects !== undefined) {
    if (!Array.isArray(raw.objects)) return { error: "objects must be an array" };
    if (raw.objects.length > 2000) return { error: "too many objects (max 2000)" };
    const seen = new Set<string>();
    const seenConstraintIds = new Set<string>();
    for (const [i, o] of raw.objects.entries()) {
      if (!o || typeof o !== "object") return { error: `objects[${i}] must be an object` };
      const obj = o as Record<string, unknown>;
      if (!isGeometryType(obj.type)) return { error: `objects[${i}].type "${String(obj.type)}" is not a basic geometry` };
      let id = typeof obj.id === "string" ? obj.id : "";
      if (!id || seen.has(id)) id = `v${i}_${Math.random().toString(36).slice(2, 8)}`;
      seen.add(id);
      const position = asVec3(obj.position ?? [0, 0, 0], `objects[${i}].position`);
      if (typeof position === "string") return { error: position };
      const rotation = asVec3(obj.rotation ?? [0, 0, 0], `objects[${i}].rotation`);
      if (typeof rotation === "string") return { error: rotation };
      const scale = asVec3(obj.scale ?? [1, 1, 1], `objects[${i}].scale`);
      if (typeof scale === "string") return { error: scale };
      const params: Record<string, number> = { ...specOf(obj.type).defaults };
      if (obj.params && typeof obj.params === "object") {
        for (const [k, v] of Object.entries(obj.params as Record<string, unknown>)) {
          if (typeof v === "number" && Number.isFinite(v)) params[k] = v;
        }
      }
      const color = typeof obj.color === "string" && HEX_RE.test(obj.color) ? obj.color : "#7c5cff";
      const od: ObjectDesc = {
        id,
        name: typeof obj.name === "string" && obj.name.trim() ? obj.name.slice(0, 80) : `${obj.type} ${i + 1}`,
        type: obj.type,
        params,
        position,
        rotation,
        scale,
        color,
        visible: obj.visible === undefined ? true : !!obj.visible,
      };
      // Membership is kept only when the target collection exists.
      if (typeof obj.collectionId === "string" && collectionIds.has(obj.collectionId)) {
        od.collectionId = obj.collectionId;
      }
      if (typeof obj.parentId === "string" && obj.parentId) od.parentId = obj.parentId.slice(0, 64);
      if (typeof obj.instanceOf === "string" && obj.instanceOf) od.instanceOf = obj.instanceOf.slice(0, 64);
      if (obj.constraints !== undefined) {
        if (!Array.isArray(obj.constraints)) return { error: `objects[${i}].constraints must be an array` };
        if (obj.constraints.length > MAX_CONSTRAINTS_PER_OBJECT) {
          return { error: `objects[${i}].constraints: too many (max ${MAX_CONSTRAINTS_PER_OBJECT})` };
        }
        const constraints: ConstraintDesc[] = [];
        for (const [j, c] of obj.constraints.entries()) {
          const cleaned = cleanConstraint(c, `objects[${i}].constraints[${j}]`);
          if (typeof cleaned === "string") return { error: cleaned };
          // Constraint ids must stay unique (like every other entity): a
          // duplicate would make update/remove address only the first match.
          if (seenConstraintIds.has(cleaned.id)) cleaned.id = newId("cst");
          seenConstraintIds.add(cleaned.id);
          constraints.push(cleaned);
        }
        if (constraints.length) od.constraints = constraints;
      }
      doc.objects.push(od);
    }
  }

  // Hierarchy / instance / constraint resolution (targets may be declared
  // after their referrer, so this runs once every object id is known):
  //  - a type:"instance" object survives only with a valid, non-recursive
  //    collection target; invalid ones are dropped whole (actions owned by
  //    them and references to them cascade below);
  //  - parentId must reference another object through an acyclic chain of
  //    depth <= 64, else the object is re-rooted;
  //  - constraints whose target object is gone are dropped silently, like
  //    orphan actions.
  // Decided against the ORIGINAL object list so the outcome never depends on
  // doc order (the splice loop below must not see its own partial results).
  const colsWithInstanceMember = new Set(
    doc.objects.filter((m) => m.type === "instance" && m.collectionId).map((m) => m.collectionId as string),
  );
  const instanceTargetsValid = (inst: ObjectDesc): boolean =>
    !!inst.instanceOf &&
    collectionIds.has(inst.instanceOf) &&
    !colsWithInstanceMember.has(inst.instanceOf);
  for (let i = doc.objects.length - 1; i >= 0; i--) {
    if (doc.objects[i].type === "instance" && !instanceTargetsValid(doc.objects[i])) doc.objects.splice(i, 1);
  }
  const objectIds = new Set(doc.objects.map((o) => o.id));
  for (const o of doc.objects) {
    if (o.parentId) {
      if (!objectIds.has(o.parentId) || o.parentId === o.id) {
        delete o.parentId;
      } else {
        // Walk the chain: a cycle or an over-deep chain re-roots the object.
        const byId = new Map(doc.objects.map((x) => [x.id, x] as const));
        let cur = byId.get(o.parentId);
        let depth = 1;
        let cyclic = false;
        const seen = new Set<string>([o.id]);
        while (cur?.parentId) {
          if (seen.has(cur.id)) {
            cyclic = true;
            break;
          }
          seen.add(cur.id);
          depth += 1;
          if (depth > 64) {
            cyclic = true;
            break;
          }
          cur = byId.get(cur.parentId);
        }
        if (cyclic) delete o.parentId;
      }
    }
    if (o.constraints?.length) {
      o.constraints = o.constraints.filter((c) => !(CONSTRAINT_NEEDS_TARGET.includes(c.type) && (!c.targetId || !objectIds.has(c.targetId))));
      if (!o.constraints.length) delete o.constraints;
    }
  }

  // Actions (Blender-style): named keyframe groups, each owned by exactly one
  // object or camera; an owner's ACTIVE action is what evaluates. Legacy
  // documents instead carry per-object `tracks` and a flat `cameraKeys` list —
  // each non-empty owner becomes one default action so old saves/imports
  // keep working.
  const actions: ActionDesc[] = [];
  if (raw.actions !== undefined) {
    if (!Array.isArray(raw.actions)) return { error: "actions must be an array" };
    if (raw.actions.length > 256) return { error: "too many actions (max 256)" };
    const seenAct = new Set<string>();
    for (const [i, a] of raw.actions.entries()) {
      if (!a || typeof a !== "object") return { error: `actions[${i}] must be an object` };
      const act = a as Record<string, unknown>;
      let id = typeof act.id === "string" && act.id ? act.id.slice(0, 64) : "";
      if (!id || seenAct.has(id)) id = `act${i}_${Math.random().toString(36).slice(2, 8)}`;
      const name = typeof act.name === "string" && act.name.trim() ? act.name.slice(0, 80) : "Action";
      if (!Array.isArray(act.keys)) return { error: `actions[${i}].keys must be an array` };
      if (act.kind === "camera") {
        const cameraId = typeof act.cameraId === "string" && cameraIds.has(act.cameraId) ? act.cameraId : "";
        if (!cameraId) continue; // owner gone — drop silently, like orphan tracks
        const keys: CameraKey[] = [];
        for (const [j, k] of act.keys.entries()) {
          if (!k || typeof k !== "object") return { error: `actions[${i}].keys[${j}] must be an object` };
          // Keys inside a camera action always belong to that camera.
          const key = cleanCameraKey(k as Record<string, unknown>, cameraId, `actions[${i}].keys[${j}]`);
          if (typeof key === "string") return { error: key };
          keys.push(key);
        }
        keys.sort((x, y) => x.t - y.t);
        seenAct.add(id);
        actions.push({ id, name, kind: "camera", cameraId, keys });
      } else {
        const objectId = typeof act.objectId === "string" && objectIds.has(act.objectId) ? act.objectId : "";
        if (!objectId) continue; // owner gone — drop silently
        const keys: TransformKey[] = [];
        for (const [j, k] of act.keys.entries()) {
          if (!k || typeof k !== "object") return { error: `actions[${i}].keys[${j}] must be an object` };
          const key = cleanObjectKey(k as Record<string, unknown>, `actions[${i}].keys[${j}]`);
          if (typeof key === "string") return { error: key };
          keys.push(key);
        }
        keys.sort((x, y) => x.t - y.t);
        seenAct.add(id);
        actions.push({ id, name, kind: "object", objectId, keys });
      }
    }
  } else {
    // Legacy migration: per-object `tracks` + flat `cameraKeys` → one default
    // action per owner that has keyframes ("Action"), set as its active action.
    if (raw.tracks && typeof raw.tracks === "object") {
      for (const [objectId, keys] of Object.entries(raw.tracks as Record<string, unknown>)) {
        if (!objectIds.has(objectId) || !Array.isArray(keys)) continue;
        const clean: TransformKey[] = [];
        for (const [i, k] of keys.entries()) {
          if (!k || typeof k !== "object") return { error: `tracks.${objectId}[${i}] must be an object` };
          const key = cleanObjectKey(k as Record<string, unknown>, `tracks.${objectId}[${i}]`);
          if (typeof key === "string") return { error: key };
          clean.push(key);
        }
        if (!clean.length) continue;
        clean.sort((x, y) => x.t - y.t);
        const action: ObjectActionDesc = { id: newId("act"), name: "Action", kind: "object", objectId, keys: clean };
        actions.push(action);
        const owner = doc.objects.find((o) => o.id === objectId);
        if (owner) owner.activeActionId = action.id;
      }
    }
    if (Array.isArray(raw.cameraKeys)) {
      const byCam = new Map<string, CameraKey[]>();
      for (const [i, k] of raw.cameraKeys.entries()) {
        if (!k || typeof k !== "object") return { error: `cameraKeys[${i}] must be an object` };
        const key = k as Record<string, unknown>;
        // Every key names its camera; legacy keys (no cameraId) attach to the
        // default camera, matching the legacy camera migration above.
        const cameraId = typeof key.cameraId === "string" && cameraIds.has(key.cameraId) ? key.cameraId : cameras[0].id;
        const clean = cleanCameraKey(key, cameraId, `cameraKeys[${i}]`);
        if (typeof clean === "string") return { error: clean };
        if (!byCam.has(cameraId)) byCam.set(cameraId, []);
        byCam.get(cameraId)!.push(clean);
      }
      for (const [cameraId, keys] of byCam) {
        keys.sort((x, y) => x.t - y.t);
        const action: CameraActionDesc = { id: newId("act"), name: "Action", kind: "camera", cameraId, keys };
        actions.push(action);
        const cam = doc.cameras.find((c) => c.id === cameraId);
        if (cam) cam.activeActionId = action.id;
      }
    }
  }
  doc.actions = actions;

  // Coerce each owner's activeActionId to one of its own actions (unknown ids
  // fall back to the owner's first action; owners without actions are clean).
  for (const o of doc.objects) {
    const owned = actions.filter((a): a is ObjectActionDesc => a.kind === "object" && a.objectId === o.id);
    if (!owned.length) delete o.activeActionId;
    else if (!o.activeActionId || !owned.some((a) => a.id === o.activeActionId)) o.activeActionId = owned[0].id;
  }
  for (const c of doc.cameras) {
    const owned = actions.filter((a): a is CameraActionDesc => a.kind === "camera" && a.cameraId === c.id);
    if (!owned.length) delete c.activeActionId;
    else if (!c.activeActionId || !owned.some((a) => a.id === c.activeActionId)) c.activeActionId = owned[0].id;
  }

  // onFrame hooks
  if (raw.onFrameScripts !== undefined) {
    if (!Array.isArray(raw.onFrameScripts)) return { error: "onFrameScripts must be an array" };
    for (const src of raw.onFrameScripts.slice(0, 16)) {
      if (typeof src === "string" && src.length < 8000) doc.onFrameScripts.push(src);
    }
  }

  return { doc };
}
