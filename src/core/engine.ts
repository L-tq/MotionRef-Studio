/** Three.js render engine for the editor viewport.
 *
 *  The engine is fully driven by a frame provider (doc + time + view state)
 *  supplied by the app store, and reports user interaction (selection,
 *  gizmo edits, playback time) back through callbacks. It never imports the
 *  store, keeping the render layer testable and detachable.
 */
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { evaluate, evalCameraById, type EvaluatedState, type HookError } from "./animation";
import { docAspect, defaultCameraDesc, type ObjectDesc, type SceneDocument } from "./types";

export type GizmoMode = "select" | "translate" | "rotate" | "scale";

export interface FrameSource {
  doc: SceneDocument;
  time: number;
  playing: boolean;
  /** Auto-key recording active: playback keeps running during gizmo drags
   *  and stops at the end of the timeline instead of looping. */
  autoKey: boolean;
  selection: string[];
  gizmo: GizmoMode;
  showGrid: boolean;
  cameraPreview: boolean;
}

export interface EngineCallbacks {
  onSelect(id: string | null, additive: boolean): void;
  onGizmoEdit(id: string, pose: { position: [number, number, number]; rotation: [number, number, number]; scale: [number, number, number] }): void;
  onGizmoDragEnd(): void;
  onTimeAdvance(t: number): void;
  /** Playback clamped at the end of the timeline (auto-key recording pass). */
  onPlaybackEnd(): void;
  onHookErrors(errors: HookError[]): void;
  onWalkChange?(active: boolean, speedPct: number, cameraMode: boolean): void;
  onWalkSpeed?(speedPct: number): void;
  /** Walk confirmed with a left click in scene-camera mode: bake the pose into the doc. */
  onWalkCommitCamera?(pose: { position: [number, number, number]; target: [number, number, number] }): void;
  /** Clicked a camera's marker in the viewport (opens it in the inspector). */
  onSelectCamera?(cameraId: string): void;
}

export type ViewAxis = "px" | "nx" | "py" | "ny" | "pz" | "nz";

const WALK_BASE_SPEED = 2.5;
const WALK_SPEED_MIN = 0.1;
const WALK_SPEED_MAX = 20;
const WALK_LOOK_SENSITIVITY = 0.0022;
const PITCH_LIMIT = Math.PI / 2 - 0.02;

interface WalkState {
  keys: Set<string>;
  yaw: number;
  pitch: number;
  /** Speed multiplier; 1 = 100% of WALK_BASE_SPEED. */
  mult: number;
  locked: boolean;
  /** Mouse-look fallback when pointer lock is unavailable: rotate while dragging. */
  dragLook: boolean;
  /** Orbit distance captured at entry, restored on exit so orbiting continues. */
  dist0: number;
  /** Drive the scene camera (camera preview) instead of the editor camera.
   *  Blender-style: left click bakes the pose into the doc, right click cancels. */
  camera: boolean;
  startPos: THREE.Vector3;
  startTarget: THREE.Vector3;
  /** Walked scene-camera position (camera mode); re-asserted after every
   *  docScene.sync() which would otherwise restore the doc pose. */
  pos: THREE.Vector3;
  downX: number;
  downY: number;
  downButton: number;
}

// Lets the app-level keyboard router yield to walk mode (WASD/QE must not
// trigger the W/E/R/Q gizmo shortcuts while walking).
let walkEngine: Engine | null = null;

export function isWalkActive(): boolean {
  return walkEngine !== null;
}

const FLAT_SHADING = new Set(["tetrahedron", "octahedron", "dodecahedron", "icosahedron"]);
const DOUBLE_SIDED = new Set(["plane", "ring"]);

function buildGeometry(obj: ObjectDesc): THREE.BufferGeometry {
  const p = obj.params;
  switch (obj.type) {
    case "box":
      return new THREE.BoxGeometry(p.width ?? 1, p.height ?? 1, p.depth ?? 1);
    case "sphere":
      return new THREE.SphereGeometry(p.radius ?? 0.6, 32, 20);
    case "cylinder":
      return new THREE.CylinderGeometry(p.radiusTop ?? 0.5, p.radiusBottom ?? 0.5, p.height ?? 1.2, 32);
    case "cone":
      return new THREE.ConeGeometry(p.radius ?? 0.6, p.height ?? 1.2, 32);
    case "torus":
      return new THREE.TorusGeometry(p.radius ?? 0.7, p.tube ?? 0.25, 20, 48);
    case "plane":
      return new THREE.PlaneGeometry(p.width ?? 20, p.height ?? 20);
    case "capsule":
      return new THREE.CapsuleGeometry(p.radius ?? 0.35, p.length ?? 0.9, 8, 24);
    case "ring":
      return new THREE.RingGeometry(p.innerRadius ?? 0.3, p.outerRadius ?? 0.7, 48);
    case "tetrahedron":
      return new THREE.TetrahedronGeometry(p.radius ?? 0.7);
    case "octahedron":
      return new THREE.OctahedronGeometry(p.radius ?? 0.7);
    case "dodecahedron":
      return new THREE.DodecahedronGeometry(p.radius ?? 0.7);
    case "icosahedron":
      return new THREE.IcosahedronGeometry(p.radius ?? 0.7);
    case "torusKnot":
      return new THREE.TorusKnotGeometry(p.radius ?? 0.6, p.tube ?? 0.2, 128, 16);
    default:
      return new THREE.BoxGeometry(1, 1, 1);
  }
}

