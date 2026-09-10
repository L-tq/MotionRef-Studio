/** The agent loop (lightweight deepseek-harness-inspired harness):
 *
 *  - task  = one named chat thread bound to the current project; each has its
 *            own transcript (store.taskEvents) and provider wire log
 *  - step  = one model request + the tools it calls
 *  - turn  = user input → steps until the model stops calling tools
 *  - guarded tool execution: unknown tool / bad args / timeout / thrown
 *    errors all normalize to isError results fed back to the model
 *  - cancellation via AbortController (fetch abort + between-step checks)
 *  - a turn always keeps writing into ITS task, so the user can switch to
 *    another task (or project) and back while it is still running
 */
import { snapshotDataUrl } from "../core/engine";
import { newId } from "../core/types";
import { aspectDims } from "../core/cameraMath";
import { useStore } from "../state/store";
import {
  deleteSessionRecord,
  getSession,
  listSessions,
  loadCurrentSessionId,
  migrateLegacyChat,
  putSession,
  saveCurrentSessionId,
  type ChatSessionRecord,
} from "../state/chatPersist";
import { streamChatCompletion, userContent, type ToolSchema } from "./llmClient";
import { sandbox } from "./sandbox";
import { getTools, systemPrompt, toWireTools, type ToolContext, type ToolResult } from "./tools";
import type { SessionEvent, WireMessage } from "./types";
import { runMockTurn } from "./mockProvider";
import { t } from "../i18n";

// --- module state -------------------------------------------------------------

/** Per-task provider context: the OpenAI-format history and the abort handle
 *  of a possibly still-running turn. */
export interface TaskRuntime {
  wireLog: WireMessage[];
  abort: AbortController | null;
}
const runtimes = new Map<string, TaskRuntime>();

/** The task the currently executing turn writes to (mock provider included). */
let turnTaskId: string | null = null;

export function stopAgentTurn(taskId?: string): void {
  const id = taskId ?? useStore.getState().activeTaskId;
  if (id) runtimes.get(id)?.abort?.abort();
}

function runningTaskIds(): string[] {
  const s = useStore.getState();
  return Object.entries(s.taskStates)
    .filter(([, st]) => st === "running")
    .map(([id]) => id);
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
      // Defaults follow the scene aspect ratio so agent-visible snapshots
      // match the export framing (16:9 → 1024x576, 9:16 → 576x1024, …).
      const dims = aspectDims(s.doc.aspect ?? 16 / 9, 1024);
      const w = Math.round(clamp(width ?? dims.w, 64, 2048));
      const h = Math.round(clamp(height ?? dims.h, 64, 2048));
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
  const taskId = store.activeTaskId;
  if (!taskId || store.taskStates[taskId] === "running") return;

  const rt = runtimeFor(taskId);
  rt.abort = new AbortController();
  turnTaskId = taskId;
  store.setTaskState(taskId, "running");
  store.setTaskStep(taskId, 0);

  // Record the user turn.
  store.taskPush(taskId, {
    id: newId("e"),
    type: "user",
    text: input.text,
    images: input.images,
  });
  rt.wireLog.push({ role: "user", content: userContent(input.text, input.images) });

  try {
    if (store.settings.provider === "mock") {
      await runMockTurn(input, makeContext(), executeToolWithEvents, rt);
    } else {
      await runRealTurn(taskId, rt, store.settings.model, store.settings.maxSteps, rt.abort.signal);
    }
    useStore.getState().setTaskState(taskId, "idle");
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      useStore.getState().taskPush(taskId, { id: newId("e"), type: "notice", text: t("chat.stopped") });
      useStore.getState().setTaskState(taskId, "idle");
    } else {
      useStore.getState().taskPush(taskId, {
        id: newId("e"),
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      });
      useStore.getState().setTaskState(taskId, "error");
    }
  } finally {
    rt.abort = null;
    if (turnTaskId === taskId) turnTaskId = null;
  }
}

function runtimeFor(taskId: string): TaskRuntime {
  let rt = runtimes.get(taskId);
  if (!rt) {
    // Seed the provider history from the persisted transcript.
    rt = { wireLog: wireFromEvents(useStore.getState().taskEvents[taskId] ?? []), abort: null };
    runtimes.set(taskId, rt);
  }
  return rt;
}

/** Event plumbing shared by the real loop and the mock provider: everything
 *  goes to the task the current turn belongs to. */
export function turnTaskPush(event: SessionEvent): void {
  if (turnTaskId) useStore.getState().taskPush(turnTaskId, event);
}

