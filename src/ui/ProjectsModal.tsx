import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Download, FilePlus, Folder, FolderOpen, Save, Upload, X } from "lucide-react";
import { useStore } from "../state/store";
import { downloadBlob } from "../core/videoExport";
import { useT } from "../i18n";
import { browseServerDirs, serverProjectOp } from "../state/studioLink";

/** Name + directory form for local studio mode. Two modes share the picker:
 *  - "new": create a fresh empty project file
 *  - "saveAs": Save on an unsaved scene — write the CURRENT scene into the
 *    chosen file instead of dropping it into the workspace default. */
function NewProjectForm({ mode, onDone }: { mode: "new" | "saveAs"; onDone: () => void }) {
  const t = useT();
  const studio = useStore((s) => s.studio);
  const docName = useStore((s) => s.doc.name);
  const [name, setName] = useState(mode === "saveAs" ? docName || "Untitled" : "Untitled");
  const [dir, setDir] = useState("");
  const [dirs, setDirs] = useState<Array<{ name: string; path: string }>>([]);
  const [parent, setParent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async (path?: string) => {
    setBusy(true);
    setError(null);
    const r = await browseServerDirs(path);
    if ("error" in r) setError(r.error);
    else {
      setDirs(r.dirs);
      setParent(r.parent);
      setDir(r.path);
    }
    setBusy(false);
  };

  useEffect(() => {
    void load(studio.workspace);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div style={{ border: "1px solid var(--border-2)", borderRadius: 8, padding: 12, marginTop: 10 }}>
      <div style={{ fontWeight: 600, marginBottom: 8, display: "flex", alignItems: "center", gap: 6 }}>
        {mode === "saveAs" ? <Save size={13} /> : <FilePlus size={13} />}
        {mode === "saveAs" ? t("studio.saveProjectAs") : t("studio.newProject")}
      </div>
      <label style={{ display: "block", marginBottom: 8 }}>
        <div style={{ fontSize: 12, marginBottom: 4 }}>{t("studio.projectName")}</div>
        <input value={name} onChange={(e) => setName(e.target.value)} style={{ width: "100%" }} autoFocus />
      </label>
      <div style={{ fontSize: 12, marginBottom: 4 }}>{t("studio.saveDir")}</div>
      <div className="dir-picker" style={{ maxHeight: 180, overflow: "auto", border: "1px solid var(--border-2)", borderRadius: 6, marginBottom: 8 }}>
        <div style={{ padding: "6px 10px", fontFamily: "var(--mono, monospace)", fontSize: 11, color: "var(--text-2)", wordBreak: "break-all", display: "flex", alignItems: "center", gap: 5 }}>
          <Folder size={12} style={{ flexShrink: 0 }} />
          {dir}
        </div>
        {parent && (
          <button className="btn small" style={{ margin: "0 6px 6px" }} onClick={() => void load(parent)} disabled={busy}>
            <ArrowLeft size={12} />
            {t("studio.parentDir")}
          </button>
        )}
        {dirs.map((d) => (
          <button
            key={d.path}
            className="btn small"
            style={{ margin: "0 6px 6px", display: "block" }}
            onClick={() => void load(d.path)}
            disabled={busy}
          >
            <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
              <FolderOpen size={12} />
              {d.name}
            </span>
          </button>
        ))}
        {busy && <div style={{ padding: 6, fontSize: 12, color: "var(--text-3)" }}>…</div>}
      </div>
      {error && <div style={{ color: "var(--danger, #f56c6c)", fontSize: 12, marginBottom: 8 }}>{error}</div>}
      <div style={{ display: "flex", gap: 8 }}>
        <button
          className="btn primary"
          disabled={!name.trim() || busy}
          onClick={() => {
            if (mode === "saveAs") serverProjectOp({ type: "projects.saveAs", name: name.trim(), dir });
            else serverProjectOp({ type: "projects.new", name: name.trim(), dir });
            onDone();
          }}
        >
          {mode === "saveAs" ? t("common.save") : t("common.create")}
        </button>
        <button className="btn" onClick={onDone}>
          {t("common.cancel")}
        </button>
      </div>
    </div>
  );
}

export function ProjectsModal() {
  const t = useT();
  const projects = useStore((s) => s.projects);
  const serverMode = useStore((s) => s.docAuthority === "server");
  const serverProjects = useStore((s) => s.serverProjects);
  const newProjectOpen = useStore((s) => s.newProjectOpen);
  const saveAsOpen = useStore((s) => s.saveAsOpen);
  const setUi = useStore((s) => s.setUi);
  const loadProject = useStore((s) => s.loadProject);
  const deleteProject = useStore((s) => s.deleteProject);
  const showToast = useStore((s) => s.showToast);
  const projectFileRef = useRef<HTMLInputElement>(null);
  /** Which picker form is open: none, new-project, or save-unsaved-scene. */
  const [formMode, setFormMode] = useState<"new" | "saveAs" | null>(null);

  useEffect(() => {
    if (newProjectOpen) {
      setFormMode("new");
      useStore.setState({ newProjectOpen: false });
    }
  }, [newProjectOpen]);

  useEffect(() => {
    if (saveAsOpen) {
      setFormMode("saveAs");
      useStore.setState({ saveAsOpen: false });
    }
  }, [saveAsOpen]);

  const fmt = (ts: number) => {
    const d = new Date(ts);
    return d.toLocaleString();
  };

  const exportProject = async () => {
    const r = await useStore.getState().exportProjectBundle();
    if ("error" in r) {
      showToast(`error.invalidProjectBundle|${r.error}`);
      return;
    }
    downloadBlob(r.blob, r.filename);
    showToast("notice.projectExported");
  };

  const importProject = async (file: File) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await file.text());
    } catch (err) {
      showToast(`error.invalidProjectBundle|${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    const r = await useStore.getState().importProjectBundle(parsed);
    if ("error" in r) {
      // Map the structured error codes to actionable messages: a scene-only
      // JSON belongs in the toolbar's Import JSON button, not here.
      if (r.error === "scene-only") showToast("error.wrongImporterScene");
      else if (r.error === "unrecognized") showToast("error.notAProjectBundle");
      else showToast(`error.invalidProjectBundle|${r.error}`);
      return;
    }
    showToast(`notice.projectImported|${r.name}`);
  };

  const list = serverMode
    ? serverProjects.map((p) => ({ id: p.id, name: p.name, savedAt: p.savedAt, path: p.path, objects: null as number[] | null, duration: null as number | null }))
    : projects.map((p) => ({ id: p.id, name: p.name, savedAt: p.savedAt, path: null as string | null, objects: p.doc.objects, duration: p.doc.duration }));

  return (
    <div className="modal-overlay" onPointerDown={(e) => e.target === e.currentTarget && setUi("projectsOpen", false)}>
      <div className="modal">
        <div className="modal-header">
          <FolderOpen size={14} />
          {t("projects.title")}
          <span className="spacer" />
          {serverMode ? (
            <button className="btn small primary" title={t("studio.newProject")} onClick={() => setFormMode((m) => (m === "new" ? null : "new"))}>
              <FilePlus size={12} />
              {t("common.new")}
            </button>
          ) : (
            <>
              <button
                className="btn small"
                title={t("topbar.importProject")}
                onClick={() => projectFileRef.current?.click()}
              >
                <Upload size={12} />
                {t("common.import")}
              </button>
              <button className="btn small" title={t("topbar.exportProject")} onClick={() => void exportProject()}>
                <Download size={12} />
                {t("common.export")}
              </button>
            </>
          )}
        </div>
        <div className="modal-body">
          {formMode && serverMode && <NewProjectForm mode={formMode} onDone={() => setFormMode(null)} />}
          {list.length === 0 ? (
            <div className="empty-note">{t("projects.empty")}</div>
          ) : (
            <div className="project-list">
              {list.map((p) => (
                <div key={p.id} className="project-item">
                  <div className="meta">
                    <b>{p.name}</b>
                    <span>
                      {p.objects !== null
                        ? `${t("projects.savedAt", { time: fmt(p.savedAt) })} · ${p.objects.length} obj · ${p.duration}s`
                        : p.path
                          ? `${t("projects.savedAt", { time: fmt(p.savedAt) })} · ${p.path}`
                          : t("projects.savedAt", { time: fmt(p.savedAt) })}
                    </span>
                  </div>
                  <button className="btn small primary" onClick={() => loadProject(p.id)}>
                    {t("projects.load")}
                  </button>
                  <button
                    className="btn small danger"
                    onClick={() => {
                      if (window.confirm(t("projects.confirmDelete", { name: p.name }))) deleteProject(p.id);
                    }}
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="hint" style={{ color: "var(--text-3)", fontSize: 11, lineHeight: 1.4, marginTop: 10 }}>
            {serverMode ? t("projects.workspaceNote") : t("projects.storageNote")}
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn" onClick={() => setUi("projectsOpen", false)}>
            {t("common.close")}
          </button>
        </div>
      </div>
      {!serverMode && (
        <input
          ref={projectFileRef}
          type="file"
          accept="application/json,.json"
          style={{ display: "none" }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void importProject(file);
            e.target.value = "";
          }}
        />
      )}
    </div>
  );
}
