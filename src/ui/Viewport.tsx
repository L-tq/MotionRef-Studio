import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Camera,
  Check,
  Footprints,
  Grid3x3,
  MousePointer2,
  Move,
  RotateCcw,
  RotateCw,
  Scaling,
  Scan,
  Video,
} from "lucide-react";
import { Engine, snapshotDataUrl, type FrameSource, type GizmoMode } from "../core/engine";
import type { PivotMode } from "../core/types";
import { downloadBlob } from "../core/videoExport";
import { aspectDims, aspectLabel } from "../core/cameraMath";
import { docAspect, activeCameraIdAt } from "../core/types";
import { useStore } from "../state/store";
import { useT } from "../i18n";
import { NavGizmo } from "./NavGizmo";

const GIZMO_BUTTONS: Array<{ mode: GizmoMode; icon: ReactNode; labelKey: string }> = [
  { mode: "select", icon: <MousePointer2 size={15} />, labelKey: "viewport.select" },
  { mode: "translate", icon: <Move size={15} />, labelKey: "viewport.translate" },
  { mode: "rotate", icon: <RotateCw size={15} />, labelKey: "viewport.rotate" },
  { mode: "scale", icon: <Scaling size={15} />, labelKey: "viewport.scale" },
];

/** Blender pivot-point modes, offered by right-clicking the rotate button. */
const PIVOT_MODES: Array<{ mode: PivotMode; labelKey: string; descKey: string }> = [
  { mode: "individual", labelKey: "pivot.individual", descKey: "pivot.individualDesc" },
  { mode: "median", labelKey: "pivot.median", descKey: "pivot.medianDesc" },
  { mode: "bbox", labelKey: "pivot.bbox", descKey: "pivot.bboxDesc" },
  { mode: "cursor", labelKey: "pivot.cursor", descKey: "pivot.cursorDesc" },
];

/** Blender-style camera passepartout: a framed rectangle matching the scene
 *  camera's aspect; everything outside the frame is dimmed. The engine renders
 *  the camera view letterboxed to the same rect, so the border sits exactly on
 *  the render edge. */
function CameraFrame({ aspect }: { aspect: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    const el = ref.current;
    const wrap = el?.parentElement;
    if (!wrap) return;
    const measure = () => {
      const W = wrap.clientWidth;
      const H = wrap.clientHeight;
      if (W === 0 || H === 0) return;
      const canvasAspect = W / H;
      const w = canvasAspect > aspect ? H * aspect : W;
      const h = canvasAspect > aspect ? H : W / aspect;
      setSize({ w, h });
    };
    const ro = new ResizeObserver(measure);
    ro.observe(wrap);
    measure();
    return () => ro.disconnect();
  }, [aspect]);

  return (
    <div ref={ref} className="camera-frame" style={size ? { width: size.w, height: size.h } : undefined}>
      {size && <span className="camera-frame-label">{aspectLabel(aspect)}</span>}
    </div>
  );
}

