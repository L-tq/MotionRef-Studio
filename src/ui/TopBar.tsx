import { useRef } from "react";
import { useStore } from "../state/store";
import { setLocale, useLocale, useT } from "../i18n";
import { validateSceneDocument } from "../core/validate";
import { cloneDoc, createEmptyDocument } from "../core/types";
import { downloadBlob } from "../core/videoExport";
import { demoDocument } from "../core/demoScene";

export function TopBar() {
  const t = useT();
  const locale = useLocale();
  const doc = useStore((s) => s.doc);
  const setUi = useStore((s) => s.setUi);
  const mutateDoc = useStore((s) => s.mutateDoc);
  const showToast = useStore((s) => s.showToast);
  const fileRef = useRef<HTMLInputElement>(null);

  const exportJson = () => {
    const data = JSON.stringify({ format: "motionref-studio/scene", ...cloneDoc(doc) }, null, 2);
    downloadBlob(new Blob([data], { type: "application/json" }), `${doc.name || "scene"}.json`);
    showToast("notice.docExported");
  };

  const importJson = async (file: File) => {
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as unknown;
      const result = validateSceneDocument(parsed);
      if ("error" in result) {
        showToast(`error.invalidJson|${result.error}`);
        return;
      }
      mutateDoc("import", (draft) => {
        Object.assign(draft, result.doc);
      });
      showToast("error.docImported");
    } catch (err) {
      showToast(`error.invalidJson|${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const newProject = () => {
    if (!window.confirm(t("projects.confirmNew"))) return;
    mutateDoc("new", (draft) => {
      Object.assign(draft, createEmptyDocument());
    });
    useStore.setState({ selection: [], playhead: 0, playing: false });
  };

  const loadDemo = () => {
    mutateDoc("demo", (draft) => {
      Object.assign(draft, demoDocument());
    });
    useStore.setState({ selection: [], playhead: 0, playing: false });
    showToast("notice.demoLoaded");
  };

  return (
    <div className="topbar">
      <div className="brand">
        <b>MotionRef</b>
        <span>{t("app.subtitle")}</span>
      </div>
      <input
        className="project-name"
        value={doc.name}
        onChange={(e) =>
          mutateDoc("name", (draft) => {
            draft.name = e.target.value;
          })
        }
      />
      <button className="btn small" title={t("topbar.new")} onClick={newProject}>
        ✦ {t("common.new")}
      </button>
      <button className="btn small" title={t("topbar.save")} onClick={() => useStore.getState().saveProject()}>
        💾 {t("common.save")}
      </button>
      <button className="btn small" title={t("topbar.projects")} onClick={() => setUi("projectsOpen", true)}>
        🗂 {t("topbar.projects")}
      </button>
      <button className="btn small" title={t("topbar.demo")} onClick={loadDemo}>
        ✨ {t("topbar.demo")}
      </button>
      <div style={{ width: 1, height: 20, background: "var(--border-2)" }} />
      <button className="btn small" title={t("topbar.importJson")} onClick={() => fileRef.current?.click()}>
        ⬆ {t("common.import")}
      </button>
      <button className="btn small" title={t("topbar.exportJson")} onClick={exportJson}>
        ⬇ {t("common.export")}
      </button>
      <input
        ref={fileRef}
        type="file"
        accept="application/json,.json"
        style={{ display: "none" }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void importJson(file);
          e.target.value = "";
        }}
      />
      <div className="spacer" />
      <button className="btn primary small" onClick={() => setUi("exportOpen", true)}>
        🎬 {t("topbar.exportVideo")}
      </button>
      <button
        className="btn small"
        onClick={() => useStore.setState({ settingsOpen: true })}
        title={t("topbar.settings")}
      >
        ⚙ {t("topbar.settings")}
      </button>
      <button
        className="btn small"
        onClick={() => setLocale(locale === "zh" ? "en" : "zh")}
        title={t("topbar.language")}
      >
        {t("topbar.language")}
      </button>
    </div>
  );
}
