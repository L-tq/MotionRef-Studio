/** MotionRef Studio — local studio server.
 *
 *  Server-authoritative deployment mode: this process owns the scene
 *  document, undo history, edit lock, agent tool pipeline and workspace
 *  project files. It serves the built Web UI (dist/) as a synced client and
 *  exposes an MCP endpoint for external coding agents. The built-in agent's
 *  tool calls are relayed here too, so every writer executes through the
 *  same pipeline.
 *
 *  Usage: tsx server/index.ts [--port 8787] [--workspace <dir>] */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import type { ProjectInfo } from "../src/shared/protocol";
import {
  LOCK_TTL_MS,
  type ClientMsg,
  type ServerMsg,
  type ToolResultMsg,
} from "../src/shared/protocol";
import { EditLock } from "./editLock";
import { NodeSandbox } from "./sandboxNode";
import { ProjectStore } from "./projects";
import { RenderBroker, type RenderClient } from "./renderBroker";
import { StudioSession } from "./session";
import { createStatusDisplay } from "./statusTui";
import { ToolService, type Actor } from "./toolRelay";
import { DEFAULT_PORT, configDir, readConfig, resolveWorkspace, serverVersion, writeConfig } from "./util";
import { serveStatic } from "./static";
import { handleMcpRequest, shutdownMcp, type StudioContext } from "./mcp";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// --- CLI --------------------------------------------------------------------------

function argValue(flag: string): string | undefined {
  const argv = process.argv;
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

const port = Number(argValue("--port") ?? process.env.MOTIONREF_PORT ?? DEFAULT_PORT) || DEFAULT_PORT;
let workspace = resolveWorkspace(argValue("--workspace") ?? process.env.MOTIONREF_WORKSPACE);
const distDir = path.resolve(REPO_ROOT, "dist");
const config = readConfig();
const version = serverVersion();
const uiUrl = `http://127.0.0.1:${port}`;
/** Snapshot auto-open: exit headless mode by opening the Web UI in the
 *  user's default browser when an agent needs a snapshot. */
const noOpenBrowser =
  process.argv.includes("--no-open-browser") || process.env.MOTIONREF_NO_OPEN_BROWSER === "1";

/** Cross-platform "open this URL in the user's browser". MOTIONREF_BROWSER_CMD
 *  overrides the opener binary (tests point it at a no-op). */
function openSystemBrowser(url: string): void {
  const custom = process.env.MOTIONREF_BROWSER_CMD;
  const run = (bin: string, args: string[]) => spawn(bin, args, { detached: true, stdio: "ignore" }).unref();
  if (custom) {
    run(custom, [url]);
    return;
  }
  if (process.platform === "darwin") run("open", [url]);
  else if (process.platform === "win32") run("cmd.exe", ["/c", "start", "", url]);
  else run("xdg-open", [url]);
}

// --- core services ------------------------------------------------------------------

let projects = new ProjectStore(workspace);
const lock = new EditLock();
const sandbox = new NodeSandbox();
/** Origin of the latest doc commit — shown in the status display feed. */
let lastEdit: { rev: number; label: string; source: string } | null = null;
const session = new StudioSession({
  onDoc: (rev, doc, label, source) => {
    lastEdit = { rev, label, source };
    broadcast({ type: "doc.update", rev, doc, label, source });
    scheduleAutosave();
    statusDisplay.touch();
  },
  onHistory: (canUndo, canRedo) => {
    broadcast({ type: "history.state", canUndo, canRedo });
    statusDisplay.touch();
  },
});

// --- browser clients ------------------------------------------------------------------

interface BrowserClient extends RenderClient {
  ws: WebSocket;
  statusLabel: string;
  builtInAgentRunning: boolean;
}

const clients = new Map<string, BrowserClient>();

function broadcast(msg: ServerMsg, exclude?: string): void {
  for (const [id, c] of clients) {
    if (id === exclude) continue;
    sendTo(c, msg);
  }
}

function sendTo(c: BrowserClient, msg: ServerMsg): void {
  if (c.ws.readyState === 1) c.ws.send(JSON.stringify(msg));
}

const renderBroker = new RenderBroker(() => [...clients.values()], {
  uiUrl,
  openUi: () => openSystemBrowser(uiUrl),
  autoOpen: !noOpenBrowser,
});
const toolService = new ToolService(session, lock, sandbox, renderBroker);

// --- presence + status display ----------------------------------------------------------

const presence = { mcpLabels: [] as string[] };
function broadcastPresence(): void {
  broadcast({
    type: "presence",
    mcpClients: presence.mcpLabels.length,
    mcpLabels: presence.mcpLabels,
    browsers: clients.size,
  });
  statusDisplay.touch();
}

const startedAt = Date.now();
const statusDisplay = createStatusDisplay({
  getSnapshot: () => ({
    version,
    uiUrl,
    workspace,
    project: session.project,
    rev: session.getRev(),
    canUndo: session.canUndo(),
    canRedo: session.canRedo(),
    lock: lock.current(),
    heldSince: lock.heldSince(),
    mcpLabels: presence.mcpLabels,
    browsers: clients.size,
    agentTurns: [...clients.values()].filter((c) => c.builtInAgentRunning).length,
    lastEdit,
  }),
  onForceUnlock: () => lock.releaseAll(),
  onOpenUi: () => openSystemBrowser(uiUrl),
  onQuit: () => shutdown(),
});

// --- projects: autosave + broadcasts --------------------------------------------------

let autosaveTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleAutosave(): void {
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    if (!session.project) return;
    session.project = projects.save(session.project, session.getDoc());
  }, 800);
}

