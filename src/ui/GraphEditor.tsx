/** Curve graph editor (Blender-style): per-channel value curves for the
 *  selected object or the scene camera, with draggable keys.
 *
 *  Keys remain the shared full-pose keyframes of the SceneDocument — dragging
 *  a point edits that key's channel value and/or time. Curves are sampled
 *  with the same interpolation math as the evaluator (linear/step/smooth),
 *  ignoring onFrame overlays, so points always lie on their curves.
 *
 *  Multi-selection: drag a rubber-band box over the plot (Shift adds), or use
 *  the Select all / Deselect all buttons atop the channel list. Dragging any
 *  selected point moves the whole selection in time (and shifts selected
 *  values vertically, 1:1 with the mouse); Delete removes selected keys;
 *  "≈" applies a Gaussian smooth (σ = kernel width in key count) to exactly
 *  the selected points.
 *
 *  Delete and retime are CHANNEL-SCOPED: keys are shared full-pose records,
 *  but moving/deleting points of one property (e.g. Position X) splits the
 *  shared key so other properties keep their own keys at their own times.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../state/store";
import { useT } from "../i18n";
import type { CameraKey, KeyVec3, SceneDocument, TransformKey, Vec3 } from "../core/types";

type KeyTarget = { objectId: string } | { camera: true };
type AnyKey = TransformKey | CameraKey;

interface ChannelDef {
  id: string;
  label: string;
  group: string;
  color: string;
  /** Display multiplier (radians → degrees for rotation channels). */
  scale: number;
  read(key: AnyKey): number | undefined;
  base(doc: SceneDocument, objectId?: string): number;
  /** Build a setKeyValues patch that sets this channel to `value` (display
   *  units) while keeping the key's other components. */
  makePatch(doc: SceneDocument, target: KeyTarget, atT: number, value: number): Parameters<ReturnType<typeof useStore.getState>["setKeyValues"]>[2];
  /** SceneDocument component this channel maps to (for smoothKeys). */
  comp: { chan: "position" | "rotation" | "scale" | "target" | "fov"; index: number };
}

function objectChannels(objectId: string, basePos: Vec3, baseRot: Vec3, baseScl: Vec3): ChannelDef[] {
  const CH: Array<{ i: number; c: string }> = [
    { i: 0, c: "#ff6b6b" },
    { i: 1, c: "#3ddc97" },
    { i: 2, c: "#38bdf8" },
  ];
  const keyAt = (doc: SceneDocument, atT: number): TransformKey | undefined =>
    (doc.tracks[objectId] ?? []).find((k) => Math.abs(k.t - atT) < 1e-4);
  const chans: ChannelDef[] = [];
  const groups: Array<{ group: string; prefix: string; sel: (k: TransformKey) => KeyVec3 | undefined; base: Vec3 }> = [
    { group: "Position", prefix: "pos", sel: (k) => k.position, base: basePos },
    { group: "Rotation", prefix: "rot", sel: (k) => k.rotation, base: baseRot },
    { group: "Scale", prefix: "scl", sel: (k) => k.scale, base: baseScl },
  ];
  for (const g of groups) {
    for (const { i, c } of CH) {
      chans.push({
        id: `${g.prefix}.${i}`,
        label: `${g.group} ${"XYZ"[i]}`,
        group: g.group,
        color: c,
        scale: g.group === "Rotation" ? 180 / Math.PI : 1,
        comp: { chan: g.prefix === "pos" ? "position" : g.prefix === "rot" ? "rotation" : "scale", index: i },
        read: (k) => {
          const v = g.sel(k as TransformKey);
          const x = v ? v[i] : undefined;
          return x === undefined || x === null ? undefined : x;
        },
        base: () => g.base[i],
        makePatch: (doc, _target, atT, value) => {
          const k = keyAt(doc, atT);
          const cur = (k && g.sel(k)) || ([...g.base] as Vec3);
          const next = [...cur] as KeyVec3;
          next[i] = value / (g.group === "Rotation" ? 180 / Math.PI : 1);
          if (g.prefix === "pos") return { position: next };
          if (g.prefix === "rot") return { rotation: next };
          return { scale: next };
        },
      });
    }
  }
  return chans;
}

