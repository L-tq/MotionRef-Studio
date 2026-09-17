# Local Studio Mode — server-authoritative local deployment with MCP for external agents

## Design summary

Add a second deployment mode: a local Node **studio server** (`npm run studio`) that **owns the scene state** and runs the agent tool pipeline server-side (headless — external agents work with no browser open). It (1) serves the Web UI at `http://127.0.0.1:8787`, which becomes a **synced client** for viewing and manual editing, and (2) hosts an **MCP server** for external agents (ZCode, Claude Code, Codex, OpenCode, DeepSeek Harness). Projects persist as **JSON files in the external agent's workspace**; manually created projects prompt for a save directory.

**Consistency guarantee:** the built-in agent's tool calls are relayed to the server and execute through the **same `runTool` registry the MCP endpoint uses**, and both system prompts are built from the **same Skill Guide body** (only header/footer vary). One execution path, one authority, one undo history.

**Concurrency model (single writer):** an **edit lock** on the server ensures that while one writer (built-in agent turn, external agent tool-burst, or user editing session) is active, **all other agents and browser tabs are view-only**. Reads (`get_scene_state`, `snapshot`, playback/scrubbing/selection) always work for everyone.

The browser-only (Vercel) deployment is untouched — client mode is dormant unless `/studio/info` answers.

## Architecture

```
External agent                Browser tab(s) (Web UI client)
   │ MCP stdio shim (cwd = workspace)   │ WebSocket (doc sync, edits, tool relay)
   │        or Streamable HTTP          ▼
   └──────────────► ┌────────────────────────────────────────┐
                    │ Studio server (Node, 127.0.0.1:8787)   │
                    │  AUTHORITY: StudioSession               │
                    │  - SceneDocument + rev + undo/redo      │
                    │  - EDIT LOCK (single writer)            │
                    │  - runTool pipeline (shared registry)   │
                    │  - Node sandbox (worker_threads)        │
                    │  - projects on disk (workspace)         │
                    │  - MCP /mcp (token) + stdio shim        │
                    │  - serves dist/ + /api/llm proxy        │
                    │  - snapshot broker → asks a browser     │
                    └────────────────────────────────────────┘
                          writes/reads <workspace>/<Name>.mrsproj.json
```

## Milestone 1 — Node-safe shared agent core (no behavior change)

- **`src/agent/tools.ts` → DOM-free:** move `toWireTools()` and `systemPrompt()` (the only i18n dependents) into a new `src/agent/wire.ts` (imported by `agentLoop.ts`, `SettingsDialog.tsx`). Add `runTool(name, argsJson, ctx)` — the guarded pipeline currently in `agentLoop.executeTool` (unknown tool / bad JSON / 20 s timeout / isError normalization) — so server and browser share one implementation. Add a `readOnly` flag to the tool defs: `true` for `get_scene_state` and `snapshot`, `false` for all 13 mutating tools (drives lock enforcement).
- **`src/agent/guide.ts`:** restructure each locale into `header(builtin|external)` + shared `body` + `footer(builtin|external)`; export `buildAgentGuide(mode, locale)`. Body byte-identical for both agents. External header: "You are an external coding agent driving MotionRef Studio through its MCP tools; a human may be watching the Web UI." External footer adds: single-writer note ("If a tool returns a lock error, the user or another agent is editing — wait a few seconds and retry"); projects are workspace files (use project tools); `snapshot` requires a connected Web UI (verify via `get_scene_state` otherwise). Keep `AGENT_SKILL_GUIDE` as the builtin composition.
- Node-importability enforced by smoke test.

## Milestone 2 — Server session engine (`server/`)

