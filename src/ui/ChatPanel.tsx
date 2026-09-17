import { useCallback, useEffect, useRef, useState } from "react";
import { isViewOnly, useStore } from "../state/store";
import { getLocale, useT } from "../i18n";
import { isConfigured } from "../agent/types";
import {
  deleteTaskById,
  newTask,
  renameTask,
  runAgentTurn,
  stopAgentTurn,
  switchTask,
} from "../agent/agentLoop";
import { sandbox } from "../agent/sandbox";
import { snapshotDataUrl } from "../core/engine";
import { aspectDims } from "../core/cameraMath";
import type { SessionEvent } from "../agent/types";

// --- image helpers -------------------------------------------------------------

async function fileToDataUrl(file: File, maxEdge = 1024): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error(`Cannot load image: ${file.name}`));
      el.src = url;
    });
    const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const g = canvas.getContext("2d")!;
    g.fillStyle = "#ffffff";
    g.fillRect(0, 0, w, h);
    g.drawImage(img, 0, 0, w, h);
    return canvas.toDataURL("image/jpeg", 0.85);
  } finally {
    URL.revokeObjectURL(url);
  }
}

// --- component -------------------------------------------------------------------

export function ChatPanel() {
  const t = useT();
  const rightTab = useStore((s) => s.rightTab);
  const anyRunning = useStore((s) => Object.values(s.taskStates).some((st) => st === "running"));
  const setUi = useStore((s) => s.setUi);
  const [tasksOpen, setTasksOpen] = useState(false);

  return (
    <div className="panel" style={{ flex: 1, minHeight: 0, position: "relative" }}>
      <div className="right-tabs">
        <button
          className={rightTab === "chat" ? "active" : ""}
          onClick={() => setUi("rightTab", "chat")}
        >
          🤖 {t("chat.title")}
          {anyRunning && <span className="running-dot" />}
        </button>
        <button
          className={rightTab === "script" ? "active" : ""}
          onClick={() => setUi("rightTab", "script")}
        >
          ⌨ {t("chat.script")}
        </button>
        <button
          title={t("task.title")}
          className={tasksOpen ? "active" : ""}
          onClick={() => setTasksOpen(!tasksOpen)}
          style={{ flex: "0 0 auto", padding: "0 12px" }}
        >
          ☰
        </button>
      </div>
      {tasksOpen && <TasksPopover onClose={() => setTasksOpen(false)} />}
      {rightTab === "chat" ? <ChatTab /> : <ScriptTab />}
    </div>
  );
}

// --- task manager --------------------------------------------------------------------

