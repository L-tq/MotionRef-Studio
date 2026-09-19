/** Core data model — plain JSON, no Three.js dependency. */

export type Vec3 = [number, number, number];

/** Vector as stored on a keyframe: `null` = this axis is not keyed here (the
 *  graph editor splits shared keys per axis). Evaluated poses are always full
 *  Vec3s — unkeyed axes fall back to the base pose during evaluation. */
export type KeyVec3 = [number | null, number | null, number | null];

export type GeometryType =
  | "box"
  | "sphere"
  | "cylinder"
  | "cone"
  | "torus"
  | "plane"
  | "capsule"
  | "ring"
  | "tetrahedron"
  | "octahedron"
  | "dodecahedron"
  | "icosahedron"
  | "torusKnot"
  /** Non-rendering transform anchor (Blender empty): drives children and
   *  constraints; shows as an editor/snapshot axis cross, never in exports. */
  | "empty"
  /** A placed copy of a whole collection (`instanceOf`); keyframe/parent it
   *  like any object — the members' own animation replays inside every copy. */
  | "instance";

export type Interp = "linear" | "step" | "smooth";

export interface ObjectDesc {
  id: string;
  name: string;
  type: GeometryType;
  /** Per-geometry size parameters, see geometryCatalog. */
  params: Record<string, number>;
  /** LOCAL position relative to the parent (== world for root objects):
   *  world = parent.world × local TRS. */
  position: Vec3;
  /** LOCAL Euler XYZ, radians. */
  rotation: Vec3;
  scale: Vec3;
  /** Hex color, e.g. "#ff8800". */
  color: string;
  visible: boolean;
  /** Parent object (Blender-style parenting). Absent/null = scene root. The
   *  parent chain must be acyclic (the validator enforces it). */
  parentId?: string;
  /** Collection instanced by a type:"instance" object (doc.collections id). */
  instanceOf?: string;
  /** Constraint stack, applied top to bottom every evaluated frame AFTER
   *  keyframes/hooks; written channels override keyframes (like hook-owned
   *  channels) and cannot be hand-edited or auto-keyed. */
  constraints?: ConstraintDesc[];
  /** Which of this object's actions is ACTIVE (evaluated/edited). */
  activeActionId?: string;
  /** Collection this object lives in (Outliner grouping); absent = scene root. */
  collectionId?: string;
}

// --- constraints (Blender-style motion bridges) ---------------------------------

export type ConstraintType =
  | "track_to"
  | "follow_path"
  | "child_of"
  | "limit_location"
  | "limit_rotation"
  | "limit_scale"
  | "copy_location"
  | "copy_rotation"
  | "copy_scale"
  | "transformation";

/** The constraint whitelist (single source for validator + scripting). */
export const CONSTRAINT_TYPES: readonly ConstraintType[] = [
  "track_to",
  "follow_path",
  "child_of",
  "limit_location",
  "limit_rotation",
  "limit_scale",
  "copy_location",
  "copy_rotation",
  "copy_scale",
  "transformation",
];

/** Constraint types that need a target object (the rest are self-contained). */
export const CONSTRAINT_NEEDS_TARGET: readonly ConstraintType[] = [
  "track_to",
  "child_of",
  "copy_location",
  "copy_rotation",
  "copy_scale",
  "transformation",
];

/** Aim axis for track_to. */
export type TrackAxis = "+x" | "-x" | "+y" | "-y" | "+z" | "-z";

/** Transform channel address used by the transformation constraint, e.g.
 *  "position.y", "rotation.x", "scale.z" (LOCAL channels of the target). */
export type ChanAddress = string;

