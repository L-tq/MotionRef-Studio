/** Single-writer edit lock.
 *
 *  While one writer (built-in agent turn, external MCP agent tool-burst, or
 *  the user editing in the Web UI) holds the lock, everyone else is view-
 *  only. Locks use sliding expiry so crashed holders are reclaimed: the
 *  built-in agent's lock is renewed on every relayed tool call, MCP agents'
 *  on every tool call, the user's on every edit. Read-only operations never
 *  touch the lock. */
import { LOCK_TTL_MS, LOCK_WAIT_MS, type LockHolder, type LockKind } from "../src/shared/protocol";

export class EditLock {
  private holder: LockHolder | null = null;
  private expiresAt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<(holder: LockHolder | null) => void>();

  constructor() {
    this.tick = this.tick.bind(this);
  }

  onChange(fn: (holder: LockHolder | null) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn(this.holder);
  }

  private tick(): void {
    this.timer = null;
    this.holder = null;
    this.expiresAt = 0;
    this.emit();
  }

  /** Arm/extend the expiry timer for the current holder. */
  private arm(ttlMs: number): void {
    this.expiresAt = Date.now() + ttlMs;
    if (this.timer) clearTimeout(this.timer);
    if (ttlMs > 0) this.timer = setTimeout(this.tick, ttlMs);
  }

  current(): LockHolder | null {
    return this.holder;
  }

  heldBy(id: string): boolean {
    return this.holder !== null && this.holder.id === id;
  }

  /** Acquire if free; returns false when another live holder owns it. */
  acquire(holder: LockHolder, ttlMs = LOCK_TTL_MS[holder.kind]): boolean {
    if (this.holder && this.holder.id !== holder.id && Date.now() < this.expiresAt) return false;
    this.holder = holder;
    this.arm(ttlMs);
    this.emit();
    return true;
  }

  /** Extend this holder's window (no-op for anyone else, no broadcast). */
  renew(id: string, ttlMs: number): boolean {
    if (!this.heldBy(id)) return false;
    this.arm(ttlMs);
    return true;
  }

  release(id: string): boolean {
    if (!this.heldBy(id)) return false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.holder = null;
    this.expiresAt = 0;
    this.emit();
    return true;
  }

  /** Escape hatch ("Force unlock" in the UI). */
  releaseAll(): LockHolder | null {
    const prev = this.holder;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.holder = null;
    this.expiresAt = 0;
    if (prev) this.emit();
    return prev;
  }

  /** Drop a holder's lock when its connection dies. */
  releaseOwner(id: string): void {
    this.release(id);
  }

  /** Acquire or wait up to LOCK_WAIT_MS for the current holder to finish.
   *  Used by agent tool calls so brief user edits don't fail them outright. */
  async acquireAndWait(holder: LockHolder, ttlMs = LOCK_TTL_MS[holder.kind]): Promise<boolean> {
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      if (this.acquire(holder, ttlMs)) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /** Lock-busy message fed back to agents so they retry instead of failing. */
  static busyMessage(holder: LockHolder | null): string {
    const who = holder ? `${holder.label} (${holder.kind})` : "another writer";
    return `ERROR: scene is locked — ${who} is editing. Wait a few seconds and retry.`;
  }
}

export type { LockKind };
