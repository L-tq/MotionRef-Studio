/** Locale-dependent wiring between the tool registry / skill guide and the
 *  OpenAI wire format. Kept separate from tools.ts so the registry itself
 *  stays DOM-free and importable from the Node studio server. */
import { getLocale } from "../i18n";
import { buildAgentGuide } from "./guide";
import { toolsForLocale } from "./tools";
import type { ToolSchema } from "./types";

/** Convert to OpenAI wire tool schemas, localized to the UI language. */
export function toWireTools(): ToolSchema[] {
  return toolsForLocale(getLocale());
}

/** The system prompt: the Agent Skill Guide in the UI language. */
export function systemPrompt(): string {
  return buildAgentGuide("builtin", getLocale());
}
