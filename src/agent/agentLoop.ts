/** The agent loop (lightweight deepseek-harness-inspired harness):
 *
 *  - step  = one model request + the tools it calls
 *  - turn  = user input → steps until the model stops calling tools
 *  - wire log = append-only OpenAI-format history (projected to the model)
 *  - session events = UI mirror of everything that happened
 *  - guarded tool execution: unknown tool / bad args / timeout / thrown
 *    errors all normalize to isError results fed back to the model
 *  - cancellation via AbortController (fetch abort + between-step checks)
 */
import { snapshotDataUrl } from "../core/engine";
import { newId } from "../core/types";
import { useStore } from "../state/store";
import { streamChatCompletion, userContent, type ToolSchema } from "./llmClient";
import { sandbox } from "./sandbox";
import { getTools, systemPrompt, toWireTools, type ToolContext, type ToolResult } from "./tools";
import type { WireMessage } from "./types";
import { runMockTurn } from "./mockProvider";
import { t } from "../i18n";

// --- module state -------------------------------------------------------------

let wireLog: WireMessage[] = [];
let abortController: AbortController | null = null;

export function resetSession(): void {
  if (useStore.getState().agentState === "running") return;
  wireLog = [];
  useStore.getState().sessionClear();
  useStore.setState({ agentStep: 0 });
}

export function stopAgentTurn(): void {
  abortController?.abort();
}

// --- tool execution pipeline ----------------------------------------------------

async function executeTool(name: string, argsJson: string, ctx: ToolContext): Promise<ToolResult> {
  const tool = getTools().find((tl) => tl.name === name);
  if (!tool) {
    return { text: `ERROR: unknown tool "${name}"`, isError: true };
  }
  let args: Record<string, unknown>;
  try {
    args = argsJson ? (JSON.parse(argsJson) as Record<string, unknown>) : {};
  } catch (err) {
    return { text: `ERROR: arguments are not valid JSON (${err instanceof Error ? err.message : String(err)}). Received: ${argsJson.slice(0, 400)}`, isError: true };
  }
  try {
    return await Promise.race([
      tool.handler(args, ctx),
      new Promise<ToolResult>((_, reject) =>
        setTimeout(() => reject(new Error("tool timed out after 20s")), 20_000),
      ),
    ]);
  } catch (err) {
    return { text: `ERROR: ${err instanceof Error ? err.message : String(err)}`, isError: true };
  }
}

function makeContext(): ToolContext {
  const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
  return {
    getDoc: () => useStore.getState().doc,
    applyDoc: (doc, label) => useStore.getState().applyDoc(doc, label),
    snapshot: (time, width, height) => {
      const s = useStore.getState();
      const time2 = clamp(time ?? s.playhead, 0, s.doc.duration);
      const w = Math.round(clamp(width ?? 1024, 64, 2048));
      const h = Math.round(clamp(height ?? 576, 64, 2048));
      // JPEG: universally accepted by vision APIs and much smaller on the wire.
      return { dataUrl: snapshotDataUrl(s.doc, time2, w, h, "jpeg"), t: time2, w, h };
    },
    runSandbox: (code) => sandbox.run(code, useStore.getState().doc),
  };
}

// --- turn entry -------------------------------------------------------------------

export interface AgentInput {
  text: string;
  images: string[];
}

export async function runAgentTurn(input: AgentInput): Promise<void> {
  const store = useStore.getState();
  if (store.agentState === "running") return;

  abortController = new AbortController();
  useStore.setState({ agentState: "running", agentStep: 0 });

  // Record the user turn.
  useStore.getState().sessionPush({
    id: newId("e"),
    type: "user",
    text: input.text,
    images: input.images,
  });
  wireLog.push({ role: "user", content: userContent(input.text, input.images) });

  try {
    if (store.settings.provider === "mock") {
      await runMockTurn(input, makeContext(), executeToolWithEvents);
    } else {
      await runRealTurn(store.settings.model, store.settings.maxSteps, abortController.signal);
    }
    useStore.setState({ agentState: "idle" });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      useStore.getState().sessionPush({ id: newId("e"), type: "notice", text: t("chat.stopped") });
      useStore.setState({ agentState: "idle" });
    } else {
      useStore.getState().sessionPush({
        id: newId("e"),
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      });
      useStore.setState({ agentState: "error" });
    }
  } finally {
    abortController = null;
  }
}

