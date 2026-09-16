import { useRef } from "react";
import { useStore } from "../state/store";
import { downloadBlob } from "../core/videoExport";
import { useT } from "../i18n";

export function ProjectsModal() {
  const t = useT();
  const projects = useStore((s) => s.projects);
  const setUi = useStore((s) => s.setUi);
  const loadProject = useStore((s) => s.loadProject);
  const deleteProject = useStore((s) => s.deleteProject);
  const showToast = useStore((s) => s.showToast);
  const projectFileRef = useRef<HTMLInputElement>(null);

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

  return (
    <div className="modal-overlay" onPointerDown={(e) => e.target === e.currentTarget && setUi("projectsOpen", false)}>
      <div className="modal">
        <div className="modal-header">
          🗂 {t("projects.title")}
          <span className="spacer" />
          <button
            className="btn small"
            title={t("topbar.importProject")}
            onClick={() => projectFileRef.current?.click()}
          >
            ⬆ {t("common.import")}
          </button>
          <button className="btn small" title={t("topbar.exportProject")} onClick={() => void exportProject()}>
            ⬇ {t("common.export")}
          </button>
        </div>
        <div className="modal-body">
          {projects.length === 0 ? (
            <div className="empty-note">{t("projects.empty")}</div>
          ) : (
            <div className="project-list">
              {projects.map((p) => (
                <div key={p.id} className="project-item">
                  <div className="meta">
                    <b>{p.name}</b>
                    <span>
                      {t("projects.savedAt", { time: fmt(p.savedAt) })} · {p.doc.objects.length} obj ·{" "}
                      {p.doc.duration}s
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
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="hint" style={{ color: "var(--text-3)", fontSize: 11, lineHeight: 1.4, marginTop: 10 }}>
            {t("projects.storageNote")}
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn" onClick={() => setUi("projectsOpen", false)}>
            {t("common.close")}
          </button>
        </div>
      </div>
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
    </div>
  );
}
