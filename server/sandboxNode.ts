/** Main-thread manager for the Node sandbox worker: single-flight execution
 *  with a hard timeout (terminate + respawn), mirroring src/agent/sandbox.ts.
 *  Satisfies the ToolContext.runSandbox contract for the server tool ctx. */
import { Worker } from "node:worker_threads";
import type { SceneDocument } from "../src/core/types";
import type { SandboxResult } from "../src/agent/types";

const TIMEOUT_MS = 5000;

export class NodeSandbox {
  private worker: Worker | null = null;
  private busy = false;
  private nextId = 1;
  private pending: {
    resolve: (r: SandboxResult) => void;
    id: number;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;

  private spawn(): Worker {
    const worker = new Worker(new URL("./sandboxNodeWorker.ts", import.meta.url));
    worker.on("message", (msg: { type: string; id: number } & SandboxResult) => {
      if (msg.type !== "done" || !this.pending || msg.id !== this.pending.id) return;
      clearTimeout(this.pending.timer);
      const resolve = this.pending.resolve;
      this.pending = null;
      this.busy = false;
      resolve(msg);
    });
    worker.on("error", (e: Error) => {
      if (!this.pending) return;
      clearTimeout(this.pending.timer);
      const resolve = this.pending.resolve;
      this.pending = null;
      this.busy = false;
      resolve({ ok: false, logs: [], error: `Worker error: ${e.message ?? "unknown"}` });
      this.worker = null;
    });
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
      const timer = setTimeout(() => {
        // Hard timeout: kill and respawn the worker.
        void worker.terminate();
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
    void this.worker?.terminate();
    this.worker = null;
    this.busy = false;
  }
}
