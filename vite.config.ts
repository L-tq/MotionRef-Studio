import { defineConfig, type Connect, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { Readable } from "node:stream";

/** Dev-mode twin of api/llm.ts so the "Vercel proxy" connection mode works
 *  under `vite dev` exactly as it does on the deployed edge function. */
function llmProxyDevPlugin(): Plugin {
  return {
    name: "dev-llm-proxy",
    configureServer(server) {
      const handler: Connect.NextHandleFunction = async (req, res) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end(JSON.stringify({ error: { message: "Method not allowed" } }));
          return;
        }
        let body = "";
        for await (const chunk of req) body += chunk;
        let parsed: { baseUrl?: string; apiKey?: string; path?: string; payload?: unknown };
        try {
          parsed = JSON.parse(body);
        } catch {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: { message: "Invalid JSON body" } }));
          return;
        }
        const { baseUrl, apiKey, path, payload } = parsed;
        if (!baseUrl || !path || payload === undefined) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: { message: "Missing baseUrl, path or payload" } }));
          return;
        }
        try {
          const headers: Record<string, string> = { "Content-Type": "application/json" };
          if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
          const upstream = await fetch(`${baseUrl.replace(/\/+$/, "")}${path}`, {
            method: "POST",
            headers,
            body: JSON.stringify(payload),
          });
          if (!upstream.ok) {
            const errText = await upstream.text().catch(() => "");
            console.error(
              `[llm-proxy] upstream ${upstream.status} for ${path}: ${errText.slice(0, 600)}`,
            );
            res.statusCode = upstream.status;
            res.setHeader("Content-Type", "application/json");
            res.end(errText);
            return;
          }
          res.statusCode = upstream.status;
          res.setHeader("Content-Type", upstream.headers.get("content-type") ?? "application/json");
          res.setHeader("Cache-Control", "no-store");
          if (upstream.body) {
            Readable.fromWeb(upstream.body as never).pipe(res);
          } else {
            res.end();
          }
        } catch (err) {
          res.statusCode = 502;
          res.end(JSON.stringify({ error: { message: `Upstream fetch failed: ${String(err)}` } }));
        }
      };
      server.middlewares.use("/api/llm", handler);
    },
  };
}

export default defineConfig({
  plugins: [react(), llmProxyDevPlugin()],
  // The sandbox worker must be bundled as a real ES module worker.
  worker: {
    format: "es",
  },
  build: {
    chunkSizeWarningLimit: 1500,
  },
});
