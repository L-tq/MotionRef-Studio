/** Studio Link — the browser-side client of the local studio server.
 *
 *  When the app is served by the studio server (local deployment mode), this
 *  module connects over WebSocket and turns the browser into a synced client
 *  of the server-owned document:
 *   - user edits apply optimistically and are confirmed by doc.apply →
 *     broadcast doc.update (roll back on doc.rejected, e.g. edit lock)
 *   - the built-in agent's tool calls are RELAYED to the server (tool.invoke)
 *     so they execute through the exact same pipeline as external MCP agents
 *   - snapshot render requests from the server are answered with the local
 *     offscreen WebGL renderer
 *   - projects live as files in the workspace (projects.* ops)
 *
 *  In the plain browser-only deployment the /studio/info probe fails and the
 *  whole module stays dormant. */
import { snapshotDataUrl } from "../core/engine";
import { validateSceneDocument } from "../core/validate";
import { getLocale, t } from "../i18n";
import type { ProjectInfo, ProjectOpMsg, ServerMsg } from "../shared/protocol";
import { newId } from "../core/types";
import { putSession } from "./chatPersist";
import { serverAuthority, useStore } from "./store";

/** Registered by studioLink, consumed by the store's server-mode branches
 *  (avoids a store → studioLink import cycle). */
interface ServerAuthority {
  sendDoc(doc: unknown, label: string): void;
  sendHistory(op: "history.undo" | "history.redo"): void;
  projectOp(op: ProjectOpMsg): void;
}

let authority: ServerAuthority | null = null;

export function isServerMode(): boolean {
  return useStore.getState().docAuthority === "server";
}

export function isViewOnly(): boolean {
  const s = useStore.getState();
  return !!s.studio.lock && s.studio.lock.id !== s.studio.clientId;
}

let ws: WebSocket | null = null;
let clientId = "";
let serverRev = 0;
let reconnectDelay = 1000;
let closedByUs = false;
/** Origin of the studio server that answered the probe (differs from the
 *  page origin in dev mode, where vite serves the app). */
let studioOrigin = "";
const pendingCalls = new Map<string, (r: { text: string; isError: boolean; snapshot?: { dataUrl: string; t: number; w: number; h: number } }) => void>();

function send(msg: unknown): void {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

// --- boot ---------------------------------------------------------------------------

interface StudioInfo {
  version: string;
  workspace: string;
  token: string;
  mcpUrl: string;
}

async function probe(url: string): Promise<StudioInfo | null> {
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    const info = (await res.json()) as Partial<StudioInfo>;
    if (!info.token || !info.mcpUrl) return null;
    return info as StudioInfo;
  } catch {
    return null;
  }
}

export async function initStudioLink(): Promise<void> {
  clientId = newId("c");
  let origin = location.origin;
  let info = await probe(`${origin}/studio/info`);
  // Dev mode: the app is served by vite; the studio server runs alongside.
  if (!info && (location.hostname === "localhost" || location.hostname === "127.0.0.1")) {
    origin = "http://127.0.0.1:8787";
    info = await probe(`${origin}/studio/info`);
  }
  if (!info) return; // browser-only deployment — stay dormant
  studioOrigin = origin;
  useStore.setState({
    docAuthority: "server",
    studio: {
      ...useStore.getState().studio,
      status: "connecting",
      workspace: info.workspace,
      mcpUrl: info.mcpUrl,
      token: info.token,
      version: info.version,
    },
  });
  connect(info.token);
}

function connect(token: string): void {
  const url = new URL(studioOrigin);
  const proto = url.protocol === "https:" ? "wss" : "ws";
  try {
    ws = new WebSocket(`${proto}://${url.host}/ws?token=${encodeURIComponent(token)}`);
  } catch {
    scheduleReconnect(token);
    return;
  }
  ws.onopen = () => {
    reconnectDelay = 1000;
    send({ type: "hello", clientId, version: "browser" });
  };
  ws.onmessage = (e) => {
    try {
      handleServerMessage(JSON.parse(String(e.data)) as ServerMsg);
    } catch {
      /* ignore malformed */
    }
  };
  ws.onclose = () => {
    useStore.setState({ studio: { ...useStore.getState().studio, status: "connecting" } });
    if (!closedByUs) scheduleReconnect(token);
  };
  ws.onerror = () => ws?.close();
}

function scheduleReconnect(token: string): void {
  setTimeout(() => connect(token), reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, 10_000);
}

// --- server messages ------------------------------------------------------------------

