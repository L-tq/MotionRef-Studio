/** Main-thread manager for the sandbox Web Worker: single-flight execution
 *  with a hard timeout (terminate + respawn), deepseek-harness style. */
import type { SceneDocument } from "../core/types";

export interface SandboxResult {
  ok: boolean;
  doc?: SceneDocument;
  logs: string[];
  error?: string;
  result?: string;
}

const TIMEOUT_MS = 5000;

export class Sandbox {
  private worker: Worker | null = null;
  private busy = false;
  private nextId = 1;
  private pending: {
    resolve: (r: SandboxResult) => void;
    id: number;
    timer: number;
  } | null = null;

  private spawn(): Worker {
    const worker = new Worker(new URL("./sandboxWorker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent) => {
      const msg = e.data as { type: string; id: number } & SandboxResult;
      if (msg.type !== "done" || !this.pending || msg.id !== this.pending.id) return;
      clearTimeout(this.pending.timer);
      const resolve = this.pending.resolve;
      this.pending = null;
      this.busy = false;
      resolve(msg);
    };
    worker.onerror = (e) => {
      if (!this.pending) return;
      clearTimeout(this.pending.timer);
      const resolve = this.pending.resolve;
      const id = this.pending.id;
      this.pending = null;
      this.busy = false;
      resolve({ ok: false, logs: [], error: `Worker error: ${e.message ?? "unknown"}` });
      void id;
    };
    this.worker = worker;
    return worker;
  }

  private ensure(): Worker {
    return this.worker ?? this.spawn();
  }

  async run(code: string, doc: SceneDocument): Promise<SandboxResult> {
    if (this.busy) {
      return { ok: false, logs: [], error: "Sandbox is busy — wait for the previous execution." };
    }
    this.busy = true;
    const worker = this.ensure();
    const id = this.nextId++;
    return new Promise<SandboxResult>((resolve) => {
      const timer = window.setTimeout(() => {
        // Hard timeout: kill and respawn the worker.
        worker.terminate();
        this.worker = null;
        this.pending = null;
        this.busy = false;
        resolve({ ok: false, logs: [], error: `Sandbox timeout: execution exceeded ${TIMEOUT_MS}ms and was terminated.` });
      }, TIMEOUT_MS);
      this.pending = { resolve, id, timer };
      worker.postMessage({ type: "exec", id, code, doc });
    });
  }

  dispose(): void {
    if (this.pending) clearTimeout(this.pending.timer);
    this.pending = null;
    this.worker?.terminate();
    this.worker = null;
    this.busy = false;
  }
}

/** Shared singleton (agent loop + script console). */
export const sandbox = new Sandbox();