/** Debounced: chained store ops (create + save) emit one coherent update with
 *  the FINAL binding instead of transient currentId:null states. */
let projectsBroadcastTimer: ReturnType<typeof setTimeout> | undefined;
function broadcastProjects(): void {
  clearTimeout(projectsBroadcastTimer);
  projectsBroadcastTimer = setTimeout(() => {
    broadcast({
      type: "projects.update",
      projects: projects.list(),
      currentId: session.project?.id ?? null,
    });
    statusDisplay.touch();
  }, 50);
}

projects.onChange(() => broadcastProjects());
lock.onChange((holder) => {
  broadcast({ type: "lock.state", lock: holder });
  statusDisplay.touch();
});

// Restore the most recent workspace project on boot.
{
  const recent = projects.list()[0];
  if (recent) {
    const opened = projects.open(recent.id);
    if (!("error" in opened)) session.loadProjectDoc(opened.info, opened.doc, "server");
  }
}

// --- origin / auth helpers -------------------------------------------------------------

function isLoopbackOrigin(origin: string | undefined): boolean {
  if (!origin) return true; // same-origin fetch or non-browser client
  try {
    const host = new URL(origin).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
  } catch {
    return false;
  }
}

/** DNS-rebinding guard: the Host header must address the loopback interface
 *  we bound to (this is a local-only server). */
function hostIsLoopback(req: http.IncomingMessage): boolean {
  const host = req.headers.host ?? "";
  const hostname = host.split(":")[0].toLowerCase();
  return !hostname || hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

function corsHeaders(origin: string | undefined): Record<string, string> {
  // Dev: the app may be served by vite (:5173) while linking to this server.
  if (origin && isLoopbackOrigin(origin) && origin.startsWith("http")) {
    return { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "GET, OPTIONS" };
  }
  return {};
}

function jsonReply(res: http.ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...extra });
  res.end(JSON.stringify(body));
}

// --- LLM proxy (port of api/llm.ts so "proxy" connection mode works locally) -----------

const ALLOWED_LLM_PATHS = new Set(["/v1/chat/completions", "/chat/completions", "/v1/models", "/models"]);