function TasksPopover({ onClose }: { onClose: () => void }) {
  const t = useT();
  const tasks = useStore((s) => s.tasks);
  const activeId = useStore((s) => s.activeTaskId);
  const taskStates = useStore((s) => s.taskStates);
  const projectId = useStore((s) => s.projectId);
  const projects = useStore((s) => s.projects);
  const showToast = useStore((s) => s.showToast);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState("");

  const projectName = projectId ? projects.find((p) => p.id === projectId)?.name : null;

  const onNew = () => newTask();
  const onSwitch = (id: string) => {
    // Pure view switch — allowed even while this or other tasks are running.
    switchTask(id);
    onClose();
  };
  const onRenameStart = (id: string, current: string) => {
    setRenamingId(id);
    setRenameText(current);
  };
  const onRenameCommit = async () => {
    if (renamingId) await renameTask(renamingId, renameText);
    setRenamingId(null);
  };
  const onDelete = async (id: string, name: string) => {
    if (taskStates[id] === "running") return showToast(t("task.runningDelete"));
    if (!window.confirm(t("task.confirmDelete", { name: name || t("task.untitled") }))) return;
    await deleteTaskById(id);
  };

  return (
    <div className="session-pop">
      <div className="session-pop-header">
        <span>{t("task.title")}</span>
        {projectName && <span className="task-project">{projectName}</span>}
        <span className="spacer" />
        <button className="btn small" title={t("task.new")} onClick={onNew}>
          ＋ {t("task.new")}
        </button>
        <button className="btn small" title={t("common.close")} onClick={onClose}>
          ✕
        </button>
      </div>
      <div className="session-pop-list">
        {tasks.length === 0 && <div className="empty-note">{t("task.empty")}</div>}
        {tasks.map((meta) => (
          <div key={meta.id} className={`session-row ${meta.id === activeId ? "active" : ""}`}>
            {renamingId === meta.id ? (
              <input
                autoFocus
                value={renameText}
                placeholder={t("task.untitled")}
                onChange={(e) => setRenameText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void onRenameCommit();
                  if (e.key === "Escape") setRenamingId(null);
                }}
                onBlur={() => void onRenameCommit()}
              />
            ) : (
              <button
                className="session-main"
                title={t("task.switch")}
                onClick={() => onSwitch(meta.id)}
              >
                <span className="session-name">
                  {taskStates[meta.id] === "running" && <span className="running-dot" />}
                  {meta.name || t("task.untitled")}
                </span>
                <span className="session-time">{new Date(meta.updatedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
              </button>
            )}
            {renamingId !== meta.id && (
              <span className="session-actions">
                <button
                  className="btn small"
                  title={t("common.rename")}
                  onClick={() => onRenameStart(meta.id, meta.name)}
                >
                  ✎
                </button>
                <button
                  className="btn small danger"
                  title={t("common.delete")}
                  onClick={() => void onDelete(meta.id, meta.name)}
                >
                  ✕
                </button>
              </span>
            )}
          </div>
        ))}
      </div>
      <div className="session-pop-hint">{t("task.hint")}</div>
    </div>
  );
}

// --- chat tab ----------------------------------------------------------------------

const EMPTY_EVENTS: SessionEvent[] = [];

function ChatTab() {
  const t = useT();
  const activeTaskId = useStore((s) => s.activeTaskId);
  const events = useStore((s) => (s.activeTaskId ? s.taskEvents[s.activeTaskId] : undefined)) ?? EMPTY_EVENTS;
  const agentState = useStore((s) => (s.activeTaskId ? s.taskStates[s.activeTaskId] : undefined)) ?? "idle";
  const agentStep = useStore((s) => (s.activeTaskId ? s.taskSteps[s.activeTaskId] : 0)) ?? 0;
  const settings = useStore((s) => s.settings);
  const showToast = useStore((s) => s.showToast);

  const [text, setText] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const logRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // Autoscroll only while the reader is at the bottom: events stream in
  // continuously while the agent runs, so unconditional scrolling would pin
  // the log down and make history unreadable mid-run.
  const stickToBottom = useRef(true);
  const configured = isConfigured(settings);

  const scrollToBottom = useCallback(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  const onLogScroll = useCallback(() => {
    const el = logRef.current;
    if (!el) return;
    // Tolerance absorbs rounding and late image height changes at the bottom.
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    stickToBottom.current = near;
    setAtBottom(near);
  }, []);

  useEffect(() => {
    if (stickToBottom.current) scrollToBottom();
  }, [events, scrollToBottom]);

  // Switching tasks always lands on the newest message of the active task,
  // regardless of where the previous task was left scrolled.
  useEffect(() => {
    stickToBottom.current = true;
    setAtBottom(true);
    scrollToBottom();
  }, [activeTaskId, scrollToBottom]);

  const addImages = useCallback(
    async (files: File[]) => {
      const imgs = files.filter((f) => f.type.startsWith("image/"));
      if (!imgs.length) return;
      const limit = useStore.getState().settings.maxImages;
      if (images.length + imgs.length > limit) {
        showToast(`chat.tooManyImages|${limit}`);
        return;
      }
      const urls = await Promise.all(imgs.map((f) => fileToDataUrl(f).catch(() => null)));
      setImages((prev) => [...prev, ...urls.filter((u): u is string => !!u)].slice(0, limit));
    },
    [images.length, showToast],
  );

  const attachCurrentView = () => {
    const s = useStore.getState();
    const limit = s.settings.maxImages;
    if (images.length >= limit) {
      showToast(`chat.tooManyImages|${limit}`);
      return;
    }
    // Match the scene camera framing (aspect ratio), JPEG keeps the payload
    // small and is accepted by every vision endpoint.
    const { w, h } = aspectDims(s.doc.aspect ?? 16 / 9, 1280);
    const dataUrl = snapshotDataUrl(s.doc, s.playhead, w, h, "jpeg");
    setImages((prev) => [...prev, dataUrl]);
  };

  const send = () => {
    if (!configured || agentState === "running") return;
    // View-only while another writer (external agent, other tab) holds the
    // edit lock — a turn here could not mutate the scene anyway.
    if (isViewOnly()) {
      showToast("error.sceneLocked");
      return;
    }
    const message = text.trim();
    if (!message && images.length === 0) return;
    setText("");
    const sent = images;
    setImages([]);
    // A message the user just sent must always be visible.
    stickToBottom.current = true;
    setAtBottom(true);
    void runAgentTurn({ text: message, images: sent });
  };

  return (
    <div
      className="chat"
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        void addImages([...e.dataTransfer.files]);
      }}
      style={{ position: "relative" }}
    >
      <div className="chat-log" ref={logRef} onScroll={onLogScroll}>
        {events.length === 0 && configured && (
          <div className="msg notice" style={{ textAlign: "left" }}>
            {t("chat.placeholder")}
          </div>
        )}
        {events.map((event) => (
          <SessionEventView key={event.id} event={event} />
        ))}
        {agentState === "running" && (
          <div className="msg notice">
            {t("chat.thinking")} {agentStep > 0 ? `· ${t("chat.stepOf", { i: agentStep, max: settings.maxSteps })}` : ""}
          </div>
        )}
        {!atBottom && (
          <div className="chat-jump-row">
            <button
              className="btn small chat-jump"
              onClick={() => {
                stickToBottom.current = true;
                setAtBottom(true);
                scrollToBottom();
              }}
            >
              ↓ {t("chat.jumpToLatest")}
            </button>
          </div>
        )}
      </div>

      {!configured ? (
        <div className="chat-disabled">
          <span>{t("chat.notConfigured")}</span>
          <button className="btn primary" onClick={() => useStore.setState({ settingsOpen: true })}>
            ⚙ {t("chat.openSettings")}
          </button>
        </div>
      ) : (
        <div className="composer">
          {images.length > 0 && (
            <div className="attach-row">
              {images.map((img, i) => (
                <div className="att" key={i}>
                  <img src={img} alt={`attachment ${i + 1}`} onClick={() => useStore.setState({ lightbox: img })} />
                  <button
                    className="rm"
                    title={t("chat.removeImage")}
                    onClick={() => setImages(images.filter((_, j) => j !== i))}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
          <textarea
            value={text}
            placeholder={t("chat.placeholder")}
            onChange={(e) => setText(e.target.value)}
            onPaste={(e) => {
              const files = [...e.clipboardData.files];
              if (files.length) {
                e.preventDefault();
                void addImages(files);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          <div className="actions">
            <button className="btn small" title={t("chat.attach")} onClick={() => fileRef.current?.click()}>
              📎
            </button>
            <button className="btn small" title={t("chat.attachView")} onClick={attachCurrentView}>
              📷+
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              multiple
              style={{ display: "none" }}
              onChange={(e) => {
                void addImages([...e.target.files ?? []]);
                e.target.value = "";
              }}
            />
            <span className="hint">{images.length > 0 ? t("chat.images", { n: images.length }) : t("chat.attachHint")}</span>
            <span className="spacer" />
            {settings.provider === "mock" && <span className="chip">{t("chat.mockBadge")}</span>}
            {agentState === "running" ? (
              <button className="btn danger small" onClick={() => stopAgentTurn()}>
                ⏹ {t("chat.stop")}
              </button>
            ) : (
              <button className="btn primary small" onClick={send} disabled={!text.trim() && images.length === 0}>
                {t("chat.send")} ➤
              </button>
            )}
          </div>
        </div>
      )}
      {dragOver && (
        <div className="chat-drop-overlay">{t("chat.dropImages")}</div>
      )}
    </div>
  );
}

function SessionEventView({ event }: { event: SessionEvent }) {
  const t = useT();
  const setLightbox = (url: string) => useStore.setState({ lightbox: url });

  switch (event.type) {
    case "user":
      return (
        <div className="msg user">
          <span className="who">{t("chat.you")}</span>
          {event.images.length > 0 && (
            <div className="thumbs">
              {event.images.map((img, i) => (
                <img key={i} src={img} alt="" onClick={() => setLightbox(img)} />
              ))}
            </div>
          )}
          {event.text && <div className="bubble">{event.text}</div>}
        </div>
      );
    case "assistant":
      return (
        <div className="msg">
          <span className="who">{t("chat.agent")}</span>
          {event.text ? <div className="bubble">{event.text}</div> : null}
        </div>
      );
    case "reasoning":
      if (!event.text) return null;
      return (
        <details className="tool-card">
          <summary>💭 {t("chat.thinking")}</summary>
          <pre>{event.text}</pre>
        </details>
      );
    case "tool_call":
      return (
        <details className={`tool-card ${event.status === "error" ? "error" : ""}`}>
          <summary>
            🛠 {event.name}
            <span className={`status ${event.status}`}>
              {event.status === "running" ? t("chat.toolRunning") : `${event.status}${event.durationMs ? ` ${event.durationMs}ms` : ""}`}
            </span>
          </summary>
          <pre>{`args:\n${event.argsJson}${event.resultText ? `\n\nresult:\n${event.resultText}` : ""}`}</pre>
        </details>
      );
    case "snapshot":
      return (
        <div className="msg snapshot-msg">
          <span className="cap">🖼 {t("chat.snapshotAt", { t: event.t.toFixed(2) })} — {event.width}×{event.height}</span>
          <img src={event.dataUrl} alt={`snapshot @ ${event.t}s`} onClick={() => setLightbox(event.dataUrl)} />
        </div>
      );
    case "error":
      return <div className="msg error-banner">⚠ {t("chat.error")}: {event.message}</div>;
    case "notice":
      return <div className="msg notice">{event.text}</div>;
    default:
      return null;
  }
}

// --- script tab ----------------------------------------------------------------------

const SAMPLE_CODE = `// Try the sandboxed Scripting API:
const id = api.add({ type: "torusKnot", name: "Knot", position: [0, 1.5, 0], color: "#3ddc97" });
api.setDuration(4);
api.onFrame((t, f) => {
  const k = f.find("Knot"); // self-contained: re-resolve ids every frame
  if (k) f.update(k, { rotation: [t * 0.8, t * 1.2, 0] });
});
api.log("added", id);`;

const DOCS: Record<"en" | "zh", string> = {
  en: `api.add({type,name?,params?,position?,rotation?,scale?,color?}) -> id
api.update(id, patch) · api.remove(id) · api.clear() · api.get() · api.list()
api.find(name) -> id · api.params(type) · api.uniqueName(type)
api.keyframes(id, [{t, position?, rotation?, scale?, color?, visible?, interp?}], actionId?)
api.setCamera({position?,target?,fov?}) — ACTIVE camera's base pose
api.addCamera({name?,position?,target?,fov?}) -> id · api.updateCamera(id, patch) · api.removeCamera(id)
api.setActiveCamera(id) — what preview/snapshot/export render
api.addCameraKeys([{t, position?, target?, fov?, interp?}], cameraId?, actionId?)
api.createAction({objectId} | {cameraId}, name?) -> id · api.setActiveAction(id)
api.renameAction(id, name) · api.duplicateAction(id) · api.removeAction(id)
  — actions are per-owner keyframe groups; keys go to the owner's ACTIVE
  action (created if missing); only the active action plays
api.setDuration(s) · api.setFps(f) · api.setAspect(16/9)
api.onFrame((t, f, state) => {...})  — must be self-contained: resolve ids
  fresh each frame (const id = f.find("Name"); if (id) f.update(id, …));
  keep counters on state; outer vars do NOT survive reload
f.update(id, patch) / f.camera(patch) — current frame only; unknown id: no-op
api.log(...) — print to the output pane`,
  zh: `api.add({type,name?,params?,position?,rotation?,scale?,color?}) -> id
api.update(id, patch) · api.remove(id) · api.clear() · api.get() · api.list()
api.find(name) -> id · api.params(type) · api.uniqueName(type)
api.keyframes(id, [{t, position?, rotation?, scale?, color?, visible?, interp?}], actionId?)
api.setCamera({position?,target?,fov?}) — 活动相机的基础位姿
api.addCamera({name?,position?,target?,fov?}) -> id · api.updateCamera(id, patch) · api.removeCamera(id)
api.setActiveCamera(id) — 预览/快照/导出渲染的相机
api.addCameraKeys([{t, position?, target?, fov?, interp?}], cameraId?, actionId?)
api.createAction({objectId} | {cameraId}, name?) -> id · api.setActiveAction(id)
api.renameAction(id, name) · api.duplicateAction(id) · api.removeAction(id)
  — 动作是每个所有者（对象/相机）的关键帧组；关键帧写入所有者的活动动作
  （没有则自动创建）；只有活动动作参与播放
api.setDuration(s) · api.setFps(f) · api.setAspect(16/9)
api.onFrame((t, f, state) => {...})  — 必须自包含：每帧重新解析 id
  （const id = f.find("名字"); if (id) f.update(id, …)）；计数存到 state；
  外部变量在刷新后不存在
f.update(id, patch) / f.camera(patch) — 仅影响当前帧；未知 id 会静默跳过
api.log(...) — 打印到输出区`,
};

function ScriptTab() {
  const t = useT();
  const [code, setCode] = useState(SAMPLE_CODE);
  const [output, setOutput] = useState<string>("");
  const [running, setRunning] = useState(false);

  const run = async () => {
    if (running) return;
    setRunning(true);
    setOutput("…");
    const store = useStore.getState();
    const result = await sandbox.run(code, store.doc);
    if (result.ok && result.doc) {
      store.applyDoc(result.doc, "script-console");
      const doc = useStore.getState().doc;
      const keyCount = doc.actions.reduce((n, a) => n + a.keys.length, 0);
      const lines = [`✓ executed — ${doc.objects.length} objects, ${doc.actions.length} actions (${keyCount} keys), ${doc.onFrameScripts.length} onFrame hooks`];
      if (result.logs.length) lines.push("", ...result.logs);
      if (result.result && result.result !== "undefined") lines.push("", `→ ${result.result}`);
      setOutput(lines.join("\n"));
    } else {
      const lines = [`✗ ${result.error ?? "failed"}`];
      if (result.logs.length) lines.push("", ...result.logs);
      setOutput(lines.join("\n"));
    }
    setRunning(false);
  };

  return (
    <div className="script">
      <div style={{ padding: 10, display: "flex", flexDirection: "column", gap: 8 }}>
        <span className="hint" style={{ color: "var(--text-3)", fontSize: 11 }}>{t("script.hint")}</span>
        <textarea
          className="code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          spellCheck={false}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
              e.preventDefault();
              void run();
            }
          }}
        />
        <div style={{ display: "flex", gap: 6 }}>
          <button className="btn primary small" onClick={() => void run()} disabled={running}>
            ▶ {t("script.run")} (Ctrl+Enter)
          </button>
          <button className="btn small" onClick={() => setCode("")}>
            {t("script.clear")}
          </button>
        </div>
      </div>
      <div className="panel-header" style={{ fontSize: 10 }}>
        <span>{t("script.output")}</span>
      </div>
      <div className="output">
        {output ? (output.startsWith("✗") ? <span className="err">{output}</span> : output) : ""}
      </div>
      <details className="docs" style={{ margin: 10, marginTop: 0 }}>
        <summary>📖 {t("script.docsTitle")}</summary>
        <pre>{DOCS[getLocale()]}</pre>
      </details>
    </div>
  );
}
