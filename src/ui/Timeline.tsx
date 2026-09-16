import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useStore, type KeyTarget } from "../state/store";
import { useT } from "../i18n";
import { actionsOfOwner, activeActionOfOwner, activeCameraIdAt, type MarkerDesc, type SceneDocument } from "../core/types";
import { GraphEditor } from "./GraphEditor";
import { ActionEditor } from "./ActionEditor";

interface TrackRow {
  key: string;
  label: string;
  /** Present on camera rows. */
  cameraId?: string;
  objectId?: string;
  color?: string;
  keys: Array<{ t: number }>;
}

/** One row per owner; keys come from the owner's ACTIVE action. When the
 *  owner has several actions, the label names the active one. */
function buildRows(doc: SceneDocument, selection: string[]): TrackRow[] {
  const rows: TrackRow[] = doc.cameras.map((c) => {
    const act = activeActionOfOwner(doc, { cameraId: c.id });
    const multi = actionsOfOwner(doc, { cameraId: c.id }).length > 1;
    return {
      key: `cam:${c.id}`,
      label: `🎥 ${c.name}${multi && act ? ` · ${act.name}` : ""}`,
      cameraId: c.id,
      keys: act ? act.keys : [],
    };
  });
  for (const obj of doc.objects) {
    const act = activeActionOfOwner(doc, { objectId: obj.id });
    const keys = act ? act.keys : [];
    if (keys.length > 0 || selection.includes(obj.id)) {
      const multi = actionsOfOwner(doc, { objectId: obj.id }).length > 1;
      rows.push({
        key: obj.id,
        label: `${obj.name}${multi && act ? ` · ${act.name}` : ""}`,
        objectId: obj.id,
        color: obj.color,
        keys,
      });
    }
  }
  return rows;
}

const ZOOM_MIN = 20;
const ZOOM_MAX = 500;
const clampZoom = (z: number) => Math.min(Math.max(Math.round(z), ZOOM_MIN), ZOOM_MAX);

/** First tick step (seconds) whose on-screen spacing is readable at this zoom. */
function tickStep(zoom: number): number {
  const candidates = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60];
  return candidates.find((s) => s * zoom >= 64) ?? 60;
}

