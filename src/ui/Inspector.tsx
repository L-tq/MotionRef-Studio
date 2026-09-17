import { evalCameraById } from "../core/animation";
import { ASPECT_PRESETS, aspectLabel, clampAspect, focalToFov, fovToFocal, FOCAL_PRESETS } from "../core/cameraMath";
import { cameraFarClip, clampFarClip, docAspect, actionsOfOwner, activeActionOfOwner, activeCameraIdAt, specOf, type CameraDesc, type ObjectDesc, type Vec3 } from "../core/types";
import { useStore } from "../state/store";
import { getLocale, useT } from "../i18n";
import { useState } from "react";

function Num({ value, onChange, step = 0.1, min, max }: { value: number; onChange: (v: number) => void; step?: number; min?: number; max?: number }) {
  return (
    <input
      type="number"
      value={Number.isFinite(value) ? +value.toFixed(4) : 0}
      step={step}
      min={min}
      max={max}
      onChange={(e) => {
        const v = parseFloat(e.target.value);
        if (Number.isFinite(v)) onChange(v);
      }}
    />
  );
}

function Vec3Input({ value, onChange, step = 0.1 }: { value: Vec3; onChange: (v: Vec3, axis: number) => void; step?: number }) {
  return (
    <div className="vec-row">
      <span className="axis">X</span>
      <Num value={value[0]} step={step} onChange={(v) => onChange([v, value[1], value[2]], 0)} />
      <span className="axis">Y</span>
      <Num value={value[1]} step={step} onChange={(v) => onChange([value[0], v, value[2]], 1)} />
      <span className="axis">Z</span>
      <Num value={value[2]} step={step} onChange={(v) => onChange([value[0], value[1], v], 2)} />
    </div>
  );
}