async function handleLlmProxy(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    });
    res.end();
    return;
  }
  if (req.method !== "POST") return void jsonReply(res, 405, { error: { message: "Method not allowed" } });
  let body: { baseUrl?: string; apiKey?: string; path?: string; payload?: unknown };
  try {
    body = JSON.parse(await readBody(req)) as typeof body;
  } catch {
    return void jsonReply(res, 400, { error: { message: "Invalid JSON body" } });
  }
  const { baseUrl, apiKey, path: llmPath, payload } = body;
  if (!baseUrl || !llmPath || payload === undefined) {
    return void jsonReply(res, 400, { error: { message: "Missing baseUrl, path or payload" } });
  }
  if (!/^https?:\/\//i.test(baseUrl)) {
    return void jsonReply(res, 400, { error: { message: "baseUrl must be an http(s) URL" } });
  }
  if (!ALLOWED_LLM_PATHS.has(llmPath)) {
    return void jsonReply(res, 400, { error: { message: `Path not allowed: ${llmPath}` } });
  }
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  try {
    const upstream = await fetch(`${baseUrl.replace(/\/+$/, "")}${llmPath}`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    res.writeHead(upstream.status, {
      "Content-Type": upstream.headers.get("content-type") ?? "application/json",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    });
    if (upstream.body) {
      for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) res.write(chunk);
    }
    res.end();
  } catch (err) {
    jsonReply(res, 502, { error: { message: `Upstream fetch failed: ${String(err)}` } });
  }
}

function readBody(req: http.IncomingMessage, limit = 64 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// --- studio context for MCP -------------------------------------------------------------

const studioContext: StudioContext = {
  session,
  lock,
  tools: toolService,
  renders: renderBroker,
  token: config.token,
  version,
  get projects() {
    return projects;
  },
  get workspace() {
    return workspace;
  },
  browsers: () => clients.size,
  setMcpClients: (labels) => {
    presence.mcpLabels = labels;
    broadcastPresence();
  },
  refreshProjects: () => broadcastProjects(),
  /** The stdio shim reports the external agent's working directory; adopt it
   *  as the workspace on first contact — only while we're still on the
   *  untouched fallback (fresh install, nothing opened yet). */
  adoptWorkspace: (cwd) => {
    if (!cwd || !fs.existsSync(cwd)) return false;
    const abs = path.resolve(cwd);
    if (workspace !== path.join(configDir(), "projects") || abs === REPO_ROOT) return false;
    workspace = abs;
    writeConfig({ workspace: abs });
    projects = new ProjectStore(abs);
    projects.onChange(() => broadcastProjects());
    session.clearProject("server");
    broadcastProjects();
    console.log(`Workspace adopted from connecting agent: ${abs}`);
    return true;
  },
};

// --- HTTP server --------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = req.url ?? "/";
  const pathname = new URL(url, "http://localhost").pathname;
  const origin = req.headers.origin;

  try {
    if (pathname === "/api/llm") return void (await handleLlmProxy(req, res));

    if (pathname === "/studio/info") {
      if (!hostIsLoopback(req) || !isLoopbackOrigin(origin)) {
        return void jsonReply(res, 403, { error: "forbidden" });
      }
      return void jsonReply(
        res,
        200,
        {
          version,
          workspace,
          ws: "/ws",
          mcp: "/mcp",
          token: config.token,
          mcpUrl: `http://127.0.0.1:${port}/mcp`,
        },
        corsHeaders(origin),
      );
    }

    if (pathname === "/studio/fs/list") {
      if (!hostIsLoopback(req) || !isLoopbackOrigin(origin)) {
        return void jsonReply(res, 403, { error: "forbidden" });
      }
      const dir = new URL(url, "http://localhost").searchParams.get("path") || path.dirname(workspace);
      try {
        const abs = path.resolve(dir);
        const entries = fs.readdirSync(abs, { withFileTypes: true });
        const dirs = entries
          .filter((e) => e.isDirectory() && !e.name.startsWith("."))
          .map((e) => ({ name: e.name, path: path.join(abs, e.name) }))
          .sort((a, b) => a.name.localeCompare(b.name));
        return void jsonReply(res, 200, { path: abs, parent: path.dirname(abs), dirs }, corsHeaders(origin));
      } catch (e) {
        return void jsonReply(res, 400, { error: `cannot list "${dir}": ${String(e)}` }, corsHeaders(origin));
      }
    }

    if (pathname === "/mcp") return void (await handleMcpRequest(req, res, studioContext));

    if (req.method === "GET" && serveStatic(distDir, req, res)) return;

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found. (Run `npm run build` first if dist/ is missing.)");
  } catch (err) {
    jsonReply(res, 500, { error: String(err) });
  }
});

