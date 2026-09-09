import { useState, type ReactElement } from "react";
import { GEOMETRY_CATALOG, type GeometryType } from "../core/types";
import { useStore } from "../state/store";
import { getLocale, useT } from "../i18n";

/** Minimal wireframe icons for the palette. */
const ICONS: Record<GeometryType, ReactElement> = {
  box: (
    <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.4">
      <path d="M6 11 16 6l10 5v10l-10 5-10-5zM6 11l10 5 10-5M16 16v10" />
    </svg>
  ),
  sphere: (
    <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.4">
      <circle cx="16" cy="16" r="10" />
      <ellipse cx="16" cy="16" rx="10" ry="4" />
      <ellipse cx="16" cy="16" rx="4" ry="10" />
    </svg>
  ),
  cylinder: (
    <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.4">
      <ellipse cx="16" cy="8" rx="8" ry="3.2" />
      <path d="M8 8v16M24 8v16" />
      <path d="M8 24c0 1.8 3.6 3.2 8 3.2s8-1.4 8-3.2" />
    </svg>
  ),
  cone: (
    <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.4">
      <path d="M16 5 7 24M16 5l9 19" />
      <ellipse cx="16" cy="24" rx="9" ry="3.4" />
    </svg>
  ),
  torus: (
    <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.4">
      <ellipse cx="16" cy="16" rx="11" ry="7" />
      <ellipse cx="16" cy="16" rx="5" ry="2.8" />
    </svg>
  ),
  plane: (
    <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.4">
      <path d="M16 6 27 16 16 26 5 16z" />
      <path d="M5 16h22M16 6v20" strokeDasharray="2 3" />
    </svg>
  ),
  capsule: (
    <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.4">
      <rect x="11" y="6" width="10" height="20" rx="5" />
    </svg>
  ),
  ring: (
    <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.4">
      <circle cx="16" cy="16" r="11" />
      <circle cx="16" cy="16" r="5.5" />
    </svg>
  ),
  tetrahedron: (
    <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.4">
      <path d="M16 5 27 24H5zM16 5v19M5 24l11-8 11 8" />
    </svg>
  ),
  octahedron: (
    <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.4">
      <path d="M16 4 28 16 16 28 4 16zM16 4v24M4 16h24" />
    </svg>
  ),
  dodecahedron: (
    <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.4">
      <path d="M16 4 27 12l-4 13H9L5 12zM9 25 5 12l11-3 11 3-4 13M16 4l-3 18M27 12 13 22" />
    </svg>
  ),
  icosahedron: (
    <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.4">
      <path d="M16 4 28 13l-4 13H8L4 13zM16 4l6 22M16 4l-6 22M4 13l24 0M8 26l18-13M24 26 8 13" />
    </svg>
  ),
  torusKnot: (
    <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.4">
      <path d="M16 8c8 0 12 4 12 8s-4 8-12 8-12-4-12-8 4-8 12-8z" />
      <path d="M9 11c6 4 8 6 14 10M23 11c-6 4-8 6-14 10" />
    </svg>
  ),
};

export function LeftPanel() {
  const t = useT();
  const locale = getLocale();
  const doc = useStore((s) => s.doc);
  const selection = useStore((s) => s.selection);
  const addObject = useStore((s) => s.addObject);
  const select = useStore((s) => s.select);
  const deleteObjects = useStore((s) => s.deleteObjects);
  const duplicateObject = useStore((s) => s.duplicateObject);
  const mutateDoc = useStore((s) => s.mutateDoc);
  const [renaming, setRenaming] = useState<string | null>(null);

  const selected = new Set(selection);

  return (
    <div className="panel left-panel">
      <div className="panel-header">
        <span>{t("panel.addGeometry")}</span>
      </div>
      <div className="palette">
        {GEOMETRY_CATALOG.map((spec) => (
          <button
            key={spec.type}
            title={locale === "zh" ? spec.labelZh : spec.label}
            onClick={() => addObject(spec.type)}
          >
            {ICONS[spec.type]}
            <span>{locale === "zh" ? spec.labelZh : spec.label}</span>
          </button>
        ))}
      </div>
      <div className="panel-header">
        <span>{t("panel.hierarchy")}</span>
        <span className="spacer" />
        <span>{t("panel.objects", { n: doc.objects.length })}</span>
      </div>
      <div className="panel-body">
        {doc.objects.length === 0 ? (
          <div className="empty-note">{t("panel.empty")}</div>
        ) : (
          <div className="hierarchy">
            {doc.objects.map((obj) => (
              <div
                key={obj.id}
                className={`hrow ${selected.has(obj.id) ? "selected" : ""}`}
                onClick={(e) => select(obj.id, e.shiftKey || e.ctrlKey || e.metaKey)}
              >
                <span className="dot" style={{ background: obj.color, opacity: obj.visible ? 1 : 0.25 }} />
                {renaming === obj.id ? (
                  <input
                    autoFocus
                    defaultValue={obj.name}
                    onClick={(e) => e.stopPropagation()}
                    onBlur={(e) => {
                      const name = e.target.value.trim() || obj.name;
                      mutateDoc("rename", (d) => {
                        const target = d.objects.find((o) => o.id === obj.id);
                        if (target) target.name = name;
                      });
                      setRenaming(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                      if (e.key === "Escape") setRenaming(null);
                    }}
                  />
                ) : (
                  <span
                    className="name"
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      setRenaming(obj.id);
                    }}
                  >
                    {obj.name}
                  </span>
                )}
                {doc.tracks[obj.id]?.length ? <span className="badge" title={t("hierarchy.keyed")}>◆</span> : null}
                <button
                  className={`icon-btn ${obj.visible ? "" : "hidden-eye"}`}
                  title={t("hierarchy.visibility")}
                  onClick={(e) => {
                    e.stopPropagation();
                    mutateDoc("visible", (d) => {
                      const target = d.objects.find((o) => o.id === obj.id);
                      if (target) target.visible = !target.visible;
                    });
                  }}
                >
                  {obj.visible ? "👁" : "🚫"}
                </button>
                <button
                  className="icon-btn"
                  title={t("common.duplicate")}
                  onClick={(e) => {
                    e.stopPropagation();
                    duplicateObject(obj.id);
                  }}
                >
                  ⧉
                </button>
                <button
                  className="icon-btn danger"
                  title={t("common.delete")}
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteObjects([obj.id]);
                  }}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