function ObjectInspector({ obj, ids }: { obj: ObjectDesc; ids: string[] }) {
  const t = useT();
  const locale = getLocale();
  const mutateDoc = useStore((s) => s.mutateDoc);
  const commitPose = useStore((s) => s.commitPose);
  const deleteObjects = useStore((s) => s.deleteObjects);
  const setKeyAtPlayhead = useStore((s) => s.setKeyAtPlayhead);
  const clearTrack = useStore((s) => s.clearTrack);
  const createAction = useStore((s) => s.createAction);
  const deleteAction = useStore((s) => s.deleteAction);
  const setActiveAction = useStore((s) => s.setActiveAction);
  const doc = useStore((s) => s.doc);
  const actions = actionsOfOwner(doc, { objectId: obj.id });
  const action = activeActionOfOwner(doc, { objectId: obj.id });
  const hasKeys = actions.some((a) => a.keys.length > 0);
  const spec = specOf(obj.type);
  // Multi-selection: pose, color, visibility, keying and delete hit every
  // selected object; name, geometry params and actions stay per-object.
  const multi = ids.length > 1;

  const patch = (fn: (o: ObjectDesc) => void, label = "inspect") =>
    mutateDoc(label, (d) => {
      const target = d.objects.find((o) => o.id === obj.id);
      if (target) fn(target);
    });

  const patchAll = (fn: (o: ObjectDesc) => void, label: string) =>
    mutateDoc(label, (d) => {
      for (const id of ids) {
        const target = d.objects.find((o) => o.id === id);
        if (target) fn(target);
      }
    });

  const rad = (v: Vec3): Vec3 => [(v[0] * Math.PI) / 180, (v[1] * Math.PI) / 180, (v[2] * Math.PI) / 180];

  /** Multi-edit one transform field: set ONLY the edited axis on every
   *  selected object (each keeps its other components), like Blender's
   *  property fields; single-selection writes the whole vector as before. */
  const commitAxisAll = (chan: "position" | "rotation" | "scale", axis: number, v: Vec3) => {
    if (!multi) {
      commitPose(obj.id, chan === "rotation" ? { rotation: rad(v) } : { [chan]: v });
      return;
    }
    const doc = useStore.getState().doc;
    for (const id of ids) {
      const cur = doc.objects.find((o) => o.id === id);
      if (!cur) continue;
      const vec = [...cur[chan]] as Vec3;
      vec[axis] = chan === "rotation" ? (v[axis] * Math.PI) / 180 : v[axis];
      commitPose(id, { [chan]: vec });
    }
  };

  return (
    <div className="insp-section">
      <h4>
        {t("inspector.object")}: {obj.name}
        {multi ? <span className="chip" title={t("inspector.multiEditHint")}>+{ids.length - 1}</span> : null}
        {hasKeys ? <span className="chip">{t("inspector.keyedBadge")}</span> : null}
      </h4>
      {multi ? <div className="hint" style={{ color: "var(--text-3)" }}>{t("inspector.multiEditHint", { n: ids.length })}</div> : null}
      <div className="field">
        <label>{t("inspector.name")}</label>
        <input type="text" value={obj.name} onChange={(e) => patch((o) => void (o.name = e.target.value), "rename")} />
      </div>

      <div className="field">
        <label>{t("inspector.params")}</label>
        <div className="insp-grid">
          {spec.params.map((p) => (
            <div key={p.key} className="insp-row">
              <label>{locale === "zh" ? p.labelZh : p.label}</label>
              <Num
                value={obj.params[p.key] ?? spec.defaults[p.key]}
                step={p.step}
                min={p.min}
                max={p.max}
                onChange={(v) => patch((o) => void (o.params[p.key] = v), "params")}
              />
            </div>
          ))}
        </div>
      </div>

      <div className="field">
        <label>{t("inspector.position")}</label>
        <Vec3Input value={obj.position} onChange={(v, axis) => commitAxisAll("position", axis, v)} />
      </div>
      <div className="field">
        <label>{t("inspector.rotation")} ({t("common.deg")})</label>
        <Vec3Input
          step={5}
          value={[
            (obj.rotation[0] * 180) / Math.PI,
            (obj.rotation[1] * 180) / Math.PI,
            (obj.rotation[2] * 180) / Math.PI,
          ]}
          onChange={(v, axis) => commitAxisAll("rotation", axis, v)}
        />
      </div>
      <div className="field">
        <label>{t("inspector.scale")}</label>
        <Vec3Input value={obj.scale} onChange={(v, axis) => commitAxisAll("scale", axis, v)} />
      </div>

      <div className="insp-row">
        <label>{t("inspector.color")}</label>
        <input
          type="color"
          value={obj.color}
          onChange={(e) => patchAll((o) => void (o.color = e.target.value), "color")}
        />
        <span style={{ fontFamily: "var(--mono)", fontSize: 11 }}>{obj.color}</span>
      </div>
      <div className="insp-row">
        <label>{t("inspector.visible")}</label>
        <input
          type="checkbox"
          checked={obj.visible}
          onChange={(e) => patchAll((o) => void (o.visible = e.target.checked), "visible")}
        />
      </div>

      <div className="insp-row" style={{ gap: 6 }}>
        <button className="btn small" onClick={() => ids.forEach((id) => setKeyAtPlayhead(id))}>
          ◆ {t("inspector.keyAtPlayhead")}
        </button>
        {hasKeys ? (
          <button className="btn small danger" onClick={() => clearTrack(obj.id)}>
            {t("inspector.clearTrack")}
          </button>
        ) : null}
        <span className="spacer" style={{ flex: 1 }} />
        <button className="btn small danger" onClick={() => deleteObjects([...ids])}>
          {t("common.delete")}
        </button>
      </div>
      {/* Actions (Blender-style): pick the ACTIVE one; manage in the Action Editor. */}
      <div className="insp-row" style={{ gap: 4 }}>
        <label style={{ flexShrink: 0 }}>{t("action.title")}</label>
        <select
          value={action?.id ?? ""}
          title={t("action.active")}
          onChange={(e) => setActiveAction(e.target.value)}
          style={{ flex: 1, minWidth: 0 }}
        >
          {actions.length === 0 && <option value="">—</option>}
          {actions.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name} ({a.keys.length})
            </option>
          ))}
        </select>
        <button className="btn small" title={t("action.new")} onClick={() => createAction({ objectId: obj.id })}>
          ＋
        </button>
        <button
          className="btn small danger"
          title={t("action.delete")}
          disabled={!action}
          onClick={() => action && deleteAction(action.id)}
        >
          🗑
        </button>
      </div>
    </div>
  );
}