// --- WebSocket bridge -----------------------------------------------------------------------

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  if (pathname !== "/ws") {
    socket.destroy();
    return;
  }
  if (!hostIsLoopback(req)) {
    socket.destroy();
    return;
  }
  const token = new URL(req.url ?? "", "http://localhost").searchParams.get("token");
  if (token !== config.token) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => handleBrowserSocket(ws));
});

function sendError(c: { ws: WebSocket }, message: string): void {
  sendTo(c as BrowserClient, { type: "error", message });
}

function userLockGate(clientId: string): { ok: true } | { ok: false; holder: unknown } {
  const current = lock.current();
  if (current && current.id !== clientId) return { ok: false, holder: current };
  lock.acquire({ kind: "user", id: clientId, label: "Web UI" }, LOCK_TTL_MS.user);
  return { ok: true };
}

function handleBrowserSocket(ws: WebSocket): void {
  let client: BrowserClient | null = null;

  ws.on("message", (raw) => {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(String(raw)) as ClientMsg;
    } catch {
      return;
    }
    if (!client) {
      if (msg.type !== "hello") return;
      client = {
        id: msg.clientId,
        ws,
        statusLabel: "Web UI",
        builtInAgentRunning: false,
        send: (m) => ws.send(JSON.stringify(m)),
      };
      clients.set(msg.clientId, client);
      sendTo(client, {
        type: "welcome",
        serverVersion: version,
        rev: session.getRev(),
        doc: session.getDoc(),
        project: session.project,
        projects: projects.list(),
        lock: lock.current(),
        mcpClients: presence.mcpLabels.length,
        mcpLabels: presence.mcpLabels,
        browsers: clients.size,
        canUndo: session.canUndo(),
        canRedo: session.canRedo(),
      });
      broadcastPresence();
      return;
    }
    void routeClientMessage(client, msg).catch((e) => sendError(client!, String(e)));
  });

  ws.on("close", () => {
    if (!client) return;
    clients.delete(client.id);
    lock.releaseOwner(client.id);
    broadcastPresence();
  });
  ws.on("error", () => {
    /* close handler cleans up */
  });
}

