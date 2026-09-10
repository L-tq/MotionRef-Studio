import { evaluate } from "../core/animation";
import { ASPECT_PRESETS, aspectLabel, clampAspect, focalToFov, fovToFocal, FOCAL_PRESETS } from "../core/cameraMath";
import { docAspect, specOf, type ObjectDesc, type Vec3 } from "../core/types";
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

function Vec3Input({ value, onChange, step = 0.1 }: { value: Vec3; onChange: (v: Vec3) => void; step?: number }) {
  return (
    <div className="vec-row">
      <span className="axis">X</span>
      <Num value={value[0]} step={step} onChange={(v) => onChange([v, value[1], value[2]])} />
      <span className="axis">Y</span>
      <Num value={value[1]} step={step} onChange={(v) => onChange([value[0], v, value[2]])} />
      <span className="axis">Z</span>
      <Num value={value[2]} step={step} onChange={(v) => onChange([value[0], value[1], v])} />
    </div>
  );
}

function ObjectInspector({ obj }: { obj: ObjectDesc }) {
  const t = useT();
  const locale = getLocale();
  const mutateDoc = useStore((s) => s.mutateDoc);
  const commitPose = useStore((s) => s.commitPose);
  const deleteObjects = useStore((s) => s.deleteObjects);
  const setKeyAtPlayhead = useStore((s) => s.setKeyAtPlayhead);
  const clearTrack = useStore((s) => s.clearTrack);
  const track = useStore((s) => s.doc.tracks[obj.id]);
  const spec = specOf(obj.type);

  const patch = (fn: (o: ObjectDesc) => void, label = "inspect") =>
    mutateDoc(label, (d) => {
      const target = d.objects.find((o) => o.id === obj.id);
      if (target) fn(target);
    });

  return (
    <div className="insp-section">
      <h4>
        {t("inspector.object")}: {obj.name}
        {track?.length ? <span className="chip">{t("inspector.keyedBadge")}</span> : null}
      </h4>
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
        <Vec3Input value={obj.position} onChange={(v) => commitPose(obj.id, { position: v })} />
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
          onChange={(v) =>
            commitPose(obj.id, {
              rotation: [(v[0] * Math.PI) / 180, (v[1] * Math.PI) / 180, (v[2] * Math.PI) / 180],
            })
          }
        />
      </div>
      <div className="field">
        <label>{t("inspector.scale")}</label>
        <Vec3Input value={obj.scale} onChange={(v) => commitPose(obj.id, { scale: v })} />
      </div>

      <div className="insp-row">
        <label>{t("inspector.color")}</label>
        <input
          type="color"
          value={obj.color}
          onChange={(e) => patch((o) => void (o.color = e.target.value), "color")}
        />
        <span style={{ fontFamily: "var(--mono)", fontSize: 11 }}>{obj.color}</span>
      </div>
      <div className="insp-row">
        <label>{t("inspector.visible")}</label>
        <input
          type="checkbox"
          checked={obj.visible}
          onChange={(e) => patch((o) => void (o.visible = e.target.checked), "visible")}
        />
      </div>

      <div className="insp-row" style={{ gap: 6 }}>
        <button className="btn small" onClick={() => setKeyAtPlayhead(obj.id)}>
          ◆ {t("inspector.keyAtPlayhead")}
        </button>
        {track?.length ? (
          <button className="btn small danger" onClick={() => clearTrack(obj.id)}>
            {t("inspector.clearTrack")}
          </button>
        ) : null}
        <span className="spacer" style={{ flex: 1 }} />
        <button className="btn small danger" onClick={() => deleteObjects([obj.id])}>
          {t("common.delete")}
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
  const [focalInput, setFocalInput] = useState<number | null>(null);
  const [aspectInput, setAspectInput] = useState<number | null>(null);

  const cam = evaluate(doc, playhead).camera;
  const focal = fovToFocal(cam.fov);
  const aspect = docAspect(doc);

  return (
    <div className="insp-section">
      <h4>
        {t("inspector.camera")}
        <span className="spacer" />
        <span style={{ fontWeight: 400, textTransform: "none" }}>
          {t("inspector.camKeys", { n: doc.cameraKeys.length })}
        </span>
      </h4>
      <div className="field">
        <label>{t("inspector.fov")} ({t("common.deg")})</label>
        <input
          type="range"
          min={10}
          max={120}
          step={0.5}
          value={cam.fov}
          onChange={(e) => commitCamera({ fov: parseFloat(e.target.value) })}
        />
        <div className="insp-row">
          <Num value={cam.fov} step={1} min={1} max={179} onChange={(v) => commitCamera({ fov: v })} />
          <span style={{ color: "var(--text-3)" }}>↔ {t("inspector.focal")}: </span>
          <Num
            value={focalInput ?? Math.round(focal)}
            step={1}
            min={2}
            max={800}
            onChange={(v) => {
              setFocalInput(v);
              commitCamera({ fov: focalToFov(v) });
            }}
          />
          <span style={{ color: "var(--text-3)" }}>mm</span>
        </div>
        <div className="insp-row" style={{ gap: 4 }}>
          {FOCAL_PRESETS.map((f) => (
            <button key={f} className="btn small" onClick={() => commitCamera({ fov: focalToFov(f) })}>
              {f}mm
            </button>
          ))}
        </div>
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
        <label>{t("inspector.cameraPosition")}</label>
        <Vec3Input value={cam.position} onChange={(v) => commitCamera({ position: v })} />
      </div>
      <div className="field">
        <label>{t("inspector.cameraTarget")}</label>
        <Vec3Input value={cam.target} onChange={(v) => commitCamera({ target: v })} />
      </div>
      <div className="insp-row">
        <button className="btn small" onClick={() => setCameraKeyAtPlayhead()}>
          ◆ {t("timeline.setCameraKey")}
        </button>
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
  const selection = useStore((s) => s.selection);
  const obj = useStore((s) => s.doc.objects.find((o) => o.id === s.selection[0]));

  return (
    <div className="panel" style={{ flex: 1, borderBottom: "1px solid var(--border)" }}>
      <div className="panel-header">
        <span>{t("inspector.object")}</span>
      </div>
      <div className="inspector">
        {selection.length === 0 || !obj ? (
          <div className="empty-note">{t("inspector.noSelection")}</div>
        ) : (
          <ObjectInspector key={obj.id} obj={obj} />
        )}
        <CameraInspector />
        <SceneInspector />
      </div>
    </div>
  );
}