export function Timeline() {
  const t = useT();
  const doc = useStore((s) => s.doc);
  const selection = useStore((s) => s.selection);
  const playing = useStore((s) => s.playing);
  const playhead = useStore((s) => s.playhead);
  const autoKey = useStore((s) => s.autoKey);
  const autoKeyMode = useStore((s) => s.autoKeyMode);
  const storedZoom = useStore((s) => s.layout.timelineZoom);
  const zoom = storedZoom ?? 140;
  const mode = useStore((s) => s.layout.timelineMode ?? "tracks");
  const play = useStore((s) => s.play);
  const pause = useStore((s) => s.pause);
  const stop = useStore((s) => s.stop);
  const setPlayhead = useStore((s) => s.setPlayhead);
  const setDuration = useStore((s) => s.setDuration);
  const setFps = useStore((s) => s.setFps);
  const setUi = useStore((s) => s.setUi);
  const setLayout = useStore((s) => s.setLayout);
  const setKeyAtPlayhead = useStore((s) => s.setKeyAtPlayhead);
  const setCameraKeyAtPlayhead = useStore((s) => s.setCameraKeyAtPlayhead);
  const retimeKey = useStore((s) => s.retimeKey);
  const deleteKey = useStore((s) => s.deleteKey);
  const select = useStore((s) => s.select);
  const setActiveCamera = useStore((s) => s.setActiveCamera);
  const addMarkerAt = useStore((s) => s.addMarker);
  const updateMarker = useStore((s) => s.updateMarker);
  const retimeMarker = useStore((s) => s.retimeMarker);
  const removeMarker = useStore((s) => s.removeMarker);
  const selectedMarkerId = useStore((s) => s.selectedMarker);

  const rows = buildRows(doc, selection);
  const areaRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [selectedKey, setSelectedKey] = useState<{ rowKey: string; t: number } | null>(null);
  // Open marker editor popover: viewport coords captured from the marker chip.
  const [markerPop, setMarkerPop] = useState<{ id: string; x: number; y: number } | null>(null);

  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const measure = () => {
      setWidth(el.clientWidth);
      // First visit (no stored zoom): fit the whole duration to the width.
      if (useStore.getState().layout.timelineZoom == null && el.clientWidth > 0 && doc.duration > 0) {
        useStore.getState().setLayout({ timelineZoom: clampZoom(el.clientWidth / doc.duration) });
      }
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, [doc.duration, mode]);

  // Zoomable time axis: pixels per second. The content is at least as wide as
  // the viewport; zooming in makes it scrollable.
  const contentWidth = Math.max(width, doc.duration * zoom);
  const tToX = useCallback((time: number) => time * zoom, [zoom]);
  const xToT = useCallback((x: number) => x / Math.max(zoom, 0.001), [zoom]);

  // Anchor for cursor-staying-still zoom (ctrl/cmd + wheel).
  const zoomAnchor = useRef<{ pxInView: number; time: number } | null>(null);
  useLayoutEffect(() => {
    const el = areaRef.current;
    const anchor = zoomAnchor.current;
    if (!el || !anchor) return;
    zoomAnchor.current = null;
    el.scrollLeft = Math.max(0, anchor.time * zoom - anchor.pxInView);
  }, [zoom, contentWidth]);

  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const rect = el.getBoundingClientRect();
        const pxInView = e.clientX - rect.left;
        const time = (pxInView + el.scrollLeft) / Math.max(zoom, 0.001);
        zoomAnchor.current = { pxInView, time };
        const factor = e.deltaY < 0 ? 1.2 : 1 / 1.2;
        setLayout({ timelineZoom: clampZoom(zoom * factor) });
        return;
      }
      // Zoomed in: vertical wheel / trackpad swipe pans the timeline.
      const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (el.scrollWidth > el.clientWidth && delta !== 0) {
        e.preventDefault();
        el.scrollLeft += delta;
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoom, setLayout, mode]);

  // Keep the playhead visible while playing on a zoomed timeline.
  useEffect(() => {
    const el = areaRef.current;
    if (!el || !playing) return;
    const x = tToX(playhead);
    if (x < el.scrollLeft + 16) el.scrollLeft = Math.max(0, x - 40);
    else if (x > el.scrollLeft + el.clientWidth - 48) el.scrollLeft = x - el.clientWidth + 96;
  }, [playhead, playing, tToX]);

  // Click-and-drag scrubbing: sets the playhead immediately, then follows
  // pointermove anywhere until release (listeners on window so dragging
  // outside the timeline keeps working).
  const beginScrub = useCallback(
    (e: React.PointerEvent) => {
      pause();
      const content = contentRef.current;
      if (!content) return;
      const apply = (clientX: number) => {
        const rect = content.getBoundingClientRect();
        setPlayhead(Math.min(Math.max(xToT(clientX - rect.left), 0), doc.duration));
      };
      apply(e.clientX);
      const move = (ev: PointerEvent) => apply(ev.clientX);
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    },
    [pause, setPlayhead, xToT, doc.duration],
  );

  // --- keyframe dragging (time-addressed, robust against re-sorting) ---
  const beginKeyDrag = (e: React.PointerEvent, target: KeyTarget, rowKey: string, startT: number) => {
    e.stopPropagation();
    e.preventDefault();
    pause();
    setSelectedKey({ rowKey, t: startT });
    let lastT = startT;
    const content = contentRef.current;
    const move = (ev: PointerEvent) => {
      if (!content) return;
      const rect = content.getBoundingClientRect();
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

  // Delete the selected keyframe or marker via keyboard. Capture phase +
  // stopPropagation so this beats App's global object-Delete handler (same as
  // the graph editor): with a timeline key/marker selected, Delete removes
  // that item only.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!selectedKey && !selectedMarkerId) return;
      const active = document.activeElement;
      if (active && ["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName)) return;
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        e.stopPropagation();
        if (selectedMarkerId) {
          removeMarker(selectedMarkerId);
          setMarkerPop(null);
        } else if (selectedKey) {
          const target: KeyTarget = selectedKey.rowKey.startsWith("cam:")
            ? { cameraId: selectedKey.rowKey.slice(4) }
            : { objectId: selectedKey.rowKey };
          deleteKey(target, selectedKey.t);
          setSelectedKey(null);
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [selectedKey, selectedMarkerId, deleteKey, removeMarker]);

  // Marker editor popover: closes on Escape or a press outside it (and
  // outside the marker chips, so dragging another marker just works).
  useEffect(() => {
    if (!markerPop) return;
    const close = (e: PointerEvent) => {
      const el = e.target as Element | null;
      if (el?.closest?.(".marker-pop, .tl-marker")) return;
      setMarkerPop(null);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMarkerPop(null);
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", esc);
    };
  }, [markerPop]);

  /** Anchor the popover to a marker chip, flipping above it when the window
   *  has no room below (the timeline sits at the bottom of the screen). */
  const openMarkerPopAt = useCallback((id: string, chip: { left: number; top: number; bottom: number }) => {
    const POP_H = 170;
    const fitsBelow = chip.bottom + 4 + POP_H <= window.innerHeight - 8;
    setMarkerPop({
      id,
      x: chip.left,
      y: fitsBelow ? chip.bottom + 4 : Math.max(8, chip.top - POP_H - 4),
    });
  }, []);

  // Marker chip interaction: drag retimes (cuts reposition live); a plain
  // click selects and opens the camera-binding popover.
  const beginMarkerDrag = (e: React.PointerEvent, m: MarkerDesc) => {
    e.stopPropagation();
    e.preventDefault();
    pause();
    setUi("selectedMarker", m.id);
    setSelectedKey(null);
    const content = contentRef.current;
    const chip = e.currentTarget as HTMLElement;
    const startX = e.clientX;
    let moved = false;
    const move = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientX - startX) < 3) return;
      moved = true;
      setMarkerPop(null);
      if (!content) return;
      const rect = content.getBoundingClientRect();
      const nextT = Math.min(Math.max(xToT(ev.clientX - rect.left), 0), doc.duration);
      retimeMarker(m.id, nextT);
      setPlayhead(nextT);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (!moved) openMarkerPopAt(m.id, chip.getBoundingClientRect());
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // Marker chip interaction inside the graph/action editors (no marker lane
  // there): clicking a chip selects the marker and opens the popover.
  const editMarkerChip = useCallback(
    (e: React.PointerEvent, m: MarkerDesc) => {
      e.stopPropagation();
      e.preventDefault();
      pause();
      setUi("selectedMarker", m.id);
      setSelectedKey(null);
      openMarkerPopAt(m.id, (e.currentTarget as HTMLElement).getBoundingClientRect());
    },
    [pause, setUi, openMarkerPopAt],
  );

  // Toolbar entry: add a marker at the playhead bound to the live camera,
  // then open the popover on the fresh chip so a camera can be picked. Two
  // rAFs so the new chip is committed to the DOM before it is measured.
  const addMarkerHere = () => {
    setSelectedKey(null);
    const id = addMarkerAt();
    if (!id) return;
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const el = document.querySelector<HTMLElement>(`[data-marker-id="${id}"]`);
        if (el) openMarkerPopAt(id, el.getBoundingClientRect());
      }),
    );
  };

  const step = tickStep(zoom);
  const tickCount = Math.floor(doc.duration / step + 1e-6);
  const tickLabel = (i: number) => `${+(i * step).toFixed(2)}s`;

  const zoomBy = (factor: number) => setLayout({ timelineZoom: clampZoom(zoom * factor) });
  const zoomFit = () => setLayout({ timelineZoom: clampZoom(width / Math.max(doc.duration, 0.5)) });

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
        {/* Auto-key recording (Blender-style): record dot + mode menu. While
         *  recording, playback keeps running during gizmo drags and stops at
         *  the end of the timeline instead of looping. */}
        <button
          type="button"
          className={`btn small rec-dot${autoKey ? " on" : ""}`}
          title={t("timeline.autoKey")}
          aria-pressed={autoKey}
          onClick={() => setUi("autoKey", !autoKey)}
        >
          ●
        </button>
        <select
          className="ak-mode"
          value={autoKeyMode}
          disabled={!autoKey}
          title={t("timeline.autoKeyMode")}
          aria-label={t("timeline.autoKeyMode")}
          onChange={(e) => setUi("autoKeyMode", e.target.value as "addReplace" | "replace")}
        >
          <option value="addReplace">{t("timeline.akAddReplace")}</option>
          <option value="replace">{t("timeline.akReplace")}</option>
        </select>
        <button className="btn small" onClick={() => setKeyAtPlayhead()} disabled={selection.length === 0}>
          ◆ {t("timeline.setKey")}
        </button>
        <button className="btn small" onClick={() => setCameraKeyAtPlayhead()}>
          🎥◆ {t("timeline.setCameraKey")}
        </button>
        <button className="btn small" title={t("timeline.addMarker")} onClick={addMarkerHere}>
          ⚑ {t("timeline.addMarkerShort")}
        </button>
        <span className="spacer" />
        <span className="tl-mode" role="group" aria-label={t("timeline.mode")}>
          <button
            className={`btn small ${mode === "tracks" ? "active" : ""}`}
            title={t("timeline.modeTracks")}
            onClick={() => setLayout({ timelineMode: "tracks" })}
          >
            ▤
          </button>
          <button
            className={`btn small ${mode === "graph" ? "active" : ""}`}
            title={t("timeline.modeGraph")}
            onClick={() => setLayout({ timelineMode: "graph" })}
          >
            ∿
          </button>
          <button
            className={`btn small ${mode === "actions" ? "active" : ""}`}
            title={t("timeline.modeActions")}
            onClick={() => setLayout({ timelineMode: "actions" })}
          >
            ◇
          </button>
        </span>
        <span className="tl-zoom" role="group" aria-label={t("timeline.zoom")}>
          <button className="btn small" title={t("timeline.zoomOut")} onClick={() => zoomBy(1 / 1.5)}>
            －
          </button>
          <button className="btn small" title={t("timeline.zoomIn")} onClick={() => zoomBy(1.5)}>
            ＋
          </button>
          <button className="btn small" title={t("timeline.zoomFit")} onClick={zoomFit}>
            ⤢ {t("timeline.zoomFitShort")}
          </button>
        </span>
      </div>

      <div className="timeline-body">
        {mode === "graph" ? (
          <GraphEditor onMarkerChipDown={editMarkerChip} />
        ) : mode === "actions" ? (
          <ActionEditor onMarkerChipDown={editMarkerChip} />
        ) : (
          <>
            <div className="track-labels">
              <div className="tl-ruler" />
              <div className="tlabels-inner">
                <div className="track-label markers" title={t("timeline.markersLaneTitle")}>
                  <span className="tl-marker-glyph">⚑</span>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{t("timeline.markersLane")}</span>
                </div>
                {rows.map((row) => (
                  <div
                    key={row.key}
                    className={`track-label ${row.cameraId ? "camera" : ""}`}
                    title={row.cameraId ? t("timeline.camRowHint") : undefined}
                    onClick={(e) => {
                      if (row.objectId) select(row.objectId, e.shiftKey || e.ctrlKey || e.metaKey);
                      else if (row.cameraId) setUi("camPanelSel", row.cameraId);
                    }}
                  >
                    {row.cameraId && (
                      <LiveStar
                        cameraId={row.cameraId}
                        title={t(row.cameraId === doc.activeCameraId ? "inspector.setActive" : "timeline.markerLiveHint")}
                        onMakeActive={() => setActiveCamera(row.cameraId!)}
                      />
                    )}
                    {!row.cameraId && (
                      <span
                        style={{ width: 8, height: 8, borderRadius: 2, background: row.color, flexShrink: 0 }}
                      />
                    )}
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{row.label}</span>
                    <span style={{ flex: 1 }} />
                    <span className="kbadge">{row.keys.length}</span>
                  </div>
                ))}
                {doc.actions.every((a) => a.keys.length === 0) && (
                  <div className="empty-note">{t("timeline.noTracks")}</div>
                )}
              </div>
            </div>

            <div className="track-area" ref={areaRef}>
              <div className="tl-content" ref={contentRef} style={{ width: contentWidth }}>
                <div
                  className="tl-ruler"
                  onPointerDown={beginScrub}
                >
                  {Array.from({ length: tickCount + 1 }, (_, i) => i).map((i) => (
                    <div key={i} className="tl-tick" style={{ left: `${tToX(i * step)}px` }}>
                      {tickLabel(i)}
                    </div>
                  ))}
                </div>
                <div className="tl-row markers" onPointerDown={beginScrub}>
                  {doc.markers.map((m) => {
                    const isSel = selectedMarkerId === m.id;
                    const cam = doc.cameras.find((c) => c.id === m.cameraId);
                    return (
                      <div
                        key={m.id}
                        data-marker-id={m.id}
                        className={`tl-marker ${isSel ? "selected" : ""}`}
                        style={{ left: `${tToX(m.t)}px` }}
                        title={`${m.name} @ ${m.t.toFixed(2)}s → ${cam?.name ?? m.cameraId} (${t("timeline.markerHint")})`}
                        onPointerDown={(e) => beginMarkerDrag(e, m)}
                      >
                        <span className="tl-marker-flag">⚑</span>
                        <span className="tl-marker-name">{m.name}</span>
                      </div>
                    );
                  })}
                </div>
                {rows.map((row) => (
                  <div
                    key={row.key}
                    className="tl-row"
                    onPointerDown={beginScrub}
                  >
                    {row.keys.map((key, index) => {
                      const target: KeyTarget = row.cameraId ? { cameraId: row.cameraId } : { objectId: row.objectId! };
                      const rowKey = row.key;
                      const isSelected = selectedKey?.rowKey === rowKey && Math.abs(selectedKey.t - key.t) < 1e-4;
                      return (
                        <div
                          key={`${key.t}-${index}`}
                          className={`keyframe ${row.cameraId ? "camera-key" : ""} ${isSelected ? "selected-key" : ""}`}
                          style={{ left: `${tToX(key.t)}px` }}
                          title={t("timeline.deleteKey")}
                          onPointerDown={(e) => beginKeyDrag(e, target, rowKey, key.t)}
                        />
                      );
                    })}
                  </div>
                ))}
                <MarkerOverlay tToX={tToX} topOffset={22} />
                <Playhead duration={doc.duration} tToX={tToX} />
              </div>
            </div>
          </>
        )}
      </div>

      {markerPop &&
        (() => {
          const m = doc.markers.find((x) => x.id === markerPop.id);
          if (!m) return null;
          return (
            <div className="pivot-menu marker-pop" style={{ left: markerPop.x, top: markerPop.y }}>
              <div className="pivot-menu-title">{t("timeline.markerEdit")}</div>
              <label className="marker-pop-field">
                {t("timeline.markerName")}
                <input value={m.name} onChange={(e) => updateMarker(m.id, { name: e.target.value })} />
              </label>
              <label className="marker-pop-field">
                {t("timeline.markerCamera")}
                <select value={m.cameraId} onChange={(e) => updateMarker(m.id, { cameraId: e.target.value })}>
                  {doc.cameras.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="btn small marker-pop-delete"
                onClick={() => {
                  removeMarker(m.id);
                  setMarkerPop(null);
                }}
              >
                {t("timeline.deleteMarker")}
              </button>
            </div>
          );
        })()}
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

/** Per-camera "live" star: filled while THIS camera is the one rendering at
 *  the playhead (markers may have cut away from the manual active camera).
 *  Subscribes to the playhead so only the stars tick during playback. */
function LiveStar({ cameraId, title, onMakeActive }: { cameraId: string; title: string; onMakeActive: () => void }) {
  const live = useStore((s) => activeCameraIdAt(s.doc, s.playhead) === cameraId);
  return (
    <button
      className={`tl-cam-star ${live ? "on" : ""}`}
      title={title}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onMakeActive();
      }}
    >
      {live ? "★" : "☆"}
    </button>
  );
}