async function routeClientMessage(client: BrowserClient, msg: ClientMsg): Promise<void> {
  switch (msg.type) {
    case "doc.apply": {
      const gate = userLockGate(client.id);
      if (!gate.ok) {
        sendTo(client, {
          type: "doc.rejected",
          reason: "lock",
          message: EditLock.busyMessage(lock.current()),
          rev: session.getRev(),
          doc: session.getDoc(),
        });
        return;
      }
      const result = session.apply(msg.doc, msg.label, "user");
      if (!result.ok) {
        sendTo(client, {
          type: "doc.rejected",
          reason: "invalid",
          message: result.error,
          rev: session.getRev(),
          doc: session.getDoc(),
        });
      }
      return;
    }
    case "history.undo":
    case "history.redo": {
      const gate = userLockGate(client.id);
      if (!gate.ok) return void sendError(client, EditLock.busyMessage(lock.current()));
      if (msg.type === "history.undo") session.undo("user");
      else session.redo("user");
      return;
    }
    case "lock.acquire": {
      // Immediate acquire (no wait): a turn that can't get the lock fails
      // fast with a readable message instead of blocking the chat UI.
      const ok = lock.acquire({ kind: "agent", id: client.id, label: msg.label || "Built-in agent" }, LOCK_TTL_MS.agent);
      if (!ok) sendError(client, EditLock.busyMessage(lock.current()));
      return;
    }
    case "lock.release":
      lock.release(client.id);
      return;
    case "lock.force":
      lock.releaseAll();
      return;
    case "tool.invoke": {
      const actor: Actor = {
        kind: "agent",
        id: client.id,
        label: client.builtInAgentRunning ? client.statusLabel : "Built-in agent",
      };
      const result = await toolService.invoke(actor, msg.name, msg.argsJson);
      const reply: ToolResultMsg = {
        type: "tool.result",
        callId: msg.callId,
        text: result.text,
        isError: !!result.isError,
      };
      if (result.snapshot) {
        reply.snapshot = {
          dataUrl: result.snapshot.dataUrl,
          t: result.snapshot.t,
          w: result.snapshot.w,
          h: result.snapshot.h,
        };
      }
      sendTo(client, reply);
      return;
    }
    case "render.result":
      renderBroker.handleResult(msg);
      return;
    case "projects.list":
      sendTo(client, {
        type: "projects.update",
        projects: projects.list(),
        currentId: session.project?.id ?? null,
      });
      return;
    case "projects.save": {
      session.project = projects.save(session.project, session.getDoc(), msg.name);
      broadcastProjects();
      return;
    }
    case "projects.saveAs": {
      // First save of a scratch scene into a user-chosen directory: create
      // the entry at the chosen location, then write the CURRENT doc into it
      // (unlike projects.new, which starts an empty scene).
      const name = (msg.name || "").trim() || session.getDoc().name || "Untitled";
      const info = projects.create(name, msg.dir);
      session.project = projects.save(info, session.getDoc(), name);
      broadcastProjects();
      return;
    }
    case "projects.open": {
      const gate = userLockGate(client.id);
      if (!gate.ok) return void sendError(client, EditLock.busyMessage(lock.current()));
      const opened = projects.open(msg.id);
      if ("error" in opened) return void sendError(client, opened.error);
      session.loadProjectDoc(opened.info, opened.doc, "user");
      broadcastProjects();
      return;
    }
    case "projects.new": {
      const gate = userLockGate(client.id);
      if (!gate.ok) return void sendError(client, EditLock.busyMessage(lock.current()));
      const info: ProjectInfo = projects.create(msg.name || "Untitled", msg.dir);
      const opened = projects.open(info.id);
      if ("error" in opened) return void sendError(client, opened.error);
      session.loadProjectDoc(opened.info, opened.doc, "user");
      broadcastProjects();
      return;
    }
    case "projects.delete": {
      projects.remove(msg.id);
      if (session.project?.id === msg.id) session.project = null;
      broadcastProjects();
      return;
    }
    case "session.status":
      client.builtInAgentRunning = msg.builtInAgentRunning;
      client.statusLabel = msg.locale === "zh" ? "内置智能体" : "Built-in agent";
      return;
  }
}

// --- lifecycle -------------------------------------------------------------------------------

server.listen(port, "127.0.0.1", () => {
  const ui = `http://127.0.0.1:${port}`;
  console.log(`MotionRef Studio ${version} — local studio server`);
  console.log(`  Web UI : ${ui}`);
  console.log(`  MCP    : ${ui}/mcp  (Bearer token in ~/.motionref-studio/config.json)`);
  console.log(`  Workspace (projects saved here): ${workspace}`);
  if (!fs.existsSync(path.join(distDir, "index.html"))) {
    console.log("  NOTE: dist/ not built yet — run `npm run build` for the Web UI.");
  }
});

function shutdown(): void {
  statusDisplay.stop();
  if (session.project) {
    try {
      projects.save(session.project, session.getDoc());
    } catch {
      /* best effort */
    }
  }
  shutdownMcp();
  sandbox.dispose();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on("SIGINT", () => shutdown());
process.on("SIGTERM", () => shutdown());
