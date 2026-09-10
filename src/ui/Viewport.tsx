import { useEffect, useRef, useState } from "react";
import { Engine, snapshotDataUrl, type FrameSource, type GizmoMode } from "../core/engine";
import { downloadBlob } from "../core/videoExport";
import { aspectDims, aspectLabel } from "../core/cameraMath";
import { docAspect } from "../core/types";
import { useStore } from "../state/store";
import { useT } from "../i18n";
import { NavGizmo } from "./NavGizmo";

const GIZMO_BUTTONS: Array<{ mode: GizmoMode; icon: string; labelKey: string }> = [
  { mode: "select", icon: "▭", labelKey: "viewport.select" },
  { mode: "translate", icon: "✥", labelKey: "viewport.translate" },
  { mode: "rotate", icon: "⟳", labelKey: "viewport.rotate" },
  { mode: "scale", icon: "⤢", labelKey: "viewport.scale" },
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
      onGizmoEdit: (id, pose) => store.getState().commitPose(id, pose),
      onGizmoDragEnd: () => {
        /* history coalescing handles grouping */
      },
      onTimeAdvance: (time) => {
        const s = store.getState();
        if (s.playing) s.setPlayhead(time);
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
    });
    engine.setSource(() => {
      const s = store.getState();
      const frame: FrameSource = {
        doc: s.doc,
        time: s.playhead,
        playing: s.playing,
        selection: s.selection,
        gizmo: s.gizmo,
        showGrid: s.showGrid,
        cameraPreview: s.cameraPreview,
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
  const showGrid = useStore((s) => s.showGrid);
  const setGizmo = useStore((s) => s.setGizmo);
  const setUi = useStore((s) => s.setUi);

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
            className={`icon-btn ${gizmo === b.mode ? "active" : ""}`}
            title={t(b.labelKey)}
            onClick={() => setGizmo(b.mode)}
          >
            {b.icon}
          </button>
        ))}
        <div className="divider" />
        <button
          className={`icon-btn ${showGrid ? "active" : ""}`}
          title={t("viewport.grid")}
          onClick={() => setUi("showGrid", !showGrid)}
        >
          ▦
        </button>
        <button
          className={`icon-btn ${cameraPreview ? "active" : ""}`}
          title={t("viewport.cameraPreview")}
          onClick={() => setUi("cameraPreview", !cameraPreview)}
        >
          🎥
        </button>
        <div className="divider" />
        <button className="icon-btn" title={t("viewport.frame")} onClick={() => engineRef.current?.frameSelection()}>
          ⛶
        </button>
        <button
          className={`icon-btn ${walk.active ? "active" : ""}`}
          title={t("viewport.walk")}
          onClick={toggleWalk}
        >
          🚶
        </button>
        <button className="icon-btn" title={t("viewport.resetView")} onClick={() => engineRef.current?.resetView()}>
          ⟲
        </button>
        <button className="icon-btn" title={t("viewport.snapshot")} onClick={snapshotNow}>
          📷
        </button>
      </div>
      {engine && !cameraPreview && <NavGizmo engine={engine} />}
      {walk.active && (
        <div className="walk-hud">
          <span className="walk-hud-title">{t("walk.title")}</span>
          <span>{t(walk.cameraMode ? "walk.hudCam" : "walk.hud")}</span>
          <span className="walk-hud-speed">{t("walk.speed", { pct: walk.speed })}</span>
        </div>
      )}
      {cameraPreview && <div className="viewport-banner">{t("viewport.previewBanner")}</div>}
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

export { GIZMO_BUTTONS };
