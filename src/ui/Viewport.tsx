import { useEffect, useRef, useState } from "react";
import { Engine, snapshotDataUrl, type FrameSource, type GizmoMode } from "../core/engine";
import { downloadBlob } from "../core/videoExport";
import { useStore } from "../state/store";
import { useT } from "../i18n";

const GIZMO_BUTTONS: Array<{ mode: GizmoMode; icon: string; labelKey: string }> = [
  { mode: "select", icon: "▭", labelKey: "viewport.select" },
  { mode: "translate", icon: "✥", labelKey: "viewport.translate" },
  { mode: "rotate", icon: "⟳", labelKey: "viewport.rotate" },
  { mode: "scale", icon: "⤢", labelKey: "viewport.scale" },
];

export function Viewport() {
  const t = useT();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<Engine | null>(null);
  const [hookError, setHookError] = useState<string | null>(null);

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
        setHookError(errors.map((e) => `#${e.index}: ${e.message}`).join("; "));
      },
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
    return () => {
      engine.dispose();
      engineRef.current = null;
    };
  }, []);

  const gizmo = useStore((s) => s.gizmo);
  const showGrid = useStore((s) => s.showGrid);
  const setGizmo = useStore((s) => s.setGizmo);
  const setUi = useStore((s) => s.setUi);

  const snapshotNow = () => {
    const s = useStore.getState();
    const dataUrl = snapshotDataUrl(s.doc, s.playhead, 1280, 720);
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
        <button className="icon-btn" title={t("viewport.resetView")} onClick={() => engineRef.current?.resetView()}>
          ⟲
        </button>
        <button className="icon-btn" title={t("viewport.snapshot")} onClick={snapshotNow}>
          📷
        </button>
      </div>
      {cameraPreview && <div className="viewport-banner">{t("viewport.previewBanner")}</div>}
      {objects === 0 && (
        <div className="viewport-empty">
          <b>{t("viewport.emptyHint")}</b>
          <span>{t("viewport.emptyHint2")}</span>
        </div>
      )}
      <PlayheadStatus />
      {hookError && (
        <div
          className="viewport-banner"
          style={{ background: "rgba(255,92,124,0.15)", borderColor: "rgba(255,92,124,0.5)", color: "#ffb3c2", top: 44 }}
          title={hookError}
          onClick={() => setHookError(null)}
        >
          {t("viewport.hookError", { msg: hookError.slice(0, 80) })}
        </div>
      )}
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