/** A THREE scene synchronized from a SceneDocument. Shared by the editor
 *  viewport and the offscreen renderer used for snapshots / video export. */
export class DocScene {
  readonly scene = new THREE.Scene();
  readonly sceneCamera = new THREE.PerspectiveCamera(45, 16 / 9, 0.1, 500);
  private meshes = new Map<string, THREE.Mesh>();
  private lastSignature = new Map<string, string>();

  constructor(doc: SceneDocument) {
    this.scene.add(new THREE.AmbientLight(0xffffff, 1.35));
    const dir = new THREE.DirectionalLight(0xffffff, 1.6);
    dir.position.set(6, 10, 8);
    this.scene.add(dir);
    const dir2 = new THREE.DirectionalLight(0xffffff, 0.5);
    dir2.position.set(-6, 4, -8);
    this.scene.add(dir2);
    this.sync(doc, evaluate(doc, 0));
  }

  /** skipId keeps one object's mesh untouched (a gizmo drag holds it), while
   *  the rest of the scene still animates during a recording pass. */
  sync(doc: SceneDocument, state: EvaluatedState, skipId?: string): void {
    this.scene.background = new THREE.Color(doc.background);

    const alive = new Set<string>();
    for (const obj of doc.objects) {
      alive.add(obj.id);
      let mesh = this.meshes.get(obj.id);
      const signature = `${obj.type}|${JSON.stringify(obj.params)}`;
      if (!mesh || this.lastSignature.get(obj.id) !== signature) {
        if (mesh) {
          mesh.geometry.dispose();
          (mesh.material as THREE.MeshStandardMaterial).dispose();
          this.scene.remove(mesh);
        }
        const material = new THREE.MeshStandardMaterial({
          color: new THREE.Color(obj.color),
          roughness: 0.65,
          metalness: 0.05,
          flatShading: FLAT_SHADING.has(obj.type),
          side: DOUBLE_SIDED.has(obj.type) ? THREE.DoubleSide : THREE.FrontSide,
        });
        mesh = new THREE.Mesh(buildGeometry(obj), material);
        mesh.userData.id = obj.id;
        this.scene.add(mesh);
        this.meshes.set(obj.id, mesh);
        this.lastSignature.set(obj.id, signature);
      }
    }

    // Remove stale meshes.
    for (const [id, mesh] of this.meshes) {
      if (!alive.has(id)) {
        mesh.geometry.dispose();
        (mesh.material as THREE.MeshStandardMaterial).dispose();
        this.scene.remove(mesh);
        this.meshes.delete(id);
        this.lastSignature.delete(id);
      }
    }

    // Apply evaluated poses.
    for (const obj of doc.objects) {
      if (obj.id === skipId) continue;
      const mesh = this.meshes.get(obj.id);
      const ev = state.objects.get(obj.id);
      if (!mesh || !ev) continue;
      mesh.position.set(ev.position[0], ev.position[1], ev.position[2]);
      mesh.rotation.set(ev.rotation[0], ev.rotation[1], ev.rotation[2]);
      mesh.scale.set(ev.scale[0], ev.scale[1], ev.scale[2]);
      mesh.visible = ev.visible;
      (mesh.material as THREE.MeshStandardMaterial).color.set(ev.color);
    }

    // Scene camera.
    const cam = state.camera;
    this.sceneCamera.position.set(cam.position[0], cam.position[1], cam.position[2]);
    this.sceneCamera.lookAt(cam.target[0], cam.target[1], cam.target[2]);
    if (Math.abs(this.sceneCamera.fov - cam.fov) > 1e-6) {
      this.sceneCamera.fov = cam.fov;
      this.sceneCamera.updateProjectionMatrix();
    }
  }

  meshFor(id: string): THREE.Mesh | undefined {
    return this.meshes.get(id);
  }

  get pickables(): THREE.Mesh[] {
    return [...this.meshes.values()];
  }

  dispose(): void {
    for (const mesh of this.meshes.values()) {
      mesh.geometry.dispose();
      (mesh.material as THREE.MeshStandardMaterial).dispose();
    }
    this.meshes.clear();
  }
}

// ---------------------------------------------------------------------------
// Offscreen renderer (snapshots + deterministic video export)
// ---------------------------------------------------------------------------

let offscreenRenderer: THREE.WebGLRenderer | null = null;

