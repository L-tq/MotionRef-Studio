import { useEffect } from "react";
import { Bot } from "lucide-react";
import { TopBar } from "./ui/TopBar";
import { LeftPanel } from "./ui/LeftPanel";
import { Viewport } from "./ui/Viewport";
import { Timeline } from "./ui/Timeline";
import { Inspector } from "./ui/Inspector";
import { ChatPanel, dockChat } from "./ui/ChatPanel";
import { ChatFloat } from "./ui/ChatFloat";
import { Resizer } from "./ui/Resizer";
import { SettingsDialog } from "./ui/SettingsDialog";
import { ProjectsModal } from "./ui/ProjectsModal";
import { ExportDialog } from "./ui/ExportDialog";
import { useStore, DEFAULT_LAYOUT } from "./state/store";
import { isConfigured } from "./agent/types";
import { isWalkActive } from "./core/engine";
import { useT, translateMessage } from "./i18n";

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

export default function App() {
  const t = useT();
  const settingsOpen = useStore((s) => s.settingsOpen);
  const onboarding = useStore((s) => s.onboarding);
  const projectsOpen = useStore((s) => s.projectsOpen);
  const exportOpen = useStore((s) => s.exportOpen);
  const lightbox = useStore((s) => s.lightbox);
  const toast = useStore((s) => s.toast);
  const layout = useStore((s) => s.layout);
  const setLayout = useStore((s) => s.setLayout);
  const chatFloatOpen = !!layout.chatFloat?.open;
  const leftOpen = layout.leftOpen;
  const rightOpen = layout.rightOpen;
  const timelineOpen = layout.timelineOpen;

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
      // Walk mode owns the keyboard: WASD/QE move, +/- change speed, etc.
      if (isWalkActive()) {
        if (e.key !== "Shift") e.preventDefault();
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
        case "m":
          // Blender-style: drop a camera-cut marker at the playhead.
          s.addMarker();
          break;
        case "f":
          // Shift+F is walk mode (handled in Viewport), plain F frames selection.
          if (!e.shiftKey) window.dispatchEvent(new CustomEvent("mrs:frame-selection"));
          break;
        case "d":
          // Shift+D (Blender): duplicate the whole selection; the copies stay selected.
          if (e.shiftKey && s.selection.length) {
            e.preventDefault();
            s.duplicateObjects([...s.selection]);
          }
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
        {leftOpen && (
          <>
            <div className="region" style={{ width: layout.leftW }}>
              <LeftPanel />
            </div>
            <Resizer
              dir="col"
              onMove={(e) => setLayout({ leftW: clamp(e.clientX, 170, 440) })}
              onReset={() => setLayout({ leftW: DEFAULT_LAYOUT.leftW })}
            />
          </>
        )}
        <div
          className="app-center"
          style={{ gridTemplateRows: timelineOpen ? `1fr 5px ${layout.timelineH}px` : "1fr" }}
        >
          <div className="viewport-slot">
            <Viewport />
            <PanelTab side="left" open={leftOpen} title={t("layout.toggleLeft")} onClick={() => setLayout({ leftOpen: !leftOpen })} />
            <PanelTab side="right" open={rightOpen} title={t("layout.toggleRight")} onClick={() => setLayout({ rightOpen: !rightOpen })} />
            <PanelTab side="bottom" open={timelineOpen} title={t("layout.toggleTimeline")} onClick={() => setLayout({ timelineOpen: !timelineOpen })} />
          </div>
          {timelineOpen && (
            <>
              <Resizer
                dir="row"
                onMove={(e) => setLayout({ timelineH: clamp(window.innerHeight - e.clientY, 110, window.innerHeight - 260) })}
                onReset={() => setLayout({ timelineH: DEFAULT_LAYOUT.timelineH })}
              />
              <Timeline />
            </>
          )}
        </div>
        {rightOpen && (
          <>
            <Resizer
              dir="col"
              onMove={(e) => setLayout({ rightW: clamp(window.innerWidth - e.clientX, 280, Math.max(420, Math.min(900, Math.floor(window.innerWidth * 0.75)))) })}
              onReset={() => setLayout({ rightW: DEFAULT_LAYOUT.rightW })}
            />
            <div className="app-right region" style={{ width: layout.rightW }}>
              {chatFloatOpen ? (
                <>
                  {/* Chat lives in its floating window; the column gives the
                      space back to the inspector and offers a way back. */}
                  <div className="region" style={{ flex: "1 1 auto" }}>
                    <Inspector />
                  </div>
                  <button className="chat-dock-strip" title={t("chat.dock")} onClick={dockChat}>
                    <Bot size={13} />
                    {t("chat.floatingStrip")}
                  </button>
                </>
              ) : (
                <>
                  <div className="region" style={{ height: layout.inspH, flex: "0 0 auto" }}>
                    <Inspector />
                  </div>
                  <Resizer
                    dir="row"
                    onMove={(e) => setLayout({ inspH: clamp(e.clientY - 44, 100, window.innerHeight - 224) })}
                    onReset={() => setLayout({ inspH: DEFAULT_LAYOUT.inspH })}
                  />
                  <ChatPanel />
                </>
              )}
            </div>
          </>
        )}
      </div>

      {settingsOpen && <SettingsDialog onboarding={onboarding} />}
      {projectsOpen && <ProjectsModal />}
      {exportOpen && <ExportDialog />}
      {chatFloatOpen && <ChatFloat />}
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
  return <div className="toast">{translateMessage(message, t)}</div>;
}

/** Small triangle tab on the viewport edge that toggles a panel (Blender-style).
 *  The arrow points toward the panel: outward when open ("collapse me"),
 *  inward when closed ("expand me"). */
function PanelTab({ side, open, title, onClick }: { side: "left" | "right" | "bottom"; open: boolean; title: string; onClick: () => void }) {
  const arrow = side === "left" ? (open ? "◂" : "▸") : side === "right" ? (open ? "▸" : "◂") : open ? "▾" : "▴";
  return (
    <button type="button" className={`panel-tab ${side}`} title={title} aria-label={title} aria-expanded={open} onClick={onClick}>
      {arrow}
    </button>
  );
}
