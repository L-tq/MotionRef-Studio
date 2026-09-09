import { useStore } from "../state/store";
import { useT } from "../i18n";

export function ProjectsModal() {
  const t = useT();
  const projects = useStore((s) => s.projects);
  const setUi = useStore((s) => s.setUi);
  const loadProject = useStore((s) => s.loadProject);
  const deleteProject = useStore((s) => s.deleteProject);

  const fmt = (ts: number) => {
    const d = new Date(ts);
    return d.toLocaleString();
  };

  return (
    <div className="modal-overlay" onPointerDown={(e) => e.target === e.currentTarget && setUi("projectsOpen", false)}>
      <div className="modal">
        <div className="modal-header">
          🗂 {t("projects.title")}
          <span className="spacer" />
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
        </div>
        <div className="modal-footer">
          <button className="btn" onClick={() => setUi("projectsOpen", false)}>
            {t("common.close")}
          </button>
        </div>
      </div>
    </div>
  );
}