function cameraChannels(): ChannelDef[] {
  const CH: Array<{ i: number; c: string }> = [
    { i: 0, c: "#ff6b6b" },
    { i: 1, c: "#3ddc97" },
    { i: 2, c: "#38bdf8" },
  ];
  const keyAt = (doc: SceneDocument, atT: number): CameraKey | undefined =>
    doc.cameraKeys.find((k) => Math.abs(k.t - atT) < 1e-4);
  const chans: ChannelDef[] = [];
  const groups: Array<{ group: string; prefix: string; sel: (k: CameraKey) => KeyVec3 | undefined }> = [
    { group: "Cam Position", prefix: "cpos", sel: (k) => k.position },
    { group: "Cam Target", prefix: "ctgt", sel: (k) => k.target },
  ];
  for (const g of groups) {
    for (const { i, c } of CH) {
      chans.push({
        id: `${g.prefix}.${i}`,
        label: `${g.group} ${"XYZ"[i]}`,
        group: g.group,
        color: c,
        scale: 1,
        comp: { chan: g.prefix === "cpos" ? "position" : "target", index: i },
        read: (k) => {
          const v = g.sel(k as CameraKey);
          const x = v ? v[i] : undefined;
          return x === undefined || x === null ? undefined : x;
        },
        base: (doc) => (g.prefix === "cpos" ? doc.camera.position[i] : doc.camera.target[i]),
        makePatch: (doc, _target, atT, value) => {
          const k = keyAt(doc, atT);
          const cur =
            (k && g.sel(k)) ||
            (g.prefix === "cpos" ? [...doc.camera.position] : [...doc.camera.target]);
          const next = [...cur] as KeyVec3;
          next[i] = value;
          return g.prefix === "cpos" ? { position: next } : { target: next };
        },
      });
    }
  }
  chans.push({
    id: "fov",
    label: "Cam FOV",
    group: "Cam FOV",
    color: "#ffb020",
    scale: 1,
    comp: { chan: "fov", index: 0 },
    read: (k) => (k as CameraKey).fov,
    base: (doc) => doc.camera.fov,
    makePatch: (_doc, _target, _atT, value) => ({ fov: value }),
  });
  return chans;
}

// --- channel curve sampling (same easing as core/animation) --------------------

function smoothstep(u: number): number {
  return u * u * (3 - 2 * u);
}
function easeFor(interp: string | undefined): (u: number) => number {
  if (interp === "step") return () => 0;
  if (interp === "smooth") return smoothstep;
  return (u) => u;
}

/** Piecewise value function of one channel through the keys that define it. */
function sampler(keys: AnyKey[], chan: ChannelDef, doc: SceneDocument, objectId?: string): (t: number) => number {
  const pts = keys.filter((k) => chan.read(k) !== undefined);
  const base = () => chan.base(doc, objectId);
  if (pts.length === 0) return base;
  return (t: number) => {
    if (t <= pts[0].t) return chan.read(pts[0])!;
    const last = pts[pts.length - 1];
    if (t >= last.t) return chan.read(last)!;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      if (t >= a.t && t <= b.t) {
        const span = b.t - a.t;
        const u = span <= 1e-9 ? 0 : easeFor(b.interp)((t - a.t) / span);
        return chan.read(a)! + (chan.read(b)! - chan.read(a)!) * u;
      }
    }
    return base();
  };
}

const ZOOM_MIN = 20;
const ZOOM_MAX = 500;
const clampZoom = (z: number) => Math.min(Math.max(Math.round(z), ZOOM_MIN), ZOOM_MAX);

function tickStepFor(zoom: number): number {
  const candidates = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60];
  return candidates.find((s) => s * zoom >= 64) ?? 60;
}

