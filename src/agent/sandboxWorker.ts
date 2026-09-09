/// <reference lib="webworker" />
/** Sandbox worker: executes agent/user JavaScript against a mirrored
 *  SceneDocument. No DOM, no network imports — only the `api` object and
 *  standard JS. The result document is posted back atomically. */
import { createScriptTarget, createScriptingAPI } from "../core/scripting";
import { cloneDoc, type SceneDocument } from "../core/types";

interface ExecMessage {
  type: "exec";
  id: number;
  code: string;
  doc: SceneDocument;
}

// Heuristic denylist: the worker has no DOM, but dynamic import/fetch would
// still allow network access. Reject the obvious tokens up front.
const FORBIDDEN = [
  /\bimport\s*[(\s]/, // dynamic import(...) — static imports are syntax errors in new Function anyway
  /\bfetch\s*\(/,
  /XMLHttpRequest/,
  /WebSocket/,
  /\bnew\s+Worker\b/,
  /importScripts/,
  /\brequire\s*\(/,
  /navigator\s*\./,
  /location\s*\./,
];

function fmt(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

function post(msg: unknown): void {
  (self as unknown as Worker).postMessage(msg);
}

self.onmessage = async (e: MessageEvent<ExecMessage>) => {
  const { type, id, code, doc } = e.data;
  if (type !== "exec") return;

  const logs: string[] = [];
  try {
    for (const re of FORBIDDEN) {
      if (re.test(code)) {
        throw new Error(`Forbidden API in sandbox code (pattern ${re}) — no network/DOM/imports allowed.`);
      }
    }
    const mirror = cloneDoc(doc);
    const target = createScriptTarget(mirror);
    const api = createScriptingAPI(target, (...args: unknown[]) => {
      logs.push(args.map(fmt).join(" "));
      if (logs.length > 200) logs.length = 200;
    });
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const fn = new Function("api", `"use strict";\nreturn (async () => {\n${code}\n})();`);
    const result = await fn(api);
    post({ type: "done", id, ok: true, doc: mirror, logs, result: fmt(result) });
  } catch (err) {
    post({
      type: "done",
      id,
      ok: false,
      error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      logs,
    });
  }
};
