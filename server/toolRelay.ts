/** ToolService — the single serialized tool-execution path shared by the MCP
 *  endpoint (external agents) and the browser's built-in agent relay. Both
 *  run the exact same registry + runTool() pipeline with the server-side
 *  ToolContext, so behavior is identical by construction.
 *
 *  Lock policy: mutating tools acquire/renew the caller's edit lock (waiting
 *  up to LOCK_WAIT_MS then failing busy); read-only tools renew an existing
 *  holder's window (so snapshot-verify steps between mutations don't drop an
 *  MCP agent's burst) but never acquire. History labels are prefixed with the
 *  actor kind so undo entries show where a change came from. */
import { aspectDims } from "../src/core/cameraMath";
import { runTool, getTools, type SnapshotPayload, type ToolContext, type ToolResult } from "../src/agent/tools";
import { LOCK_TTL_MS, LOCK_WAIT_MS, type LockHolder, type LockKind } from "../src/shared/protocol";
import type { StudioSession } from "./session";
import { EditLock } from "./editLock";
import type { NodeSandbox } from "./sandboxNode";
import type { RenderBroker } from "./renderBroker";

export interface Actor {
  kind: LockKind;
  id: string;
  label: string;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

export class ToolService {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private session: StudioSession,
    private lock: EditLock,
    private sandbox: NodeSandbox,
    private renders: RenderBroker,
  ) {}

  /** Serialize invocations: one tool at a time across all actors (the
   *  browser sandbox is single-flight anyway; keeps snapshot-verify loops
   *  consistent and lock transitions orderly). */
  invoke(actor: Actor, name: string, argsJson: string): Promise<ToolResult> {
    const run = () => this.invokeNow(actor, name, argsJson);
    const result = this.queue.then(run, run);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async invokeNow(actor: Actor, name: string, argsJson: string): Promise<ToolResult> {
    const tool = getTools().find((tl) => tl.name === name);
    if (!tool) return runTool(name, argsJson, this.ctxFor(actor)); // → unknown-tool error

    if (tool.readOnly) {
      this.lock.renew(actor.id, LOCK_TTL_MS[actor.kind]);
    } else {
      if (!this.lock.heldBy(actor.id)) {
        const ok = await this.lock.acquireAndWait(this.holderOf(actor));
        if (!ok) return { text: EditLock.busyMessage(this.lock.current()), isError: true };
      } else {
        this.lock.renew(actor.id, LOCK_TTL_MS[actor.kind]);
      }
    }
    return runTool(name, argsJson, this.ctxFor(actor));
  }

  private holderOf(actor: Actor): LockHolder {
    return { kind: actor.kind, id: actor.id, label: actor.label };
  }

  private ctxFor(actor: Actor): ToolContext {
    const session = this.session;
    const renders = this.renders;
    const sandbox = this.sandbox;
    const prefix = actor.kind === "mcp" ? "mcp:" : "agent:";
    return {
      getDoc: () => session.getDoc(),
      applyDoc: (doc, label) => {
        session.apply(doc, `${prefix}${label}`, actor.kind === "mcp" ? "mcp" : "agent");
      },
      snapshot: async (time, width, height) => {
        const doc = session.getDoc();
        const time2 = clamp(time ?? 0, 0, doc.duration);
        const dims = aspectDims(doc.aspect ?? 16 / 9, 1024);
        const w = Math.round(clamp(width ?? dims.w, 64, 2048));
        const h = Math.round(clamp(height ?? dims.h, 64, 2048));
        const r = await renders.render(session.getRev(), time2, w, h);
        if ("error" in r) throw new Error(r.error);
        const payload: SnapshotPayload = { dataUrl: r.dataUrl, t: time2, w, h };
        return payload;
      },
      runSandbox: (code) => sandbox.run(code, session.getDoc()),
    };
  }
}

export { LOCK_WAIT_MS };
