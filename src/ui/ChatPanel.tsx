import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowDown,
  BookOpen,
  Bot,
  Box,
  Brain,
  Camera,
  ChevronDown,
  ChevronRight,
  Image as ImageIcon,
  List,
  Maximize2,
  Minimize2,
  Paperclip,
  Pencil,
  Play,
  Plus,
  SendHorizontal,
  Settings,
  Square,
  Terminal,
  TriangleAlert,
  Video,
  Wrench,
  X,
} from "lucide-react";
import { isViewOnly, useStore, type ChatFloatState } from "../state/store";
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
import {
  filterMentionItems,
  fromChatImageItems,
  imageToken,
  mentionQueryAt,
  mergeSnapshotImages,
  parseMentions,
  snapshotMentionItems,
  splitByMentions,
  type MentionItem,
} from "../agent/mentions";
import { sandbox } from "../agent/sandbox";
import { snapshotDataUrl } from "../core/engine";
import { aspectDims } from "../core/cameraMath";
import { Resizer } from "./Resizer";
import { MentionPopup } from "./MentionPopup";
import type { MentionKind, SessionEvent, UserMention } from "../agent/types";

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

// --- floating window helpers ------------------------------------------------------

/** Bounds of the composer textarea height: the user drags between these and
 *  the textarea auto-grows up to the dragged height. */
export const COMPOSER_MIN = 48;
export const COMPOSER_MAX = 400;

function defaultChatFloat(): ChatFloatState {
  const w = Math.min(560, Math.max(340, Math.floor(window.innerWidth * 0.4)));
  const h = Math.min(680, Math.max(320, window.innerHeight - 160));
  return {
    open: true,
    w,
    h,
    x: Math.max(16, window.innerWidth - w - 40),
    y: Math.max(16, Math.min(96, window.innerHeight - h - 40)),
  };
}

export function undockChat(): void {
  const s = useStore.getState();
  if (s.layout.chatFloat?.open) return;
  s.setLayout({ chatFloat: defaultChatFloat() });
}

export function dockChat(): void {
  const s = useStore.getState();
  const f = s.layout.chatFloat ?? defaultChatFloat();
  s.setLayout({ chatFloat: { ...f, open: false }, rightOpen: true });
}

// --- @mention helpers ----------------------------------------------------------

/** Viewport position of the caret line at `index`, via a hidden mirror div
 *  that clones the textarea's font/padding/width so the mention popup can
 *  anchor at the token. `above` flips the popup when the caret sits low. */
function caretViewportPos(
  el: HTMLTextAreaElement,
  text: string,
  index: number,
): { x: number; y: number; above: boolean } {
  const cs = window.getComputedStyle(el);
  const div = document.createElement("div");
  const props = [
    "boxSizing",
    "width",
    "fontFamily",
    "fontSize",
    "fontWeight",
    "fontStyle",
    "letterSpacing",
    "lineHeight",
    "textTransform",
    "wordSpacing",
    "textIndent",
    "paddingTop",
    "paddingRight",
    "paddingBottom",
    "paddingLeft",
    "borderTopWidth",
    "borderRightWidth",
    "borderBottomWidth",
    "borderLeftWidth",
  ] as const;
  for (const p of props) div.style[p] = cs[p];
  div.style.position = "absolute";
  div.style.top = "0";
  div.style.left = "-9999px";
  div.style.visibility = "hidden";
  div.style.whiteSpace = "pre-wrap";
  div.style.overflowWrap = "break-word";
  div.textContent = text.slice(0, index);
  const marker = document.createElement("span");
  marker.textContent = "\u200b";
  div.appendChild(marker);
  document.body.appendChild(div);
  const mx = marker.offsetLeft;
  const my = marker.offsetTop;
  document.body.removeChild(div);
  const er = el.getBoundingClientRect();
  const px = (v: string) => parseFloat(v) || 0;
  const lh = px(cs.lineHeight) || px(cs.fontSize) * 1.4 || 16;
  return {
    x: er.left + px(cs.borderLeftWidth) + mx - el.scrollLeft,
    y: er.top + px(cs.borderTopWidth) + my - el.scrollTop + lh,
    above: er.top + my > window.innerHeight * 0.4,
  };
}

