/** MCP stdio shim (`npm run mcp`) — lets agent clients that only support
 *  command-based (stdio) MCP servers use the studio server's HTTP endpoint.
 *
 *  Bridges newline-delimited JSON-RPC on stdin/stdout to MCP Streamable
 *  HTTP. The first initialize request is annotated with the shim's working
 *  directory (the external agent's workspace) so the server can adopt it.
 *
 *  Usage: npm run mcp [-- --url http://127.0.0.1:8787/mcp] [-- --token <t>]
 *  Env:   MOTIONREF_URL, MOTIONREF_TOKEN (token also read from
 *         ~/.motionref-studio/config.json). */
import readline from "node:readline";
import { readConfig } from "./util";

function argValue(flag: string): string | undefined {
  const argv = process.argv;
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

const url = argValue("--url") ?? process.env.MOTIONREF_URL ?? "http://127.0.0.1:8787/mcp";
const token = argValue("--token") ?? process.env.MOTIONREF_TOKEN ?? readConfig().token;

let sessionId: string | null = null;

async function post(message: unknown): Promise<void> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${token}`,
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(message) });
  const newSid = res.headers.get("mcp-session-id");
  if (newSid) sessionId = newSid;
  if (res.status === 202) return; // notification accepted — no body
  const text = await res.text();
  if (!text) return;
  // JSON-response mode returns a single JSON-RPC message; SSE mode (not used
  // by the studio server) would stream — pass lines through if that happens.
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("data:")) {
      process.stdout.write(`${trimmed.slice(5).trim()}\n`);
    } else {
      process.stdout.write(`${trimmed}\n`);
    }
  }
}

async function main(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return;
    }
    // Announce the external agent's workspace on initialize.
    if (message.method === "initialize") {
      const params = (message.params ?? {}) as Record<string, unknown>;
      params._meta = { ...((params._meta as object) ?? {}), workspace: process.cwd() };
      message.params = params;
    }
    void post(message).catch((e) => {
      process.stderr.write(`mcp shim: request failed: ${String(e)}\n`);
      if (typeof message.id === "number" || typeof message.id === "string") {
        process.stdout.write(
          `${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: String(e) } })}\n`,
        );
      }
    });
  });
  process.stdin.on("close", () => process.exit(0));
}

void main();