export interface ConstraintParams {
  /** track_to: local axis aimed at the target (default "+z"). */
  axis?: TrackAxis;
  /** follow_path: world-space waypoints (>= 2), sampled as a Catmull-Rom
   *  spline parameterized by arc length. */
  points?: Vec3[];
  /** follow_path: position along the path, 0..1 (keyframable via keys.u). */
  u?: number;
  /** follow_path: also orient the aim axis along the path tangent. */
  followRotation?: boolean;
  /** child_of: offset matrix baked at add/"set inverse" time
   *  (column-major 16 numbers; desired world = inverse × target world). */
  inverse?: number[];
  /** child_of: which channels follow the target (defaults loc+rot, no scale). */
  useLoc?: boolean;
  useRot?: boolean;
  useScale?: boolean;
  /** limit_*: inclusive per-axis bounds in LOCAL space (default -1..1). */
  min?: Vec3;
  max?: Vec3;
  /** limit_*: whether each axis's min/max bound is enforced. */
  useMin?: [boolean, boolean, boolean];
  useMax?: [boolean, boolean, boolean];
  /** copy_*: which axes copy (default all). */
  axes?: [boolean, boolean, boolean];
  /** copy_*: negate the copied value per axis. */
  invert?: boolean;
  /** transformation: source channel on the target, e.g. "rotation.x". */
  from?: ChanAddress;
  /** transformation: destination channel on the owner, e.g. "position.y". */
  to?: ChanAddress;
  /** transformation: destination = offset + factor × source (default 1 / 0). */
  factor?: number;
  offset?: number;
}

/** Per-constraint mini keyframe track: `influence` animates every constraint
 *  (e.g. child_of attach/detach), `u` animates follow_path traversal. */
export interface ConstraintKey {
  t: number;
  influence?: number;
  u?: number;
  interp?: Interp;
}

export interface ConstraintDesc {
  id: string;
  type: ConstraintType;
  name?: string;
  /** Disabled constraints are skipped (default true). */
  enabled?: boolean;
  /** Static influence 0..1 (default 1); overridden by keyed influence. */
  influence?: number;
  /** Target object (empty-friendly) — required by track_to / child_of /
   *  copy_* / transformation. */
  targetId?: string;
  params: ConstraintParams;
  keys?: ConstraintKey[];
}

/** Transform channels a constraint writes on its owner (used to mark channels
 *  un-editable, mirroring the onFrame-hook channel ownership). */
export function constraintChannels(c: ConstraintDesc): Array<"position" | "rotation" | "scale"> {
  const p = c.params;
  switch (c.type) {
    case "track_to":
      return ["rotation"];
    case "follow_path":
      return p.followRotation ? ["position", "rotation"] : ["position"];
    case "child_of": {
      const out: Array<"position" | "rotation" | "scale"> = [];
      if (p.useLoc !== false) out.push("position");
      if (p.useRot !== false) out.push("rotation");
      if (p.useScale) out.push("scale");
      return out;
    }
    case "limit_location":
      return ["position"];
    case "limit_rotation":
      return ["rotation"];
    case "limit_scale":
      return ["scale"];
    case "copy_location":
      return ["position"];
    case "copy_rotation":
      return ["rotation"];
    case "copy_scale":
      return ["scale"];
    case "transformation":
      return [(p.to?.split(".")[0] ?? "position") as "position" | "rotation" | "scale"];
  }
}

/** Objects whose parentId is `id`, in document order. */
export function childrenOf(doc: SceneDocument, id: string): ObjectDesc[] {
  return doc.objects.filter((o) => o.parentId === id);
}

/** True when `ancestorId` is `childId` itself or appears anywhere in its
 *  parent chain (used to reject cyclic parenting). */
export function isDescendantOf(doc: SceneDocument, childId: string, ancestorId: string): boolean {
  if (childId === ancestorId) return true;
  const byId = new Map(doc.objects.map((o) => [o.id, o] as const));
  let cur = byId.get(childId);
  const seen = new Set<string>();
  while (cur?.parentId) {
    if (seen.has(cur.id)) return false; // defensive: cyclic doc
    seen.add(cur.id);
    if (cur.parentId === ancestorId) return true;
    cur = byId.get(cur.parentId);
  }
  return false;
}

