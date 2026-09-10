/** Core data model — plain JSON, no Three.js dependency. */

export type Vec3 = [number, number, number];

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
  | "torusKnot";

export type Interp = "linear" | "step" | "smooth";

export interface ObjectDesc {
  id: string;
  name: string;
  type: GeometryType;
  /** Per-geometry size parameters, see geometryCatalog. */
  params: Record<string, number>;
  position: Vec3;
  /** Euler XYZ, radians. */
  rotation: Vec3;
  scale: Vec3;
  /** Hex color, e.g. "#ff8800". */
  color: string;
  visible: boolean;
}

/** A keyframe for one object. Only the properties present are keyed. */
export interface TransformKey {
  /** Seconds from clip start. */
  t: number;
  position?: Vec3;
  rotation?: Vec3;
  scale?: Vec3;
  color?: string;
  visible?: boolean;
  interp?: Interp;
}

export interface CameraKey {
  t: number;
  position: Vec3;
  /** lookAt target. */
  target: Vec3;
  /** Vertical field of view in degrees. */
  fov: number;
  interp?: Interp;
}

export interface CameraState {
  position: Vec3;
  target: Vec3;
  fov: number;
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
  /** Base (static) camera pose — used when no cameraKeys exist. */
  camera: CameraState;
  /** Camera keyframes, kept sorted by t. */
  cameraKeys: CameraKey[];
  /** Per-object keyframe tracks, keyed by object id. */
  tracks: Record<string, TransformKey[]>;
  /** Serialized onFrame hook sources, run in order every evaluated frame. */
  onFrameScripts: string[];
}

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
  return { position: [8, 6, 10], target: [0, 1, 0], fov: 45 };
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
    camera: defaultCamera(),
    cameraKeys: [],
    tracks: {},
    onFrameScripts: [],
  };
}

/** Accept documents saved before `aspect` existed. */
export function docAspect(doc: SceneDocument): number {
  return typeof doc.aspect === "number" && doc.aspect > 0 ? doc.aspect : 16 / 9;
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
