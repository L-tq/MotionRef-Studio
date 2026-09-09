import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "../state/store";
import { getLocale, useT } from "../i18n";
import { isConfigured } from "../agent/types";
import { runAgentTurn, resetSession, stopAgentTurn } from "../agent/agentLoop";
import { sandbox } from "../agent/sandbox";
import { snapshotDataUrl } from "../core/engine";
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
  const rightTab = useStore((s) => s.rightTab);
  const agentState = useStore((s) => s.agentState);
  const setUi = useStore((s) => s.setUi);

  return (
    <div className="panel" style={{ flex: 1, minHeight: 0 }}>
      <div className="right-tabs">
        <button
          className={rightTab === "chat" ? "active" : ""}
          onClick={() => setUi("rightTab", "chat")}
        >
          🤖 Agent
          {agentState === "running" && <span className="running-dot" />}
        </button>
        <button
          className={rightTab === "script" ? "active" : ""}
          onClick={() => setUi("rightTab", "script")}
        >
          ⌨ Script
        </button>
        <button
          title="New session"
          onClick={() => {
            if (agentState === "running") return;
            resetSession();
          }}
          style={{ flex: "0 0 auto", padding: "0 12px" }}
        >
          ✚
        </button>
      </div>
      {rightTab === "chat" ? <ChatTab /> : <ScriptTab />}
    </div>
  );
}

// --- chat tab ----------------------------------------------------------------------

function ChatTab() {
  const t = useT();
  const session = useStore((s) => s.session);
  const agentState = useStore((s) => s.agentState);
  const agentStep = useStore((s) => s.agentStep);
  const settings = useStore((s) => s.settings);
  const showToast = useStore((s) => s.showToast);

  const [text, setText] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const configured = isConfigured(settings);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [session]);

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
    const dataUrl = snapshotDataUrl(s.doc, s.playhead, 1280, 720);
    setImages((prev) => [...prev, dataUrl]);
  };

  const send = () => {
    if (!configured || agentState === "running") return;
    const message = text.trim();
    if (!message && images.length === 0) return;
    setText("");
    const sent = images;
    setImages([]);
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
      <div className="chat-log" ref={logRef}>
        {session.length === 0 && configured && (
          <div className="msg notice" style={{ textAlign: "left" }}>
            {t("chat.placeholder")}
          </div>
        )}
        {session.map((event) => (
          <SessionEventView key={event.id} event={event} />
        ))}
        {agentState === "running" && (
          <div className="msg notice">
            {t("chat.thinking")} {agentStep > 0 ? `· ${t("chat.stepOf", { i: agentStep, max: settings.maxSteps })}` : ""}
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
              <button className="btn danger small" onClick={stopAgentTurn}>
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
  f.update(id, { rotation: [t * 0.8, t * 1.2, 0] });
});
api.log("added", id);`;

const DOCS: Record<"en" | "zh", string> = {
  en: `api.add({type,name?,params?,position?,rotation?,scale?,color?}) -> id
api.update(id, patch) · api.remove(id) · api.clear() · api.get() · api.list()
api.find(name) -> id · api.params(type) · api.uniqueName(type)
api.keyframes(id, [{t, position?, rotation?, scale?, color?, visible?, interp?}])
api.setCamera({position?,target?,fov?})
api.addCameraKeys([{t, position?, target?, fov?, interp?}])
api.setDuration(s) · api.setFps(f) · api.onFrame((t, f) => {...})
f.update(id, patch) / f.camera(patch) — affect the current frame only
api.log(...) — print to the output pane`,
  zh: `api.add({type,name?,params?,position?,rotation?,scale?,color?}) -> id
api.update(id, patch) · api.remove(id) · api.clear() · api.get() · api.list()
api.find(name) -> id · api.params(type) · api.uniqueName(type)
api.keyframes(id, [{t, position?, rotation?, scale?, color?, visible?, interp?}])
api.setCamera({position?,target?,fov?})
api.addCameraKeys([{t, position?, target?, fov?, interp?}])
api.setDuration(s) · api.setFps(f) · api.onFrame((t, f) => {...})
f.update(id, patch) / f.camera(patch) — 仅影响当前帧
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
      const lines = [`✓ executed — ${doc.objects.length} objects, ${doc.cameraKeys.length} camera keys, ${doc.onFrameScripts.length} onFrame hooks`];
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