/** A keyframe for one object. Only the properties present are keyed; within a
 *  vector, only the axes present (non-null) are keyed. */
export interface TransformKey {
  /** Seconds from clip start. */
  t: number;
  position?: KeyVec3;
  rotation?: KeyVec3;
  scale?: KeyVec3;
  color?: string;
  visible?: boolean;
  interp?: Interp;
}

export interface CameraKey {
  t: number;
  /** Which scene camera (doc.cameras id) this key belongs to. */
  cameraId: string;
  /** Components are optional: the graph editor splits shared keys when one
   *  channel is retimed or deleted alone. Missing components fall back to the
   *  base camera during evaluation. */
  position?: KeyVec3;
  /** lookAt target. */
  target?: KeyVec3;
  /** Vertical field of view in degrees. */
  fov?: number;
  interp?: Interp;
}

export interface CameraState {
  position: Vec3;
  target: Vec3;
  fov: number;
  /** Far clip plane distance (not keyframable; carried from the base camera). */
  farClip: number;
}

/** A named keyframe group owned by ONE object (Blender-style action). */
export interface ObjectActionDesc {
  id: string;
  name: string;
  kind: "object";
  objectId: string;
  /** This action's keyframes, sorted by t. */
  keys: TransformKey[];
}

/** A named keyframe group owned by ONE scene camera. */
export interface CameraActionDesc {
  id: string;
  name: string;
  kind: "camera";
  cameraId: string;
  /** This action's keyframes, sorted by t. */
  keys: CameraKey[];
}

export type ActionDesc = ObjectActionDesc | CameraActionDesc;

/** Owner handle shared by the action helpers: `{ objectId }` or `{ cameraId }`. */
export type ActionOwner = { objectId: string } | { cameraId: string };

/** A named scene camera (Blender-style multi-camera support). */
export interface CameraDesc {
  id: string;
  name: string;
  position: Vec3;
  /** lookAt target. */
  target: Vec3;
  /** Vertical field of view in degrees. */
  fov: number;
  /** Far clip plane distance; geometry beyond it is not rendered. */
  farClip?: number;
  /** Which of this camera's actions is ACTIVE (evaluated/edited). */
  activeActionId?: string;
}

/** A named collection grouping objects in the Outliner (Blender-style).
 *  Single-level: objects belong to at most one collection; objects without
 *  one sit directly under the implicit "Scene Collection" root. */
export interface CollectionDesc {
  id: string;
  name: string;
  /** View-layer exclusion (Blender): a hidden collection renders none of its
   *  objects directly, but collection INSTANCES still render them — that is
   *  how a master assembly is kept out of the picture while its copies show. */
  hidden?: boolean;
}

/** A timeline marker bound to a scene camera (Blender-style camera cut):
 *  from its time on, that camera renders until the next marker. */
export interface MarkerDesc {
  id: string;
  name: string;
  /** Seconds from clip start. */
  t: number;
  /** Camera (doc.cameras id) that renders from this time onward. */
  cameraId: string;
}

export interface SceneDocument {
  version: 1;
  name: string;
  /** Scene background hex color. */
  background: string;
  /** Clip length in seconds. */
  duration: number;
  /** Export frame rate. */
  fps: number;
  /** Camera framing aspect ratio (width / height, e.g. 16/9). Used by the
   *  scene-camera preview letterbox and aspect-aware snapshots. */
  aspect: number;
  objects: ObjectDesc[];
  /** Outliner collections; members reference them via ObjectDesc.collectionId. */
  collections: CollectionDesc[];
  /** Timeline markers bound to cameras; kept sorted by t. The latest marker
   *  at/before the current time decides which camera renders (camera cut). */
  markers: MarkerDesc[];
  /** Scene cameras; the first entry is the legacy default camera. Previews,
   *  snapshots and video export always render the ACTIVE camera. */
  cameras: CameraDesc[];
  /** id of the camera used for preview/snapshot/export (Blender "active camera"). */
  activeCameraId: string;
  /** Named keyframe actions (Blender-style). Each action belongs to exactly one
   *  owner — an object or a camera — and only an owner's ACTIVE action
   *  evaluates; owners without an action use their base pose. */
  actions: ActionDesc[];
  /** Serialized onFrame hook sources, run in order every evaluated frame. */
  onFrameScripts: string[];
  /** Red-and-white 3D cursor (Blender-style): pivot for "cursor" rotation
   *  mode, placed with Shift + Right-click in the viewport. */
  cursor: Vec3;
}

