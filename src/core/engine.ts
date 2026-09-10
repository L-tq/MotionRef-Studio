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
import { evaluate, type EvaluatedState, type HookError } from "./animation";
import { docAspect, type ObjectDesc, type SceneDocument } from "./types";

export type GizmoMode = "select" | "translate" | "rotate" | "scale";

export interface FrameSource {
  doc: SceneDocument;
  time: number;
  playing: boolean;
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
  onHookErrors(errors: HookError[]): void;
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

  sync(doc: SceneDocument, state: EvaluatedState): void {
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
  private selectionBox: THREE.BoxHelper | null = null;
  private raycaster = new THREE.Raycaster();
  private source: () => FrameSource | null = () => null;
  private raf = 0;
  private lastTime = performance.now();
  private dragging = false;
  private disposed = false;
  private lastHookErrorAt = 0;
  private resizeObserver: ResizeObserver | null = null;

  constructor(private canvas: HTMLCanvasElement, private callbacks: EngineCallbacks) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    this.docScene = new DocScene({ version: 1, name: "", background: "#191922", duration: 1, fps: 30, aspect: 16 / 9, objects: [], camera: { position: [8, 6, 10], target: [0, 1, 0], fov: 45 }, cameraKeys: [], tracks: {}, onFrameScripts: [] });

    this.editorCamera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
    this.editorCamera.position.set(10, 8, 12);

    this.orbit = new OrbitControls(this.editorCamera, canvas);
    this.orbit.target.set(0, 1, 0);
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.12;
    this.orbit.maxPolarAngle = Math.PI * 0.55;

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

      if (frame.playing && !this.dragging) {
        let t = frame.time + dt;
        if (t > frame.doc.duration) t = 0;
        this.callbacks.onTimeAdvance(t);
      }

      const errors: HookError[] = [];
      const state = evaluate(frame.doc, frame.time, errors);
      if (errors.length && now - this.lastHookErrorAt > 2000) {
        this.lastHookErrorAt = now;
        this.callbacks.onHookErrors(errors);
      }

      if (!this.dragging) this.docScene.sync(frame.doc, state);

      this.grid.visible = frame.showGrid;
      this.axes.visible = frame.showGrid;

      this.updateCameraHelper(frame);
      this.updateSelectionBox(frame);
      this.updateGizmoAttachment(frame);

      this.orbit.update();
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
    if (e.button !== 0 || this.dragging) return;
    const dx = e.clientX - this.downPos.x;
    const dy = e.clientY - this.downPos.y;
    if (dx * dx + dy * dy > 25) return;
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.editorCamera);
    const hits = this.raycaster.intersectObjects(this.docScene.pickables, false);
    const hit = hits.find((h) => (h.object as THREE.Mesh).visible);
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

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.resizeObserver?.disconnect();
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    this.canvas.removeEventListener("pointerup", this.onPointerUp);
    this.transform.dispose();
    this.orbit.dispose();
    this.docScene.dispose();
    this.renderer.dispose();
  }
}
