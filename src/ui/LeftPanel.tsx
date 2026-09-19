import { useRef, useState, type DragEvent, type ReactElement } from "react";
import { ChevronDown, ChevronRight, Copy, Diamond, Eye, EyeOff, Plus, X } from "lucide-react";
import { GEOMETRY_CATALOG, isDescendantOf, type GeometryType, type ObjectDesc } from "../core/types";
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
  empty: (
    <svg viewBox="0 0 32 32" fill="none" strokeWidth="2.2">
      <path d="M16 4v24M4 16h24" stroke="#ff5c7c" />
      <path d="M16 16 6 6M16 16l10 10M16 16 26 6M16 16 6 26" stroke="#38bdf8" strokeWidth="1.6" />
    </svg>
  ),
  instance: (
    <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.4">
      <rect x="4" y="8" width="12" height="12" rx="2" />
      <rect x="14" y="14" width="12" height="12" rx="2" strokeDasharray="3 2.5" />
    </svg>
  ),
};

/** Blender-style folder glyph for collection rows. */
const FOLDER_ICON = (
  <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.6">
    <path d="M5 10a2 2 0 0 1 2-2h6l3 3h9a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2z" />
  </svg>
);

export function LeftPanel() {
  const t = useT();
  const locale = getLocale();
  const doc = useStore((s) => s.doc);
  const selection = useStore((s) => s.selection);
  const addObject = useStore((s) => s.addObject);
  const select = useStore((s) => s.select);
  const selectMany = useStore((s) => s.selectMany);
  const deleteObjects = useStore((s) => s.deleteObjects);
  const duplicateObjects = useStore((s) => s.duplicateObjects);
  const mutateDoc = useStore((s) => s.mutateDoc);
  const addCollection = useStore((s) => s.addCollection);
  const renameCollection = useStore((s) => s.renameCollection);
  const deleteCollection = useStore((s) => s.deleteCollection);
  const moveToCollection = useStore((s) => s.moveToCollection);
  const setCollectionVisible = useStore((s) => s.setCollectionVisible);
  const setParent = useStore((s) => s.setParent);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renamingCol, setRenamingCol] = useState<string | null>(null);
  // Outliner tree state: root disclosure + per-collection collapse + the drop
  // target currently highlighted during a row drag ("root" = scene root).
  const [rootOpen, setRootOpen] = useState(true);
  const [collapsedCols, setCollapsedCols] = useState<Set<string>>(new Set());
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const dragIds = useRef<string[] | null>(null);

  const selected = new Set(selection);
  /** True when any root-level (uncollected) object is selected — highlights
   *  the "Scene Collection" row. */
  const rootHasSelected = doc.objects.some((o) => !o.collectionId && selected.has(o.id));

  const startDrag = (e: DragEvent, obj: ObjectDesc) => {
    // Blender convention: dragging a row that is part of the selection moves
    // the entire selection, not just that row.
    dragIds.current = selected.has(obj.id) && selection.length > 1 ? [...selection] : [obj.id];
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", dragIds.current.join(","));
  };

  const endDrag = () => {
    dragIds.current = null;
    setDropTarget(null);
  };

  /** Order a group's objects parent-first with child depth, so the outliner
   *  shows the hierarchy as indentation (children of parents in ANOTHER group
   *  stay in their own group at depth 0, with a parent hint). */
  const layoutTree = (members: ObjectDesc[]): Array<{ obj: ObjectDesc; depth: number; crossGroupParent?: string }> => {
    const inGroup = new Set(members.map((m) => m.id));
    const byId = new Map(doc.objects.map((o) => [o.id, o] as const));
    const out: Array<{ obj: ObjectDesc; depth: number; crossGroupParent?: string }> = [];
    const emitted = new Set<string>();
    const depthOf = (o: ObjectDesc, guard: Set<string>): number => {
      if (!o.parentId || !inGroup.has(o.parentId) || guard.has(o.id)) return 0;
      guard.add(o.id);
      return 1 + (byId.get(o.parentId) ? depthOf(byId.get(o.parentId)!, guard) : 0);
    };
    const emitRec = (o: ObjectDesc, depth: number) => {
      if (emitted.has(o.id)) return;
      emitted.add(o.id);
      const crossGroupParent = o.parentId && !inGroup.has(o.parentId) ? byId.get(o.parentId)?.name : undefined;
      out.push({ obj: o, depth, crossGroupParent });
      for (const child of members) if (child.parentId === o.id) emitRec(child, depth + 1);
    };
    for (const m of members) emitRec(m, depthOf(m, new Set()));
    return out;
  };

  /** Drag-to-parent: dropping rows on an OBJECT row parents them to it
   *  (keep-world). Drops that would create a cycle are ignored. */
  const dropOnObject = (e: DragEvent, targetId: string) => {
    e.preventDefault();
    e.stopPropagation();
    const ids = dragIds.current ?? [];
    for (const id of ids) {
      if (id === targetId || isDescendantOf(doc, targetId, id)) continue;
      setParent(id, targetId, "world");
    }
    endDrag();
  };

  const renderObjectRow = (obj: ObjectDesc, inCollection: boolean, depth = 0, crossGroupParent?: string) => (
    <div
      key={obj.id}
      className={`hrow ${inCollection ? "in-collection" : ""} ${selected.has(obj.id) ? "selected" : ""} ${dropTarget === `p:${obj.id}` ? "drop-target" : ""}`}
      style={depth ? { marginLeft: (inCollection ? 18 : 0) + depth * 14 } : undefined}
      draggable
      onDragStart={(e) => startDrag(e, obj)}
      onDragEnd={endDrag}
      onDragOver={(e) => {
        if (!dragIds.current) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "move";
        if (dropTarget !== `p:${obj.id}`) setDropTarget(`p:${obj.id}`);
      }}
      onDrop={(e) => dropOnObject(e, obj.id)}
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
          title={crossGroupParent ? t("outliner.parentedIn", { name: crossGroupParent }) : undefined}
          onDoubleClick={(e) => {
            e.stopPropagation();
            setRenaming(obj.id);
          }}
        >
          {obj.type === "instance" ? "⧉ " : ""}
          {obj.name}
          {crossGroupParent ? <span className="dim"> → {crossGroupParent}</span> : null}
        </span>
      )}
      {doc.actions.some((a) => a.kind === "object" && a.objectId === obj.id && a.keys.length > 0) ? (
        <span className="badge" title={t("outliner.keyed")}>
          <Diamond size={8} fill="currentColor" />
        </span>
      ) : null}
      <button
        className={`icon-btn ${obj.visible ? "" : "hidden-eye"}`}
        title={t("outliner.visibility")}
        onClick={(e) => {
          e.stopPropagation();
          mutateDoc("visible", (d) => {
            const target = d.objects.find((o) => o.id === obj.id);
            if (target) target.visible = !target.visible;
          });
        }}
      >
        {obj.visible ? <Eye size={12} /> : <EyeOff size={12} />}
      </button>
      <button
        className="icon-btn"
        title={t("common.duplicate")}
        onClick={(e) => {
          e.stopPropagation();
          // Blender convention: duplicating a row that is part of the selection
          // duplicates the entire selection.
          duplicateObjects(selected.has(obj.id) && selection.length > 1 ? [...selection] : [obj.id]);
        }}
      >
        <Copy size={12} />
      </button>
      <button
        className="icon-btn danger"
        title={t("common.delete")}
        onClick={(e) => {
          e.stopPropagation();
          deleteObjects([obj.id]);
        }}
      >
        <X size={12} />
      </button>
    </div>
  );

  const dropProps = (targetId: string | null) => ({
    onDragOver: (e: DragEvent) => {
      if (!dragIds.current) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "move";
      if (dropTarget !== targetId) setDropTarget(targetId);
    },
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (dragIds.current) moveToCollection(dragIds.current, targetId);
      endDrag();
    },
  });

  return (
    <div className="panel left-panel">
      <div className="panel-header">
        <span>{t("panel.addGeometry")}</span>
      </div>
      <div className="palette">
        {GEOMETRY_CATALOG.filter((spec) => !spec.pseudo).map((spec) => (
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
        <span>{t("panel.outliner")}</span>
        <span className="spacer" />
        <span>{t("panel.objects", { n: doc.objects.length })}</span>
        <button className="icon-btn new-collection" title={t("outliner.newCollection")} onClick={addCollection}>
          <Plus size={12} />
        </button>
      </div>
      <div
        className="panel-body"
        onClick={(e) => {
          // Blender Outliner convention: clicking anywhere below/outside the
          // rows (empty space, padding) deselects everything.
          if (!(e.target as HTMLElement).closest(".hrow,.crow")) select(null, false);
        }}
        onDragOver={(e) => {
          if (!dragIds.current) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          if (dropTarget !== "root") setDropTarget("root");
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropTarget(null);
        }}
        onDrop={(e) => {
          if (!dragIds.current) return;
          e.preventDefault();
          moveToCollection(dragIds.current, null);
          endDrag();
        }}
      >
        {doc.objects.length === 0 && doc.collections.length === 0 ? (
          <div className="empty-note">{t("panel.empty")}</div>
        ) : (
          <div className="outliner">
            <div
              className={`crow root ${rootHasSelected ? "has-selected" : ""} ${dropTarget === "root" ? "drop-target" : ""}`}
              onClick={() => select(null, false)}
              {...dropProps(null)}
            >
              <button
                className="tri"
                onClick={(e) => {
                  e.stopPropagation();
                  setRootOpen((v) => !v);
                }}
              >
                {rootOpen ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
              </button>
              <span className="col-icon">{FOLDER_ICON}</span>
              <span className="name">{t("outliner.sceneCollection")}</span>
            </div>
            {rootOpen && (
              <>
                {doc.collections.map((col) => {
                  const members = doc.objects.filter((o) => o.collectionId === col.id);
                  const open = !collapsedCols.has(col.id);
                  // Collection visibility is the collection's own `hidden`
                  // flag (view-layer exclusion) — instances still render
                  // hidden collections' objects.
                  const colHidden = col.hidden === true;
                  // Collections glow when they contain selected objects.
                  const anyMemberSelected = members.some((m) => selected.has(m.id));
                  return (
                    <div className="col-group" key={col.id}>
                      <div
                        className={`crow ${anyMemberSelected ? "has-selected" : ""} ${dropTarget === col.id ? "drop-target" : ""}`}
                        onClick={(e) => {
                          if (renamingCol === col.id) return;
                          // Clicking the row selects its contents (Blender
                          // syncs collection selection to child objects).
                          selectMany(members.map((m) => m.id), e.shiftKey || e.ctrlKey || e.metaKey);
                        }}
                        {...dropProps(col.id)}
                      >
                        <button
                          className="tri"
                          onClick={(e) => {
                            e.stopPropagation();
                            setCollapsedCols((prev) => {
                              const next = new Set(prev);
                              if (next.has(col.id)) next.delete(col.id);
                              else next.add(col.id);
                              return next;
                            });
                          }}
                        >
                          {open ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                        </button>
                        <span className="col-icon">{FOLDER_ICON}</span>
                        {renamingCol === col.id ? (
                          <span className="name">
                            <input
                              autoFocus
                              defaultValue={col.name}
                              onClick={(e) => e.stopPropagation()}
                              onBlur={(e) => {
                                renameCollection(col.id, e.target.value || col.name);
                                setRenamingCol(null);
                              }}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                                if (e.key === "Escape") setRenamingCol(null);
                              }}
                            />
                          </span>
                        ) : (
                          <span
                            className="name"
                            title={t("outliner.dropHint")}
                            onDoubleClick={(e) => {
                              e.stopPropagation();
                              setRenamingCol(col.id);
                            }}
                          >
                            {col.name}
                          </span>
                        )}
                        <button
                          className={`icon-btn ${colHidden ? "hidden-eye" : ""}`}
                          title={t("outliner.collectionVisibility")}
                          onClick={(e) => {
                            e.stopPropagation();
                            setCollectionVisible(col.id, colHidden);
                          }}
                        >
                          {colHidden ? <EyeOff size={12} /> : <Eye size={12} />}
                        </button>
                        <button
                          className="icon-btn danger"
                          title={t("outliner.deleteCollection")}
                          onClick={(e) => {
                            e.stopPropagation();
                            deleteCollection(col.id);
                          }}
                        >
                          <X size={12} />
                        </button>
                      </div>
                      {open && layoutTree(members).map(({ obj, depth, crossGroupParent }) => renderObjectRow(obj, true, depth, crossGroupParent))}
                    </div>
                  );
                })}
                {layoutTree(doc.objects.filter((o) => !o.collectionId)).map(({ obj, depth, crossGroupParent }) => renderObjectRow(obj, false, depth, crossGroupParent))}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