function CameraInspector() {
  const t = useT();
  const doc = useStore((s) => s.doc);
  const playhead = useStore((s) => s.playhead);
  const commitCamera = useStore((s) => s.commitCamera);
  const setAspect = useStore((s) => s.setAspect);
  const setCameraKeyAtPlayhead = useStore((s) => s.setCameraKeyAtPlayhead);
  const mutateDoc = useStore((s) => s.mutateDoc);
  const addCamera = useStore((s) => s.addCamera);
  const removeCamera = useStore((s) => s.removeCamera);
  const setActiveCamera = useStore((s) => s.setActiveCamera);
  const setLayout = useStore((s) => s.setLayout);
  const viewportFarClip = useStore((s) => s.layout.viewportFarClip);
  const camPanelSel = useStore((s) => s.camPanelSel);
  const setUi = useStore((s) => s.setUi);
  const createAction = useStore((s) => s.createAction);
  const deleteAction = useStore((s) => s.deleteAction);
  const setActiveAction = useStore((s) => s.setActiveAction);
  const [focalInput, setFocalInput] = useState<number | null>(null);
  const [aspectInput, setAspectInput] = useState<number | null>(null);

  // The panel edits ONE camera: the picked one, or the active camera by default.
  const camDesc = doc.cameras.find((c) => c.id === camPanelSel) ?? doc.cameras[0];
  const isLive = camDesc.id === doc.activeCameraId;
  // "Rendering" = the LIVE camera at the playhead (markers may have cut away
  // from the manual active camera).
  const isRendering = camDesc.id === activeCameraIdAt(doc, playhead);
  const ev = evalCameraById(doc, camDesc.id, playhead);
  const focal = fovToFocal(ev.fov);
  const aspect = docAspect(doc);
  const camActions = actionsOfOwner(doc, { cameraId: camDesc.id });
  const camAction = activeActionOfOwner(doc, { cameraId: camDesc.id });
  const keyCount = camActions.reduce((n, a) => n + a.keys.length, 0);

  const patchCam = (fn: (c: CameraDesc) => void, label: string) =>
    mutateDoc(label, (d) => {
      const c = d.cameras.find((x) => x.id === camDesc.id);
      if (c) fn(c);
    });

  // Blender "align active camera to view": copy the editor viewport pose.
  const alignToView = () => {
    const eng = (window as unknown as {
      __mrsEngine?: {
        getEditorCamera(): { position: { x: number; y: number; z: number } };
        getOrbitTarget(): { x: number; y: number; z: number };
      };
    }).__mrsEngine;
    if (!eng) return;
    const p = eng.getEditorCamera().position;
    const tg = eng.getOrbitTarget();
    commitCamera({ position: [p.x, p.y, p.z], target: [tg.x, tg.y, tg.z] }, camDesc.id);
  };

  return (
    <div className="insp-section">
      <h4>
        {t("inspector.cameras")}
        <span className="spacer" />
        <span style={{ fontWeight: 400, textTransform: "none" }}>
          {t("inspector.camKeys", { n: keyCount })}
        </span>
      </h4>
      <div className="insp-row">
        <select
          value={camDesc.id}
          onChange={(e) => setUi("camPanelSel", e.target.value)}
          style={{ flex: 1, minWidth: 0 }}
          title={t("inspector.camSelect")}
        >
          {doc.cameras.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
              {c.id === doc.activeCameraId ? " ★" : ""}
            </option>
          ))}
        </select>
        <button className="btn small" title={t("inspector.addCamera")} onClick={addCamera}>
          ＋
        </button>
      </div>
      <div className="insp-row" style={{ gap: 4, flexWrap: "wrap" }}>
        <button
          className={`btn small ${isLive ? "active" : ""}`}
          title={t("inspector.setActive")}
          onClick={() => setActiveCamera(camDesc.id)}
        >
          ★ {isLive ? t("inspector.activeBadge") : t("inspector.setActiveShort")}
        </button>
        {isRendering && (
          <span className="live-badge" title={t("inspector.liveBadge")}>
            ● {t("inspector.liveBadge")}
          </span>
        )}
        <button className="btn small" title={t("inspector.alignToView")} onClick={alignToView}>
          {t("inspector.alignToViewShort")}
        </button>
        <span className="spacer" style={{ flex: 1 }} />
        <button
          className="btn small danger"
          title={t("inspector.removeCamera")}
          disabled={doc.cameras.length <= 1}
          onClick={() => removeCamera(camDesc.id)}
        >
          🗑
        </button>
      </div>
      <div className="field">
        <label>{t("inspector.name")}</label>
        <input type="text" value={camDesc.name} onChange={(e) => patchCam((c) => void (c.name = e.target.value), "rename-camera")} />
      </div>
      <div className="field">
        <label>{t("inspector.fov")} ({t("common.deg")})</label>
        <input
          type="range"
          min={10}
          max={120}
          step={0.5}
          value={ev.fov}
          onChange={(e) => commitCamera({ fov: parseFloat(e.target.value) }, camDesc.id)}
        />
        <div className="insp-row">
          <Num value={ev.fov} step={1} min={1} max={179} onChange={(v) => commitCamera({ fov: v }, camDesc.id)} />
          <span style={{ color: "var(--text-3)" }}>↔ {t("inspector.focal")}: </span>
          <Num
            value={focalInput ?? Math.round(focal)}
            step={1}
            min={2}
            max={800}
            onChange={(v) => {
              setFocalInput(v);
              commitCamera({ fov: focalToFov(v) }, camDesc.id);
            }}
          />
          <span style={{ color: "var(--text-3)" }}>mm</span>
        </div>
        <div className="insp-row" style={{ gap: 4 }}>
          {FOCAL_PRESETS.map((f) => (
            <button key={f} className="btn small" onClick={() => commitCamera({ fov: focalToFov(f) }, camDesc.id)}>
              {f}mm
            </button>
          ))}
        </div>
      </div>
      <div className="field">
        <label>{t("inspector.cameraPosition")}</label>
        <Vec3Input value={ev.position} onChange={(v) => commitCamera({ position: v }, camDesc.id)} />
      </div>
      <div className="field">
        <label>{t("inspector.farClip")}</label>
        <div className="insp-row">
          <Num
            value={cameraFarClip(camDesc)}
            step={50}
            min={1}
            onChange={(v) => patchCam((c) => void (c.farClip = clampFarClip(v)), "camera-farclip")}
          />
          <span className="hint" style={{ color: "var(--text-3)", flex: 1 }}>{t("inspector.farClipHint")}</span>
        </div>
      </div>
      <div className="field">
        <label>{t("inspector.cameraTarget")}</label>
        <Vec3Input value={ev.target} onChange={(v) => commitCamera({ target: v }, camDesc.id)} />
      </div>
      <div className="insp-row">
        <button className="btn small" onClick={() => setCameraKeyAtPlayhead(camDesc.id)}>
          ◆ {t("timeline.setCameraKey")}
        </button>
      </div>
      {/* Camera actions: pick the ACTIVE one; manage in the Action Editor. */}
      <div className="insp-row" style={{ gap: 4 }}>
        <label style={{ flexShrink: 0 }}>{t("action.title")}</label>
        <select
          value={camAction?.id ?? ""}
          title={t("action.active")}
          onChange={(e) => setActiveAction(e.target.value)}
          style={{ flex: 1, minWidth: 0 }}
        >
          {camActions.length === 0 && <option value="">—</option>}
          {camActions.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name} ({a.keys.length})
            </option>
          ))}
        </select>
        <button className="btn small" title={t("action.new")} onClick={() => createAction({ cameraId: camDesc.id })}>
          ＋
        </button>
        <button
          className="btn small danger"
          title={t("action.delete")}
          disabled={!camAction}
          onClick={() => camAction && deleteAction(camAction.id)}
        >
          🗑
        </button>
      </div>
      <div className="field">
        <label>
          {t("inspector.aspect")} · <span style={{ fontFamily: "var(--mono)" }}>{aspectLabel(aspect)}</span>
        </label>
        <div className="insp-row" style={{ gap: 4, flexWrap: "wrap" }}>
          {ASPECT_PRESETS.map((a) => (
            <button
              key={a}
              className={`btn small ${Math.abs(aspect - a) < 0.01 ? "active" : ""}`}
              onClick={() => {
                setAspectInput(null);
                setAspect(a);
              }}
            >
              {aspectLabel(a)}
            </button>
          ))}
          <Num
            value={aspectInput ?? +aspect.toFixed(3)}
            step={0.05}
            min={0.2}
            max={5}
            onChange={(v) => {
              setAspectInput(v);
              setAspect(clampAspect(v));
            }}
          />
        </div>
        <span className="hint" style={{ color: "var(--text-3)" }}>{t("inspector.aspectHint")}</span>
      </div>
      <div className="field">
        <label>{t("inspector.viewportFarClip")}</label>
        <Num
          value={viewportFarClip}
          step={50}
          min={1}
          onChange={(v) => setLayout({ viewportFarClip: clampFarClip(v) })}
        />
        <span className="hint" style={{ color: "var(--text-3)" }}>{t("inspector.viewportFarClipHint")}</span>
      </div>
    </div>
  );
}