function handleServerMessage(msg: ServerMsg): void {
  switch (msg.type) {
    case "welcome":
      useStore.setState({
        studio: {
          ...useStore.getState().studio,
          status: "connected",
          clientId,
          lock: msg.lock,
          mcpClients: msg.mcpClients,
          mcpLabels: msg.mcpLabels ?? [],
          browsers: msg.browsers,
        },
      });
      serverRev = msg.rev - 1;
      applyRemoteDoc(msg.rev, msg.doc, "welcome");
      useStore.setState({ serverProjects: msg.projects, projectId: msg.project?.id ?? null });
      useStore.setState({ studioHistory: { canUndo: msg.canUndo, canRedo: msg.canRedo } });
      registerAuthority();
      break;
    case "doc.update":
      applyRemoteDoc(msg.rev, msg.doc, msg.label);
      break;
    case "doc.rejected": {
      serverRev = msg.rev - 1;
      applyRemoteDoc(msg.rev, msg.doc, "rollback");
      useStore.getState().showToast(msg.reason === "lock" ? "error.sceneLocked" : `error.invalidJson|${msg.message}`);
      break;
    }
    case "history.state":
      useStore.setState({ studioHistory: { canUndo: msg.canUndo, canRedo: msg.canRedo } });
      break;
    case "lock.state":
      useStore.setState({ studio: { ...useStore.getState().studio, lock: msg.lock } });
      break;
    case "presence":
      useStore.setState({
        studio: {
          ...useStore.getState().studio,
          mcpClients: msg.mcpClients,
          mcpLabels: msg.mcpLabels ?? [],
          browsers: msg.browsers,
        },
      });
      break;
    case "projects.update": {
      const prev = useStore.getState().projectId;
      useStore.setState({ serverProjects: msg.projects, projectId: msg.currentId });
      // First save of a scratch scene: adopt scratch chat tasks into the new
      // project id (mirrors the local-mode saveProject behavior).
      if (!prev && msg.currentId) void adoptScratchTasks(msg.currentId);
      break;
    }
    case "render.request": {
      try {
        const s = useStore.getState();
        const dataUrl = snapshotDataUrl(s.doc, msg.time, msg.width, msg.height, "jpeg");
        send({ type: "render.result", requestId: msg.requestId, ok: true, dataUrl });
      } catch (e) {
        send({ type: "render.result", requestId: msg.requestId, ok: false, error: String(e) });
      }
      break;
    }
    case "tool.result": {
      const resolve = pendingCalls.get(msg.callId);
      if (resolve) {
        pendingCalls.delete(msg.callId);
        resolve({ text: msg.text, isError: msg.isError, snapshot: msg.snapshot });
      }
      break;
    }
    case "error":
      useStore.getState().showToast(`error.studio|${msg.message}`);
      break;
  }
}

function applyRemoteDoc(rev: number, doc: unknown, label: string): void {
  if (rev <= serverRev) return;
  serverRev = rev;
  const result = validateSceneDocument(doc);
  if ("error" in result) return; // server only broadcasts validated docs
  const s = useStore.getState();
  if (JSON.stringify(s.doc) === JSON.stringify(result.doc)) return;
  const patch: Record<string, unknown> = { doc: result.doc };
  if (label === "open-project" || label === "new-project" || label === "welcome") {
    Object.assign(patch, { selection: [], playhead: 0, playing: false, camPanelSel: null, selectedMarker: null });
  }
  useStore.setState(patch as never);
}

async function adoptScratchTasks(projectId: string): Promise<void> {
  const s = useStore.getState();
  for (const meta of s.tasks) {
    if (meta.projectId) continue;
    s.registerTaskProject(meta.id, projectId);
    await putSession({
      id: meta.id,
      name: meta.name,
      projectId,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      events: s.taskEvents[meta.id] ?? [],
    }).catch(() => undefined);
  }
  useStore.setState({ tasks: s.tasks.map((m) => (m.projectId ? m : { ...m, projectId })) });
}

// --- authority registration (store calls these in server mode) --------------------------

function registerAuthority(): void {
  authority = {
    sendDoc: (doc, label) => send({ type: "doc.apply", baseRev: serverRev, doc, label }),
    sendHistory: (op) => send({ type: op }),
    projectOp: (op) => send(op),
  };
  serverAuthority.sendDoc = (doc, label) => authority?.sendDoc(doc, label);
  serverAuthority.sendHistory = (op) => authority?.sendHistory(op);
  serverAuthority.projectOp = (op) => authority?.projectOp(op);
}

// --- built-in agent integration -----------------------------------------------------------

/** Acquire the edit lock for a built-in agent turn. Returns an error message
 *  when another writer currently holds the lock. */
export async function acquireTurnLock(label: string): Promise<string | null> {
  if (!isServerMode()) return null;
  send({ type: "lock.acquire", label });
  // The server answers with lock.state (broadcast) or an error message; wait
  // briefly and check whether we became the holder.
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const holder = useStore.getState().studio.lock;
    if (holder && holder.id === clientId) return null;
    if (holder && holder.id !== clientId) return t("error.sceneLocked");
  }
  return t("error.sceneLocked");
}

export function releaseTurnLock(): void {
  if (isServerMode()) send({ type: "lock.release" });
}

export function forceUnlock(): void {
  send({ type: "lock.force" });
}

export function reportTurnState(running: boolean): void {
  if (isServerMode()) send({ type: "session.status", builtInAgentRunning: running, locale: getLocale() });
}

/** Relay one built-in agent tool call to the server — the exact pipeline
 *  external MCP agents use. */
export function invokeRemoteTool(name: string, argsJson: string): Promise<{ text: string; isError: boolean; snapshot?: { dataUrl: string; t: number; w: number; h: number } }> {
  return new Promise((resolve) => {
    const callId = newId("call");
    const timer = setTimeout(() => {
      pendingCalls.delete(callId);
      resolve({ text: "ERROR: studio server did not answer in 30s (is it still running?)", isError: true });
    }, 30_000);
    pendingCalls.set(callId, (r) => {
      clearTimeout(timer);
      resolve(r);
    });
    send({ type: "tool.invoke", callId, name, argsJson });
  });
}

// --- project ops (server mode) ---------------------------------------------------------------

export function serverProjectOp(op: ProjectOpMsg): void {
  send(op);
}

/** Browse server-side directories for the new-project save picker. */
export async function browseServerDirs(path?: string): Promise<{ path: string; parent: string; dirs: Array<{ name: string; path: string }> } | { error: string }> {
  try {
    const res = await fetch(`${studioOrigin}/studio/fs/list?path=${encodeURIComponent(path ?? "")}`, { headers: { Accept: "application/json" } });
    const body = (await res.json()) as { path: string; parent: string; dirs: Array<{ name: string; path: string }> } & { error?: string };
    if (!res.ok || body.error) return { error: body.error ?? `HTTP ${res.status}` };
    return body;
  } catch (e) {
    return { error: String(e) };
  }
}

// Boot on module load (single-page app: this runs once per tab).
void initStudioLink();