/** Transform pivot point for multi-object rotation (Blender's pivot modes). */
export type PivotMode = "individual" | "median" | "bbox" | "cursor";

let idCounter = 0;
export function newId(prefix = "o"): string {
  idCounter += 1;
  return `${prefix}${Date.now().toString(36)}${idCounter.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

export function defaultParams(type: GeometryType): Record<string, number> {
  // Filled from the geometry catalog at import time to avoid a cycle; see geometryCatalog.
  return { ...GEOMETRY_DEFAULTS[type] };
}

export function defaultCamera(): CameraState {
  return { position: [8, 6, 10], target: [0, 1, 0], fov: 45, farClip: DEFAULT_FAR_CLIP };
}

/** Stable id of the legacy default camera — old documents' camera keys
 *  (which predate `cameraId`) migrate to it. */
export const DEFAULT_CAMERA_ID = "camera";

export function defaultCameraDesc(): CameraDesc {
  return { id: DEFAULT_CAMERA_ID, name: "Camera", ...defaultCamera() };
}

export function createEmptyDocument(name = "Untitled"): SceneDocument {
  return {
    version: 1,
    name,
    background: "#191922",
    duration: 6,
    fps: 30,
    aspect: 16 / 9,
    objects: [],
    collections: [],
    markers: [],
    cameras: [defaultCameraDesc()],
    activeCameraId: DEFAULT_CAMERA_ID,
    actions: [],
    onFrameScripts: [],
    cursor: [0, 0, 0],
  };
}

/** The camera a render/preview currently shows (falls back to the first). */
export function activeCameraOf(doc: SceneDocument): CameraDesc {
  return doc.cameras.find((c) => c.id === doc.activeCameraId) ?? doc.cameras[0];
}

/** Which camera renders at time t: the latest camera-bound marker at/before
 *  t wins (hard cut at its time); before the first marker (or with no
 *  markers) the manual active camera renders. Tolerant of pre-marker docs
 *  whose `markers` field is missing. */
export function activeCameraIdAt(doc: SceneDocument, t: number): string {
  let id = doc.activeCameraId;
  for (const m of doc.markers ?? []) {
    if (m.t <= t + 1e-9) id = m.cameraId;
    else break;
  }
  return doc.cameras.some((c) => c.id === id) ? id : doc.cameras[0]?.id ?? id;
}

/** Next free default marker name: "Marker", "Marker 2", … */
export function defaultMarkerName(doc: SceneDocument): string {
  if (!doc.markers.some((m) => m.name === "Marker")) return "Marker";
  let n = 2;
  while (doc.markers.some((m) => m.name === `Marker ${n}`)) n += 1;
  return `Marker ${n}`;
}

/** All actions owned by an object or camera (document order). */
export function actionsOfOwner(doc: SceneDocument, owner: ActionOwner): ActionDesc[] {
  return "objectId" in owner
    ? doc.actions.filter((a): a is ObjectActionDesc => a.kind === "object" && a.objectId === owner.objectId)
    : doc.actions.filter((a): a is CameraActionDesc => a.kind === "camera" && a.cameraId === owner.cameraId);
}

/** An owner's ACTIVE action: an explicit actionId wins (when it belongs to the
 *  owner), else the owner's `activeActionId`, else its first action. Null when
 *  the owner has no actions at all. */
export function activeActionOfOwner(doc: SceneDocument, owner: ActionOwner, actionId?: string): ActionDesc | null {
  const owned = actionsOfOwner(doc, owner);
  if (actionId) {
    const hit = owned.find((a) => a.id === actionId);
    if (hit) return hit;
  }
  const activeId =
    "objectId" in owner
      ? doc.objects.find((o) => o.id === owner.objectId)?.activeActionId
      : doc.cameras.find((c) => c.id === owner.cameraId)?.activeActionId;
  return owned.find((a) => a.id === activeId) ?? owned[0] ?? null;
}

/** An object's evaluated keyframes: its ACTIVE action's keys ([] when unkeyed). */
export function objectKeysOf(doc: SceneDocument, objectId: string): TransformKey[] {
  const act = activeActionOfOwner(doc, { objectId });
  return act && act.kind === "object" ? act.keys : [];
}

/** A camera's evaluated keyframes: its ACTIVE action's keys ([] when unkeyed). */
export function cameraKeysOf(doc: SceneDocument, cameraId: string): CameraKey[] {
  const act = activeActionOfOwner(doc, { cameraId });
  return act && act.kind === "camera" ? act.keys : [];
}

/** Next free default action name for an owner: "Action", "Action 2", … */
export function defaultActionName(doc: SceneDocument, owner: ActionOwner): string {
  const owned = actionsOfOwner(doc, owner);
  if (!owned.some((a) => a.name === "Action")) return "Action";
  let n = 2;
  while (owned.some((a) => a.name === `Action ${n}`)) n += 1;
  return `Action ${n}`;
}

/** Next free default collection name: "Collection", "Collection 2", … */
export function defaultCollectionName(doc: SceneDocument): string {
  if (!doc.collections.some((c) => c.name === "Collection")) return "Collection";
  let n = 2;
  while (doc.collections.some((c) => c.name === `Collection ${n}`)) n += 1;
  return `Collection ${n}`;
}

/** Key-framed objects grouped by their Outliner collection, for the editors'
 *  label-column hierarchy. An object qualifies when it is selected or its
 *  ACTIVE action has keys (the same rule the tracks timeline uses for rows).
 *  Collections keep document order and drop out when none of their members
 *  qualify; the final group (`collection: null`) holds uncollected objects
 *  and is likewise omitted when empty. */
export function keyedObjectsByCollection(
  doc: SceneDocument,
  selection: readonly string[] = [],
): Array<{ collection: CollectionDesc | null; members: ObjectDesc[] }> {
  const eligible = doc.objects.filter((o) => {
    if (selection.includes(o.id)) return true;
    const act = activeActionOfOwner(doc, { objectId: o.id });
    return !!act && act.keys.length > 0;
  });
  const groups: Array<{ collection: CollectionDesc | null; members: ObjectDesc[] }> = [];
  for (const col of doc.collections) {
    const members = eligible.filter((o) => o.collectionId === col.id);
    if (members.length > 0) groups.push({ collection: col, members });
  }
  const root = eligible.filter((o) => !o.collectionId || !doc.collections.some((c) => c.id === o.collectionId));
  if (root.length > 0) groups.push({ collection: null, members: root });
  return groups;
}

/** Accept documents saved before `aspect` existed. */
export function docAspect(doc: SceneDocument): number {
  return typeof doc.aspect === "number" && doc.aspect > 0 ? doc.aspect : 16 / 9;
}

/** Far clip plane defaults and limits, in world units. The default is large
 *  enough that distant scenery never pops out of frame; the max keeps the
 *  depth buffer precision usable (near plane is 0.1). */
export const DEFAULT_FAR_CLIP = 5000;
export const FAR_CLIP_MIN = 1;
export const FAR_CLIP_MAX = 1_000_000;

export function clampFarClip(v: number): number {
  return Math.min(Math.max(v, FAR_CLIP_MIN), FAR_CLIP_MAX);
}

/** Resolved far clip of a camera: the stored value when usable, else the
 *  default (documents saved before `farClip` existed). */
export function cameraFarClip(cam: Pick<CameraDesc, "farClip">): number {
  return typeof cam.farClip === "number" && Number.isFinite(cam.farClip) && cam.farClip > 0
    ? clampFarClip(cam.farClip)
    : DEFAULT_FAR_CLIP;
}

export function cloneDoc(doc: SceneDocument): SceneDocument {
  return JSON.parse(JSON.stringify(doc)) as SceneDocument;
}

/** Deep-clone helper for Vec3-ish arrays and plain values. */
export function vec3(v: Vec3): Vec3 {
  return [v[0], v[1], v[2]];
}

// ---------------------------------------------------------------------------
// Geometry catalog is defined here (types module) because defaultParams needs
// it and the catalog itself needs GeometryType. Keep both together.
// ---------------------------------------------------------------------------

export interface GeometryParamSpec {
  key: string;
  label: string;
  labelZh: string;
  min: number;
  max: number;
  step: number;
}

export interface GeometrySpec {
  type: GeometryType;
  label: string;
  labelZh: string;
  params: GeometryParamSpec[];
  defaults: Record<string, number>;
  /** Hidden from the geometry palette (added through tools/UI instead). */
  pseudo?: boolean;
}

export const GEOMETRY_CATALOG: GeometrySpec[] = [
  {
    type: "box",
    label: "Box",
    labelZh: "立方体",
    params: [
      { key: "width", label: "Width", labelZh: "宽", min: 0.01, max: 50, step: 0.1 },
      { key: "height", label: "Height", labelZh: "高", min: 0.01, max: 50, step: 0.1 },
      { key: "depth", label: "Depth", labelZh: "深", min: 0.01, max: 50, step: 0.1 },
    ],
    defaults: { width: 1, height: 1, depth: 1 },
  },
  {
    type: "sphere",
    label: "Sphere",
    labelZh: "球体",
    params: [{ key: "radius", label: "Radius", labelZh: "半径", min: 0.01, max: 50, step: 0.1 }],
    defaults: { radius: 0.6 },
  },
  {
    type: "cylinder",
    label: "Cylinder",
    labelZh: "圆柱",
    params: [
      { key: "radiusTop", label: "Top radius", labelZh: "顶部半径", min: 0, max: 50, step: 0.1 },
      { key: "radiusBottom", label: "Bottom radius", labelZh: "底部半径", min: 0.01, max: 50, step: 0.1 },
      { key: "height", label: "Height", labelZh: "高", min: 0.01, max: 50, step: 0.1 },
    ],
    defaults: { radiusTop: 0.5, radiusBottom: 0.5, height: 1.2 },
  },
  {
    type: "cone",
    label: "Cone",
    labelZh: "圆锥",
    params: [
      { key: "radius", label: "Radius", labelZh: "半径", min: 0.01, max: 50, step: 0.1 },
      { key: "height", label: "Height", labelZh: "高", min: 0.01, max: 50, step: 0.1 },
    ],
    defaults: { radius: 0.6, height: 1.2 },
  },
  {
    type: "torus",
    label: "Torus",
    labelZh: "圆环",
    params: [
      { key: "radius", label: "Radius", labelZh: "半径", min: 0.01, max: 50, step: 0.1 },
      { key: "tube", label: "Tube", labelZh: "管径", min: 0.01, max: 25, step: 0.05 },
    ],
    defaults: { radius: 0.7, tube: 0.25 },
  },
  {
    type: "plane",
    label: "Plane",
    labelZh: "平面",
    params: [
      { key: "width", label: "Width", labelZh: "宽", min: 0.01, max: 200, step: 0.5 },
      { key: "height", label: "Height", labelZh: "高", min: 0.01, max: 200, step: 0.5 },
    ],
    defaults: { width: 20, height: 20 },
  },
  {
    type: "capsule",
    label: "Capsule",
    labelZh: "胶囊",
    params: [
      { key: "radius", label: "Radius", labelZh: "半径", min: 0.01, max: 25, step: 0.05 },
      { key: "length", label: "Length", labelZh: "长", min: 0.01, max: 50, step: 0.1 },
    ],
    defaults: { radius: 0.35, length: 0.9 },
  },
  {
    type: "ring",
    label: "Ring",
    labelZh: "圆环面",
    params: [
      { key: "innerRadius", label: "Inner radius", labelZh: "内径", min: 0, max: 50, step: 0.05 },
      { key: "outerRadius", label: "Outer radius", labelZh: "外径", min: 0.01, max: 50, step: 0.05 },
    ],
    defaults: { innerRadius: 0.3, outerRadius: 0.7 },
  },
  {
    type: "tetrahedron",
    label: "Tetrahedron",
    labelZh: "四面体",
    params: [{ key: "radius", label: "Radius", labelZh: "半径", min: 0.01, max: 50, step: 0.1 }],
    defaults: { radius: 0.7 },
  },
  {
    type: "octahedron",
    label: "Octahedron",
    labelZh: "八面体",
    params: [{ key: "radius", label: "Radius", labelZh: "半径", min: 0.01, max: 50, step: 0.1 }],
    defaults: { radius: 0.7 },
  },
  {
    type: "dodecahedron",
    label: "Dodecahedron",
    labelZh: "十二面体",
    params: [{ key: "radius", label: "Radius", labelZh: "半径", min: 0.01, max: 50, step: 0.1 }],
    defaults: { radius: 0.7 },
  },
  {
    type: "icosahedron",
    label: "Icosahedron",
    labelZh: "二十面体",
    params: [{ key: "radius", label: "Radius", labelZh: "半径", min: 0.01, max: 50, step: 0.1 }],
    defaults: { radius: 0.7 },
  },
  {
    type: "torusKnot",
    label: "Torus Knot",
    labelZh: "环面纽结",
    params: [
      { key: "radius", label: "Radius", labelZh: "半径", min: 0.01, max: 50, step: 0.1 },
      { key: "tube", label: "Tube", labelZh: "管径", min: 0.01, max: 10, step: 0.05 },
    ],
    defaults: { radius: 0.6, tube: 0.2 },
  },
  {
    type: "empty",
    label: "Empty",
    labelZh: "空物体",
    params: [{ key: "size", label: "Display size", labelZh: "显示大小", min: 0.05, max: 20, step: 0.1 }],
    defaults: { size: 1 },
  },
  {
    type: "instance",
    label: "Collection Instance",
    labelZh: "集合实例",
    params: [],
    defaults: {},
    pseudo: true,
  },
];

export const GEOMETRY_DEFAULTS: Record<GeometryType, Record<string, number>> = Object.fromEntries(
  GEOMETRY_CATALOG.map((spec) => [spec.type, spec.defaults]),
) as Record<GeometryType, Record<string, number>>;

export const GEOMETRY_TYPES = GEOMETRY_CATALOG.map((s) => s.type);

export function isGeometryType(v: unknown): v is GeometryType {
  return typeof v === "string" && (GEOMETRY_TYPES as string[]).includes(v);
}

export function specOf(type: GeometryType): GeometrySpec {
  return GEOMETRY_CATALOG.find((s) => s.type === type) ?? GEOMETRY_CATALOG[0];
}

export const PALETTE_COLORS = [
  "#7c5cff",
  "#3ddc97",
  "#ff5c7c",
  "#ffb020",
  "#38bdf8",
  "#f472b6",
  "#a3e635",
  "#f97316",
  "#e2e8f0",
  "#94a3b8",
];

export function randomPaletteColor(): string {
  return PALETTE_COLORS[Math.floor(Math.random() * PALETTE_COLORS.length)];
}