- **`server/session.ts` — `StudioSession` (authority):** current doc + monotonic `rev` + undo/redo mirroring today's store semantics (JSON snapshots, limit 60, label coalescing 700 ms). `apply(doc, label, baseRev?, actor?)` → validate → commit → broadcast `doc.update {rev, doc, label}`.
- **Edit lock (in `server/editLock.ts`):** `holder: {kind: "agent"|"mcp"|"user", id, label}`, sliding expiry, broadcast `lock.state {holder, expiresAt}` / `lock.released` to all clients.
  - *Built-in agent:* browser sends `lock.acquire` at `runAgentTurn` start (label = task name); released in the turn's `finally`. Well-defined begin/end.
  - *External MCP client:* any tool call from the holder **renews** a 15 s sliding window (so snapshot-verify steps between mutations don't drop it); mutating calls from a non-holder **wait up to 5 s** for the lock, then return a clear `isError` busy message. Idle expiry (15 s) auto-releases after a crashed/disconnected agent.
  - *User (browser):* first user mutation acquires a user lock with a 3 s sliding window (renewed by every edit — held through drags, released when idle), so external agents don't mutate mid-drag; agent calls wait-then-busy as above.
  - Server enforces at every mutation point: `doc.apply` from browsers, mutating `runTool` calls, project open/new/save (they rebind the doc). Read-only tools and snapshot rendering never need the lock. Escape hatch: "Force unlock" from the UI badge menu (clears the lock; for a built-in turn it also stops the turn via the existing abort).
- **`server/sandboxNode.ts`:** port of `sandboxWorker.ts` (73 lines, core-only imports) to `worker_threads` — same `FORBIDDEN` denylist, same `new Function("api", …)` wrap, 5 s timeout, atomic mirror-doc commit → `runSandbox(code, doc)`.
- **`server/projects.ts` — workspace project store:** each project = one JSON file in the existing bundle v1 format (`motionref-studio/project`). Workspace resolution: `--workspace` flag → cwd reported by the first-connecting stdio MCP shim (the external agent's working dir) → last-used in `~/.motionref-studio/config.json` → `~/.motionref-studio/projects`. Default path `<workspace>/<Name>.mrsproj.json`; index at `<workspace>/.motionref/index.json`. Atomic writes (tmp+rename), debounced autosave (~800 ms) + save on switch/close. API: `list / open / save / create(name, dir) / delete`.
- **`server/renderBroker.ts`:** `render.request {requestId, rev, time, w, h}` → a connected browser renders via the existing offscreen WebGL path → JPEG data URL; 10 s timeout; no browser → `snapshot` returns `isError` with guidance. Read-only — works regardless of lock.
- **`server/toolRelay.ts`:** serialized invoke queue (25 s cap) shared by MCP and the built-in agent relay; per-source history labels (`mcp:<tool>` / `agent:<tool>`).

## Milestone 3 — HTTP/WS surface

- **`server/index.ts`** (`tsx`, flags `--port 8787 --workspace`): static `dist/` serving (SPA fallback); `GET /studio/info` (same-origin; URLs + WS token); `GET /studio/fs/list?path=` (same-origin, for the save-directory picker); `POST /api/llm` (port of `api/llm.ts` so proxy LLM mode works locally); `/mcp`; `/ws` upgrade. Binds 127.0.0.1 only; token auth from `~/.motionref-studio/config.json`.
- **WS protocol:** `hello{clientId,version}` → `welcome{rev,doc,project,projects,lock,serverVersion,mcpClients}`; server→client `doc.update`, `history.state {canUndo,canRedo}`, `lock.state`/`lock.released`, `presence`, `projects.update`, `render.request`, `tool.result`; client→server `doc.apply{baseRev,doc,label}` (optimistic confirm; rejected with `lock.busy` when the user doesn't hold the lock), `history.undo|redo` (lock-gated), `lock.acquire/release`, `tool.invoke{callId,name,argsJson}` (built-in agent → SAME `runTool`; auto-acquires the agent lock if not held), `render.result`, `projects.{save|open|new|delete}`, `session.status{builtInAgentRunning,locale}`. Multiple browser tabs allowed (doc broadcast; selection/playhead per-tab).

## Milestone 4 — MCP for external agents

- **`server/mcp.ts`** (`@modelcontextprotocol/sdk`): the 15 scene tools with identical names/schemas/descriptions, executed via `runTool` + server ctx with lock enforcement (busy = wait ≤5 s → isError with retry guidance); plus `list_projects`, `open_project{id|path}`, `save_project{name?,path?}`, `new_project{name?,path?}`, `get_status{}` (project, rev, dirty, lock holder, connected browsers, snapshot availability). `snapshot` returns text + MCP `ImageContent` (base64 JPEG) and writes `<workspace>/.motionref/snapshots/snap-<t>.jpg` (path included for text-only agents). `initialize` instructions = `buildAgentGuide("external","en")`; also exposed as resource `motionref://agent-guide`.
- **`server/mcpStdio.ts`** (`npm run mcp`): stdio↔HTTP shim for command-based agent configs; passes `process.cwd()` as the workspace hint on connect.

## Milestone 5 — Browser client mode

- **`src/state/studioLink.ts` (new):** probe `/studio/info` on boot (404 → dormant); connect WS with reconnect backoff; apply `welcome`/`doc.update` (rev-guarded, no echo); forward user edits (`doc.apply`, optimistic — on `lock.busy` rejection roll back to the last confirmed doc and toast); acquire/release the agent lock around built-in agent turns; relay built-in agent tool calls (`tool.invoke` → `tool.result`, same transcript events as today); answer `render.request` via existing `snapshotDataUrl`; track `lock.state`/`presence`.
- **`src/state/store.ts` — authority seam (confined to 3 touch points):** `docAuthority: "local"|"server"` flag set by studioLink. In server mode `mutateDoc` computes the draft as today, applies optimistically, sends `doc.apply` (local past/future unused — server owns history); `undo/redo` relay `history.*`; `applyDoc` same. Autosave + localStorage projects disabled in server mode (boot doc from `welcome`; `projects` fed by `projects.update`; chat transcripts stay in IndexedDB keyed by server project ids, existing task-adoption on first save).
- **View-only mode UI:** while `lock.state` names another holder, show a banner "🔒 <holder> is editing — view only" and disable doc-mutating affordances (gizmos, inspector, timeline key edits, outliner add/delete/rename, script console runs, ChatPanel send, project open/new/save). Playback, scrubbing, selection, snapshots remain active. Undo buttons follow `history.state`. When the lock releases, the UI returns to editable automatically.
- **`src/ui/StudioLinkBadge.tsx`:** TopBar badge — connection state, attached agents, lock holder + "Force unlock" escape hatch, recent external tool-call popover. Projects dialog (server mode) lists workspace projects; **new projects prompt for a save directory** (fs-browse modal, default workspace root). SettingsDialog "External Agents" tab: copy-paste configs for ZCode (mcp.json url+headers), Claude Code (`claude mcp add --transport http … --header …`), Codex (`config.toml [mcp_servers.motionref]`), OpenCode (`opencode.json` remote), DeepSeek Harness (`npm run mcp` stdio shim).

## Build, deps, tests, docs

- Deps: `ws`, `@modelcontextprotocol/sdk`; devDeps: `tsx`, `@types/ws`. Scripts: `"studio"`, `"studio:dev"` (UI proxied to vite :5173 for HMR), `"mcp"`, `"typecheck:server"`. `tsconfig.server.json`: `server/**` + DOM-free shared modules (`src/agent/tools.ts`, `src/agent/guide.ts`, `src/core/*`), lib ES2022 without DOM — enforces Node-safety at type level.
- **`smoke/server.test.mjs`:** ephemeral port + temp workspace + fake WS browser (stubs `render.result` with a 1×1 JPEG); SDK HTTP MCP client: initialize (guide in instructions), `tools/list` (20 tools), `add_object` → `get_scene_state` round-trip, `save_project` → file on disk in bundle format → reopen, invalid `set_scene` rejected, `snapshot` errors clearly with no browser. **Lock tests:** second MCP client's mutating tool busy-errors while the first holds the lock and succeeds after release; user `doc.apply` rejected during an agent hold; lock auto-expires after idle; read-only tools unaffected. Plus Node smoke for `tools.ts`/`buildAgentGuide` imports and `runSandbox("api.add(...)")` via worker_threads.
- **README (EN+zh):** "Local Studio Mode" — quickstart, the five agent configs, single-writer lock behavior, workspace/file layout, security (localhost + token), snapshot-needs-a-browser caveat, phased headless-renderer note.

## Concurrency & risks

One server-side doc; exactly one writer at a time via the edit lock (built-in turn = explicit acquire/release; external agents = 15 s sliding tool-burst window; user = 3 s sliding edit window). Everyone else is view-only with reads always available. Waiting writers block ≤5 s then get a retryable busy error; crashed holders are reclaimed by idle expiry; "Force unlock" is the manual escape hatch. LWW/rev checks remain only as the backstop for the optimistic-edit race window. Main risks: the store authority seam (confined to `mutateDoc`/`undo`/`redo`/`applyDoc`) and the browser-dependent snapshot (phase 2: optional playwright headless renderer reusing the same UI build).

## Out of scope (future)
Optional playwright headless snapshot renderer; fs.watch hot-reload of project files edited directly on disk; server-hosted chat transcripts; multi-workspace servers.