function SceneInspector() {
  const t = useT();
  const doc = useStore((s) => s.doc);
  const mutateDoc = useStore((s) => s.mutateDoc);
  const [editing, setEditing] = useState<number | null>(null);
  return (
    <div className="insp-section">
      <h4>
        {t("inspector.onFrameScripts")}
        <span className="spacer" />
        <button
          className="btn small"
          title={t("inspector.hookAdd")}
          onClick={() =>
            mutateDoc("add-script", (d) => {
              d.onFrameScripts.push('(t, f, state) => {\n  \n}');
              setEditing(d.onFrameScripts.length - 1);
            })
          }
        >
          ＋
        </button>
      </h4>
      <div className="hint" style={{ color: "var(--text-3)" }}>{t("inspector.hookHint")}</div>
      {doc.onFrameScripts.map((src, i) => (
        <div key={i} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <div className="insp-row">
            <span className="chip">#{i}</span>
            <code
              style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--text-2)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", cursor: "pointer" }}
              onClick={() => setEditing(editing === i ? null : i)}
              title={src}
            >
              {src.replace(/\s+/g, " ").slice(0, 64) || "…"}
            </code>
            <button className="btn small" onClick={() => setEditing(editing === i ? null : i)}>
              ✎
            </button>
            <button
              className="btn small danger"
              title={t("inspector.removeScript")}
              onClick={() => {
                mutateDoc("rm-script", (d) => {
                  d.onFrameScripts.splice(i, 1);
                });
                setEditing(null);
              }}
            >
              ✕
            </button>
          </div>
          {editing === i && (
            <textarea
              className="code"
              value={src}
              spellCheck={false}
              rows={4}
              style={{ fontFamily: "var(--mono)", fontSize: 11, width: "100%", resize: "vertical" }}
              onChange={(e) =>
                mutateDoc("edit-script", (d) => {
                  if (d.onFrameScripts[i] !== undefined) d.onFrameScripts[i] = e.target.value;
                })
              }
            />
          )}
        </div>
      ))}
      <div className="insp-row">
        <label>{t("inspector.background")}</label>
        <input
          type="color"
          value={doc.background}
          onChange={(e) =>
            mutateDoc("background", (d) => {
              d.background = e.target.value;
            })
          }
        />
        <span style={{ fontFamily: "var(--mono)", fontSize: 11 }}>{doc.background}</span>
      </div>
    </div>
  );
}

