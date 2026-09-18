/** Blender-style Action Editor: manage per-owner actions (create / duplicate /
 *  rename / delete / activate) with an editable dopesheet of every action the
 *  selected owner has — not just the active one. Only the ACTIVE action's keys
 *  drive preview/playback; other actions are dimmed but their keys can still
 *  be selected, retimed (drag) and deleted right here (ops carry actionId).
 *
 *  Channel rows are summaries (like Blender's collapsed F-curve groups): the
 *  key times that define each component group, not per-axis curves — per-axis
 *  editing lives in the graph editor.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Copy, Plus, Star, Trash2 } from "lucide-react";
import { useStore, type KeyTarget } from "../state/store";
import { useT } from "../i18n";
import {
  actionsOfOwner,
  activeActionOfOwner,
  activeCameraOf,
  type ActionDesc,
  type MarkerDesc,
  type SceneDocument,
} from "../core/types";
import { MarkerOverlay } from "./Timeline";

type AnyKey = SceneDocument["actions"][number]["keys"][number];

interface ChanSummary {
  id: string;
  labelKey: string;
  times: number[];
}

/** Summary channels of one action's keys (only groups that have keys). */
function chanSummaries(keys: AnyKey[], isCamera: boolean): ChanSummary[] {
  const has = (k: AnyKey, chan: "position" | "rotation" | "scale" | "target") => {
    const v = k[chan as keyof typeof k] as unknown;
    return !!v && Array.isArray(v) && v.some((x) => x !== null && x !== undefined);
  };
  const defs: Array<{ id: string; labelKey: string; sel: (k: AnyKey) => boolean }> = isCamera
    ? [
        { id: "position", labelKey: "inspector.cameraPosition", sel: (k) => has(k, "position") },
        { id: "target", labelKey: "inspector.cameraTarget", sel: (k) => has(k, "target") },
        { id: "fov", labelKey: "inspector.fov", sel: (k) => (k as { fov?: number }).fov !== undefined },
      ]
    : [
        { id: "position", labelKey: "inspector.position", sel: (k) => has(k, "position") },
        { id: "rotation", labelKey: "inspector.rotation", sel: (k) => has(k, "rotation") },
        { id: "scale", labelKey: "inspector.scale", sel: (k) => has(k, "scale") },
        { id: "color", labelKey: "inspector.color", sel: (k) => (k as { color?: string }).color !== undefined },
        { id: "visible", labelKey: "inspector.visible", sel: (k) => (k as { visible?: boolean }).visible !== undefined },
      ];
  return defs
    .map((d) => ({ id: d.id, labelKey: d.labelKey, times: keys.filter(d.sel).map((k) => k.t) }))
    .filter((d) => d.times.length > 0);
}

interface Row {
  key: string;
  actionId: string;
  actionName: string;
  isActiveAction: boolean;
  isHeader: boolean;
  /** Whether the header is expanded (header rows only). */
  isOpen: boolean;
  /** Null on header rows (which list all key times). */
  labelKey: string | null;
  times: number[];
  /** Header only: total keys in the action. */
  keyCount: number;
  target: KeyTarget;
}

const ZOOM_MIN = 20;
const ZOOM_MAX = 500;
const clampZoom = (z: number) => Math.min(Math.max(Math.round(z), ZOOM_MIN), ZOOM_MAX);

function tickStepFor(zoom: number): number {
  const candidates = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60];
  return candidates.find((s) => s * zoom >= 64) ?? 60;
}

