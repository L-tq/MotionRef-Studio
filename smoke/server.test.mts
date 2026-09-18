/** Integration smoke test for the local studio server (M2–M4).
 *
 *  Boots the real server on an ephemeral port with an isolated HOME and
 *  workspace, then drives it with the MCP SDK client (as an external agent
 *  would) and a fake WebSocket browser client:
 *   - initialize carries the external Agent Skill Guide as instructions
 *   - tools/list serves the 15 shared scene tools + 5 studio tools
 *   - add_object / get_scene_state round-trip through the shared pipeline
 *   - invalid set_scene is rejected; snapshot degrades without a browser
 *   - with a browser connected, snapshot returns image content
 *   - single-writer lock: second agent busy-errors, user edits rejected,
 *     read-only tools unaffected, lock released on disconnect
 *   - status display: [studio] transition lines when stdout is piped, ink
 *     panel content with MOTIONREF_FORCE_TUI=1, presence carries mcpLabels
 *   - projects: save → file on disk in bundle format → new → reopen
 *
 *  Run: npx tsx smoke/server.test.mts */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import WebSocket from "ws";

// fileURLToPath: a raw URL .pathname keeps a leading "/" on Windows, which
// path.resolve turns into a doubled drive letter and spawn() then fails on.
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "mrs-home-"));
const WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), "mrs-ws-"));
const PORT = 9300 + Math.floor(Math.random() * 400);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Status-display output arrives asynchronously; poll the captured stdout. */
async function waitForServerLine(re: RegExp, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (re.test(serverOut.join(""))) return;
    if (Date.now() > deadline) throw new Error(`no [server] output matching ${re}`);
    await sleep(100);
  }
}

async function waitForHttp(url: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`server did not start: ${url}`);
    await sleep(150);
  }
}

function readToken(): string {
  const cfg = JSON.parse(fs.readFileSync(path.join(HOME, ".motionref-studio", "config.json"), "utf8")) as { token: string };
  return cfg.token;
}

