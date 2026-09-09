import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "../state/store";
import { useT } from "../i18n";
import type { SceneDocument } from "../core/types";

interface TrackRow {
  key: string;
  label: string;
  camera: boolean;
  objectId?: string;
  color?: string;
  keys: Array<{ t: number }>;
}

function buildRows(doc: SceneDocument, selection: string[]): TrackRow[] {
  const rows: TrackRow[] = [
    { key: "__camera", label: "🎥 Camera", camera: true, keys: doc.cameraKeys },
  ];
  for (const obj of doc.objects) {
    const keys = doc.tracks[obj.id] ?? [];
    if (keys.length > 0 || selection.includes(obj.id)) {
      rows.push({ key: obj.id, label: obj.name, camera: false, objectId: obj.id, color: obj.color, keys });
    }
  }
  return rows;
}

type KeyTarget = { objectId: string } | { camera: true };

export function Timeline() {
  const t = useT();
  const doc = useStore((s) => s.doc);
  const selection = useStore((s) => s.selection);
  const playing = useStore((s) => s.playing);
  const autoKey = useStore((s) => s.autoKey);
  const play = useStore((s) => s.play);
  const pause = useStore((s) => s.pause);
  const stop = useStore((s) => s.stop);
  const setPlayhead = useStore((s) => s.setPlayhead);
  const setDuration = useStore((s) => s.setDuration);
  const setFps = useStore((s) => s.setFps);
  const setUi = useStore((s) => s.setUi);
  const setKeyAtPlayhead = useStore((s) => s.setKeyAtPlayhead);
  const setCameraKeyAtPlayhead = useStore((s) => s.setCameraKeyAtPlayhead);
  const retimeKey = useStore((s) => s.retimeKey);
  const deleteKey = useStore((s) => s.deleteKey);
  const select = useStore((s) => s.select);

  const rows = buildRows(doc, selection);
  const areaRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [selectedKey, setSelectedKey] = useState<{ rowKey: string; t: number } | null>(null);

  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const tToX = useCallback((time: number) => (time / Math.max(doc.duration, 0.001)) * width, [doc.duration, width]);
  const xToT = useCallback((x: number) => (x / Math.max(width, 1)) * doc.duration, [doc.duration, width]);

  const scrub = useCallback(
    (e: React.PointerEvent) => {
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      setPlayhead(xToT(e.clientX - rect.left));
    },
    [setPlayhead, xToT],
  );

  // --- keyframe dragging (time-addressed, robust against re-sorting) ---
  const beginKeyDrag = (e: React.PointerEvent, target: KeyTarget, startT: number) => {
    e.stopPropagation();
    e.preventDefault();
    pause();
    setSelectedKey({ rowKey: "camera" in target ? "__camera" : target.objectId, t: startT });
    let lastT = startT;
    const area = areaRef.current;
    const move = (ev: PointerEvent) => {
      if (!area) return;
      const rect = area.getBoundingClientRect();
      const nextT = Math.min(Math.max(xToT(ev.clientX - rect.left), 0), doc.duration);
      retimeKey(target, lastT, nextT);
      setPlayhead(nextT);
      lastT = nextT;
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // Delete the selected keyframe via keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!selectedKey) return;
      const active = document.activeElement;
      if (active && ["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName)) return;
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        if (selectedKey.rowKey === "__camera") deleteKey({ camera: true }, selectedKey.t);
        else deleteKey({ objectId: selectedKey.rowKey }, selectedKey.t);
        setSelectedKey(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedKey, deleteKey]);

  const ticks = Math.min(Math.max(Math.ceil(doc.duration), 1), 60);
  const showEvery = ticks > 20 ? 5 : ticks > 10 ? 2 : 1;

  return (
    <div className="timeline">
      <div className="timeline-bar">
        <button
          className="btn small"
          title={playing ? t("timeline.pause") : t("timeline.play")}
          onClick={() => (playing ? pause() : play())}
        >
          {playing ? "⏸" : "▶"}
        </button>
        <button className="btn small" title={t("timeline.stop")} onClick={stop}>
          ⏹
        </button>
        <TimeDisplay />
        <label>
          {t("timeline.duration")}
          <input
            type="number"
            min={0.1}
            max={300}
            step={0.5}
            value={doc.duration}
            onChange={(e) => setDuration(parseFloat(e.target.value))}
            style={{ width: 56 }}
          />
        </label>
        <label>
          {t("timeline.fps")}
          <select value={doc.fps} onChange={(e) => setFps(parseInt(e.target.value, 10))}>
            {[12, 24, 25, 30, 48, 50, 60].map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </label>
        <label title={t("timeline.autoKey")}>
          <input type="checkbox" checked={autoKey} onChange={(e) => setUi("autoKey", e.target.checked)} />
          {t("timeline.autoKey")}
        </label>
        <button className="btn small" onClick={() => setKeyAtPlayhead()} disabled={selection.length === 0}>
          ◆ {t("timeline.setKey")}
        </button>
        <button className="btn small" onClick={setCameraKeyAtPlayhead}>
          🎥◆ {t("timeline.setCameraKey")}
        </button>
      </div>

      <div className="timeline-body">
        <div className="track-labels">
          <div className="tl-ruler" />
          <div className="tlabels-inner">
            {rows.map((row) => (
              <div
                key={row.key}
                className={`track-label ${row.camera ? "camera" : ""}`}
                onClick={() => {
                  if (row.objectId) select(row.objectId, false);
                }}
              >
                {!row.camera && (
                  <span
                    style={{ width: 8, height: 8, borderRadius: 2, background: row.color, flexShrink: 0 }}
                  />
                )}
                <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{row.label}</span>
                <span style={{ flex: 1 }} />
                <span className="kbadge">{row.keys.length}</span>
              </div>
            ))}
            {doc.cameraKeys.length === 0 && Object.keys(doc.tracks).length === 0 && (
              <div className="empty-note">{t("timeline.noTracks")}</div>
            )}
          </div>
        </div>

        <div className="track-area" ref={areaRef}>
          <div
            className="tl-ruler"
            onPointerDown={(e) => {
              scrub(e);
              pause();
            }}
          >
            {Array.from({ length: ticks + 1 }, (_, i) => i).map((i) =>
              i % showEvery === 0 ? (
                <div key={i} className="tl-tick" style={{ left: `${tToX(i)}px` }}>
                  {i}s
                </div>
              ) : null,
            )}
          </div>
          {rows.map((row) => (
            <div
              key={row.key}
              className="tl-row"
              onPointerDown={(e) => {
                scrub(e);
                pause();
              }}
            >
              {row.keys.map((key, index) => {
                const target: KeyTarget = row.camera ? { camera: true } : { objectId: row.objectId! };
                const rowKey = row.camera ? "__camera" : row.objectId!;
                const isSelected = selectedKey?.rowKey === rowKey && Math.abs(selectedKey.t - key.t) < 1e-4;
                return (
                  <div
                    key={`${key.t}-${index}`}
                    className={`keyframe ${row.camera ? "camera-key" : ""} ${isSelected ? "selected-key" : ""}`}
                    style={{ left: `${tToX(key.t)}px` }}
                    title={t("timeline.deleteKey")}
                    onPointerDown={(e) => beginKeyDrag(e, target, key.t)}
                  />
                );
              })}
            </div>
          ))}
          <Playhead duration={doc.duration} tToX={tToX} />
        </div>
      </div>
    </div>
  );
}

function TimeDisplay() {
  const playhead = useStore((s) => s.playhead);
  const duration = useStore((s) => s.doc.duration);
  return (
    <span className="time-display">
      {playhead.toFixed(2)} / {duration.toFixed(2)}s
    </span>
  );
}

function Playhead({ duration, tToX }: { duration: number; tToX: (time: number) => number }) {
  const playhead = useStore((s) => s.playhead);
  const left = Math.min(Math.max(tToX(playhead), 0), tToX(duration));
  return <div className="playhead" style={{ left: `${left}px` }} />;
}
