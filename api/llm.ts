// Vercel Edge Function: dumb passthrough proxy for OpenAI-compatible LLM APIs.
// The browser sends { baseUrl, apiKey, path, payload }; we forward and stream back.
// Nothing is logged or stored server-side — the API key only exists in the request.

export const config = { runtime: "edge" };

const ALLOWED_PATHS = new Set(["/v1/chat/completions", "/chat/completions", "/v1/models", "/models"]);

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json(405, { error: { message: "Method not allowed" } });

  let body: { baseUrl?: string; apiKey?: string; path?: string; payload?: unknown };
  try {
    body = await req.json();
  } catch {
    return json(400, { error: { message: "Invalid JSON body" } });
  }

  const { baseUrl, apiKey, path, payload } = body;
  if (!baseUrl || !path || payload === undefined) {
    return json(400, { error: { message: "Missing baseUrl, path or payload" } });
  }
  if (!/^https?:\/\//i.test(baseUrl)) {
    return json(400, { error: { message: "baseUrl must be an http(s) URL" } });
  }
  if (!ALLOWED_PATHS.has(path)) {
    return json(400, { error: { message: `Path not allowed: ${path}` } });
  }

  const target = `${baseUrl.replace(/\/+$/, "")}${path}`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  try {
    const upstream = await fetch(target, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "Content-Type": upstream.headers.get("content-type") ?? "application/json",
        "Cache-Control": "no-store",
        ...CORS,
      },
    });
  } catch (err) {
    return json(502, { error: { message: `Upstream fetch failed: ${String(err)}` } });
  }
}