let server: ChildProcess | null = null;
const serverOut: string[] = [];
const cleanup: Array<() => void> = [];
async function main(): Promise<void> {
  server = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
    cwd: REPO,
    env: {
      ...process.env,
      HOME,
      // Windows os.homedir() reads USERPROFILE, not HOME — set both so the
      // child keeps its config/token inside the isolated test HOME.
      USERPROFILE: HOME,
      MOTIONREF_PORT: String(PORT),
      MOTIONREF_WORKSPACE: WORKSPACE,
      // Never open real browser tabs from the test environment.
      MOTIONREF_NO_OPEN_BROWSER: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", (d: Buffer) => {
    serverOut.push(String(d));
    process.stdout.write(`[server] ${d}`);
  });
  server.stderr?.on("data", (d: Buffer) => process.stderr.write(`[server:err] ${d}`));
  cleanup.push(() => server?.kill("SIGTERM"));

  const base = `http://127.0.0.1:${PORT}`;
  await waitForHttp(`${base}/studio/info`);
  const token = readToken();

  // /studio/info rejects foreign origins but serves loopback ones.
  {
    const res = await fetch(`${base}/studio/info`, { headers: { Origin: "https://evil.example" } });
    assert.equal(res.status, 403, "foreign origin must be rejected");
    const ok = await fetch(`${base}/studio/info`);
    assert.equal(ok.status, 200);
    const info = (await ok.json()) as { mcpUrl: string; token: string; workspace: string };
    assert.equal(info.token, token);
    assert.equal(info.workspace, WORKSPACE);
  }

  const mkClient = async () => mkClientAt(base, token);

  const mkClientAt = async (baseUrl: string, bearer: string) => {
    const client = new Client({ name: "smoke-agent", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${bearer}` } },
    });
    await client.connect(transport);
    return { client, transport };
  };

  const bad = new Client({ name: "noauth", version: "1.0" });
  await assert.rejects(
    () =>
      bad.connect(
        new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
          requestInit: { headers: { Authorization: "Bearer wrong" } },
        }),
      ),
    undefined,
    "MCP without token must be rejected",
  );

  const a = await mkClient();
  cleanup.push(() => a.client.close().catch(() => {}));

  // Instructions carry the external Agent Skill Guide (raw initialize — the
  // SDK 1.30 client no longer exposes them via a getter).
  {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "1" } },
      }),
    });
    const init = (await res.json()) as { result?: { instructions?: string } };
    assert.ok(init.result?.instructions?.includes("external coding agent"), "instructions use the external guide header");
    assert.ok(init.result?.instructions?.includes("Never claim success without a verifying snapshot"), "guide body shared verbatim");
  }

  // 15 shared scene tools + 5 studio tools, same names as the registry.
  const tools = await a.client.listTools();
  const names = tools.tools.map((t) => t.name);
  for (const expected of [
    "get_scene_state", "set_scene", "add_object", "update_object", "remove_object", "set_camera",
    "add_camera", "set_active_camera", "manage_marker", "manage_action", "add_camera_keyframes",
    "add_keyframes", "set_timeline", "snapshot", "execute_code",
    "list_projects", "open_project", "save_project", "new_project", "get_status",
  ]) {
    assert.ok(names.includes(expected), `tool ${expected} present`);
  }
  assert.equal(tools.tools.length, 20);
  const addTool = tools.tools.find((t) => t.name === "add_object")!;
  assert.deepEqual(addTool.inputSchema.type, "object");

  // Mutating tool through the shared pipeline.
  const add = await a.client.callTool({ name: "add_object", arguments: { object: { type: "box", name: "Cube", position: [0, 1, 0] } } });
  assert.ok(!add.isError, `add_object ok: ${JSON.stringify(add.content)}`);
  const state = await a.client.callTool({ name: "get_scene_state", arguments: {} });
  const doc = JSON.parse((state.content as Array<{ text: string }>)[0].text);
  assert.equal(doc.objects.length, 1);
  assert.equal(doc.objects[0].name, "Cube");

  // Validation errors are fed back as tool errors.
  const invalid = await a.client.callTool({ name: "set_scene", arguments: { doc: { version: 1, objects: "not-an-array" } } });
  assert.ok(invalid.isError, "invalid set_scene rejected");

  // Snapshot without a browser degrades to a clear error (auto-open disabled
  // for this server instance so the test never opens a real tab).
  const noView = await a.client.callTool({ name: "snapshot", arguments: { time: 0 } });
  assert.ok(noView.isError, "snapshot errors without a browser");
  assert.match((noView.content as Array<{ text: string }>)[0].text, /no Web UI/i);

  // --- single-writer lock ------------------------------------------------------------
  const b = await mkClient();
  cleanup.push(() => b.client.close().catch(() => {}));

  // a holds the lock (sliding 15s from its mutations). b must busy-error.
  const busy = await b.client.callTool({ name: "set_timeline", arguments: { duration: 8 } });
  assert.ok(busy.isError, "second agent busy-errors while first edits");
  assert.match((busy.content as Array<{ text: string }>)[0].text, /locked/i);

  // Read-only tools are unaffected by someone else's lock.
  const peek = await b.client.callTool({ name: "get_scene_state", arguments: {} });
  assert.ok(!peek.isError, "read-only tool works while another agent holds the lock");

  // User edits (browser doc.apply) are rejected during an agent hold.
  const ws1 = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${token}`);
  const wsMsgs: Array<Record<string, unknown>> = [];
  const wsWait = (type: string, timeoutMs = 8_000) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const t0 = Date.now();
      const check = () => {
        const found = wsMsgs.find((m) => m.type === type);
        if (found) return resolve(found);
        if (Date.now() - t0 > timeoutMs) return reject(new Error(`no ${type} message`));
        setTimeout(check, 50);
      };
      check();
    });
  ws1.on("message", (raw) => wsMsgs.push(JSON.parse(String(raw))));
  await new Promise((r) => ws1.on("open", r));
  cleanup.push(() => ws1.close());
  ws1.send(JSON.stringify({ type: "hello", clientId: "browser-1", version: "test" }));
  const welcome = await wsWait("welcome");
  assert.equal((welcome as { doc?: { objects?: unknown[] } }).doc?.objects?.length, 1, "welcome carries live doc");

  ws1.send(JSON.stringify({ type: "doc.apply", baseRev: welcome.rev, doc: { ...doc, name: "user edit" }, label: "user edit" }));
  const rejected = await wsWait("doc.rejected");
  assert.equal(rejected.reason, "lock", "user edit rejected while agent holds the lock");

  // Disconnecting the holder releases the lock; the user edit then works.
  await a.transport.terminateSession().catch(() => {});
  await a.client.close().catch(() => {});
  await sleep(300);
  ws1.send(JSON.stringify({ type: "doc.apply", baseRev: welcome.rev, doc: { ...doc, name: "user edit" }, label: "user edit" }));
  const update = await wsWait("doc.update");
  assert.equal((update as { doc?: { name?: string } }).doc?.name, "user edit");

  // --- status display: line mode (stdout piped) ---------------------------------------
  // Lock transitions appear as one timestamped [studio] line each.
  ws1.send(JSON.stringify({ type: "lock.acquire", label: "smoke-turn" }));
  await waitForServerLine(/lock acquired — smoke-turn \(agent\)/);
  ws1.send(JSON.stringify({ type: "lock.release" }));
  await waitForServerLine(/lock released — smoke-turn \(agent\)/);
  // presence now carries the connected agents' names, not just a count.
  {
    const found = wsMsgs.find(
      (m) => m.type === "presence" && Array.isArray(m.mcpLabels) && (m.mcpLabels as string[]).includes("smoke-agent"),
    );
    assert.ok(found, "presence message carries mcpLabels");
  }

  // With a browser connected, snapshot succeeds via the render relay.
  const tinyJpeg =
    "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwcJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPDIzNP/AABEIAAEAAQMBIgACEQEDEQH/xAAfAAABBQEBAQEBAQAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscHRJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2dri4+Tl5ufo6ery8/T19vf4+fr/2gAMAwEAAhEDEQA/AJQA/9k=";
  ws1.on("message", (raw) => {
    const msg = JSON.parse(String(raw));
    if (msg.type === "render.request") {
      wsMsgs.push(msg);
      ws1.send(JSON.stringify({ type: "render.result", requestId: msg.requestId, ok: true, dataUrl: tinyJpeg }));
    }
  });
  const snap = await b.client.callTool({ name: "snapshot", arguments: { time: 1 } });
  assert.ok(!snap.isError, `snapshot with browser ok: ${JSON.stringify(snap.content)}`);
  const snapContent = snap.content as Array<{ type: string; data?: string; mimeType?: string }>;
  assert.ok(snapContent.some((c) => c.type === "image" && c.mimeType === "image/jpeg"), "snapshot returns MCP image content");
  const snapDir = path.join(WORKSPACE, ".motionref", "snapshots");
  assert.ok(fs.readdirSync(snapDir).length >= 1, "snapshot file written to workspace");

  // --- projects on disk ---------------------------------------------------------------
  const saved = await b.client.callTool({ name: "save_project", arguments: { name: "Box Study" } });
  assert.ok(!saved.isError, `save_project ok: ${JSON.stringify(saved.content)}`);
  const files = fs.readdirSync(WORKSPACE).filter((f) => f.endsWith(".mrsproj.json"));
  assert.equal(files.length, 1, "project bundle in workspace");
  const bundle = JSON.parse(fs.readFileSync(path.join(WORKSPACE, files[0]), "utf8"));
  assert.equal(bundle.format, "motionref-studio/project");
  assert.equal(bundle.doc.name, "user edit");

  const fresh = await b.client.callTool({ name: "new_project", arguments: { name: "Second" } });
  assert.ok(!fresh.isError);
  const empty = await b.client.callTool({ name: "get_scene_state", arguments: {} });
  assert.equal(JSON.parse((empty.content as Array<{ text: string }>)[0].text).objects.length, 0, "new project is empty");

  const opened = await b.client.callTool({ name: "open_project", arguments: { id: bundle.project.id } });
  assert.ok(!opened.isError, `open_project ok: ${JSON.stringify(opened.content)}`);
  const back = await b.client.callTool({ name: "get_scene_state", arguments: {} });
  assert.equal(JSON.parse((back.content as Array<{ text: string }>)[0].text).objects.length, 1, "reopen restores the box");

  const status = await b.client.callTool({ name: "get_status", arguments: {} });
  const statusJson = JSON.parse((status.content as Array<{ text: string }>)[0].text);
  assert.equal(statusJson.project.name, "Box Study");
  assert.equal(statusJson.browsers, 1);
  assert.equal(statusJson.workspace, WORKSPACE);

  // --- save-as: Save on an unsaved/bound scene asks for a directory ------------------
  const sub = path.join(WORKSPACE, "renders");
  ws1.send(JSON.stringify({ type: "projects.saveAs", name: "Saved Copy", dir: sub }));
  // Wait for the update that actually lists the new project (earlier ops
  // queued older projects.update messages).
  const copyFile = path.join(sub, "Saved-Copy.mrsproj.json");
  {
    const deadline = Date.now() + 8_000;
    for (;;) {
      const found = wsMsgs.find(
        (m) => m.type === "projects.update" && Array.isArray(m.projects) && (m.projects as Array<{ name?: string }>).some((p) => p.name === "Saved Copy"),
      );
      if (found) break;
      if (Date.now() > deadline) throw new Error("saveAs project never appeared");
      await sleep(100);
    }
  }
  assert.ok(fs.existsSync(copyFile), "saveAs wrote the file into the chosen directory");
  const copyBundle = JSON.parse(fs.readFileSync(copyFile, "utf8"));
  assert.equal(copyBundle.format, "motionref-studio/project");
  assert.equal(copyBundle.doc.objects.length, 1, "saveAs preserved the CURRENT scene (not an empty doc)");
  const afterSaveAs = await b.client.callTool({ name: "get_status", arguments: {} });
  assert.equal(JSON.parse((afterSaveAs.content as Array<{ text: string }>)[0].text).project.path, copyFile);

  // --- headless exit: snapshot auto-opens a browser and waits ------------------------
  {
    // Second server with auto-open ENABLED but a no-op opener command, so the
    // launch path runs without touching the real desktop.
    const PORT2 = 9700 + Math.floor(Math.random() * 200);
    const server2 = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
      cwd: REPO,
      env: {
        ...process.env,
        HOME,
        USERPROFILE: HOME,
        MOTIONREF_PORT: String(PORT2),
        MOTIONREF_WORKSPACE: WORKSPACE,
        MOTIONREF_BROWSER_CMD: "true",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    cleanup.push(() => server2.kill("SIGTERM"));
    const base2 = `http://127.0.0.1:${PORT2}`;
    await waitForHttp(`${base2}/studio/info`);

    const c2 = await mkClientAt(base2, token);
    cleanup.push(() => c2.client.close().catch(() => {}));

    // Start the snapshot call with NO browser connected; 1.5s later — while
    // the broker waits for the tab it "opened" — a browser connects and
    // starts answering render requests.
    const call = c2.client.callTool({ name: "snapshot", arguments: { time: 0 } });
    setTimeout(() => {
      const wsLate = new WebSocket(`ws://127.0.0.1:${PORT2}/ws?token=${token}`);
      cleanup.push(() => wsLate.close());
      wsLate.on("open", () => wsLate.send(JSON.stringify({ type: "hello", clientId: "late-browser", version: "test" })));
      wsLate.on("message", (raw) => {
        const msg = JSON.parse(String(raw));
        if (msg.type === "render.request") {
          wsLate.send(JSON.stringify({ type: "render.result", requestId: msg.requestId, ok: true, dataUrl: tinyJpeg }));
        }
      });
    }, 1500);
    const autoSnap = await call;
    assert.ok(!autoSnap.isError, `auto-open snapshot ok: ${JSON.stringify(autoSnap.content)}`);
    const autoContent = autoSnap.content as Array<{ type: string; data?: string }>;
    assert.ok(autoContent.some((c) => c.type === "image"), "auto-opened browser rendered the snapshot");
  }

  // --- status TUI: MOTIONREF_FORCE_TUI renders the panel even when piped ---------------
  {
    const PORT3 = 9700 + Math.floor(Math.random() * 200);
    const out3: string[] = [];
    const server3 = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
      cwd: REPO,
      env: {
        ...process.env,
        HOME,
        USERPROFILE: HOME,
        MOTIONREF_PORT: String(PORT3),
        MOTIONREF_WORKSPACE: WORKSPACE,
        MOTIONREF_NO_OPEN_BROWSER: "1",
        MOTIONREF_FORCE_TUI: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    cleanup.push(() => server3.kill("SIGTERM"));
    server3.stdout?.on("data", (d: Buffer) => out3.push(String(d)));
    server3.stderr?.on("data", (d: Buffer) => process.stderr.write(`[server3:err] ${d}`));
    const base3 = `http://127.0.0.1:${PORT3}`;
    await waitForHttp(`${base3}/studio/info`);
    // A browser tab first (so the panel has a baseline state), then the MCP
    // agent — its connect event must appear in the rendered feed.
    const ws3 = new WebSocket(`ws://127.0.0.1:${PORT3}/ws?token=${token}`);
    cleanup.push(() => ws3.close());
    await new Promise((r) => ws3.on("open", r));
    ws3.send(JSON.stringify({ type: "hello", clientId: "tui-browser", version: "test" }));
    await sleep(300);
    const c3 = await mkClientAt(base3, token);
    cleanup.push(() => c3.client.close().catch(() => {}));
    const added = await c3.client.callTool({
      name: "add_object",
      arguments: { object: { type: "sphere", name: "TuiBall", position: [0, 0, 0] } },
    });
    assert.ok(!added.isError, `add_object on TUI server ok: ${JSON.stringify(added.content)}`);
    // The panel header + event feed (agent name is contiguous within one
    // rendered cell run, so it survives the ANSI framing).
    const deadline = Date.now() + 8_000;
    for (;;) {
      const all = out3.join("");
      if (/MotionRef Studio/.test(all) && /MCP agent connected — smoke-agent/.test(all)) break;
      if (Date.now() > deadline) {
        throw new Error(`FORCE_TUI panel never rendered; tail: ${JSON.stringify(all.slice(-1200))}`);
      }
      await sleep(100);
    }
  }

  console.log("smoke/server.test: ALL PASS");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("smoke/server.test: FAIL", e);
    process.exit(1);
  })
  .finally(() => {
    for (const fn of cleanup) {
      try {
        fn();
      } catch {
        /* ignore */
      }
    }
  });
