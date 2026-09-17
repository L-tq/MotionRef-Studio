/** Shared agent-harness types: session log events (deepseek-harness-style
 *  append-only record projected into model messages + chat UI).
 *
 *  This module must stay DOM-free: it is imported by the Node studio server
 *  (which shares the tool registry and sandbox result shape with the browser). */

/** OpenAI-style function-tool wire schema. */
export interface ToolSchema {
  type: "function";
  function: { name: string; description: string; parameters: object };
}

/** Result of a sandboxed execute_code run (mirrored doc + logs). */
export interface SandboxResult {
  ok: boolean;
  doc?: import("../core/types").SceneDocument;
  logs: string[];
  error?: string;
  result?: string;
}

export interface UserEvent {
  id: string;
  type: "user";
  text: string;
  /** data-URL images attached by the user */
  images: string[];
}

export interface AssistantEvent {
  id: string;
  type: "assistant";
  text: string;
  /** step index within the turn */
  step: number;
}

export interface ReasoningEvent {
  id: string;
  type: "reasoning";
  text: string;
}

export interface ToolCallEvent {
  id: string;
  type: "tool_call";
  callId: string;
  name: string;
  argsJson: string;
  status: "running" | "ok" | "error";
  resultText?: string;
  durationMs?: number;
}

export interface SnapshotEvent {
  id: string;
  type: "snapshot";
  dataUrl: string;
  t: number;
  width: number;
  height: number;
}

export interface ErrorEvent {
  id: string;
  type: "error";
  message: string;
}

export interface NoticeEvent {
  id: string;
  type: "notice";
  text: string;
}

export type SessionEvent =
  | UserEvent
  | AssistantEvent
  | ReasoningEvent
  | ToolCallEvent
  | SnapshotEvent
  | ErrorEvent
  | NoticeEvent;

export type AgentState = "idle" | "running" | "error";

export interface LlmSettings {
  provider: "real" | "mock";
  baseUrl: string;
  apiKey: string;
  model: string;
  connection: "proxy" | "direct";
  maxImages: number;
  maxSteps: number;
}

export const DEFAULT_LLM_SETTINGS: LlmSettings = {
  provider: "real",
  baseUrl: "",
  apiKey: "",
  model: "",
  connection: "direct",
  maxImages: 8,
  maxSteps: 100,
};

export function isConfigured(s: LlmSettings): boolean {
  if (s.provider === "mock") return true;
  // API key may legitimately be empty for local servers (e.g. Ollama).
  return !!s.baseUrl.trim() && !!s.model.trim();
}

/** OpenAI-compatible wire types (subset used here). */
export interface WireToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface WireContentPart {
  type: "text" | "image_url";
  text?: string;
  image_url?: { url: string };
}

export interface WireMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | WireContentPart[] | null;
  tool_calls?: WireToolCall[];
  tool_call_id?: string;
  name?: string;
}
