/** Minimal static file serving for the built SPA (dist/) with an index.html
 *  fallback — no framework, just enough for a local studio server. */
import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
};

export function serveStatic(root: string, req: IncomingMessage, res: ServerResponse): boolean {
  if (!req.url) return false;
  const pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  let file = path.normalize(path.join(root, pathname));
  if (!file.startsWith(path.normalize(root))) return false; // path traversal guard
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    // SPA fallback: unknown routes get the app shell.
    file = path.join(root, "index.html");
    if (!fs.existsSync(file)) return false;
  }
  const ext = path.extname(file).toLowerCase();
  const immutable = pathname.startsWith("/assets/");
  res.writeHead(200, {
    "Content-Type": MIME[ext] ?? "application/octet-stream",
    "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
  });
  fs.createReadStream(file).pipe(res);
  return true;
}