export function ActionEditor({ onMarkerChipDown }: { onMarkerChipDown?: (e: React.PointerEvent, m: MarkerDesc) => void }) {
  const t = useT();
  const doc = useStore((s) => s.doc);
  const selection = useStore((s) => s.selection);
  const camPanelSel = useStore((s) => s.camPanelSel);
  const playing = useStore((s) => s.playing);
  const playhead = useStore((s) => s.playhead);
  const storedZoom = useStore((s) => s.layout.timelineZoom);
  const zoom = storedZoom ?? 140;
  const pause = useStore((s) => s.pause);
  const setPlayhead = useStore((s) => s.setPlayhead);
  const setLayout = useStore((s) => s.setLayout);
  const createAction = useStore((s) => s.createAction);
  const duplicateAction = useStore((s) => s.duplicateAction);
  const deleteAction = useStore((s) => s.deleteAction);
  const renameAction = useStore((s) => s.renameAction);
  const setActiveAction = useStore((s) => s.setActiveAction);
  const retimeKey = useStore((s) => s.retimeKey);
  const deleteKey = useStore((s) => s.deleteKey);

  /** Which owner the editor shows: "obj:<id>" / "cam:<id>". Null = follow the
   *  viewport selection / camera panel pick. */
  const [override, setOverride] = useState<string | null>(null);
  const areaRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [selectedKey, setSelectedKey] = useState<{ rowKey: string; t: number } | null>(null);
  /** Expand/collapse overrides; unset ids follow the active action. */
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);

  const activeCamId = activeCameraOf(doc).id;
  const defaultTarget = selection[0] ? `obj:${selection[0]}` : `cam:${camPanelSel ?? activeCamId}`;
  const rawTarget = override ?? defaultTarget;
  const isCameraTarget = rawTarget.startsWith("cam:");
  const targetId = rawTarget.slice(4);
  const targetExists = isCameraTarget
    ? doc.cameras.some((c) => c.id === targetId)
    : doc.objects.some((o) => o.id === targetId);
  const target = targetExists ? rawTarget : defaultTarget;
  const effCamera = target.startsWith("cam:");
  const ownerId = target.slice(4);
  const owner = effCamera ? { cameraId: ownerId } : { objectId: ownerId };

  const acts: ActionDesc[] = actionsOfOwner(doc, owner);
  const activeAct = activeActionOfOwner(doc, owner);

  const rows: Row[] = acts.flatMap((a) => {
    const isOpen = expanded.has(a.id) ? true : collapsed.has(a.id) ? false : a.id === activeAct?.id;
    const target: KeyTarget =
      a.kind === "object" ? { objectId: a.objectId, actionId: a.id } : { cameraId: a.cameraId, actionId: a.id };
    const head: Row = {
      key: `${a.id}:head`,
      actionId: a.id,
      actionName: a.name,
      isActiveAction: a.id === activeAct?.id,
      isHeader: true,
      isOpen,
      labelKey: null,
      times: a.keys.map((k) => k.t),
      keyCount: a.keys.length,
      target,
    };
    if (!isOpen) return [head];
    const chans = chanSummaries(a.keys, a.kind === "camera").map<Row>((c) => ({
      key: `${a.id}:${c.id}`,
      actionId: a.id,
      actionName: a.name,
      isActiveAction: a.id === activeAct?.id,
      isHeader: false,
      isOpen,
      labelKey: c.labelKey,
      times: c.times,
      keyCount: 0,
      target,
    }));
    return [head, ...chans];
  });

  const contentWidth = Math.max(width, doc.duration * zoom);
  const tToX = useCallback((time: number) => time * zoom, [zoom]);
  const xToT = useCallback((x: number) => x / Math.max(zoom, 0.001), [zoom]);

  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const measure = () => {
      setWidth(el.clientWidth);
      if (useStore.getState().layout.timelineZoom == null && el.clientWidth > 0 && doc.duration > 0) {
        useStore.getState().setLayout({ timelineZoom: clampZoom(el.clientWidth / doc.duration) });
      }
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, [doc.duration]);

  // Cursor-staying-still zoom (ctrl/cmd + wheel), panning otherwise.
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
      const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (el.scrollWidth > el.clientWidth && delta !== 0) {
        e.preventDefault();
        el.scrollLeft += delta;
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoom, setLayout]);

  // Keep the playhead visible while playing on a zoomed timeline.
  useEffect(() => {
    const el = areaRef.current;
    if (!el || !playing) return;
    const x = tToX(playhead);
    if (x < el.scrollLeft + 16) el.scrollLeft = Math.max(0, x - 40);
    else if (x > el.scrollLeft + el.clientWidth - 48) el.scrollLeft = x - el.clientWidth + 96;
  }, [playhead, playing, tToX]);

  // Click-and-drag scrubbing (same behavior as the keyframe timeline).
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

  // Key dragging within ONE specific action (target carries actionId), so
  // keys of non-active actions can be retimed without switching.
  const beginKeyDrag = (e: React.PointerEvent, row: Row, startT: number) => {
    e.stopPropagation();
    e.preventDefault();
    pause();
    setSelectedKey({ rowKey: row.key, t: startT });
    let lastT = startT;
    const content = contentRef.current;
    const move = (ev: PointerEvent) => {
      if (!content) return;
      const rect = content.getBoundingClientRect();
      const nextT = Math.min(Math.max(xToT(ev.clientX - rect.left), 0), doc.duration);
      retimeKey(row.target, lastT, nextT);
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

  // Delete the selected keyframe via keyboard. Capture phase + stopPropagation
  // so this beats App's global object-Delete handler (same as the graph
  // editor): with a dopesheet key selected, Delete removes the KEY only.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!selectedKey) return;
      const active = document.activeElement;
      if (active && ["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName)) return;
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        e.stopPropagation();
        const row = rows.find((r) => r.key === selectedKey.rowKey);
        if (row) deleteKey(row.target, selectedKey.t);
        setSelectedKey(null);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [selectedKey, rows, deleteKey]);

  const toggleExpand = (actionId: string, isOpen: boolean) => {
    if (isOpen) {
      setCollapsed((s) => new Set(s).add(actionId));
      setExpanded((s) => {
        const n = new Set(s);
        n.delete(actionId);
        return n;
      });
    } else {
      setExpanded((s) => new Set(s).add(actionId));
      setCollapsed((s) => {
        const n = new Set(s);
        n.delete(actionId);
        return n;
      });
    }
  };

  const commitRename = () => {
    if (renaming) {
      const clean = renaming.value.trim();
      if (clean) renameAction(renaming.id, clean);
    }
    setRenaming(null);
  };

  const step = tickStepFor(zoom);
  const tickCount = Math.floor(doc.duration / step + 1e-6);
  const tickLabel = (i: number) => `${+(i * step).toFixed(2)}s`;

  return (
    <div className="action-editor">
      <div className="action-toolbar">
        <select
          className="action-target"
          value={target}
          title={t("action.target")}
          onChange={(e) => setOverride(e.target.value)}
        >
          {doc.objects.map((o) => (
            <option key={o.id} value={`obj:${o.id}`}>
              {o.name}
            </option>
          ))}
          {doc.cameras.map((c) => (
            <option key={c.id} value={`cam:${c.id}`}>
              {`⌖ ${c.name}${c.id === doc.activeCameraId ? ` · ${t("inspector.activeBadge")}` : ""}`}
            </option>
          ))}
        </select>
        <select
          className="action-acts"
          value={activeAct?.id ?? ""}
          disabled={acts.length === 0}
          title={t("action.active")}
          onChange={(e) => setActiveAction(e.target.value)}
        >
          {acts.length === 0 && <option value="">—</option>}
          {acts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <button className="btn small" title={t("action.new")} onClick={() => createAction(owner)}>
          <Plus size={12} />
        </button>
        <button className="btn small" title={t("action.duplicate")} disabled={!activeAct} onClick={() => activeAct && duplicateAction(activeAct.id)}>
          <Copy size={12} />
        </button>
        <button className="btn small danger" title={t("action.delete")} disabled={!activeAct} onClick={() => activeAct && deleteAction(activeAct.id)}>
          <Trash2 size={12} />
        </button>
      </div>

      <div className="action-columns">
        <div className="track-labels">
          <div className="tl-ruler" />
          <div className="tlabels-inner">
            {acts.length === 0 && <div className="empty-note">{t("action.noActions")}</div>}
            {rows.map((row) =>
              row.isHeader ? (
                <div
                  key={row.key}
                  className={`track-label action-head ${row.isActiveAction ? "active" : "dimmed"}`}
                  title={row.isActiveAction ? t("action.active") : t("action.activateHint")}
                  onClick={() => setActiveAction(row.actionId)}
                >
                  <button
                    className="action-caret"
                    title={t("action.expand")}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleExpand(row.actionId, row.isOpen);
                    }}
                  >
                    {row.isOpen ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                  </button>
                  {renaming?.id === row.actionId ? (
                    <input
                      autoFocus
                      value={renaming.value}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => setRenaming({ id: renaming.id, value: e.target.value })}
                      onBlur={commitRename}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                        if (e.key === "Escape") setRenaming(null);
                      }}
                    />
                  ) : (
                    <span
                      className="action-name"
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        setRenaming({ id: row.actionId, value: row.actionName });
                      }}
                    >
                      {row.actionName}
                    </span>
                  )}
                  {row.isActiveAction && (
                    <span className="action-star">
                      <Star size={10} fill="currentColor" />
                    </span>
                  )}
                  <span style={{ flex: 1 }} />
                  <span className="kbadge">{row.keyCount}</span>
                </div>
              ) : (
                <div key={row.key} className={`track-label action-chan ${row.isActiveAction ? "" : "dimmed"}`}>
                  {t(row.labelKey!)}
                </div>
              ),
            )}
          </div>
        </div>

        <div className="track-area" ref={areaRef}>
          <div className="tl-content" ref={contentRef} style={{ width: contentWidth }}>
            <div className="tl-ruler" onPointerDown={beginScrub}>
              {Array.from({ length: tickCount + 1 }, (_, i) => i).map((i) => (
                <div key={i} className="tl-tick" style={{ left: `${tToX(i * step)}px` }}>
                  {tickLabel(i)}
                </div>
              ))}
            </div>
            {rows.map((row) => (
              <div
                key={row.key}
                className={`tl-row ${row.isHeader ? "action-head-row" : "action-chan-row"}`}
                onPointerDown={beginScrub}
              >
                {row.times.map((time, index) => {
                  const isSelected = selectedKey?.rowKey === row.key && Math.abs(selectedKey.t - time) < 1e-4;
                  return (
                    <div
                      key={`${time}-${index}`}
                      className={`keyframe ${row.isActiveAction ? "" : "dimmed-key"} ${isSelected ? "selected-key" : ""}`}
                      style={{ left: `${tToX(time)}px` }}
                      title={row.isHeader ? t("timeline.deleteKey") : t(row.labelKey!)}
                      onPointerDown={(e) => beginKeyDrag(e, row, time)}
                    />
                  );
                })}
              </div>
            ))}
            <MarkerOverlay tToX={tToX} topOffset={22} onChipDown={onMarkerChipDown} />
            <Playhead duration={doc.duration} tToX={tToX} />
          </div>
        </div>
      </div>
    </div>
  );
}

function Playhead({ duration, tToX }: { duration: number; tToX: (time: number) => number }) {
  const playhead = useStore((s) => s.playhead);
  const left = Math.min(Math.max(tToX(playhead), 0), tToX(duration));
  return <div className="playhead" style={{ left: `${left}px` }} />;
}
