/** Embedded status display for the studio server's own terminal.
 *
 *  Shows who is using MotionRef right now — above all who holds the edit
 *  lock — plus connected agents/tabs and a rolling activity feed, without
 *  flooding the terminal with log lines.
 *
 *  Interactive TTY (default): an ink panel is pinned at the bottom of the
 *  terminal; the server's console.log output prints above it (ink's
 *  patchConsole). Piped stdout (`studio:dev` under concurrently, tests) or
 *  `--no-tui` / MOTIONREF_NO_TUI=1: one `[studio] HH:MM:SS` line per state
 *  transition instead. MOTIONREF_FORCE_TUI=1 renders the panel even when
 *  piped — the smoke test asserts on the rendered output. */
import type { LockHolder, ProjectInfo } from "../src/shared/protocol";

export interface StatusSnapshot {
  version: string;
  uiUrl: string;
  workspace: string;
  project: ProjectInfo | null;
  rev: number;
  canUndo: boolean;
  canRedo: boolean;
  lock: LockHolder | null;
  heldSince: number | null;
  /** External agent client names (MCP initialize clientInfo). */
  mcpLabels: string[];
  browsers: number;
  /** Web UI tabs with a built-in agent turn running. */
  agentTurns: number;
  lastEdit: { rev: number; label: string; source: string } | null;
}

export interface StatusEvent {
  t: number;
  text: string;
}

export interface StatusDisplayOptions {
  getSnapshot(): StatusSnapshot;
  onForceUnlock(): void;
  onOpenUi(): void;
  onQuit(): void;
}

export interface StatusDisplay {
  /** Feed the current state; diffs against the previous call and surfaces
   *  what changed (panel event feed in TUI mode, one line per transition in
   *  line mode). Cheap — call it on every state change. */
  touch(): void;
  /** Restore the terminal (TUI mode) before shutdown. */
  stop(): void;
}

function describeHolder(h: LockHolder): string {
  return `${h.label} (${h.kind})`;
}

function diffEvents(prev: StatusSnapshot | null, next: StatusSnapshot): StatusEvent[] {
  if (!prev) return [];
  const out: StatusEvent[] = [];
  const add = (text: string) => out.push({ t: Date.now(), text });

  const lockChanged =
    !!next.lock !== !!prev.lock ||
    (!!next.lock &&
      !!prev.lock &&
      (next.lock.id !== prev.lock.id || next.lock.kind !== prev.lock.kind || next.lock.label !== prev.lock.label));
  if (next.lock && lockChanged) {
    const takeover = prev.lock ? ` (took over from ${describeHolder(prev.lock)})` : "";
    add(`lock acquired — ${describeHolder(next.lock)}${takeover}`);
  }
  if (!next.lock && prev.lock) {
    add(`lock released — ${describeHolder(prev.lock)}`);
  }
  for (const l of next.mcpLabels) if (!prev.mcpLabels.includes(l)) add(`MCP agent connected — ${l}`);
  for (const l of prev.mcpLabels) if (!next.mcpLabels.includes(l)) add(`MCP agent disconnected — ${l}`);
  if (next.browsers > prev.browsers) add(`Web UI tab opened — ${next.browsers} connected`);
  if (next.browsers < prev.browsers) add(`Web UI tab closed — ${next.browsers} connected`);
  if (next.lastEdit && (!prev.lastEdit || prev.lastEdit.rev !== next.lastEdit.rev)) {
    add(`rev ${next.lastEdit.rev} — "${next.lastEdit.label}" (${next.lastEdit.source})`);
  }
  if (prev.project?.id !== next.project?.id) {
    add(next.project ? `project open — ${next.project.name}` : "project closed");
  }
  return out;
}

function hhmmss(t: number): string {
  return new Date(t).toTimeString().slice(0, 8);
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  if (m >= 60) return `${Math.floor(m / 60)}h${m % 60}m`;
  return m > 0 ? `${m}m${String(s % 60).padStart(2, "0")}s` : `${s}s`;
}

/** Keep the tail; paths read better truncated at the start. */
function midTrunc(s: string, max: number): string {
  if (max <= 1 || s.length <= max) return s;
  const half = Math.floor((max - 1) / 2);
  return `${s.slice(0, half)}…${s.slice(s.length - half)}`;
}

function row(label: string, value: string, cols: number): string {
  return `${label.padEnd(10)}${midTrunc(value, Math.max(10, cols - 11))}`;
}

const EVENT_FEED_LINES = 8;

export function createStatusDisplay(opts: StatusDisplayOptions): StatusDisplay {
  const noTui = process.env.MOTIONREF_NO_TUI === "1" || process.argv.includes("--no-tui");
  const forceTui = process.env.MOTIONREF_FORCE_TUI === "1";
  const useTui = !noTui && (forceTui || !!process.stdout.isTTY);

  const events: StatusEvent[] = [];
  let prev: StatusSnapshot | null = null;
  let stopped = false;
  let tuiFailed = false;
  let instance: { unmount(): void } | null = null;

  const touch = (): void => {
    if (stopped) return;
    const next = opts.getSnapshot();
    const fresh = diffEvents(prev, next);
    prev = next;
    if (!fresh.length) return;
    events.push(...fresh);
    if (events.length > 200) events.splice(0, events.length - 200);
    if (!useTui || tuiFailed) {
      for (const e of fresh) console.log(`[studio] ${hhmmss(e.t)} ${e.text}`);
    }
  };

  const stop = (): void => {
    stopped = true;
    try {
      instance?.unmount();
    } catch {
      /* already gone */
    }
    instance = null;
  };

  if (useTui) {
    void startTui(opts, { events, forceInteractive: forceTui })
      .then((inst) => {
        if (stopped) {
          inst.unmount();
          return;
        }
        instance = inst;
      })
      .catch((e) => {
        // Ink failed to load (shouldn't happen) — degrade to line mode and
        // flush what was buffered while the panel was mounting.
        console.error(`status TUI unavailable, falling back to line mode: ${String(e)}`);
        tuiFailed = true;
        for (const ev of events) console.log(`[studio] ${hhmmss(ev.t)} ${ev.text}`);
      });
  }

  return { touch, stop };
}