const MENTION_ICONS: Record<MentionKind, ReactNode> = {
  object: <Box size={11} />,
  camera: <Video size={11} />,
  snapshot: <Camera size={11} />,
  image: <ImageIcon size={11} />,
};

// --- component -------------------------------------------------------------------

export function ChatPanel({
  floating = false,
  onHeaderPointerDown,
}: {
  floating?: boolean;
  /** When floating, the tab bar doubles as the window's drag handle. */
  onHeaderPointerDown?: (e: React.PointerEvent) => void;
}) {
  const t = useT();
  const rightTab = useStore((s) => s.rightTab);
  const anyRunning = useStore((s) => Object.values(s.taskStates).some((st) => st === "running"));
  const setUi = useStore((s) => s.setUi);
  const [tasksOpen, setTasksOpen] = useState(false);

  return (
    <div
      className="panel"
      // Floating: flex:1 + min-width:0 — inside .chat-float-inner (a row flex
      // container) the panel must fill the window instead of hugging its
      // content's max-content width (text would stop at the longest line and
      // only re-fill once a long wrapping message arrived).
      style={floating ? { flex: 1, minWidth: 0, height: "100%", minHeight: 0, position: "relative" } : { flex: 1, minHeight: 0, position: "relative" }}
    >
      <div
        className={`right-tabs ${floating ? "floating" : ""}`}
        onPointerDown={floating ? onHeaderPointerDown : undefined}
      >
        <button
          className={rightTab === "chat" ? "active" : ""}
          onClick={() => setUi("rightTab", "chat")}
        >
          <Bot size={13} />
          {t("chat.title")}
          {anyRunning && <span className="running-dot" />}
        </button>
        <button
          className={rightTab === "script" ? "active" : ""}
          onClick={() => setUi("rightTab", "script")}
        >
          <Terminal size={13} />
          {t("chat.script")}
        </button>
        <button
          title={t("task.title")}
          className={tasksOpen ? "active" : ""}
          onClick={() => setTasksOpen(!tasksOpen)}
          style={{ flex: "0 0 auto", padding: "0 12px" }}
        >
          <List size={14} />
        </button>
        <button
          title={floating ? t("chat.dock") : t("chat.undock")}
          onClick={() => (floating ? dockChat() : undockChat())}
          style={{ flex: "0 0 auto", padding: "0 12px" }}
        >
          {floating ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
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
  const popRef = useRef<HTMLDivElement>(null);

  // Dismiss on outside click / Escape — a silently-stuck popover covers the
  // top of the chat log and eats clicks on cards underneath it.
  useEffect(() => {
    const onPointer = (e: PointerEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

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
    <div className="session-pop" ref={popRef}>
      <div className="session-pop-header">
        <span>{t("task.title")}</span>
        {projectName && <span className="task-project">{projectName}</span>}
        <span className="spacer" />
        <button className="btn small" title={t("task.new")} onClick={onNew}>
          <Plus size={12} />
          {t("task.new")}
        </button>
        <button className="btn small" title={t("common.close")} onClick={onClose}>
          <X size={12} />
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
                  <Pencil size={12} />
                </button>
                <button
                  className="btn small danger"
                  title={t("common.delete")}
                  onClick={() => void onDelete(meta.id, meta.name)}
                >
                  <X size={12} />
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
  const composerH = useStore((s) => s.layout.composerH);
  const settings = useStore((s) => s.settings);
  const showToast = useStore((s) => s.showToast);
  const doc = useStore((s) => s.doc);

  const [text, setText] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  // Active `@token` under the caret plus the popup's viewport anchor.
  const [mention, setMention] = useState<{
    range: { start: number; end: number; query: string };
    pos: { x: number; y: number; above: boolean };
  } | null>(null);
  const [mentionActive, setMentionActive] = useState(0);
  // Escape/outside dismissal is scoped to the current query: typing on reopens.
  const [mentionDismissed, setMentionDismissed] = useState<string | null>(null);
  // Ctrl+Space keeps the popup open even when nothing matches (manual mode).
  const [mentionManual, setMentionManual] = useState(false);
  // Caret position to restore after a programmatic text change (accept/Ctrl+Space).
  const pendingCaretRef = useRef<number | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // Autoscroll only while the reader is at the bottom: events stream in
  // continuously while the agent runs, so unconditional scrolling would pin
  // the log down and make history unreadable mid-run.
  const stickToBottom = useRef(true);
  // While a pointer is down inside the log, streaming flushes must not scroll
  // — otherwise the pressed summary moves out from under the cursor between
  // mousedown and mouseup and the click never toggles the card.
  const interactingRef = useRef(false);
  // Viewport anchor for a just-toggled card: streaming flushes re-apply it so
  // the card stays under the cursor instead of being scrolled away. Stores the
  // summary element and its viewport distance; the summary's content position
  // is re-resolved on every apply, so toggles and growth above/below it are
  // all handled.
  const anchorRef = useRef<{ summary: HTMLElement; dView: number } | null>(null);
  // True for the one scroll event caused by programmatically applying the
  // anchor — without this the "near bottom" check would read the anchor's own
  // scroll as the user re-pinning and clear the anchor every flush.
  const suppressScrollRef = useRef(false);
  const composerDragRef = useRef<{ y: number; h: number } | null>(null);
  const configured = isConfigured(settings);

  const scrollToBottom = useCallback(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  const onLogScroll = useCallback(() => {
    if (suppressScrollRef.current) {
      suppressScrollRef.current = false;
      return;
    }
    const el = logRef.current;
    if (!el) return;
    // Tolerance absorbs rounding and late image height changes at the bottom.
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    stickToBottom.current = near;
    if (near) anchorRef.current = null;
    setAtBottom(near);
  }, []);

  useEffect(() => {
    const up = () => {
      interactingRef.current = false;
    };
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, []);

  useEffect(() => {
    const el = logRef.current;
    if (!el || interactingRef.current) return;
    const anchor = anchorRef.current;
    if (anchor) {
      // Keep the toggled card's summary at its viewport position while
      // streamed content changes the log around it.
      if (!anchor.summary.isConnected) {
        anchorRef.current = null;
      } else {
        const lr = el.getBoundingClientRect();
        const sr = anchor.summary.getBoundingClientRect();
        const sumTopContent = sr.top - lr.top + el.scrollTop;
        suppressScrollRef.current = true;
        el.scrollTop = sumTopContent - (el.clientHeight - anchor.dView);
        // A no-op assignment fires no scroll event — never keep the flag stale.
        requestAnimationFrame(() => {
          suppressScrollRef.current = false;
        });
      }
      return;
    }
    if (stickToBottom.current) scrollToBottom();
  }, [events, scrollToBottom]);

  // Switching tasks always lands on the newest message of the active task,
  // regardless of where the previous task was left scrolled.
  useEffect(() => {
    stickToBottom.current = true;
    anchorRef.current = null;
    setAtBottom(true);
    scrollToBottom();
  }, [activeTaskId, scrollToBottom]);

  // Auto-grow the textarea with its content: floor = user-dragged composer
  // height, cap = hard limit. Clearing the text returns to the floor. Set
  // imperatively — a state-derived height would bail out when the value is
  // unchanged and leave the measurement's 0px height in place.
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "0px";
    const content = el.scrollHeight;
    el.style.height = `${Math.max(composerH, Math.min(content, COMPOSER_MAX), COMPOSER_MIN)}px`;
  }, [text, composerH]);

  // --- @mention popup ----------------------------------------------------------------

  // Popup rows: scene objects/cameras, this task's snapshots, pending
  // attachments and images already present in the transcript.
  const mentionItems = useMemo<MentionItem[]>(() => {
    const objs: MentionItem[] = doc.objects.map((o) => ({
      kind: "object",
      section: "objects",
      label: o.name,
      token: `@${o.name}`,
      id: o.id,
      sublabel: o.type,
    }));
    const cams: MentionItem[] = doc.cameras.map((c) => ({
      kind: "camera",
      section: "cameras",
      label: c.name,
      token: `@${c.name}`,
      id: c.id,
      sublabel: c.id === doc.activeCameraId ? t("chat.mentionActive") : undefined,
    }));
    const imgs: MentionItem[] = images.map((d, i) => ({
      kind: "image",
      section: "images",
      label: imageToken(i + 1),
      token: imageToken(i + 1),
      sublabel: t("chat.mentionAttached"),
      dataUrl: d,
      index: i + 1,
    }));
    const fromChat = fromChatImageItems(events, images).map((it) => ({
      ...it,
      label: t("chat.mentionImageGeneric"),
    }));
    return [...objs, ...cams, ...snapshotMentionItems(events), ...imgs, ...fromChat];
  }, [doc, events, images, t]);

  const filteredMentionItems = useMemo(
    () => filterMentionItems(mentionItems, mention?.range.query ?? ""),
    [mentionItems, mention?.range.query],
  );
  // Highlighted row, clamped while the filtered list shrinks under the cursor
  // position; kept valid across renders without extra effects.
  const mentionIdx = filteredMentionItems.length
    ? Math.min(mentionActive, filteredMentionItems.length - 1)
    : 0;
  const mentionOpen =
    !!mention &&
    (mentionManual ||
      (mentionDismissed !== mention.range.query && filteredMentionItems.length > 0));

  // Re-arm the popup at the top row whenever the query changes.
  useEffect(() => {
    setMentionActive(0);
  }, [mention?.range.query]);

  // Restore the caret after programmatic text changes (mention accept and
  // Ctrl+Space's "@" insertion) so typing continues where the user expects.
  useEffect(() => {
    const c = pendingCaretRef.current;
    if (c == null) return;
    pendingCaretRef.current = null;
    taRef.current?.setSelectionRange(c, c);
  }, [text]);

  const syncMention = useCallback((value: string, caret: number) => {
    const ta = taRef.current;
    if (!ta) return;
    const range = mentionQueryAt(value, caret);
    if (!range) {
      setMention(null);
      setMentionManual(false);
      return;
    }
    const pos = caretViewportPos(ta, value, range.start);
    setMention((prev) =>
      prev && prev.range.start === range.start && prev.range.query === range.query
        ? prev
        : { range, pos },
    );
  }, []);

  const acceptMention = useCallback(
    (item: MentionItem) => {
      const ta = taRef.current;
      const m = mention;
      if (!ta || !m) return;
      let imgs = images;
      let insertion = item.token;
      // Snapshots and from-chat images become real attachments on accept so
      // `@Image n` always indexes a sent image.
      if (item.dataUrl && !images.includes(item.dataUrl)) {
        const limit = useStore.getState().settings.maxImages;
        if (images.length >= limit) {
          showToast(`chat.tooManyImages|${limit}`);
        } else {
          imgs = [...images, item.dataUrl];
          setImages(imgs);
        }
      }
      if (item.kind === "image" && !item.index && item.dataUrl) {
        const idx = imgs.indexOf(item.dataUrl);
        insertion = imageToken(idx + 1);
      }
      if (!insertion) {
        setMention(null);
        setMentionManual(false);
        return;
      }
      const { start, end } = m.range;
      pendingCaretRef.current = start + insertion.length + 1;
      setText(ta.value.slice(0, start) + insertion + " " + ta.value.slice(end));
      setMention(null);
      setMentionManual(false);
      setMentionDismissed(null);
      ta.focus();
    },
    [mention, images, showToast],
  );

  // Anchors the log when the user expands/collapses a card (via its summary)
  // so the next streaming flush keeps the card in place instead of jumping to
  // the newest message. Measured synchronously — a summary's own position is
  // unaffected by its own toggle, so pre-toggle geometry is already correct,
  // and the anchor must not depend on rAF timing. Programmatic auto-open/
  // close intentionally does NOT anchor.
  const onCardClick = useCallback((summary: HTMLElement) => {
    const log = logRef.current;
    if (!log) return;
    anchorRef.current = {
      summary,
      dView: log.getBoundingClientRect().bottom - summary.getBoundingClientRect().top,
    };
    stickToBottom.current = false;
  }, []);

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
    // Resolve @tokens against the live scene: snapshot references pull their
    // image into the attachment list, entity names get recorded for chips and
    // for the [References] block the model receives.
    const docNow = useStore.getState().doc;
    const mentions = parseMentions(message, docNow);
    const sent = mergeSnapshotImages(images, mentions, events, useStore.getState().settings.maxImages);
    setText("");
    setImages([]);
    setMention(null);
    setMentionManual(false);
    setMentionDismissed(null);
    // A message the user just sent must always be visible.
    stickToBottom.current = true;
    anchorRef.current = null;
    setAtBottom(true);
    void runAgentTurn({ text: message, images: sent, mentions: mentions.length ? mentions : undefined });
  };

  // The event currently being streamed by the agent — drives the typing
  // dots, the caret and the auto-expanded thinking cards. A step pushes its
  // assistant event BEFORE the reasoning that follows it, so the live
  // assistant is the first non-reasoning event scanning from the end (any
  // tool_call/user/snapshot after it means that step is over).
  let liveAssistantId: string | null = null;
  let liveReasoningId: string | null = null;
  if (agentState === "running" && events.length > 0) {
    const last = events[events.length - 1];
    if (last.type === "reasoning") liveReasoningId = last.id;
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.type === "reasoning") continue;
      if (e.type === "assistant") liveAssistantId = e.id;
      break;
    }
  }
  const isLive = (id: string) => id === liveAssistantId || id === liveReasoningId;

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
      <div className="chat-log" ref={logRef} onScroll={onLogScroll} onPointerDown={() => (interactingRef.current = true)}>
        {events.length === 0 && configured && (
          <div className="msg notice" style={{ textAlign: "left" }}>
            {t("chat.placeholder")}
          </div>
        )}
        {events.map((event) => (
          <SessionEventView key={event.id} event={event} live={isLive(event.id)} onSummaryClick={onCardClick} />
        ))}
        {agentState === "running" && (
          <div className="msg notice">
            {t("chat.thinking")}{" "}
            {agentStep > 0
              ? `· ${
                  settings.limitMaxSteps
                    ? t("chat.stepOf", { i: agentStep, max: settings.maxSteps })
                    : t("chat.step", { i: agentStep })
                }`
              : ""}
          </div>
        )}
        {!atBottom && (
          <div className="chat-jump-row">
            <button
              className="btn small chat-jump"
              onClick={() => {
                stickToBottom.current = true;
                anchorRef.current = null;
                setAtBottom(true);
                scrollToBottom();
              }}
            >
              <ArrowDown size={12} />
              {t("chat.jumpToLatest")}
            </button>
          </div>
        )}
      </div>

      {!configured ? (
        <div className="chat-disabled">
          <span>{t("chat.notConfigured")}</span>
          <button className="btn primary" onClick={() => useStore.setState({ settingsOpen: true })}>
            <Settings size={13} />
            {t("chat.openSettings")}
          </button>
        </div>
      ) : (
        <div className="composer">
          <Resizer
            dir="row"
            onStart={(e) => {
              composerDragRef.current = { y: e.clientY, h: composerH };
            }}
            onMove={(e) => {
              const start = composerDragRef.current;
              if (!start) return;
              useStore.getState().setLayout({
                composerH: Math.min(COMPOSER_MAX, Math.max(COMPOSER_MIN, start.h + (start.y - e.clientY))),
              });
            }}
          />
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
                    <X size={10} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <textarea
            ref={taRef}
            value={text}
            placeholder={t("chat.placeholder")}
            onChange={(e) => {
              setText(e.target.value);
              syncMention(e.target.value, e.target.selectionStart);
            }}
            onSelect={() => {
              const ta = taRef.current;
              if (ta) syncMention(ta.value, ta.selectionStart);
            }}
            onPaste={(e) => {
              const files = [...e.clipboardData.files];
              if (files.length) {
                e.preventDefault();
                void addImages(files);
              }
            }}
            onKeyDown={(e) => {
              // Ctrl/Cmd+Space: invoke the mention popup at the caret — even
              // with no `@token` present (one is inserted in that case).
              if ((e.ctrlKey || e.metaKey) && (e.code === "Space" || e.key === " ")) {
                e.preventDefault();
                const ta = e.currentTarget;
                const caret = ta.selectionStart;
                const range = mentionQueryAt(ta.value, caret);
                if (!range) {
                  const next = ta.value.slice(0, caret) + "@" + ta.value.slice(ta.selectionEnd);
                  pendingCaretRef.current = caret + 1;
                  setText(next);
                  syncMention(next, caret + 1);
                } else {
                  syncMention(ta.value, caret);
                }
                setMentionManual(true);
                setMentionDismissed(null);
                return;
              }
              if (mentionOpen && filteredMentionItems.length > 0) {
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  const n = filteredMentionItems.length;
                  setMentionActive((a) => (e.key === "ArrowDown" ? (a + 1) % n : (a - 1 + n) % n));
                  return;
                }
                if (e.key === "Enter" || e.key === "Tab") {
                  e.preventDefault();
                  if (!e.nativeEvent.isComposing) acceptMention(filteredMentionItems[mentionIdx]);
                  return;
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  setMentionDismissed(mention!.range.query);
                  setMentionManual(false);
                  return;
                }
              }
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          {mentionOpen && mention && (
            <MentionPopup
              items={filteredMentionItems}
              activeIndex={mentionIdx}
              x={mention.pos.x}
              y={mention.pos.y}
              above={mention.pos.above}
              onHover={setMentionActive}
              onAccept={acceptMention}
              onClose={() => {
                setMentionDismissed(mention.range.query);
                setMentionManual(false);
              }}
            />
          )}
          <div className="actions">
            <button className="btn small" title={t("chat.attach")} onClick={() => fileRef.current?.click()}>
              <Paperclip size={13} />
            </button>
            <button className="btn small" title={t("chat.attachView")} onClick={attachCurrentView}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 1 }}>
                <Camera size={13} />
                <Plus size={9} />
              </span>
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
                <Square size={12} />
                {t("chat.stop")}
              </button>
            ) : (
              <button className="btn primary small" onClick={send} disabled={!text.trim() && images.length === 0}>
                {t("chat.send")}
                <SendHorizontal size={12} />
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

// --- event rendering -----------------------------------------------------------------
// Memoized: streaming patches replace one event object every ~90ms, so with
// memo the untouched rows skip re-rendering entirely.

/** Inline pill for an `@token` in a sent message. Object chips are clickable
 *  and select the referenced object in the scene — by stored id, falling back
 *  to a unique name match when the object was rebuilt (new id) since the
 *  message was sent. */
function MentionChip({ mention }: { mention: UserMention }) {
  const t = useT();
  const label = mention.name ?? mention.token.slice(1);
  if (mention.kind === "object") {
    return (
      <button
        type="button"
        className="mention-chip"
        title={t("chat.mentionSelect")}
        onClick={() => {
          const doc = useStore.getState().doc;
          const target =
            doc.objects.find((o) => o.id === mention.id) ??
            doc.objects.find((o) => o.name === mention.name);
          if (target) useStore.setState({ selection: [target.id] });
        }}
      >
        {MENTION_ICONS[mention.kind]}
        <span>{label}</span>
      </button>
    );
  }
  return (
    <span className="mention-chip">
      {MENTION_ICONS[mention.kind]}
      <span>{label}</span>
    </span>
  );
}


const SessionEventView = memo(function SessionEventView({
  event,
  live = false,
  onSummaryClick,
}: {
  event: SessionEvent;
  live?: boolean;
  onSummaryClick?: (summary: HTMLElement) => void;
}) {
  const t = useT();

  switch (event.type) {
    case "user": {
      const parts = event.mentions?.length ? splitByMentions(event.text, event.mentions) : null;
      return (
        <div className="msg user">
          <span className="who">{t("chat.you")}</span>
          {event.images.length > 0 && <UserImages images={event.images} />}
          {event.text && (
            <div className="bubble">
              {parts
                ? parts.map((p, i) =>
                    typeof p === "string" ? <span key={i}>{p}</span> : <MentionChip key={i} mention={p} />,
                  )
                : event.text}
            </div>
          )}
        </div>
      );
    }
    case "assistant":
      return (
        <div className="msg">
          <span className="who">
            {t("chat.agent")}
            {event.step ? ` · ${t("chat.step", { i: event.step })}` : ""}
          </span>
          {!event.text && live ? (
            // Waiting for the first token of this step.
            <div className="bubble typing" aria-label={t("chat.thinking")}>
              <span />
              <span />
              <span />
            </div>
          ) : event.text ? (
            <div className="bubble">
              {event.text}
              {live && <span className="stream-caret" />}
            </div>
          ) : null}
        </div>
      );
    case "reasoning":
      if (!event.text) return null;
      return (
        <details
          className="tool-card"
          ref={(el) => {
            // Auto-expand while this card actively streams and auto-collapse
            // when the stream moves on — unless the user toggled it manually.
            if (el && !el.dataset.manual) el.open = live;
          }}
        >
          <summary
            onClick={(e) => {
              const d = e.currentTarget.parentElement as HTMLDetailsElement | null;
              if (d) d.dataset.manual = "1";
              onSummaryClick?.(e.currentTarget);
            }}
          >
            <Brain size={12} />
            {t("chat.thinking")}
          </summary>
          <pre>{event.text}</pre>
        </details>
      );
    case "tool_call":
      return (
        <details
          className={`tool-card ${event.status === "error" ? "error" : ""}`}
          ref={(el) => {
            // Auto-open while the tool executes; the result stays visible
            // until the user closes the card themselves.
            if (el && !el.dataset.manual && event.status === "running") el.open = true;
          }}
        >
          <summary
            onClick={(e) => {
              const d = e.currentTarget.parentElement as HTMLDetailsElement | null;
              if (d) d.dataset.manual = "1";
              onSummaryClick?.(e.currentTarget);
            }}
          >
            <Wrench size={12} />
            {event.name}
            <span className={`status ${event.status}`}>
              {event.status === "running" ? t("chat.toolRunning") : `${event.status}${event.durationMs ? ` ${event.durationMs}ms` : ""}`}
            </span>
          </summary>
          <pre>{`args:\n${event.argsJson}${event.resultText ? `\n\nresult:\n${event.resultText}` : ""}`}</pre>
        </details>
      );
    case "snapshot":
      return <SnapshotImage event={event} />;
    case "error":
      return (
        <div className="msg error-banner">
          <TriangleAlert size={12} /> {t("chat.error")}: {event.message}
        </div>
      );
    case "notice":
      return <div className="msg notice">{event.text}</div>;
    default:
      return null;
  }
});

// Attached user images follow the same collapse/expand pattern as snapshots:
// a row of small thumbnails by default; clicking one expands it inline
// (clicking the expanded image opens the full-size lightbox).
function UserImages({ images }: { images: string[] }) {
  const t = useT();
  const [expanded, setExpanded] = useState<number | null>(null);
  if (expanded === null) {
    return (
      <div className="thumbs">
        {images.map((img, i) => (
          <button key={i} type="button" className="thumb-wrap" title={t("chat.expandImage")} onClick={() => setExpanded(i)}>
            <img src={img} alt="" />
          </button>
        ))}
      </div>
    );
  }
  return (
    <div className="thumbs has-expanded">
      <img
        className="expanded-img"
        src={images[expanded]}
        alt=""
        onClick={() => useStore.setState({ lightbox: images[expanded] })}
      />
      <div className="thumbs mini-row">
        {images.map((img, i) => (
          <button
            key={i}
            type="button"
            className={`thumb-wrap ${i === expanded ? "current" : ""}`}
            onClick={() => setExpanded(i)}
          >
            <img src={img} alt="" />
          </button>
        ))}
      </div>
      <button type="button" className="img-toggle" onClick={() => setExpanded(null)}>
        <ChevronRight size={10} />
        {t("chat.collapseImage")}
      </button>
    </div>
  );
}

// Snapshots default to a small thumbnail so a multi-snapshot turn doesn't
// flood the log; the caption toggles inline expansion and the expanded image
// still opens the lightbox for full-size viewing.
function SnapshotImage({ event }: { event: Extract<SessionEvent, { type: "snapshot" }> }) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="msg snapshot-msg">
      <span
        className="cap"
        title={expanded ? t("chat.collapseImage") : t("chat.expandImage")}
        onClick={() => setExpanded(!expanded)}
      >
        <span className="toggle">{expanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}</span>
        <ImageIcon size={11} />
        <span>
          {t("chat.snapshotAt", { t: event.t.toFixed(2) })} — {event.width}×{event.height}
        </span>
      </span>
      <img
        src={event.dataUrl}
        alt={`snapshot @ ${event.t}s`}
        className={expanded ? "expanded" : "thumb"}
        onClick={() => (expanded ? useStore.setState({ lightbox: event.dataUrl }) : setExpanded(true))}
      />
    </div>
  );
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
            <Play size={12} />
            {t("script.run")} (Ctrl+Enter)
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
        <summary>
          <BookOpen size={12} />
          {t("script.docsTitle")}
        </summary>
        <pre>{DOCS[getLocale()]}</pre>
      </details>
    </div>
  );
}