export function GraphEditor() {
  const t = useT();
  const doc = useStore((s) => s.doc);
  const selection = useStore((s) => s.selection);
  const playhead = useStore((s) => s.playhead);
  const zoom = useStore((s) => s.layout.timelineZoom ?? 140);
  const setLayout = useStore((s) => s.setLayout);
  const setPlayhead = useStore((s) => s.setPlayhead);
  const pause = useStore((s) => s.pause);
  const retimeKeyChan = useStore((s) => s.retimeKeyChan);
  const deleteKeyChans = useStore((s) => s.deleteKeyChans);
  const setKeyValues = useStore((s) => s.setKeyValues);
  const insertKeyAt = useStore((s) => s.insertKeyAt);
  const smoothKeys = useStore((s) => s.smoothKeys);
  const select = useStore((s) => s.select);

  const selectedObj = useStore((s) => s.doc.objects.find((o) => o.id === s.selection[0]));
  const [kind, setKind] = useState<"object" | "camera">(selection.length ? "object" : "camera");
  const effectiveKind = kind === "object" && !selectedObj ? "camera" : kind;

  const areaRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [plotH, setPlotH] = useState(200);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  /** Multi-selection of curve points: `${channelId}|${t.toFixed(4)}`. Points
   *  of several channels can share one (full-pose) key; retiming moves the
   *  shared key, value edits touch only the selected channels. */
  const [selKeys, setSelKeys] = useState<Set<string>>(new Set());
  const [sigma, setSigma] = useState(1);
  const [rubber, setRubber] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  /** Value range frozen while a point drag is active, so the dragged point
   *  stays 1:1 under the cursor instead of the auto-fit range rescaling. */
  const [rangeOverride, setRangeOverride] = useState<{ min: number; max: number } | null>(null);

  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const el = plotRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setPlotH(Math.max(el.clientHeight, 80)));
    ro.observe(el);
    setPlotH(Math.max(el.clientHeight, 80));
    return () => ro.disconnect();
  }, []);

  const target: KeyTarget = effectiveKind === "camera" ? { camera: true } : { objectId: selectedObj!.id };
  const keys: AnyKey[] = effectiveKind === "camera" ? doc.cameraKeys : doc.tracks[selectedObj!.id] ?? [];
  const channels = useMemo(
    () =>
      effectiveKind === "camera"
        ? cameraChannels()
        : objectChannels(
            selectedObj!.id,
            selectedObj!.position,
            selectedObj!.rotation,
            selectedObj!.scale,
          ),
    [effectiveKind, selectedObj],
  );

  const contentWidth = Math.max(width, doc.duration * zoom);
  const tToX = useCallback((time: number) => time * zoom, [zoom]);
  const xToT = useCallback((x: number) => x / Math.max(zoom, 0.001), [zoom]);

  const keyId = (chanId: string, time: number) => `${chanId}|${time.toFixed(4)}`;
  const channelById = useMemo(() => new Map(channels.map((c) => [c.id, c])), [channels]);

  /** Selected points mapped to store-level components, for Gaussian smoothing. */
  const selPoints = useMemo(
    () =>
      [...selKeys].flatMap((id) => {
        const [cid, ts] = id.split("|");
        const c = channelById.get(cid);
        return c ? [{ chan: c.comp.chan, index: c.comp.index, t: parseFloat(ts) }] : [];
      }),
    [selKeys, channelById],
  );

  // Value range over visible channels (display units), sampled across the clip.
  const visible = channels.filter((c) => !hidden.has(c.id));

  /** Select every point of every visible channel (header button). */
  const selectAllPoints = () => {
    const next = new Set<string>();
    for (const c of visible) {
      for (const k of keys) {
        if (c.read(k) === undefined) continue;
        next.add(keyId(c.id, k.t));
      }
    }
    setSelKeys(next);
  };
  const valueRange = useMemo(() => {
    let min = Infinity;
    let max = -Infinity;
    for (const c of visible) {
      const f = sampler(keys, c, doc, selectedObj?.id);
      const n = 120;
      for (let i = 0; i <= n; i++) {
        const v = f((i / n) * doc.duration) * c.scale;
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: -1, max: 1 };
    if (max - min < 1e-6) {
      const pad = Math.max(Math.abs(max) * 0.2, 0.5);
      return { min: min - pad, max: max + pad };
    }
    const pad = (max - min) * 0.12;
    return { min: min - pad, max: max + pad };
  }, [visible, keys, doc, selectedObj]);

  const effRange = rangeOverride ?? valueRange;
  const yFor = useCallback(
    (v: number) => {
      const { min, max } = effRange;
      return 6 + ((max - v) / (max - min)) * (plotH - 12);
    },
    [effRange, plotH],
  );

  // Wheel: ctrl = zoom (anchored), otherwise pan horizontally.
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
        setLayout({ timelineZoom: clampZoom(zoom * (e.deltaY < 0 ? 1.2 : 1 / 1.2)) });
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

  const beginScrub = (e: React.PointerEvent) => {
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
  };

  /** Drag curve points. Grabbing an unselected point selects it alone; grabbing
   *  a selected point drags the WHOLE selection: horizontal moves every selected
   *  key in time (the shared full-pose key moves once), vertical shifts every
   *  selected channel's value by the same display-unit amount. Shift-click
   *  toggles a point without dragging. */
  const beginPointDrag = (e: React.PointerEvent, chan: ChannelDef, startT: number) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    pause();
    const id = keyId(chan.id, startT);
    let sel = selKeys;
    if (e.shiftKey) {
      sel = new Set(selKeys);
      if (sel.has(id)) sel.delete(id);
      else sel.add(id);
      setSelKeys(sel);
      return;
    }
    if (!sel.has(id)) {
      sel = new Set([id]);
      setSelKeys(sel);
    }
    // Freeze the y-scale for the whole drag: the display range the dv formula
    // uses stays the one on screen, so the point follows the cursor exactly.
    setRangeOverride(valueRange);
    const entries = [...sel].map((s) => {
      const [cid, ts] = s.split("|");
      const c = channelById.get(cid);
      return { chanId: cid, origT: parseFloat(ts), chan: c?.comp.chan, index: c?.comp.index ?? 0 };
    });
    // One move per (channel axis, time): X/Y/Z are independent curves, so
    // dragging "Position X" (or "Cam Position X") must not drag the Y/Z axes
    // — and never other components' keys at the same time.
    const compMoves = [
      ...new Map(
        entries
          .filter((en) => en.chan)
          .map((en) => [
            `${en.chan}.${en.index}|${en.origT}`,
            { chan: en.chan!, index: en.index, origT: en.origT },
          ] as const),
      ).values(),
    ];
    const clampT = (v: number) => Math.min(Math.max(v, 0), doc.duration);
    const keysOf = (d: SceneDocument) => ("camera" in target ? d.cameraKeys : d.tracks[(target as { objectId: string }).objectId] ?? []);
    const startX = e.clientX;
    const startY = e.clientY;
    // Start-of-drag values (display units) and actual current times: every
    // move sets value = v0 + dv and time = t0 + dt absolutely, so the drag
    // follows the mouse 1:1 no matter how many move events fire, and time
    // clamping cannot accumulate drift.
    const docStart = useStore.getState().doc;
    const startVals = entries.map((en) => {
      const ch = channelById.get(en.chanId);
      const k = keysOf(docStart).find((kk) => Math.abs(kk.t - en.origT) < 1e-4);
      const raw = k && ch ? ch.read(k) : undefined;
      return ch && raw !== undefined ? raw * ch.scale : null;
    });
    const curT = new Map(compMoves.map((m) => [`${m.chan}.${m.index}|${m.origT}`, m.origT]));
    let curDt = 0;
    let curDv = 0;
    const move = (ev: PointerEvent) => {
      const dt = (ev.clientX - startX) / zoom;
      const dv = (-(ev.clientY - startY) / Math.max(plotH - 12, 1)) * (valueRange.max - valueRange.min);
      if (Math.abs(dt - curDt) > 1e-4) {
        for (const m of compMoves) {
          const mk = `${m.chan}.${m.index}|${m.origT}`;
          const from = curT.get(mk)!;
          const to = clampT(m.origT + dt);
          if (Math.abs(to - from) > 1e-6) {
            retimeKeyChan(target, m.chan, m.index, from, to);
            curT.set(mk, to);
          }
        }
        curDt = dt;
        // Keep selection ids in step with the moved times so dragged points
        // stay highlighted (and remain grabbed) mid-drag.
        setSelKeys(
          new Set(
            entries.map((en) =>
              keyId(en.chanId, (en.chan && curT.get(`${en.chan}.${en.index}|${en.origT}`)) ?? en.origT),
            ),
          ),
        );
      }
      if (Math.abs(dv - curDv) > 1e-6) {
        for (let i = 0; i < entries.length; i++) {
          const en = entries[i];
          const v0 = startVals[i];
          const ch = channelById.get(en.chanId);
          if (!ch || v0 === null) continue;
          const newT = clampT(en.origT + curDt);
          // Fresh doc per entry: sibling-channel patches on one shared key
          // must not clobber each other with stale components.
          setKeyValues(target, newT, ch.makePatch(useStore.getState().doc, target, newT, v0 + dv));
        }
        curDv = dv;
      }
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setRangeOverride(null);
      // Re-key the selection to the moved times so the next drag keeps working.
      setSelKeys(
        new Set(
          entries.map((en) =>
            keyId(en.chanId, (en.chan && curT.get(`${en.chan}.${en.index}|${en.origT}`)) ?? en.origT),
          ),
        ),
      );
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  /** Rubber-band selection on empty plot space (Blender box select). Shift
   *  adds to the current selection; a tiny box counts as a click (deselect). */
  const beginBoxSelect = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    pause();
    const plot = plotRef.current;
    if (!plot) return;
    const rect0 = plot.getBoundingClientRect();
    const x0 = e.clientX - rect0.left;
    const y0 = e.clientY - rect0.top;
    if (!e.shiftKey) setSelKeys(new Set());
    const move = (ev: PointerEvent) => {
      const r = plot.getBoundingClientRect();
      setRubber({ x0, y0, x1: ev.clientX - r.left, y1: ev.clientY - r.top });
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      const r = plot.getBoundingClientRect();
      const x1 = ev.clientX - r.left;
      const y1 = ev.clientY - r.top;
      setRubber(null);
      const minX = Math.min(x0, x1);
      const maxX = Math.max(x0, x1);
      const minY = Math.min(y0, y1);
      const maxY = Math.max(y0, y1);
      if (maxX - minX < 3 && maxY - minY < 3) return;
      const next = e.shiftKey ? new Set(selKeys) : new Set<string>();
      for (const c of visible) {
        for (const k of keys) {
          const v = c.read(k);
          if (v === undefined) continue;
          const px = tToX(k.t);
          const py = yFor(v * c.scale);
          if (px >= minX && px <= maxX && py >= minY && py <= maxY) next.add(keyId(c.id, k.t));
        }
      }
      setSelKeys(next);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const insertAt = (e: React.MouseEvent) => {
    const content = contentRef.current;
    if (!content) return;
    const rect = content.getBoundingClientRect();
    insertKeyAt(target, xToT(e.clientX - rect.left));
  };

  // Delete the selected points' channel keys / clear selection via keyboard.
  // Capture phase so this runs before App's global bubble listener: with graph
  // keys selected, Delete must remove KEYS, not the selected object. Only the
  // components with selected points lose their keys — e.g. deleting "Position
  // X" keys leaves rotation/scale keys at the same times untouched.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const active = document.activeElement;
      if (active && ["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName)) return;
      if (e.key === "Escape" && selKeys.size) {
        setSelKeys(new Set());
        return;
      }
      if ((e.key === "Delete" || e.key === "Backspace") && selPoints.length) {
        e.preventDefault();
        e.stopPropagation();
        const specs = new Map<string, { chan: (typeof selPoints)[number]["chan"]; index: number; t: number }>();
        for (const p of selPoints) specs.set(`${p.chan}.${p.index}|${p.t.toFixed(4)}`, { chan: p.chan, index: p.index, t: p.t });
        deleteKeyChans(target, [...specs.values()]);
        setSelKeys(new Set());
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [selKeys, selPoints, deleteKeyChans, target]);

  const step = tickStepFor(zoom);
  const tickCount = Math.floor(doc.duration / step + 1e-6);

  // Curve polylines
  const curves = visible.map((c) => {
    const f = sampler(keys, c, doc, selectedObj?.id);
    const n = Math.min(600, Math.max(120, Math.round(contentWidth / 3)));
    let d = "";
    for (let i = 0; i <= n; i++) {
      const time = (i / n) * doc.duration;
      const x = tToX(time);
      const y = yFor(f(time) * c.scale);
      d += `${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
    }
    return { chan: c, d };
  });

  // Grid lines with value labels
  const gridLines = [0, 1 / 3, 2 / 3, 1].map((f) => {
    const v = effRange.max - f * (effRange.max - effRange.min);
    return { y: 6 + f * (plotH - 12), label: formatValue(v) };
  });

  return (
    <>
      <div className="graph-labels">
        <div className="tl-ruler" />
        <div className="graph-target">
          <button
            className={`btn small ${effectiveKind === "object" ? "active" : ""}`}
            disabled={!selectedObj}
            onClick={() => setKind("object")}
            title={t("graph.objectTarget")}
          >
            {selectedObj ? selectedObj.name : t("graph.noObject")}
          </button>
          <button
            className={`btn small ${effectiveKind === "camera" ? "active" : ""}`}
            onClick={() => setKind("camera")}
          >
            🎥 {t("timeline.camera")}
          </button>
        </div>
        <div className="graph-actions">
          <button className="btn small" onClick={selectAllPoints} title={t("graph.selectAll")}>
            {t("graph.selectAll")}
          </button>
          <button
            className="btn small"
            onClick={() => setSelKeys(new Set())}
            disabled={!selKeys.size}
            title={t("graph.deselectAll")}
          >
            {t("graph.deselectAll")}
          </button>
        </div>
        {channels.map((c) => (
          <div key={c.id} className="graph-chan" onClick={() => select(selectedObj?.id ?? null, false)}>
            <span className="dot" style={{ background: c.color }} />
            <span className="name">{c.label}</span>
            <span style={{ flex: 1 }} />
            <button
              className={`graph-eye ${hidden.has(c.id) ? "off" : ""}`}
              title={t("graph.toggleChannel")}
              onClick={(e2) => {
                e2.stopPropagation();
                const next = new Set(hidden);
                if (next.has(c.id)) next.delete(c.id);
                else next.add(c.id);
                setHidden(next);
              }}
            >
              {hidden.has(c.id) ? "◌" : "◉"}
            </button>
          </div>
        ))}
        <div className="graph-smooth">
          <span className="cnt">{t("graph.selected", { n: selPoints.length })}</span>
          <span style={{ flex: 1 }} />
          <label title={t("graph.smoothSigma")}>
            σ
            <input
              type="number"
              min={0.1}
              max={6}
              step={0.1}
              value={sigma}
              onChange={(e2) => setSigma(Math.min(6, Math.max(0.1, parseFloat(e2.target.value) || 1)))}
            />
          </label>
          <button
            className="btn small"
            disabled={!selPoints.length}
            title={t("graph.smooth")}
            onClick={() => smoothKeys(target, selPoints, sigma)}
          >
            ≈
          </button>
        </div>
      </div>

      <div className="track-area" ref={areaRef}>
        <div className="tl-content graph-content" ref={contentRef} style={{ width: contentWidth }}>
          <div className="tl-ruler" onPointerDown={beginScrub}>
            {Array.from({ length: tickCount + 1 }, (_, i) => i).map((i) => (
              <div key={i} className="tl-tick" style={{ left: `${tToX(i * step)}px` }}>
                {`${+(i * step).toFixed(2)}s`}
              </div>
            ))}
          </div>
          <div className="graph-plot" ref={plotRef} onPointerDown={beginBoxSelect} onDoubleClick={insertAt}>
            <svg width={contentWidth} height={plotH}>
              {gridLines.map((g, i) => (
                <g key={i}>
                  <line x1={0} x2={contentWidth} y1={g.y} y2={g.y} className="graph-grid" />
                  <text x={4} y={g.y - 3} className="graph-grid-label">
                    {g.label}
                  </text>
                </g>
              ))}
              {curves.map((c) => (
                <path key={c.chan.id} d={c.d} fill="none" stroke={c.chan.color} strokeWidth={1.4} />
              ))}
              {visible.map((c) =>
                keys
                  .filter((k) => c.read(k) !== undefined)
                  .map((k) => {
                    const isSel = selKeys.has(keyId(c.id, k.t));
                    return (
                      <circle
                        key={`${c.id}@${k.t}`}
                        cx={tToX(k.t)}
                        cy={yFor(c.read(k)! * c.scale)}
                        r={isSel ? 5.5 : 4.5}
                        fill={isSel ? "#ffc24d" : c.color}
                        fillOpacity={isSel ? 1 : 0.3}
                        stroke={isSel ? "#0b0b10" : "#0b0b10"}
                        strokeOpacity={isSel ? 1 : 0.55}
                        className="graph-point"
                        onPointerDown={(e) => beginPointDrag(e, c, k.t)}
                      />
                    );
                  }),
              )}
            </svg>
            {rubber && (
              <div
                className="graph-rubber"
                style={{
                  left: Math.min(rubber.x0, rubber.x1),
                  top: Math.min(rubber.y0, rubber.y1),
                  width: Math.abs(rubber.x1 - rubber.x0),
                  height: Math.abs(rubber.y1 - rubber.y0),
                }}
              />
            )}
            <div className="playhead" style={{ left: `${tToX(playhead)}px` }} />
          </div>
        </div>
      </div>
    </>
  );
}

function formatValue(v: number): string {
  const a = Math.abs(v);
  if (a >= 1000) return v.toFixed(0);
  if (a >= 10) return v.toFixed(1);
  if (a >= 1) return v.toFixed(2);
  return v.toFixed(3);
}