export function getOffscreenRenderer(): THREE.WebGLRenderer {
  if (!offscreenRenderer) {
    const canvas = document.createElement("canvas");
    offscreenRenderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      preserveDrawingBuffer: true,
    });
    offscreenRenderer.setPixelRatio(1);
  }
  return offscreenRenderer;
}

export function disposeOffscreen(): void {
  offscreenRenderer?.dispose();
  offscreenRenderer = null;
}

/** Render one deterministic frame of the doc at target size; returns the
 *  offscreen canvas (call canvas.toDataURL() afterwards if needed). */
export function renderDocFrame(
  doc: SceneDocument,
  time: number,
  width: number,
  height: number,
  holder?: { docScene?: DocScene },
): HTMLCanvasElement {
  const renderer = getOffscreenRenderer();
  renderer.setSize(width, height, false);
  let ds = holder?.docScene;
  if (!ds) {
    ds = new DocScene(doc);
    if (holder) holder.docScene = ds;
  }
  ds.sceneCamera.aspect = width / height;
  ds.sceneCamera.updateProjectionMatrix();
  ds.sync(doc, evaluate(doc, time));
  renderer.render(ds.scene, ds.sceneCamera);
  return renderer.domElement;
}

export function snapshotDataUrl(
  doc: SceneDocument,
  time: number,
  width = 1024,
  height = 576,
  format: "png" | "jpeg" = "png",
): string {
  const canvas = renderDocFrame(doc, time, width, height);
  return format === "jpeg"
    ? canvas.toDataURL("image/jpeg", 0.92)
    : canvas.toDataURL("image/png");
}

// ---------------------------------------------------------------------------
// Editor engine
// ---------------------------------------------------------------------------

export class Engine {
  private renderer: THREE.WebGLRenderer;
  private docScene: DocScene;
  private editorCamera: THREE.PerspectiveCamera;
  private orbit: OrbitControls;
  private transform: TransformControls;
  private transformHelper: THREE.Object3D;
  private grid: THREE.GridHelper;
  private axes: THREE.AxesHelper;
  private cameraHelper: THREE.CameraHelper | null = null;
  /** Editor-only frustum wireframe + click target for each NON-active camera
   *  (the active one already gets `cameraHelper`). Blender-style camera markers. */
  private camGizmos = new Map<string, { cam: THREE.PerspectiveCamera; helper: THREE.CameraHelper; pick: THREE.Mesh }>();
  private selectionBox: THREE.BoxHelper | null = null;
  private raycaster = new THREE.Raycaster();
  private source: () => FrameSource | null = () => null;
  private raf = 0;
  private lastTime = performance.now();
  private dragging = false;
  private disposed = false;
  private lastHookErrorAt = 0;
  private resizeObserver: ResizeObserver | null = null;
  private walk: WalkState | null = null;
  private viewTween: { from: THREE.Vector3; to: THREE.Vector3; fromQ: THREE.Quaternion; toQ: THREE.Quaternion; start: number; dur: number } | null = null;

  constructor(private canvas: HTMLCanvasElement, private callbacks: EngineCallbacks) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    this.docScene = new DocScene({ version: 1, name: "", background: "#191922", duration: 1, fps: 30, aspect: 16 / 9, objects: [], collections: [], cameras: [defaultCameraDesc()], activeCameraId: defaultCameraDesc().id, actions: [], onFrameScripts: [] });

    this.editorCamera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
    this.editorCamera.position.set(10, 8, 12);

    this.orbit = new OrbitControls(this.editorCamera, canvas);
    this.orbit.target.set(0, 1, 0);
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.12;
    // Full orbit (like Blender): the nav gizmo offers top/bottom views and walk
    // mode is free-flight, so the camera may go below the ground plane.
    this.orbit.maxPolarAngle = Math.PI;

    this.transform = new TransformControls(this.editorCamera, canvas);
    this.transform.setSize(0.85);
    this.transformHelper = (this.transform as unknown as { getHelper?: () => THREE.Object3D }).getHelper?.() ?? (this.transform as unknown as THREE.Object3D);
    this.docScene.scene.add(this.transformHelper);
    this.transform.addEventListener("dragging-changed", (e) => {
      const dragging = (e as unknown as { value: boolean }).value;
      this.dragging = dragging;
      this.orbit.enabled = !dragging;
      if (!dragging) this.callbacks.onGizmoDragEnd();
    });
    this.transform.addEventListener("objectChange", () => {
      const mesh = this.transform.object as THREE.Mesh | null;
      if (!mesh) return;
      const id = mesh.userData.id as string;
      this.callbacks.onGizmoEdit(id, {
        position: [mesh.position.x, mesh.position.y, mesh.position.z],
        rotation: [mesh.rotation.x, mesh.rotation.y, mesh.rotation.z],
        scale: [mesh.scale.x, mesh.scale.y, mesh.scale.z],
      });
    });