/** Everything ink lives in here so line mode never loads react/ink (they are
 *  pulled in via a dynamic import; createElement keeps this a plain .ts). */
async function startTui(
  opts: StatusDisplayOptions,
  feed: { events: StatusEvent[]; forceInteractive: boolean },
): Promise<{ unmount(): void }> {
  const [ink, React] = await Promise.all([import("ink"), import("react")]);
  const h = React.createElement;
  const { useState, useEffect } = React;
  const { Box, Text, render, useInput, useStdout } = ink;

  const App = () => {
    const { stdout } = useStdout();
    const cols = Math.max(40, (stdout.columns ?? 80) - 4);
    const [snap, setSnap] = useState<StatusSnapshot>(() => opts.getSnapshot());
    const [events, setEvents] = useState<StatusEvent[]>(() => feed.events.slice(-EVENT_FEED_LINES));
    const [confirmForce, setConfirmForce] = useState(false);

    // Poll rather than push: covers snapshots (live lock duration), the
    // event feed, and events that landed while the panel was mounting.
    useEffect(() => {
      const timer = setInterval(() => {
        setSnap(opts.getSnapshot());
        setEvents(feed.events.slice(-EVENT_FEED_LINES));
      }, 500);
      return () => clearInterval(timer);
    }, []);

    useEffect(() => {
      if (!confirmForce) return;
      const timer = setTimeout(() => setConfirmForce(false), 3000);
      return () => clearTimeout(timer);
    }, [confirmForce]);

    useInput(
      (input, key) => {
        if (key.ctrl && input === "c") {
          opts.onQuit();
          return;
        }
        if (input === "q") opts.onQuit();
        else if (input === "f") {
          if (!snap.lock) return;
          if (confirmForce) {
            setConfirmForce(false);
            opts.onForceUnlock();
          } else {
            setConfirmForce(true);
          }
        } else if (input === "o") opts.onOpenUi();
      },
      { isActive: !!process.stdin.isTTY },
    );

    const held = snap.lock && snap.heldSince ? ` · held ${formatDuration(Date.now() - snap.heldSince)}` : "";
    const projectText = snap.project
      ? `${snap.project.name} · rev ${snap.rev} · undo ${snap.canUndo ? "available" : "—"}`
      : `rev ${snap.rev}${snap.canUndo ? " · undo available" : ""}`;
    const clientsText =
      `MCP ${snap.mcpLabels.length}${snap.mcpLabels.length ? ` (${snap.mcpLabels.join(", ")})` : ""}` +
      ` · Web UI ${snap.browsers} tab${snap.browsers === 1 ? "" : "s"}` +
      ` · agent turns ${snap.agentTurns}`;
    const footer = confirmForce
      ? `Force-unlock ${snap.lock?.label ?? "holder"}? press f again to confirm`
      : "f force-unlock · o open Web UI · q quit";

    return h(
      Box,
      { flexDirection: "column", borderStyle: "round", borderColor: snap.lock ? "red" : "gray", paddingX: 1 },
      h(
        Box,
        { key: "head", justifyContent: "space-between" },
        h(Text, { key: "t", bold: true, color: "cyan" }, `MotionRef Studio ${snap.version}`),
        h(Text, { key: "u", dimColor: true }, snap.uiUrl),
      ),
      h(Text, { key: "p" }, row("Project", projectText, cols)),
      h(Text, { key: "w" }, row("Workspace", snap.workspace, cols)),
      snap.lock
        ? h(
            Text,
            { key: "l" },
            h(Text, { key: "dot", color: "red" }, "● "),
            `${"Lock".padEnd(8)}${describeHolder(snap.lock)}${held}`,
          )
        : h(Text, { key: "l", color: "green" }, `${"Lock".padEnd(8)}○ free`),
      h(Text, { key: "c" }, row("Clients", clientsText, cols)),
      h(
        Box,
        { key: "ev", flexDirection: "column", marginTop: 1 },
        h(Text, { key: "h", bold: true }, "Activity"),
        events.length === 0
          ? h(Text, { key: "q", dimColor: true }, "(quiet)")
          : events.map((e, i) =>
              h(
                Text,
                { key: i },
                h(Text, { key: "ts", dimColor: true }, `${hhmmss(e.t)} `),
                e.text,
              ),
            ),
      ),
      h(
        Text,
        { key: "f", dimColor: !confirmForce, color: confirmForce ? "yellow" : undefined },
        footer,
      ),
    );
  };

  // Ctrl+C must NOT kill the process directly — the server owns graceful
  // shutdown (project save); it arrives as useInput(key.ctrl+c) instead.
  // forceInteractive: MOTIONREF_FORCE_TUI on a piped stdout — ink's default
  // non-interactive mode never writes frames while running (only at unmount),
  // so the panel would stay invisible for a long-lived server.
  return render(h(App), {
    exitOnCtrlC: false,
    patchConsole: true,
    interactive: feed.forceInteractive || undefined,
  });
}
