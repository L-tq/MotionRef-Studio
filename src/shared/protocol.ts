/** Wire protocol between the studio server and browser clients (DOM-free,
 *  shared by server/* and src/state/studioLink.ts).
 *
 *  The server owns the SceneDocument (single authority). Browser clients are
 *  synced viewers/editors: they apply edits optimistically and confirm via
 *  doc.apply; the server validates, commits, and broadcasts doc.update. A
 *  single-writer edit lock gates every mutation — while one writer (built-in
 *  agent turn, external MCP agent, or the user) holds the lock, everyone else
 *  is view-only. Reads (get_scene_state, snapshot, playback) never lock. */

export type LockKind = "agent" | "mcp" | "user";

export interface LockHolder {
  kind: LockKind;
  /** Stable actor id: browser clientId, MCP session id… */
  id: string;
  /** Human-readable: task name, agent client name, "Web UI". */
  label: string;
}

export interface ProjectInfo {
  id: string;
  name: string;
  /** Absolute path of the .mrsproj.json bundle on disk. */
  path: string;
  savedAt: number;
}

/** Sliding lock windows (ms). Built-in agent turns are long (LLM steps), so
 *  their lock is renewed on every relayed tool call instead of expiring
 *  quickly; user edits renew a short window on every mutation. */
export const LOCK_TTL_MS: Record<LockKind, number> = {
  agent: 10 * 60_000,
  mcp: 15_000,
  user: 3_000,
};

/** How long a would-be writer waits for the lock before failing busy. */
export const LOCK_WAIT_MS = 5_000;

// --- server → browser ------------------------------------------------------------

export interface WelcomeMsg {
  type: "welcome";
  serverVersion: string;
  rev: number;
  doc: unknown;
  project: ProjectInfo | null;
  projects: ProjectInfo[];
  lock: LockHolder | null;
  mcpClients: number;
  browsers: number;
  canUndo: boolean;
  canRedo: boolean;
}

export interface DocUpdateMsg {
  type: "doc.update";
  rev: number;
  doc: unknown;
  label: string;
  /** Who caused it: "user" | "agent" | "mcp" | "server". */
  source: string;
}

/** Sent to the origin of a rejected doc.apply so it can roll its optimistic
 *  edit back to the authoritative document. */
export interface DocRejectedMsg {
  type: "doc.rejected";
  reason: "lock" | "invalid";
  message: string;
  rev: number;
  doc: unknown;
}

export interface HistoryStateMsg {
  type: "history.state";
  canUndo: boolean;
  canRedo: boolean;
}

export interface LockStateMsg {
  type: "lock.state";
  lock: LockHolder | null;
}

export interface PresenceMsg {
  type: "presence";
  mcpClients: number;
  browsers: number;
}

export interface ProjectsUpdateMsg {
  type: "projects.update";
  projects: ProjectInfo[];
  currentId: string | null;
}

export interface RenderRequestMsg {
  type: "render.request";
  requestId: string;
  rev: number;
  time: number;
  width: number;
  height: number;
}

export interface ToolResultMsg {
  type: "tool.result";
  callId: string;
  text: string;
  isError: boolean;
  snapshot?: { dataUrl: string; t: number; w: number; h: number };
}

export interface ServerErrorMsg {
  type: "error";
  message: string;
}

export type ServerMsg =
  | WelcomeMsg
  | DocUpdateMsg
  | DocRejectedMsg
  | HistoryStateMsg
  | LockStateMsg
  | PresenceMsg
  | ProjectsUpdateMsg
  | RenderRequestMsg
  | ToolResultMsg
  | ServerErrorMsg;

// --- browser → server ------------------------------------------------------------

export interface HelloMsg {
  type: "hello";
  clientId: string;
  version: string;
}

export interface DocApplyMsg {
  type: "doc.apply";
  baseRev: number;
  doc: unknown;
  label: string;
}

export interface HistoryOpMsg {
  type: "history.undo" | "history.redo";
}

export interface LockAcquireMsg {
  type: "lock.acquire";
  /** Task name for the banner shown to everyone else. */
  label: string;
}

export interface LockReleaseMsg {
  type: "lock.release";
}

export interface LockForceMsg {
  type: "lock.force";
}

export interface ToolInvokeMsg {
  type: "tool.invoke";
  callId: string;
  name: string;
  argsJson: string;
}

export interface RenderResultMsg {
  type: "render.result";
  requestId: string;
  ok: boolean;
  dataUrl?: string;
  error?: string;
}

export type ProjectOpMsg =
  | { type: "projects.list" }
  | { type: "projects.save"; name?: string }
  /** First save of a scratch scene: create the project file at the chosen
   *  directory and write the CURRENT scene into it (the web UI asks for
   *  name + dir before sending this). */
  | { type: "projects.saveAs"; name: string; dir?: string }
  | { type: "projects.open"; id: string }
  | { type: "projects.new"; name?: string; dir?: string }
  | { type: "projects.delete"; id: string };

export interface SessionStatusMsg {
  type: "session.status";
  builtInAgentRunning: boolean;
  locale: "en" | "zh";
}

export type ClientMsg =
  | HelloMsg
  | DocApplyMsg
  | HistoryOpMsg
  | LockAcquireMsg
  | LockReleaseMsg
  | LockForceMsg
  | ToolInvokeMsg
  | RenderResultMsg
  | ProjectOpMsg
  | SessionStatusMsg;