/** Exported for the mock provider so it shares the same event plumbing. */
export async function executeToolWithEvents(name: string, argsJson: string, ctx: ToolContext): Promise<ToolResult> {
  const eventId = newId("e");
  useStore.getState().sessionPush({
    id: eventId,
    type: "tool_call",
    callId: newId("c"),
    name,
    argsJson: prettify(argsJson),
    status: "running",
  });
  const t0 = performance.now();
  const result = await executeTool(name, argsJson, ctx);
  useStore.getState().sessionPatch(eventId, {
    status: result.isError ? "error" : "ok",
    resultText: result.text,
    durationMs: Math.round(performance.now() - t0),
  } as never);

  if (result.snapshot) {
    const snap = result.snapshot;
    useStore.getState().sessionPush({
      id: newId("e"),
      type: "snapshot",
      dataUrl: snap.dataUrl,
      t: snap.t,
      width: snap.w,
      height: snap.h,
    });
  }
  return result;
}

/** Snapshot feedback must be appended to the wire log only AFTER every tool
 *  message of the current assistant message — providers require tool replies
 *  to be contiguous. Callers drain collected snapshots here. */
export function appendSnapshotFeedback(snap: { dataUrl: string; t: number; w: number; h: number }): void {
  wireLog.push({
    role: "user",
    content: [
      {
        type: "text",
        text: `[SNAPSHOT t=${snap.t.toFixed(2)}s] Rendered from the scene camera (export framing). Verify composition, framing, colors and motion blocking.`,
      },
      { type: "image_url", image_url: { url: snap.dataUrl } },
    ],
  });
}

function prettify(argsJson: string): string {
  try {
    return JSON.stringify(JSON.parse(argsJson), null, 1);
  } catch {
    return argsJson;
  }
}

// --- real provider turn -------------------------------------------------------------

async function runRealTurn(model: string, maxSteps: number, signal: AbortSignal): Promise<void> {
  const ctx = makeContext();
  const tools: ToolSchema[] = toWireTools();

  for (let step = 1; step <= maxSteps; step++) {
    if (signal.aborted) throw new DOMException("aborted", "AbortError");
    useStore.setState({ agentStep: step });

    const assistantEventId = newId("e");
    useStore.getState().sessionPush({ id: assistantEventId, type: "assistant", text: "", step });
    const reasoningEventId = newId("e");
    let reasoningPushed = false;

    let streamedText = "";
    let streamedReasoning = "";
    let lastFlush = 0;
    const flush = (force = false) => {
      const now = performance.now();
      if (!force && now - lastFlush < 90) return;
      lastFlush = now;
      useStore.getState().sessionPatch(assistantEventId, { text: streamedText } as never);
      if (reasoningPushed) useStore.getState().sessionPatch(reasoningEventId, { text: streamedReasoning } as never);
    };

    const result = await streamChatCompletion({
      settings: useStore.getState().settings,
      model,
      messages: [{ role: "system", content: systemPrompt() }, ...wireLog],
      tools,
      signal,
      onDelta: (d) => {
        if (d.reasoning) {
          if (!reasoningPushed) {
            reasoningPushed = true;
            useStore.getState().sessionPush({ id: reasoningEventId, type: "reasoning", text: "" });
          }
          streamedReasoning += d.reasoning;
        }
        if (d.content) streamedText += d.content;
        flush();
      },
    });
    flush(true);

    if (!result.toolCalls.length) {
      wireLog.push({ role: "assistant", content: result.content || "(done)" });
      if (step >= maxSteps) useStore.setState({ agentStep: 0 });
      return;
    }

    wireLog.push({
      role: "assistant",
      content: result.content || null,
      tool_calls: result.toolCalls,
    });

    const snapshots: Array<{ dataUrl: string; t: number; w: number; h: number }> = [];
    for (const call of result.toolCalls) {
      if (signal.aborted) throw new DOMException("aborted", "AbortError");
      const toolResult = await executeToolWithEvents(call.function.name, call.function.arguments, ctx);
      wireLog.push({ role: "tool", tool_call_id: call.id, name: call.function.name, content: toolResult.text });
      if (toolResult.snapshot) snapshots.push(toolResult.snapshot);
    }
    // Feedback images go after ALL tool replies to keep the tool block contiguous.
    for (const snap of snapshots) appendSnapshotFeedback(snap);
  }

  useStore.getState().sessionPush({
    id: newId("e"),
    type: "notice",
    text: t("chat.stepLimit", { n: useStore.getState().settings.maxSteps }),
  });
}