export function turnTaskPatch(eventId: string, patch: Partial<SessionEvent>): void {
  if (turnTaskId) useStore.getState().taskPatch(turnTaskId, eventId, patch);
}

/** Exported for the mock provider so it shares the same event plumbing. */
export async function executeToolWithEvents(name: string, argsJson: string, ctx: ToolContext): Promise<ToolResult> {
  const eventId = newId("e");
  turnTaskPush({
    id: eventId,
    type: "tool_call",
    callId: newId("c"),
    name,
    argsJson: prettify(argsJson),
    status: "running",
  });
  const t0 = performance.now();
  const result = await executeTool(name, argsJson, ctx);
  turnTaskPatch(eventId, {
    status: result.isError ? "error" : "ok",
    resultText: result.text,
    durationMs: Math.round(performance.now() - t0),
  } as never);

  if (result.snapshot) {
    const snap = result.snapshot;
    turnTaskPush({
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
export function appendSnapshotFeedback(rt: TaskRuntime, snap: { dataUrl: string; t: number; w: number; h: number }): void {
  rt.wireLog.push({
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

// --- chat task management ----------------------------------------------------------
//
// Tasks are chat threads bound to a project (IndexedDB, see
// state/chatPersist.ts). Each task's provider wire log lives in its runtime
// and is rebuilt from the transcript when a turn starts in a task that has no
// runtime yet: only user messages (text + images) and assistant text survive —
// tool-call blocks cannot be reliably reconstructed, and assistant text
// summaries keep enough context.

function wireFromEvents(events: SessionEvent[]): WireMessage[] {
  const out: WireMessage[] = [];
  for (const e of events) {
    if (e.type === "user") out.push({ role: "user", content: userContent(e.text, e.images) });
    else if (e.type === "assistant" && e.text.trim()) out.push({ role: "assistant", content: e.text });
  }
  return out;
}

function metaOf(record: ChatSessionRecord) {
  return { id: record.id, name: record.name, projectId: record.projectId, createdAt: record.createdAt, updatedAt: record.updatedAt };
}

/** Load (or create) the task list of one project and make it visible. Safe to
 *  call while other tasks are running — their runtimes keep streaming. */
export async function loadProjectTasks(projectId: string | null): Promise<void> {
  let records = await listSessions(projectId);
  if (records.length === 0) {
    const now = Date.now();
    const fresh: ChatSessionRecord = { id: newId("s"), name: "", projectId, createdAt: now, updatedAt: now, events: [] };
    await putSession(fresh);
    records = [fresh];
  }
  records.forEach((r) => useStore.getState().registerTaskProject(r.id, projectId));
  const events: Record<string, SessionEvent[]> = {};
  const prevEvents = useStore.getState().taskEvents;
  for (const r of records) {
    // A still-running turn keeps appending to its in-memory transcript — never
    // clobber it with the (older) persisted snapshot.
    events[r.id] = runtimes.get(r.id)?.abort ? (prevEvents[r.id] ?? r.events) : r.events;
  }
  const lastActive = loadCurrentSessionId();
  const active = records.find((r) => r.id === lastActive) ?? records[0];
  // A task that is still running keeps its running state across the switch.
  const states: Record<string, "running"> = {};
  for (const r of records) if (runtimes.get(r.id)?.abort) states[r.id] = "running";
  useStore.setState({ tasks: records.map(metaOf), taskEvents: events, activeTaskId: active.id, taskStates: states });
  saveCurrentSessionId(active.id);
}

/** Start a fresh task in the current project. Running turns elsewhere are
 *  untouched; the user can switch back to them at any time. */
export function newTask(): boolean {
  const s = useStore.getState();
  const projectId = s.projectId;
  const now = Date.now();
  const id = newId("s");
  useStore.getState().registerTaskProject(id, projectId);
  void putSession({ id, name: "", projectId, createdAt: now, updatedAt: now, events: [] });
  saveCurrentSessionId(id);
  useStore.setState((st) => ({
    tasks: [{ id, name: "", projectId, createdAt: now, updatedAt: now }, ...st.tasks],
    taskEvents: { ...st.taskEvents, [id]: [] },
    activeTaskId: id,
  }));
  return true;
}

/** Switch the visible task. Pure view switch — always allowed, even while
 *  other tasks are running. */
export function switchTask(id: string): void {
  const s = useStore.getState();
  if (!s.tasks.some((m) => m.id === id)) return;
  saveCurrentSessionId(id);
  useStore.setState({ activeTaskId: id });
}

export async function renameTask(id: string, name: string): Promise<void> {
  const clean = name.trim().slice(0, 80);
  const s = useStore.getState();
  useStore.setState({ tasks: s.tasks.map((m) => (m.id === id ? { ...m, name: clean } : m)) });
  const events = s.taskEvents[id];
  if (events) {
    const meta = s.tasks.find((m) => m.id === id);
    await putSession({
      id,
      name: clean,
      projectId: meta?.projectId ?? null,
      createdAt: meta?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
      events,
    });
  }
}

/** Delete a task record. A running task cannot be deleted; deleting the
 *  active one activates the most recent remaining task (or starts fresh). */
export async function deleteTaskById(id: string): Promise<boolean> {
  const s = useStore.getState();
  if (s.taskStates[id] === "running") return false;
  await deleteSessionRecord(id);
  runtimes.delete(id);
  const remaining = s.tasks.filter((m) => m.id !== id);
  if (id === s.activeTaskId) {
    if (remaining.length > 0) {
      const next = remaining[0];
      saveCurrentSessionId(next.id);
      useStore.setState({ tasks: remaining, activeTaskId: next.id });
    } else {
      useStore.setState({ tasks: remaining });
      newTask();
    }
  } else {
    useStore.setState({ tasks: remaining });
  }
  return true;
}

// On boot, restore the current project's tasks so chat history survives
// reloads, and migrate any pre-task-era transcript.
void (async () => {
  try {
    await migrateLegacyChat();
    await loadProjectTasks(useStore.getState().projectId);
    useStore.subscribe((state, prev) => {
      if (state.projectId !== prev.projectId) void loadProjectTasks(state.projectId);
    });
  } catch {
    /* no persisted chat — start empty */
  }
})();

function prettify(argsJson: string): string {
  try {
    return JSON.stringify(JSON.parse(argsJson), null, 1);
  } catch {
    return argsJson;
  }
}

// --- real provider turn -------------------------------------------------------------

async function runRealTurn(
  taskId: string,
  rt: TaskRuntime,
  model: string,
  maxSteps: number,
  signal: AbortSignal,
): Promise<void> {
  const ctx = makeContext();
  const tools: ToolSchema[] = toWireTools();

  for (let step = 1; step <= maxSteps; step++) {
    if (signal.aborted) throw new DOMException("aborted", "AbortError");
    useStore.getState().setTaskStep(taskId, step);

    const assistantEventId = newId("e");
    useStore.getState().taskPush(taskId, { id: assistantEventId, type: "assistant", text: "", step });
    const reasoningEventId = newId("e");
    let reasoningPushed = false;

    let streamedText = "";
    let streamedReasoning = "";
    let lastFlush = 0;
    const flush = (force = false) => {
      const now = performance.now();
      if (!force && now - lastFlush < 90) return;
      lastFlush = now;
      useStore.getState().taskPatch(taskId, assistantEventId, { text: streamedText } as never);
      if (reasoningPushed) useStore.getState().taskPatch(taskId, reasoningEventId, { text: streamedReasoning } as never);
    };

    const result = await streamChatCompletion({
      settings: useStore.getState().settings,
      model,
      messages: [{ role: "system", content: systemPrompt() }, ...rt.wireLog],
      tools,
      signal,
      onDelta: (d) => {
        if (d.reasoning) {
          if (!reasoningPushed) {
            reasoningPushed = true;
            useStore.getState().taskPush(taskId, { id: reasoningEventId, type: "reasoning", text: "" });
          }
          streamedReasoning += d.reasoning;
        }
        if (d.content) streamedText += d.content;
        flush();
      },
    });
    flush(true);

    if (!result.toolCalls.length) {
      rt.wireLog.push({ role: "assistant", content: result.content || "(done)" });
      if (step >= maxSteps) useStore.getState().setTaskStep(taskId, 0);
      return;
    }

    rt.wireLog.push({
      role: "assistant",
      content: result.content || null,
      tool_calls: result.toolCalls,
    });

    const snapshots: Array<{ dataUrl: string; t: number; w: number; h: number }> = [];
    for (const call of result.toolCalls) {
      if (signal.aborted) throw new DOMException("aborted", "AbortError");
      const toolResult = await executeToolWithEvents(call.function.name, call.function.arguments, ctx);
      rt.wireLog.push({ role: "tool", tool_call_id: call.id, name: call.function.name, content: toolResult.text });
      if (toolResult.snapshot) snapshots.push(toolResult.snapshot);
    }
    // Feedback images go after ALL tool replies to keep the tool block contiguous.
    for (const snap of snapshots) appendSnapshotFeedback(rt, snap);
  }

  useStore.getState().taskPush(taskId, {
    id: newId("e"),
    type: "notice",
    text: t("chat.stepLimit", { n: maxSteps }),
  });
}
