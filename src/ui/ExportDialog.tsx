import { useEffect, useRef, useState } from "react";
import { Clapperboard } from "lucide-react";
import { useStore } from "../state/store";
import { useT } from "../i18n";
import { downloadBlob, exportVideo, pickVideoMime, probeWebCodecsExport, validateDocForExport } from "../core/videoExport";
import { aspectDims, aspectLabel } from "../core/cameraMath";
import { docAspect } from "../core/types";

const PRESETS = [
  { label: "720p 16:9", w: 1280, h: 720 },
  { label: "1080p 16:9", w: 1920, h: 1080 },
  { label: "720 9:16", w: 720, h: 1280 },
  { label: "1080 9:16", w: 1080, h: 1920 },
  { label: "720 1:1", w: 720, h: 720 },
];

export function ExportDialog() {
  const t = useT();
  const doc = useStore((s) => s.doc);
  const setUi = useStore((s) => s.setUi);
  const showToast = useStore((s) => s.showToast);

  // A preset matching the scene camera's aspect ratio, so the exported video
  // frames exactly what the preview shows.
  const sceneDims = aspectDims(docAspect(doc), 1920);
  const SCENE_PRESET = { label: `${t("export.sceneAspect", { ratio: aspectLabel(docAspect(doc)) })}`, w: sceneDims.w, h: sceneDims.h };
  const ALL_PRESETS = [...PRESETS, SCENE_PRESET];
  const SCENE_IDX = PRESETS.length;

  const [presetIdx, setPresetIdx] = useState(SCENE_IDX);
  const [fps, setFps] = useState(doc.fps);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ frame: number; total: number; etaSec: number | null } | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const exportStartRef = useRef(0);

  const picked = pickVideoMime();
  const preset = ALL_PRESETS[presetIdx] ?? SCENE_PRESET;

  // Export runs through frame-exact WebCodecs (always .mp4) when the browser
  // can encode H.264 at the chosen size/rate; MediaRecorder is the fallback.
  const [webCodecsCodec, setWebCodecsCodec] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    probeWebCodecsExport(preset.w, preset.h, fps).then((codec) => {
      if (alive) setWebCodecsCodec(codec);
    });
    return () => {
      alive = false;
    };
  }, [preset.w, preset.h, fps]);
  const canExport = !!webCodecsCodec || !!picked;
  const formatLabel = webCodecsCodec ? ".mp4" : picked ? `.${picked.ext}` : "—";

  const start = async () => {
    if (!canExport) return;
    const warn = validateDocForExport(doc, fps);
    if (warn) {
      setWarning(warn);
      return;
    }
    setRunning(true);
    setWarning(null);
    setProgress({ frame: 0, total: Math.round(doc.duration * fps), etaSec: null });
    exportStartRef.current = performance.now();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const result = await exportVideo(doc, {
        width: preset.w,
        height: preset.h,
        fps,
        signal: controller.signal,
        onProgress: (frame, total) => {
          // Linear ETA from committed-frame throughput; shown once the rate
          // estimate has a few samples to stand on.
          const elapsedSec = (performance.now() - exportStartRef.current) / 1000;
          const etaSec =
            frame >= 3 && frame < total
              ? Math.max(1, Math.round((elapsedSec / frame) * (total - frame)))
              : frame >= total
                ? 0
                : null;
          setProgress({ frame, total, etaSec });
        },
      });
      const safeName = (doc.name || "animation").replace(/[^\w\u4e00-\u9fa5-]+/g, "_");
      downloadBlob(result.blob, `${safeName}.${result.ext}`);
      showToast(`export.done|${result.ext}|${result.frames}`);
      setUi("exportOpen", false);
    } catch (err) {
      if ((err as Error).name === "AbortError") showToast("export.aborted");
      else setWarning(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
      setProgress(null);
      abortRef.current = null;
    }
  };

  return (
    <div className="modal-overlay">
      <div className="modal">
        <div className="modal-header">
          <Clapperboard size={14} />
          {t("export.title")}
          <span className="spacer" />
        </div>
        <div className="modal-body">
          <div className="field">
            <label>{t("export.resolution")}</label>
            <div className="res-grid">
              {ALL_PRESETS.map((p, i) => (
                <button key={p.label} className={i === presetIdx ? "active" : ""} onClick={() => setPresetIdx(i)}>
                  {p.label}
                  <br />
                  {p.w}×{p.h}
                </button>
              ))}
            </div>
            <span className="hint">{t("export.aspectNote")}</span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
            <div className="field">
              <label>{t("export.fps")}</label>
              <select value={fps} onChange={(e) => setFps(parseInt(e.target.value, 10))} disabled={running}>
                {[12, 24, 25, 30, 48, 50, 60].map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>{t("export.duration")}</label>
              <input type="number" value={doc.duration} disabled />
            </div>
            <div className="field">
              <label>{t("export.format")}</label>
              <input type="text" value={formatLabel} disabled />
              <span className="hint">{t("export.formatAuto")}</span>
            </div>
          </div>
          {!canExport && <div className="msg error-banner">{t("export.noRecorder")}</div>}
          {warning && <div className="msg error-banner">{t("export.warning", { msg: warning })}</div>}
          {progress && (
            <div className="field">
              <div className="progress-track">
                <div style={{ width: `${(progress.frame / Math.max(progress.total, 1)) * 100}%` }} />
              </div>
              <span className="hint">
                {progress.frame >= progress.total
                  ? t("export.processing")
                  : t("export.progress", { frame: progress.frame, total: progress.total }) +
                    (progress.etaSec ? ` · ${t("export.eta", { sec: progress.etaSec })}` : "")}
              </span>
            </div>
          )}
        </div>
        <div className="modal-footer">
          {running ? (
            <button className="btn danger" onClick={() => abortRef.current?.abort()}>
              {t("common.cancel")}
            </button>
          ) : (
            <>
              <button className="btn" onClick={() => setUi("exportOpen", false)}>
                {t("common.close")}
              </button>
              <button className="btn primary" onClick={() => void start()} disabled={!canExport}>
                {t("export.start")}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
