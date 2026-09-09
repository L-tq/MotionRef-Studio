import { useEffect } from "react";
import { TopBar } from "./ui/TopBar";
import { LeftPanel } from "./ui/LeftPanel";
import { Viewport } from "./ui/Viewport";
import { Timeline } from "./ui/Timeline";
import { Inspector } from "./ui/Inspector";
import { ChatPanel } from "./ui/ChatPanel";
import { SettingsDialog } from "./ui/SettingsDialog";
import { ProjectsModal } from "./ui/ProjectsModal";
import { ExportDialog } from "./ui/ExportDialog";
import { useStore } from "./state/store";
import { isConfigured } from "./agent/types";
import { useT } from "./i18n";

export default function App() {
  const t = useT();
  const settingsOpen = useStore((s) => s.settingsOpen);
  const onboarding = useStore((s) => s.onboarding);
  const projectsOpen = useStore((s) => s.projectsOpen);
  const exportOpen = useStore((s) => s.exportOpen);
  const lightbox = useStore((s) => s.lightbox);
  const toast = useStore((s) => s.toast);

  // First visit: open onboarding when the LLM is not configured.
  useEffect(() => {
    if (!isConfigured(useStore.getState().settings)) {
      useStore.setState({ settingsOpen: true, onboarding: true });
    }
  }, []);

  // Global keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = document.activeElement;
      const typing = target && (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || (target as HTMLElement).isContentEditable);
      const s = useStore.getState();

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) s.redo();
        else s.undo();
        return;
      }
      if (typing) return;

      switch (e.key.toLowerCase()) {
        case " ":
          e.preventDefault();
          if (s.playing) s.pause();
          else s.play();
          break;
        case "q":
          s.setGizmo("select");
          break;
        case "w":
          s.setGizmo("translate");
          break;
        case "e":
          s.setGizmo("rotate");
          break;
        case "r":
          s.setGizmo("scale");
          break;
        case "k":
          s.setKeyAtPlayhead();
          break;
        case "c":
          s.setCameraKeyAtPlayhead();
          break;
        case "f":
          window.dispatchEvent(new CustomEvent("mrs:frame-selection"));
          break;
        case "delete":
        case "backspace":
          if (s.selection.length) {
            e.preventDefault();
            s.deleteObjects(s.selection);
          }
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="app-shell">
      <TopBar />
      <div className="app-main">
        <LeftPanel />
        <div className="app-center">
          <Viewport />
          <Timeline />
        </div>
        <div className="app-right">
          <Inspector />
          <ChatPanel />
        </div>
      </div>

      {settingsOpen && <SettingsDialog onboarding={onboarding} />}
      {projectsOpen && <ProjectsModal />}
      {exportOpen && <ExportDialog />}
      {lightbox && (
        <div className="lightbox" onClick={() => useStore.setState({ lightbox: null })}>
          <img src={lightbox} alt="snapshot" />
        </div>
      )}
      {toast && <Toast message={toast} />}
    </div>
  );
}

/** Renders "key|arg1|arg2…" toast strings through i18n. */
function Toast({ message }: { message: string }) {
  const t = useT();
  const [key, ...args] = message.split("|");
  let text: string;
  if (key === "export.done") text = t("export.done", { ext: args[0] ?? "", frames: args[1] ?? "" });
  else if (key === "error.invalidJson") text = t("error.invalidJson", { msg: args[0] ?? "" });
  else if (key === "viewport.hookError") text = t("viewport.hookError", { msg: args[0] ?? "" });
  else text = t(key);
  return <div className="toast">{text}</div>;
}