export function Viewport() {
  const t = useT();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<Engine | null>(null);
  const [engine, setEngine] = useState<Engine | null>(null);
  const [walk, setWalk] = useState<{ active: boolean; speed: number; cameraMode: boolean }>({ active: false, speed: 100, cameraMode: false });

  const doc = useStore((s) => s.doc);
  const objects = doc.objects.length;
  const cameraPreview = useStore((s) => s.cameraPreview);

  useEffect(() => {
    if (!canvasRef.current) return;
    const store = useStore;
    const engine = new Engine(canvasRef.current, {
      onSelect: (id, additive) => store.getState().select(id, additive),
      onGizmoEdit: (edits) => {
        const s = store.getState();
        for (const e of edits) s.commitPose(e.id, e.pose, e.scripted);
      },
      onScriptedDragStart: (affected) => {
        const s = store.getState();
        const names = affected
          .map((a) => s.doc.objects.find((o) => o.id === a.id)?.name ?? a.id)
          .join(", ");
        const chanKey = (c: string) =>
          c === "position" ? "inspector.position" : c === "rotation" ? "inspector.rotation" : "inspector.scale";
        const chans = [...new Set(affected.flatMap((a) => a.channels))].map((c) => t(chanKey(c))).join(", ");
        s.showToast(`viewport.scriptedPose|${names}|${chans}`);
      },
      onPlaceCursor: (pos) => store.getState().setCursor(pos),
      onGizmoDragEnd: () => {
        /* history coalescing handles grouping */
      },
      onTimeAdvance: (time) => {
        const s = store.getState();
        if (s.playing) s.setPlayhead(time);
      },
      onPlaybackEnd: () => {
        // Auto-key recording pass reached the end: rest at the last frame
        // instead of looping (pressing play again restarts from 0).
        const s = store.getState();
        if (s.playing) {
          s.pause();
          s.pushMessage("info", "timeline.recordingDone", { toast: true });
        }
      },
      onHookErrors: (errors) => {
        // Archive in the message center (repeats collapse into one entry);
        // only the first occurrence also pops a transient toast.
        const msg = errors.map((e) => `#${e.index}: ${e.message}`).join("; ");
        store.getState().pushMessage("error", t("viewport.hookError", { msg }), { toast: true });
      },
      onWalkChange: (active, speedPct, cameraMode) => setWalk({ active, speed: speedPct, cameraMode }),
      onWalkSpeed: (speedPct) => setWalk((w) => (w.speed === speedPct ? w : { ...w, speed: speedPct })),
      onWalkCommitCamera: (pose) => store.getState().commitCamera({ position: pose.position, target: pose.target }),
      // Clicking a camera marker selects it for editing in the inspector.
      onSelectCamera: (cameraId) => store.getState().setUi("camPanelSel", cameraId),
    });
    engine.setSource(() => {
      const s = store.getState();
      const frame: FrameSource = {
        doc: s.doc,
        time: s.playhead,
        playing: s.playing,
        autoKey: s.autoKey,
        selection: s.selection,
        gizmo: s.gizmo,
        pivotMode: s.pivotMode,
        showGrid: s.showGrid,
        cameraPreview: s.cameraPreview,
        viewportFarClip: s.layout.viewportFarClip,
      };
      return frame;
    });
    engine.start();
    engineRef.current = engine;
    setEngine(engine);
    // Debug/testing handle (also lets power users script view tweaks from the console).
    (window as unknown as Record<string, unknown>).__mrsEngine = engine;
    return () => {
      engine.dispose();
      engineRef.current = null;
      setEngine(null);
      delete (window as unknown as Record<string, unknown>).__mrsEngine;
    };
  }, []);

  // Shift+F enters/exits walk mode (mirrors the toolbar button).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || !e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key.toLowerCase() !== "f") return;
      const s = useStore.getState();
      if (s.settingsOpen || s.projectsOpen || s.exportOpen || s.lightbox) return;
      const eng = engineRef.current;
      if (!eng) return;
      if (eng.isWalking()) eng.endWalk();
      else eng.beginWalk();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const gizmo = useStore((s) => s.gizmo);
  const pivotMode = useStore((s) => s.pivotMode);
  const setPivotMode = useStore((s) => s.setPivotMode);
  const showGrid = useStore((s) => s.showGrid);
  const setGizmo = useStore((s) => s.setGizmo);
  const setUi = useStore((s) => s.setUi);
  const rotateBtnRef = useRef<HTMLButtonElement>(null);
  const [pivotMenuAt, setPivotMenuAt] = useState<{ x: number; y: number } | null>(null);

  // Right-click the rotate button → pivot point menu (closes on Escape or an
  // outside press).
  useEffect(() => {
    if (!pivotMenuAt) return;
    const close = (e: PointerEvent) => {
      const el = e.target as Element | null;
      if (el?.closest?.(".pivot-menu, [data-pivot-btn]")) return;
      setPivotMenuAt(null);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPivotMenuAt(null);
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", esc);
    };
  }, [pivotMenuAt]);

  const openPivotMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const r = rotateBtnRef.current?.getBoundingClientRect();
    if (!r) return;
    setPivotMenuAt({ x: r.left, y: r.bottom + 4 });
  };

  const toggleWalk = () => {
    const eng = engineRef.current;
    if (!eng) return;
    if (eng.isWalking()) eng.endWalk();
    else eng.beginWalk();
  };

  const snapshotNow = () => {
    const s = useStore.getState();
    const { w, h } = aspectDims(docAspect(s.doc), 1280);
    const dataUrl = snapshotDataUrl(s.doc, s.playhead, w, h);
    fetch(dataUrl)
      .then((r) => r.blob())
      .then((b) => downloadBlob(b, `${s.doc.name || "snapshot"}_${s.playhead.toFixed(2)}s.png`))
      .catch(() => undefined);
  };

  return (
    <div className="viewport-wrap">
      <canvas ref={canvasRef} />
      <div className="viewport-toolbar">
        {GIZMO_BUTTONS.map((b) => (
          <button
            key={b.mode}
            ref={b.mode === "rotate" ? rotateBtnRef : undefined}
            data-pivot-btn={b.mode === "rotate" ? "" : undefined}
            className={`icon-btn ${gizmo === b.mode ? "active" : ""}`}
            title={t(b.labelKey)}
            onContextMenu={b.mode === "rotate" ? openPivotMenu : undefined}
            onClick={() => setGizmo(b.mode)}
          >
            {b.icon}
            {b.mode === "rotate" && <span className="menu-caret" />}
            {b.mode === "rotate" && pivotMode !== "median" && <span className="pivot-dot" />}
          </button>
        ))}
        <div className="divider" />
        <button
          className={`icon-btn ${showGrid ? "active" : ""}`}
          title={t("viewport.grid")}
          onClick={() => setUi("showGrid", !showGrid)}
        >
          <Grid3x3 size={15} />
        </button>
        <button
          className={`icon-btn ${cameraPreview ? "active" : ""}`}
          title={t("viewport.cameraPreview")}
          onClick={() => setUi("cameraPreview", !cameraPreview)}
        >
          <Video size={15} />
        </button>
        <div className="divider" />
        <button className="icon-btn" title={t("viewport.frame")} onClick={() => engineRef.current?.frameSelection()}>
          <Scan size={15} />
        </button>
        <button
          className={`icon-btn ${walk.active ? "active" : ""}`}
          title={t("viewport.walk")}
          onClick={toggleWalk}
        >
          <Footprints size={15} />
        </button>
        <button className="icon-btn" title={t("viewport.resetView")} onClick={() => engineRef.current?.resetView()}>
          <RotateCcw size={15} />
        </button>
        <button className="icon-btn" title={t("viewport.snapshot")} onClick={snapshotNow}>
          <Camera size={15} />
        </button>
      </div>
      {pivotMenuAt && (
        <div className="pivot-menu" style={{ left: pivotMenuAt.x, top: pivotMenuAt.y }}>
          <div className="pivot-menu-title">{t("pivot.title")}</div>
          {PIVOT_MODES.map((m) => (
            <button
              key={m.mode}
              className={`pivot-item ${pivotMode === m.mode ? "active" : ""}`}
              title={t(m.descKey)}
              onClick={() => {
                setPivotMode(m.mode);
                setPivotMenuAt(null);
              }}
            >
              <span className="pivot-check">{pivotMode === m.mode && <Check size={10} />}</span>
              {t(m.labelKey)}
            </button>
          ))}
          <div className="pivot-menu-hint">{t("pivot.cursorHint")}</div>
        </div>
      )}
      {engine && !cameraPreview && <NavGizmo engine={engine} />}
      {walk.active && (
        <div className="walk-hud">
          <span className="walk-hud-title">{t("walk.title")}</span>
          <span>{t(walk.cameraMode ? "walk.hudCam" : "walk.hud")}</span>
          <span className="walk-hud-speed">{t("walk.speed", { pct: walk.speed })}</span>
        </div>
      )}
      {cameraPreview && (
        <div className="viewport-banner">
          {t("viewport.previewBanner")}
          <LiveCameraName />
        </div>
      )}
      {cameraPreview && <CameraFrame aspect={docAspect(doc)} />}
      {objects === 0 && (
        <div className="viewport-empty">
          <b>{t("viewport.emptyHint")}</b>
          <span>{t("viewport.emptyHint2")}</span>
        </div>
      )}
      <PlayheadStatus />
    </div>
  );
}

function PlayheadStatus() {
  const playhead = useStore((s) => s.playhead);
  const duration = useStore((s) => s.doc.duration);
  return (
    <div className="viewport-status">
      {playhead.toFixed(2)}s / {duration.toFixed(2)}s
    </div>
  );
}

/** Camera name in the preview banner — follows marker cuts during playback.
 *  Subscribing here keeps the (name string) re-renders local to this span. */
function LiveCameraName() {
  const name = useStore((s) => {
    const id = activeCameraIdAt(s.doc, s.playhead);
    return s.doc.cameras.find((c) => c.id === id)?.name ?? "";
  });
  return <span className="banner-live-cam"> · {name}</span>;
}

export { GIZMO_BUTTONS };