    this.grid = new THREE.GridHelper(40, 40, 0x3a3a46, 0x26262f);
    (this.grid.material as THREE.Material).transparent = true;
    (this.grid.material as THREE.Material).opacity = 0.9;
    this.docScene.scene.add(this.grid);

    this.axes = new THREE.AxesHelper(2.4);
    this.docScene.scene.add(this.axes);

    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointerup", this.onPointerUp);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas.parentElement ?? canvas);
    this.resize();
  }

  setSource(source: () => FrameSource | null): void {
    this.source = source;
  }

  start(): void {
    const loop = () => {
      if (this.disposed) return;
      this.raf = requestAnimationFrame(loop);
      const now = performance.now();
      const dt = Math.min((now - this.lastTime) / 1000, 0.1);
      this.lastTime = now;
      const frame = this.source();
      if (!frame) return;

      // Auto-key recording pass: playback keeps running while a gizmo drag is
      // held (that is the point — keys are recorded as the playhead sweeps)
      // and stops at the end of the timeline instead of looping.
      if (frame.playing && (!this.dragging || frame.autoKey)) {
        let t = frame.time + dt;
        let ended = false;
        if (t > frame.doc.duration) {
          if (frame.autoKey) {
            t = frame.doc.duration;
            ended = true;
          } else {
            t = 0;
          }
        }
        this.callbacks.onTimeAdvance(t);
        if (ended) this.callbacks.onPlaybackEnd();
      }

      // While a drag is held during a recording pass, commit the held pose
      // every tick so each swept frame inserts/updates a key, even when the
      // mouse is motionless (commitPose dedupes by playhead time).
      if (this.dragging && frame.playing && frame.autoKey) {
        const mesh = this.transform.object as THREE.Mesh | null;
        if (mesh?.userData.id) {
          this.callbacks.onGizmoEdit(mesh.userData.id as string, {
            position: [mesh.position.x, mesh.position.y, mesh.position.z],
            rotation: [mesh.rotation.x, mesh.rotation.y, mesh.rotation.z],
            scale: [mesh.scale.x, mesh.scale.y, mesh.scale.z],
          });
        }
      }

      const errors: HookError[] = [];
      const state = evaluate(frame.doc, frame.time, errors);
      if (errors.length && now - this.lastHookErrorAt > 2000) {
        this.lastHookErrorAt = now;
        this.callbacks.onHookErrors(errors);
      }

      const heldId = this.dragging
        ? ((this.transform.object as THREE.Mesh | null)?.userData.id as string | undefined)
        : undefined;
      this.docScene.sync(frame.doc, state, heldId);

      this.grid.visible = frame.showGrid;
      this.axes.visible = frame.showGrid;

      this.updateCameraHelper(frame);
      this.updateCameraGizmos(frame);
      this.updateSelectionBox(frame);
      this.updateGizmoAttachment(frame);

      if (this.walk) this.updateWalk(dt);
      else if (this.viewTween) this.updateViewTween();
      // OrbitControls.update() re-derives its pose from the camera position,
      // so it re-syncs after walk mode or a view tween hands control back.
      else this.orbit.update();
      // The scene camera always carries the document's framing aspect so the
      // editor frustum helper shows the real export framing.
      const aspect = docAspect(frame.doc);
      this.docScene.sceneCamera.aspect = aspect;
      this.docScene.sceneCamera.updateProjectionMatrix();
      const W = this.canvas.clientWidth || 1;
      const H = this.canvas.clientHeight || 1;
      if (frame.cameraPreview) {
        // Letterbox the scene camera's aspect inside the viewport so what you
        // see is exactly the export framing.
        const canvasAspect = W / H;
        const vw = canvasAspect > aspect ? H * aspect : W;
        const vh = canvasAspect > aspect ? H : W / aspect;
        this.renderer.autoClear = false;
        this.renderer.setScissorTest(false);
        this.renderer.setViewport(0, 0, W, H);
        this.renderer.clear();
        this.renderer.setViewport((W - vw) / 2, (H - vh) / 2, vw, vh);
        this.renderer.render(this.docScene.scene, this.docScene.sceneCamera);
      } else {
        this.renderer.autoClear = true;
        this.renderer.setViewport(0, 0, W, H);
        this.renderer.render(this.docScene.scene, this.editorCamera);
      }
    };
    this.lastTime = performance.now();
    this.raf = requestAnimationFrame(loop);
  }

  private updateCameraHelper(frame: FrameSource): void {
    if (frame.cameraPreview || frame.gizmo !== "select") {
      if (this.cameraHelper) this.cameraHelper.visible = false;
      return;
    }
    if (!this.cameraHelper) {
      this.cameraHelper = new THREE.CameraHelper(this.docScene.sceneCamera);
      (this.cameraHelper.material as THREE.Material).transparent = true;
      (this.cameraHelper.material as THREE.Material).opacity = 0.55;
      this.docScene.scene.add(this.cameraHelper);
    }
    this.cameraHelper.visible = true;
    this.cameraHelper.update();
  }

  /** Wireframe frustum + invisible pick sphere per non-active camera, following
   *  its EVALUATED pose so keyed cameras visibly fly during playback. */
  private updateCameraGizmos(frame: FrameSource): void {
    const doc = frame.doc;
    const activeId = doc.cameras.find((c) => c.id === doc.activeCameraId)?.id ?? doc.cameras[0]?.id;
    for (const [id, g] of this.camGizmos) {
      if (!doc.cameras.some((c) => c.id === id)) {
        this.docScene.scene.remove(g.helper);
        g.helper.dispose();
        this.docScene.scene.remove(g.pick);
        g.pick.geometry.dispose();
        (g.pick.material as THREE.Material).dispose();
        this.camGizmos.delete(id);
      }
    }
    if (frame.cameraPreview) {
      for (const g of this.camGizmos.values()) {
        g.helper.visible = false;
        g.pick.visible = false;
      }
      return;
    }
    for (const c of doc.cameras) {
      if (c.id === activeId) continue; // the sceneCamera helper covers the active one
      let g = this.camGizmos.get(c.id);
      if (!g) {
        const cam = new THREE.PerspectiveCamera(c.fov, 16 / 9, 0.35, 3);
        const helper = new THREE.CameraHelper(cam);
        (helper.material as THREE.Material).transparent = true;
        (helper.material as THREE.Material).opacity = 0.4;
        this.docScene.scene.add(helper);
        const pick = new THREE.Mesh(
          new THREE.SphereGeometry(0.32, 8, 8),
          // Invisible to the renderer but still raycastable (click to inspect).
          new THREE.MeshBasicMaterial({ visible: false }),
        );
        pick.userData.camId = c.id;
        this.docScene.scene.add(pick);
        g = { cam, helper, pick };
        this.camGizmos.set(c.id, g);
      }
      const pose = evalCameraById(doc, c.id, frame.time);
      g.cam.position.set(pose.position[0], pose.position[1], pose.position[2]);
      g.cam.lookAt(pose.target[0], pose.target[1], pose.target[2]);
      if (Math.abs(g.cam.fov - pose.fov) > 1e-6) {
        g.cam.fov = pose.fov;
        g.cam.updateProjectionMatrix();
      }
      g.helper.update();
      g.helper.visible = true;
      g.pick.position.copy(g.cam.position);
      g.pick.visible = true;
    }
  }

  private updateSelectionBox(frame: FrameSource): void {
    const id = frame.selection[0];
    const mesh = id ? this.docScene.meshFor(id) : undefined;
    if (!mesh) {
      if (this.selectionBox) this.selectionBox.visible = false;
      return;
    }
    if (!this.selectionBox) {
      this.selectionBox = new THREE.BoxHelper(mesh, 0xffc24d);
      this.docScene.scene.add(this.selectionBox);
    }
    this.selectionBox.setFromObject(mesh);
    this.selectionBox.visible = !frame.cameraPreview;
  }

  private updateGizmoAttachment(frame: FrameSource): void {
    const id = frame.selection[0];
    const mesh = id ? this.docScene.meshFor(id) : undefined;
    if (frame.gizmo !== "select" && mesh && !frame.cameraPreview) {
      if (this.transform.object !== mesh) this.transform.attach(mesh);
      const mode = frame.gizmo === "translate" ? "translate" : frame.gizmo === "rotate" ? "rotate" : "scale";
      if (this.transform.mode !== mode) this.transform.setMode(mode);
      this.transformHelper.visible = true;
    } else {
      if (this.transform.object) this.transform.detach();
      this.transformHelper.visible = false;
    }
  }

  // --- selection picking -----------------------------------------------------

  private downPos = { x: 0, y: 0, button: 0 };

  private onPointerDown = (e: PointerEvent): void => {
    this.downPos = { x: e.clientX, y: e.clientY, button: e.button };
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (this.walk || e.button !== 0 || this.dragging) return;
    const dx = e.clientX - this.downPos.x;
    const dy = e.clientY - this.downPos.y;
    if (dx * dx + dy * dy > 25) return;
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.editorCamera);
    const camPicks = [...this.camGizmos.values()].map((g) => g.pick);
    const hits = this.raycaster.intersectObjects([...this.docScene.pickables, ...camPicks], false);
    const hit = hits.find((h) => (h.object as THREE.Mesh).visible);
    if (hit && hit.object.userData.camId) {
      this.callbacks.onSelectCamera?.(hit.object.userData.camId as string);
      return;
    }
    this.callbacks.onSelect(hit ? ((hit.object as THREE.Mesh).userData.id as string) : null, e.shiftKey);
  };

  // --- misc -------------------------------------------------------------------

  resize(): void {
    const parent = this.canvas.parentElement;
    const w = parent?.clientWidth ?? this.canvas.clientWidth;
    const h = parent?.clientHeight ?? this.canvas.clientHeight;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h, false);
    this.editorCamera.aspect = w / h;
    this.editorCamera.updateProjectionMatrix();
  }

  resetView(): void {
    this.editorCamera.position.set(10, 8, 12);
    this.orbit.target.set(0, 1, 0);
    this.orbit.update();
  }

  frameSelection(): void {
    const frame = this.source();
    const id = frame?.selection[0];
    const mesh = id ? this.docScene.meshFor(id) : undefined;
    if (mesh) {
      const box = new THREE.Box3().setFromObject(mesh);
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3()).length() || 2;
      const dir = this.editorCamera.position.clone().sub(this.orbit.target).normalize();
      this.orbit.target.copy(center);
      this.editorCamera.position.copy(center).add(dir.multiplyScalar(size * 1.8));
      this.orbit.update();
    } else {
      this.resetView();
    }
  }

  snapshot(width = 1024, height = 576): string {
    const frame = this.source();
    if (!frame) return "";
    // Snap the *scene camera* view (what an export would produce).
    return snapshotDataUrl(frame.doc, frame.time, width, height);
  }

  // --- walk navigation (Blender-style) -----------------------------------------
  // Modal first-person mode: mouse look (pointer lock), WASD to move on the
  // ground plane, Q/E to move down/up, Shift to slow, wheel or +/- to change
  // speed while moving. Escape exits (the browser releases the pointer lock).

  getEditorCamera(): THREE.PerspectiveCamera {
    return this.editorCamera;
  }

  getSceneCamera(): THREE.PerspectiveCamera {
    return this.docScene.sceneCamera;
  }

  /** Orbit pivot of the editor view — the "align camera to view" action maps
   *  (editorCamera.position → getEditorCamera(), this → lookAt target). */
  getOrbitTarget(): THREE.Vector3 {
    return this.orbit.target.clone();
  }

  isWalking(): boolean {
    return this.walk !== null;
  }

  /** Enter walk mode. In scene camera preview it flies the scene camera
   *  (Blender-style: left click confirms into the doc, right click cancels);
   *  otherwise it moves the editor view. */
  beginWalk(): boolean {
    if (this.walk) return true;
    const frame = this.source();
    const cameraMode = !!frame?.cameraPreview;
    let yaw: number;
    let pitch: number;
    let dist0: number;
    const startPos = new THREE.Vector3();
    const startTarget = new THREE.Vector3();
    if (cameraMode && frame) {
      // Start from the *evaluated* camera — with camera keyframes the preview
      // shows the keyed pose at the playhead, not the doc's base camera.
      const cam = evaluate(frame.doc, frame.time).camera;
      startPos.set(cam.position[0], cam.position[1], cam.position[2]);
      startTarget.set(cam.target[0], cam.target[1], cam.target[2]);
      const dir = startTarget.clone().sub(startPos);
      dist0 = Math.max(dir.length(), 0.1);
      dir.normalize();
      yaw = Math.atan2(-dir.x, -dir.z);
      pitch = Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1));
      this.docScene.sceneCamera.rotation.order = "YXZ";
      this.docScene.sceneCamera.position.copy(startPos);
    } else {
      const dir = this.editorCamera.getWorldDirection(new THREE.Vector3());
      this.editorCamera.rotation.order = "YXZ";
      yaw = Math.atan2(-dir.x, -dir.z);
      pitch = Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1));
      dist0 = this.editorCamera.position.distanceTo(this.orbit.target);
    }
    this.walk = {
      keys: new Set(),
      yaw,
      pitch,
      mult: 1,
      locked: false,
      dragLook: false,
      dist0,
      camera: cameraMode,
      startPos,
      startTarget,
      pos: startPos.clone(),
      downX: 0,
      downY: 0,
      downButton: -1,
    };
    this.viewTween = null;
    this.orbit.enabled = false;
    this.transform.enabled = false;
    window.addEventListener("keydown", this.onWalkKeyDown);
    window.addEventListener("keyup", this.onWalkKeyUp);
    window.addEventListener("wheel", this.onWalkWheel, { passive: false });
    window.addEventListener("blur", this.onWalkBlur);
    document.addEventListener("mousemove", this.onWalkMouseMove);
    document.addEventListener("pointerlockchange", this.onPointerLockChange);
    this.canvas.addEventListener("pointerdown", this.onWalkPointerDown);
    this.canvas.addEventListener("pointerup", this.onWalkPointerUp);
    this.canvas.addEventListener("contextmenu", this.onWalkContextMenu);
    try {
      const p = this.canvas.requestPointerLock() as unknown;
      if (p instanceof Promise) p.catch(() => undefined);
    } catch {
      /* pointer lock unavailable — drag-to-look still works */
    }
    walkEngine = this;
    this.callbacks.onWalkChange?.(true, 100, cameraMode);
    return true;
  }

  endWalk(): void {
    const walk = this.walk;
    if (!walk) return;
    this.walk = null;
    walkEngine = null;
    window.removeEventListener("keydown", this.onWalkKeyDown);
    window.removeEventListener("keyup", this.onWalkKeyUp);
    window.removeEventListener("wheel", this.onWalkWheel);
    window.removeEventListener("blur", this.onWalkBlur);
    document.removeEventListener("mousemove", this.onWalkMouseMove);
    document.removeEventListener("pointerlockchange", this.onPointerLockChange);
    this.canvas.removeEventListener("pointerdown", this.onWalkPointerDown);
    this.canvas.removeEventListener("pointerup", this.onWalkPointerUp);
    this.canvas.removeEventListener("contextmenu", this.onWalkContextMenu);
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
    if (!walk.camera) {
      // Re-arm the orbit around a point straight ahead at the old distance so a
      // subsequent orbit continues naturally from wherever the walk ended.
      const dir = this.editorCamera.getWorldDirection(new THREE.Vector3());
      this.orbit.target.copy(this.editorCamera.position).addScaledVector(dir, walk.dist0);
      this.orbit.update();
    }
    this.orbit.enabled = true;
    this.transform.enabled = true;
    this.callbacks.onWalkChange?.(false, 100, false);
  }

  /** Left click in scene-camera walk: bake the walked pose into the doc camera,
   *  keeping the original position→target distance for framing. */
  private confirmCameraWalk(): void {
    const w = this.walk;
    if (!w) return;
    const fwd = new THREE.Vector3(
      -Math.sin(w.yaw) * Math.cos(w.pitch),
      Math.sin(w.pitch),
      -Math.cos(w.yaw) * Math.cos(w.pitch),
    );
    const target = w.pos.clone().addScaledVector(fwd, w.dist0);
    this.callbacks.onWalkCommitCamera?.({
      position: [w.pos.x, w.pos.y, w.pos.z],
      target: [target.x, target.y, target.z],
    });
    this.endWalk();
  }

  private updateWalk(dt: number): void {
    const w = this.walk;
    if (!w) return;
    const slow = w.keys.has("shift") ? 0.25 : 1;
    const step = WALK_BASE_SPEED * w.mult * slow * dt;
    const f = (w.keys.has("w") ? 1 : 0) - (w.keys.has("s") ? 1 : 0);
    const r = (w.keys.has("d") ? 1 : 0) - (w.keys.has("a") ? 1 : 0);
    const u = (w.keys.has("e") ? 1 : 0) - (w.keys.has("q") ? 1 : 0);
    if (w.camera) {
      if (f !== 0 || r !== 0 || u !== 0) {
        const fwd = new THREE.Vector3(-Math.sin(w.yaw), 0, -Math.cos(w.yaw));
        const right = new THREE.Vector3(Math.cos(w.yaw), 0, -Math.sin(w.yaw));
        w.pos.addScaledVector(fwd, f * step).addScaledVector(right, r * step);
        w.pos.y += u * step;
      }
      // sync() restored the doc camera pose earlier this frame — re-assert ours.
      this.docScene.sceneCamera.position.copy(w.pos);
      this.docScene.sceneCamera.rotation.set(w.pitch, w.yaw, 0);
      return;
    }
    const cam = this.editorCamera;
    cam.rotation.set(w.pitch, w.yaw, 0);
    if (f !== 0 || r !== 0 || u !== 0) {
      const fwd = new THREE.Vector3(-Math.sin(w.yaw), 0, -Math.cos(w.yaw));
      const right = new THREE.Vector3(Math.cos(w.yaw), 0, -Math.sin(w.yaw));
      cam.position.addScaledVector(fwd, f * step).addScaledVector(right, r * step);
      cam.position.y += u * step;
    }
  }

  private setWalkMult(next: number): void {
    const w = this.walk;
    if (!w) return;
    w.mult = THREE.MathUtils.clamp(next, WALK_SPEED_MIN, WALK_SPEED_MAX);
    this.callbacks.onWalkSpeed?.(Math.round(w.mult * 100));
  }

  private onWalkKeyDown = (e: KeyboardEvent): void => {
    const w = this.walk;
    if (!w) return;
    const key = e.key.toLowerCase();
    if (key === "escape") {
      e.preventDefault();
      this.endWalk();
      return;
    }
    if (key === "+" || key === "=") {
      e.preventDefault();
      if (!e.repeat) this.setWalkMult(w.mult * 1.15);
      return;
    }
    if (key === "-" || key === "_") {
      e.preventDefault();
      if (!e.repeat) this.setWalkMult(w.mult / 1.15);
      return;
    }
    if (["w", "a", "s", "d", "q", "e", "shift"].includes(key)) {
      e.preventDefault();
      w.keys.add(key);
    }
  };

  private onWalkKeyUp = (e: KeyboardEvent): void => {
    this.walk?.keys.delete(e.key.toLowerCase());
  };

  private onWalkWheel = (e: WheelEvent): void => {
    const w = this.walk;
    if (!w) return;
    e.preventDefault();
    this.setWalkMult(e.deltaY < 0 ? w.mult * 1.15 : w.mult / 1.15);
  };

  private onWalkBlur = (): void => {
    if (this.walk) this.walk.keys.clear();
  };

  private onWalkMouseMove = (e: MouseEvent): void => {
    const w = this.walk;
    if (!w) return;
    if (document.pointerLockElement !== this.canvas && !w.dragLook) return;
    w.yaw -= e.movementX * WALK_LOOK_SENSITIVITY;
    w.pitch = THREE.MathUtils.clamp(w.pitch - e.movementY * WALK_LOOK_SENSITIVITY, -PITCH_LIMIT, PITCH_LIMIT);
  };

  private onWalkPointerDown = (e: PointerEvent): void => {
    const w = this.walk;
    if (!w) return;
    if (e.button === 2 && w.camera) {
      // Right click cancels: the doc was never touched, so plain exit restores it.
      e.preventDefault();
      this.endWalk();
      return;
    }
    if (e.button !== 0) return;
    w.downX = e.clientX;
    w.downY = e.clientY;
    w.downButton = 0;
    if (document.pointerLockElement !== this.canvas) {
      w.dragLook = true;
      this.canvas.setPointerCapture?.(e.pointerId);
    }
  };

  private onWalkPointerUp = (e: PointerEvent): void => {
    const w = this.walk;
    if (!w || e.button !== 0) return;
    w.dragLook = false;
    // A click (barely any movement between down and up) confirms in camera mode;
    // drags are mouse-look via the pointer-lock fallback.
    const dx = e.clientX - w.downX;
    const dy = e.clientY - w.downY;
    if (w.camera && w.downButton === 0 && dx * dx + dy * dy < 25) this.confirmCameraWalk();
  };

  private onWalkContextMenu = (e: MouseEvent): void => {
    if (this.walk) e.preventDefault();
  };

  private onPointerLockChange = (): void => {
    const w = this.walk;
    if (!w) return;
    if (document.pointerLockElement === this.canvas) w.locked = true;
    else if (w.locked) this.endWalk(); // Escape was pressed: the browser ate the keydown
  };

  // --- axis view snapping (navigation gizmo) -----------------------------------

  setEditorView(axis: ViewAxis): void {
    if (this.walk) return;
    // Pole views are nudged ~3° toward +Z: an exact ±Y camera makes OrbitControls'
    // lookAt degenerate (view direction parallel to the up vector). The offset is
    // far too small to notice but keeps the pose numerically safe.
    const dirs: Record<ViewAxis, [number, number, number]> = {
      px: [1, 0, 0], nx: [-1, 0, 0],
      py: [0, 1, 0.05], ny: [0, -1, 0.05],
      pz: [0, 0, 1], nz: [0, 0, -1],
    };
    const dist = this.editorCamera.position.distanceTo(this.orbit.target);
    const dir = new THREE.Vector3(...dirs[axis]).normalize();
    const to = this.orbit.target.clone().addScaledVector(dir, dist);
    const aim = new THREE.PerspectiveCamera();
    aim.position.copy(to);
    aim.lookAt(this.orbit.target);
    this.viewTween = {
      from: this.editorCamera.position.clone(),
      to,
      fromQ: this.editorCamera.quaternion.clone(),
      toQ: aim.quaternion.clone(),
      start: performance.now(),
      dur: 260,
    };
    this.orbit.enabled = false;
  }

  private updateViewTween(): void {
    const tw = this.viewTween;
    if (!tw) return;
    const k = Math.min(1, (performance.now() - tw.start) / tw.dur);
    const s = k * k * (3 - 2 * k);
    this.editorCamera.position.lerpVectors(tw.from, tw.to, s);
    this.editorCamera.quaternion.slerpQuaternions(tw.fromQ, tw.toQ, s);
    if (k >= 1) {
      this.viewTween = null;
      this.orbit.enabled = true;
      this.orbit.update();
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.walk) this.endWalk();
    cancelAnimationFrame(this.raf);
    this.resizeObserver?.disconnect();
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    this.canvas.removeEventListener("pointerup", this.onPointerUp);
    this.transform.dispose();
    this.orbit.dispose();
    for (const g of this.camGizmos.values()) {
      g.helper.dispose();
      g.pick.geometry.dispose();
      (g.pick.material as THREE.Material).dispose();
    }
    this.camGizmos.clear();
    this.docScene.dispose();
    this.renderer.dispose();
  }
}

// Dev-only guard: this module cannot be hot-swapped in isolation. The render
// engine captures the store once at mount, so a hot update that replaces only
// one side would split the app across two instances (UI reading the new store,
// engine still rendering the old one — "cleared hierarchy but models still
// visible"). A full reload keeps them consistent. Stripped from production.
if (import.meta.hot) import.meta.hot.accept(() => window.location.reload());