export function Inspector() {
  const t = useT();
  const setUi = useStore((s) => s.setUi);
  const tab = useStore((s) => s.inspectorTab);
  const selection = useStore((s) => s.selection);
  const obj = useStore((s) => s.doc.objects.find((o) => o.id === s.selection[0]));

  return (
    <div className="panel" style={{ flex: 1, borderBottom: "1px solid var(--border)" }}>
      <div className="right-tabs">
        <button className={tab === "object" ? "active" : ""} onClick={() => setUi("inspectorTab", "object")}>
          {t("inspector.object")}
        </button>
        <button className={tab === "cameras" ? "active" : ""} onClick={() => setUi("inspectorTab", "cameras")}>
          {t("inspector.cameras")}
        </button>
        <button className={tab === "scene" ? "active" : ""} onClick={() => setUi("inspectorTab", "scene")}>
          {t("inspector.onFrameScripts")}
        </button>
      </div>
      <div className="inspector">
        {tab === "object" &&
          (selection.length === 0 || !obj ? (
            <div className="empty-note">{t("inspector.noSelection")}</div>
          ) : (
            <ObjectInspector key={obj.id} obj={obj} ids={selection} />
          ))}
        {tab === "cameras" && <CameraInspector />}
        {tab === "scene" && <SceneInspector />}
      </div>
    </div>
  );
}
