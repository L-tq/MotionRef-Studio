/** Snapshot broker: WebGL rendering only exists in the browser, so the
 *  server relays render requests to a connected Web UI client.
 *
 *  HEADLESS EXIT: when a snapshot is needed and no browser is connected, the
 *  broker opens the Web UI in the user's default browser and waits for it
 *  to connect — external agents keep their verify-with-snapshot workflow
 *  without anyone manually opening a tab. Launch attempts are rate-limited
 *  so a retrying agent cannot spam tabs; the user can opt out with
 *  --no-open-browser (tests use MOTIONREF_BROWSER_CMD / the disable flag). */
import { randomUUID } from "node:crypto";
import type { RenderRequestMsg, RenderResultMsg, ServerMsg } from "../src/shared/protocol";

const RENDER_TIMEOUT_MS = 10_000;
const LAUNCH_COOLDOWN_MS = 10_000;

export interface RenderClient {
  id: string;
  send(msg: ServerMsg): void;
}

export interface RenderBrokerOptions {
  /** The Web UI URL to open when no browser is connected. */
  uiUrl: string;
  /** Open the Web UI in the system browser (exits headless mode). */
  openUi(): void;
  /** Tests / opt-out: never auto-open and never wait for a browser. */
  autoOpen?: boolean;
  /** How long to wait for a browser to connect after opening one. */
  launchWaitMs?: number;
}

interface Pending {
  resolve: (r: { dataUrl: string } | { error: string }) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class RenderBroker {
  private pending = new Map<string, Pending>();
  private lastLaunchAt = 0;

  constructor(
    private getClients: () => RenderClient[],
    private options: RenderBrokerOptions,
  ) {}

  canAutoOpen(): boolean {
    return this.options.autoOpen !== false;
  }

  /** Feed a render.result message from a browser client. */
  handleResult(msg: RenderResultMsg): void {
    const p = this.pending.get(msg.requestId);
    if (!p) return;
    this.pending.delete(msg.requestId);
    clearTimeout(p.timer);
    if (msg.ok && msg.dataUrl) p.resolve({ dataUrl: msg.dataUrl });
    else p.resolve({ error: msg.error ?? "render failed" });
  }

  /** Drop a browser client — outstanding requests fail via their timeout. */
  dropClient(_clientId: string): void {}

  private async waitForClient(ms: number): Promise<boolean> {
    const deadline = Date.now() + ms;
    for (;;) {
      await new Promise((r) => setTimeout(r, 250));
      if (this.getClients().length > 0) return true;
      if (Date.now() >= deadline) return false;
    }
  }

  /** Ensure a render-capable browser exists; opens one when allowed. The
   *  wait budget stays well under the shared tool pipeline's 20s timeout. */
  private async ensureClient(): Promise<boolean> {
    if (this.getClients().length > 0) return true;
    if (this.options.autoOpen === false) return false;
    if (Date.now() - this.lastLaunchAt > LAUNCH_COOLDOWN_MS) {
      this.lastLaunchAt = Date.now();
      console.log(`[snapshot] no Web UI connected — opening ${this.options.uiUrl} in your browser…`);
      try {
        this.options.openUi();
      } catch {
        /* best effort — the unavailable() message says what to do */
      }
    }
    return this.waitForClient(this.options.launchWaitMs ?? 8_000);
  }

  private unavailable(): { error: string } {
    const url = this.options.uiUrl;
    return this.options.autoOpen === false
      ? { error: `snapshot unavailable: no Web UI is connected (auto-open disabled). Open ${url} in a browser and retry; meanwhile verify via get_scene_state.` }
      : { error: `snapshot unavailable: the server opened ${url} in your browser but no Web UI connected in time. Wait a moment and retry (the browser may still be starting); meanwhile verify via get_scene_state.` };
  }

  async render(rev: number, time: number, width: number, height: number): Promise<{ dataUrl: string } | { error: string }> {
    if (this.getClients().length === 0) {
      const ok = await this.ensureClient();
      if (!ok) return this.unavailable();
    }
    const client = this.getClients()[0];
    if (!client) return this.unavailable(); // disconnected again mid-wait
    const requestId = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve({ error: "render timed out — the connected Web UI did not answer in 10s" });
      }, RENDER_TIMEOUT_MS);
      this.pending.set(requestId, { resolve, timer });
      const msg: RenderRequestMsg = { type: "render.request", requestId, rev, time, width, height };
      client.send(msg);
    });
  }
}