/** Camera-cut markers drawn over one editor view: a thin dashed vertical line
 *  at each marker's start frame spanning the view, plus — when `onChipDown`
 *  is given — a compact chip (for views without a marker lane). Render inside
 *  the view's positioned `.tl-content`; `topOffset` skips the 22px ruler. */
export function MarkerOverlay({
  tToX,
  topOffset = 22,
  onChipDown,
}: {
  tToX: (time: number) => number;
  topOffset?: number;
  onChipDown?: (e: React.PointerEvent, m: MarkerDesc) => void;
}) {
  const t = useT();
  const markers = useStore((s) => s.doc.markers);
  const cameras = useStore((s) => s.doc.cameras);
  const selectedMarkerId = useStore((s) => s.selectedMarker);
  return (
    <>
      {markers.map((m) => {
        const cam = cameras.find((c) => c.id === m.cameraId);
        return (
          <Fragment key={m.id}>
            <div className="tl-marker-cut" style={{ left: `${tToX(m.t)}px`, top: topOffset }} />
            {onChipDown && (
              <div
                data-marker-id={m.id}
                className={`tl-marker tl-marker-compact ${selectedMarkerId === m.id ? "selected" : ""}`}
                style={{ left: `${tToX(m.t)}px`, top: topOffset + 3 }}
                title={`${m.name} @ ${m.t.toFixed(2)}s → ${cam?.name ?? m.cameraId} · ${t("timeline.markerClickHint")}`}
                onPointerDown={(e) => onChipDown(e, m)}
              >
                <span className="tl-marker-flag">⚑</span>
                <span className="tl-marker-name">{m.name}</span>
              </div>
            )}
          </Fragment>
        );
      })}
    </>
  );
}
