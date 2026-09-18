/** MCP endpoint for external coding agents (ZCode, Claude Code, Codex,
 *  OpenCode, DeepSeek Harness…).
 *
 *  Streamable HTTP at POST/GET/DELETE /mcp with stateful sessions (one
 *  transport per session; the session id is the lock actor id). The 15 scene
 *  tools are served from the SHARED registry with the exact same JSON
 *  Schemas and descriptions the built-in agent uses, executed through the
 *  same ToolService pipeline. initialize carries the external Agent Skill
 *  Guide as instructions; the guide is also exposed as a resource.
 *
 *  Extra tools beyond the shared registry: project management + status. */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  ListResourcesRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { getTools, type ToolResult } from "../src/agent/tools";
import { buildAgentGuide } from "../src/agent/guide";
import type { ProjectInfo } from "../src/shared/protocol";
import { EditLock } from "./editLock";
import type { ProjectStore } from "./projects";
import type { RenderBroker } from "./renderBroker";
import type { StudioSession } from "./session";
import type { Actor, ToolService } from "./toolRelay";

export interface StudioContext {
  session: StudioSession;
  lock: EditLock;
  projects: ProjectStore;
  tools: ToolService;
  renders: RenderBroker;
  workspace: string;
  token: string;
  version: string;
  browsers(): number;
  /** Connected MCP agent client names (called on every session open/close). */
  setMcpClients(labels: string[]): void;
  refreshProjects(): void;
  adoptWorkspace(cwd: string): boolean;
}

interface McpSession {
  transport: StreamableHTTPServerTransport;
  server: Server;
  actor: Actor;
}

const sessions = new Map<string, McpSession>();

const GUIDE_URI = "motionref://agent-guide";

function actorFor(sessionId: string, label: string): Actor {
  return { kind: "mcp", id: `mcp:${sessionId}`, label };
}

function currentMcpLabels(): string[] {
  return [...new Set([...sessions.values()].map((s) => s.actor.label))];
}

function buildServer(ctx: StudioContext, actor: Actor): Server {
  const server = new Server(
    { name: "motionref-studio", version: ctx.version },
    { instructions: buildAgentGuide("external", "en"), capabilities: { tools: {}, resources: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools: Tool[] = getTools().map((t) => ({
      name: t.name,
      description: t.description.en,
      inputSchema: t.parameters as Tool["inputSchema"],
    }));
    tools.push(
      {
        name: "list_projects",
        description: "List the MotionRef Studio projects in the workspace (JSON bundle files on disk).",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      {
        name: "open_project",
        description: "Open a project by id or file path, replacing the current scene. The scene document and chat project binding switch to it.",
        inputSchema: {
          type: "object",
          properties: { id: { type: "string", description: "Project id or absolute file path (from list_projects)" } },
          required: ["id"],
          additionalProperties: false,
        },
      },
      {
        name: "save_project",
        description: "Persist the current scene into its project file. First save of an unsaved scene creates a new project (pass name, and dir for an absolute directory other than the workspace root). Projects are JSON bundle files in the workspace.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "New project name (first save / rename)" },
            dir: { type: "string", description: "Absolute directory for a NEW project file (default: workspace root)" },
          },
          additionalProperties: false,
        },
      },
      {
        name: "new_project",
        description: "Create and open a fresh empty project. Default directory: the workspace root.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string" },
            dir: { type: "string", description: "Absolute directory for the new .mrsproj.json file (default: workspace)" },
          },
          additionalProperties: false,
        },
      },
      {
        name: "get_status",
        description: "Session status: current project, revision, undo availability, edit-lock holder, connected Web UI count (snapshot availability), workspace.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
    );
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;

    // Project/status tools (server-side, not part of the shared scene registry).
    if (name === "list_projects") {
      return textResult(JSON.stringify(ctx.projects.list(), null, 1));
    }
    if (name === "get_status") {
      const s = ctx.session;
      return textResult(
        JSON.stringify(
          {
            project: s.project,
            rev: s.getRev(),
            canUndo: s.canUndo(),
            canRedo: s.canRedo(),
            lock: ctx.lock.current(),
            browsers: ctx.browsers(),
            // Snapshots render in a browser; with none connected the server
            // opens one automatically (unless opted out).
            snapshotAvailable: ctx.browsers() > 0 || ctx.renders.canAutoOpen(),
            snapshotOpensBrowser: ctx.browsers() === 0 && ctx.renders.canAutoOpen(),
            workspace: ctx.workspace,
          },
          null,
          1,
        ),
      );
    }
    if (name === "open_project" || name === "new_project") {
      const ok = await gateLock(ctx, actor);
      if (!ok.ok) return textResult(ok.message, true);
      if (name === "open_project") {
        const opened = ctx.projects.open(String(args.id ?? ""));
        if ("error" in opened) return textResult(`ERROR: ${opened.error}`, true);
        ctx.session.loadProjectDoc(opened.info, opened.doc, "mcp");
        ctx.refreshProjects();
        return textResult(`Opened project "${opened.info.name}" (${opened.info.path}).`);
      }
      const info: ProjectInfo = ctx.projects.create(
        typeof args.name === "string" && args.name.trim() ? args.name : "Untitled",
        typeof args.dir === "string" ? args.dir : undefined,
      );
      const opened = ctx.projects.open(info.id);
      if ("error" in opened) return textResult(`ERROR: ${opened.error}`, true);
      ctx.session.loadProjectDoc(opened.info, opened.doc, "mcp");
      ctx.refreshProjects();
      return textResult(`Created project "${info.name}" (${info.path}).`);
    }
    if (name === "save_project") {
      ctx.session.project = ctx.projects.save(
        ctx.session.project,
        ctx.session.getDoc(),
        typeof args.name === "string" ? args.name : undefined,
        typeof args.dir === "string" ? args.dir : undefined,
      );
      ctx.refreshProjects();
      return textResult(`Saved project "${ctx.session.project.name}" (${ctx.session.project.path}).`);
    }

    // Shared scene tools — identical registry, identical pipeline.
    const result = await ctx.tools.invoke(actor, name, JSON.stringify(args));
    return toolResultToMcp(ctx, result);
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [{ uri: GUIDE_URI, name: "MotionRef Studio — Agent Skill Guide", mimeType: "text/plain" }],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    if (String(req.params.uri) !== GUIDE_URI) throw new Error(`unknown resource ${req.params.uri}`);
    return { contents: [{ uri: GUIDE_URI, mimeType: "text/plain", text: buildAgentGuide("external", "en") }] };
  });

  return server;
}

