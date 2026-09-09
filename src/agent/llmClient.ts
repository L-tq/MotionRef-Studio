/** OpenAI-compatible chat completions client with streaming, tool calls and
 *  multimodal (image_url) content. Transport is either direct fetch or the
 *  Vercel edge proxy (/api/llm), chosen by settings. */
import type { LlmSettings, WireContentPart, WireMessage, WireToolCall } from "./types";

export interface ToolSchema {
  type: "function";
  function: { name: string; description: string; parameters: object };
}

export interface StreamDelta {
  content?: string;
  reasoning?: string;
  toolCalls?: Array<{ index: number; id?: string; name?: string; args?: string }>;
}

export interface StreamResult {
  content: string;
  toolCalls: WireToolCall[];
  finishReason: string | null;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export class LlmError extends Error {
  constructor(
    message: string,
    public status?: number,
    public detail?: string,
  ) {
    super(message);
  }
}

/** Normalize user-entered base URL to { base, path } where path is the API
 *  route to append. Handles "...", ".../v1", ".../v1/", openrouter-style
 *  ".../api/v1". */
function normalizeBase(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

function chatPath(base: string): string {
  return /\/v\d+$/.test(base) ? "/chat/completions" : "/v1/chat/completions";
}

function modelsPath(base: string): string {
  return /\/v\d+$/.test(base) ? "/models" : "/v1/models";
}

interface Transport {
  url: string;
  init: RequestInit;
}

function buildTransport(settings: LlmSettings, path: string, payload: unknown, signal?: AbortSignal): Transport {
  const base = normalizeBase(settings.baseUrl);
  if (settings.connection === "direct") {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;
    return { url: base + path, init: { method: "POST", headers, body: JSON.stringify(payload), signal } };
  }
  return {
    url: "/api/llm",
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseUrl: base, apiKey: settings.apiKey, path, payload }),
      signal,
    },
  };
}

async function readError(res: Response): Promise<string> {
  let detail = "";
  try {
    const text = await res.text();
    try {
      const json = JSON.parse(text) as { error?: { message?: string }; message?: string };
      detail = json.error?.message ?? json.message ?? text.slice(0, 400);
    } catch {
      detail = text.slice(0, 400);
    }
  } catch {
    /* ignore */
  }
  return detail;
}

/** Stream one chat completion. onDelta receives incremental pieces. */
export async function streamChatCompletion(opts: {
  settings: LlmSettings;
  model: string;
  messages: WireMessage[];
  tools?: ToolSchema[];
  signal?: AbortSignal;
  onDelta?: (delta: StreamDelta) => void;
}): Promise<StreamResult> {
  const payload: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    stream: true,
  };
  if (opts.tools?.length) {
    payload.tools = opts.tools;
    payload.tool_choice = "auto";
  }

  const transport = buildTransport(opts.settings, chatPath(normalizeBase(opts.settings.baseUrl)), payload, opts.signal);
  let res: Response;
  try {
    res = await fetch(transport.url, transport.init);
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    throw new LlmError(
      opts.settings.connection === "direct"
        ? `Network error (direct mode may need CORS): ${String(err)}`
        : `Network error via proxy: ${String(err)}`,
    );
  }

  if (!res.ok) {
    throw new LlmError(`HTTP ${res.status} ${res.statusText}`, res.status, await readError(res));
  }

  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("event-stream")) {
    // Provider answered with a plain JSON body (streaming unsupported).
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string | null; tool_calls?: WireToolCall[] }; finish_reason?: string }>;
      usage?: StreamResult["usage"];
    };
    const choice = json.choices?.[0];
    const content = (choice?.message?.content as string) ?? "";
    opts.onDelta?.({ content });
    return {
      content,
      toolCalls: choice?.message?.tool_calls ?? [],
      finishReason: choice?.finish_reason ?? null,
      usage: json.usage,
    };
  }

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const toolAcc = new Map<number, { id: string; name: string; args: string }>();
  let content = "";
  let reasoning = "";
  let finishReason: string | null = null;
  let usage: StreamResult["usage"] | undefined;

  const handleChunk = (data: string) => {
    if (data === "[DONE]") return;
    let json: {
      choices?: Array<{
        delta?: { content?: string | null; reasoning_content?: string | null; tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> };
        finish_reason?: string | null;
      }>;
      usage?: StreamResult["usage"];
    };
    try {
      json = JSON.parse(data);
    } catch {
      return;
    }
    const choice = json.choices?.[0];
    if (!choice) {
      if (json.usage) usage = json.usage;
      return;
    }
    const delta = choice.delta ?? {};
    if (delta.content) {
      content += delta.content;
      opts.onDelta?.({ content: delta.content });
    }
    if (delta.reasoning_content) {
      reasoning += delta.reasoning_content;
      opts.onDelta?.({ reasoning: delta.reasoning_content });
    }
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const entry = toolAcc.get(tc.index) ?? { id: "", name: "", args: "" };
        if (tc.id) entry.id = tc.id;
        if (tc.function?.name) entry.name += tc.function.name;
        if (tc.function?.arguments) entry.args += tc.function.arguments;
        toolAcc.set(tc.index, entry);
      }
      opts.onDelta?.({
        toolCalls: delta.tool_calls.map((tc) => ({
          index: tc.index,
          id: tc.id,
          name: tc.function?.name,
          args: tc.function?.arguments,
        })),
      });
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;
    if (json.usage) usage = json.usage;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("data:")) handleChunk(trimmed.slice(5).trim());
      }
    }
    if (buffer.trim().startsWith("data:")) handleChunk(buffer.trim().slice(5).trim());
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    throw new LlmError(`Stream interrupted: ${String(err)}`);
  }

  const toolCalls: WireToolCall[] = [...toolAcc.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([i, tc]) => ({
      id: tc.id || `call_${i}_${Date.now().toString(36)}`,
      type: "function" as const,
      function: { name: tc.name, arguments: tc.args || "{}" },
    }));

  void reasoning; // surfaced via onDelta already
  return { content, toolCalls, finishReason, usage };
}

/** Fetch /models to verify connectivity; returns model id list. */
export async function listModels(settings: LlmSettings, signal?: AbortSignal): Promise<string[]> {
  const transport = buildTransport(settings, modelsPath(normalizeBase(settings.baseUrl)), {}, signal);
  const res = await fetch(transport.url, { ...transport.init, method: "POST" });
  if (!res.ok) throw new LlmError(`HTTP ${res.status} ${res.statusText}`, res.status, await readError(res));
  const json = (await res.json()) as { data?: Array<{ id?: string }> };
  return (json.data ?? []).map((m) => m.id ?? "").filter(Boolean);
}

/** Build multimodal user content parts from text + data-URL images. */
export function userContent(text: string, images: string[]): string | WireContentPart[] {
  if (!images.length) return text;
  const parts: WireContentPart[] = [];
  if (text.trim()) parts.push({ type: "text", text });
  for (const url of images) parts.push({ type: "image_url", image_url: { url } });
  return parts;
}