function textResult(text: string, isError = false): CallToolResult {
  return { content: [{ type: "text", text }], isError };
}

async function gateLock(ctx: StudioContext, actor: Actor): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!ctx.lock.heldBy(actor.id)) {
    const ok = await ctx.lock.acquireAndWait(actor);
    if (!ok) return { ok: false, message: EditLock.busyMessage(ctx.lock.current()) };
  }
  return { ok: true };
}

function toolResultToMcp(ctx: StudioContext, result: ToolResult): CallToolResult {
  if (!result.snapshot) return textResult(result.text, !!result.isError);
  // Snapshot: image content for multimodal agents + a file on disk (path in
  // the text) for text-only agents.
  const comma = result.snapshot.dataUrl.indexOf(",");
  const b64 = comma >= 0 ? result.snapshot.dataUrl.slice(comma + 1) : result.snapshot.dataUrl;
  const dir = path.join(ctx.workspace, ".motionref", "snapshots");
  const file = path.join(dir, `snap-r${ctx.session.getRev()}-t${result.snapshot.t.toFixed(2)}.jpg`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, Buffer.from(b64, "base64"));
  } catch {
    /* disk write is best-effort */
  }
  return {
    content: [
      { type: "text", text: `${result.text}\nAlso saved to: ${file}` },
      { type: "image", data: b64, mimeType: "image/jpeg" },
    ],
    isError: !!result.isError,
  };
}

function isInitializeRequest(body: unknown): body is { method: "initialize"; params?: { clientInfo?: { name?: string } } } {
  const b = body as { method?: string } | null;
  return !!b && typeof b === "object" && b.method === "initialize";
}

/** Route one HTTP request to the /mcp endpoint. */
export async function handleMcpRequest(req: IncomingMessage, res: ServerResponse, ctx: StudioContext): Promise<void> {
  const auth = req.headers.authorization ?? "";
  if (auth !== `Bearer ${ctx.token}`) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Missing or invalid bearer token (see ~/.motionref-studio/config.json)" } }));
    return;
  }

  if (req.method === "GET") {
    // JSON-response mode: no standalone SSE stream.
    res.writeHead(405, { "Content-Type": "application/json", Allow: "POST, DELETE" });
    res.end(JSON.stringify({ error: { message: "GET not supported; POST JSON-RPC messages instead" } }));
    return;
  }

  if (req.method === "DELETE") {
    const sid = String(req.headers["mcp-session-id"] ?? "");
    const session = sessions.get(sid);
    if (!session) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Unknown session" } }));
      return;
    }
    await session.transport.close();
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Method not allowed" } }));
    return;
  }

  let body: unknown;
  try {
    const raw = await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", reject);
    });
    body = JSON.parse(raw);
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }));
    return;
  }

  // The stdio shim announces the external agent's working directory so the
  // server can adopt it as the workspace on first contact.
  const clientInfo = (body as { params?: { _meta?: { workspace?: string } } }).params?._meta;
  if (clientInfo?.workspace) ctx.adoptWorkspace(clientInfo.workspace);

  const sidHeader = String(req.headers["mcp-session-id"] ?? "");
  let session = sidHeader ? sessions.get(sidHeader) : undefined;

  if (!session) {
    if (!isInitializeRequest(body)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Missing session id — initialize first" }, id: null }));
      return;
    }
    const label = (isInitializeRequest(body) && body.params?.clientInfo?.name) || "MCP client";
    const actor = actorFor("pending", label); // id rebound to the real session below
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
    });
    const server = buildServer(ctx, actor);
    await server.connect(transport);
    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid && sessions.get(sid)) {
        sessions.delete(sid);
        ctx.lock.releaseOwner(actor.id);
        ctx.setMcpClients(currentMcpLabels());
      }
    };
    await transport.handleRequest(req, res, body);
    const sid = transport.sessionId;
    if (sid) {
      actor.id = `mcp:${sid}`;
      sessions.set(sid, { transport, server, actor });
      ctx.setMcpClients(currentMcpLabels());
    }
    return;
  }

  await session.transport.handleRequest(req, res, body);
}

export function shutdownMcp(): void {
  for (const [, s] of sessions) void s.transport.close();
  sessions.clear();
}
