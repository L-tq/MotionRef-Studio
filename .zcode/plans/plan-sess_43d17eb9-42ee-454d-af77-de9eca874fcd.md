# Plan: Download / Upload project session (scene + chat history)

Add a portable project-bundle file format and toolbar buttons to download/upload it, plus notes distinguishing "Save" (browser storage) from "Download to disk".

## Bundle format

A new JSON file (extension `.project.json`), distinct from the existing scene-only `.json`:

```json
{
  "format": "motionref-studio/project",
  "version": 1,
  "exportedAt": 1694880000000,
  "project": { "name": "Bouncing Ball" },
  "doc": { …full SceneDocument… },
  "sessions": [ { …ChatSessionRecord… }, … ]
}
```

- `doc` = `cloneDoc(state.doc)` (the working scene).
- `sessions` = `await listSessions(state.projectId)` from `chatPersist.ts` — already DESC by `updatedAt`, events capped at 200 (matches what's persisted, so the round trip is lossless).
- We do **not** serialize `wireLog`, `taskStates`, `taskSteps`, or `activeTaskId` — none are persisted; `wireLog` is rebuilt from events, and the active task is recomputed as `records[0]` on load.

## New store actions (`src/state/store.ts`)

Add to `AppActions` and implement (mirroring `saveProject`/`loadProject`):

1. **`exportProjectBundle(): Promise<{ filename: string; blob: Blob } | { error: string }>`**
   - Gather `cloneDoc(get().doc)` + `await listSessions(get().projectId)`.
   - Build the bundle object, `JSON.stringify(…, null, 2)`, wrap in a `Blob`.
   - Return `{ filename: \`${doc.name || "project"}\`.project.json\`, blob }`.
   - Errors (e.g. none) → `{ error }`.
   - Import `listSessions` from `./chatPersist` (store already imports `putSession`).

2. **`importProjectBundle(parsed: unknown): Promise<{ ok: true; name: string } | { error: string }>`**
   - Validate shape: `parsed.format === "motionref-studio/project"`, `parsed.doc` is an object, `parsed.sessions` is an array; each session has a string `id` and array `events`.
   - Validate the doc half with `validateSceneDocument(parsed.doc)` (reuse `src/core/validate.ts`).
   - **Non-destructive, collision-safe restore:** generate a fresh project id `newId("p")` and a fresh session id `newId("s")` for every bundled session; remap each session's `projectId` to the new project id. (Keeps session ids unique across re-imports so a second import never overwrites the first project's chat — a real corruption risk if ids were reused.)
   - Build a `ProjectEntry { id, name: parsed.project.name || doc.name || "Imported", savedAt: Date.now(), doc: validatedDoc }`, prepend to `projects` (cap 50), write `mrs.projects` to localStorage.
   - `await Promise.all(remappedSessions.map(putSession))` — the only IndexedDB writes needed; binding is just the `projectId` field on each record.
   - Apply the scene via `mutateDoc("import-project", draft => Object.assign(draft, validatedDoc))` (pushes current scene to undo history, like the existing `importJson`).
   - `get().setProjectId(newId)` → writes `mrs.currentProject`; the `agentLoop` subscription (`store.ts` / `agentLoop.ts`) fires `loadProjectTasks(newId)`, which reads the just-inserted sessions from IndexedDB and populates `tasks`/`taskEvents`/`activeTaskId`. (Relies on the earlier fix where `setProjectId` no longer wipes tasks — `loadProjectTasks` fully replaces them.)

## TopBar UI (`src/ui/TopBar.tsx`)

Add two buttons after the existing Import/Export JSON buttons, behind a divider, mirroring the inline-handler pattern already there:

- `⬇ Export Project` (title `topbar.exportProject`) → `const r = await useStore.getState().exportProjectBundle(); if ("error" in r) showToast(\`error.invalidProjectBundle|${r.error}\`); else downloadBlob(r.blob, r.filename), showToast("notice.projectExported")`. Reuse the already-imported `downloadBlob`.
- `⬆ Import Project` (title `topbar.importProject`) → a second hidden `<input type="file" accept="application/json,.json">` (or reuse `fileRef` with a discriminating flag) → read `file.text()`, `JSON.parse`, call `importProjectBundle`, toast `notice.projectImported|<name>` on success or `error.invalidProjectBundle|<msg>` on failure. Reset `e.target.value=""` after.

Tooltips updated to make the distinction explicit:
- `💾 Save` → `topbar.save` clarified: "Save the scene + chat to this browser's storage (stays on this device)."
- `⬇ Export JSON` → "Download only the scene (no chat) as JSON."
- `⬇ Export Project` → "Download the scene AND chat history as a portable file."
- `⬆ Import JSON` / `⬆ Import Project` → symmetric wording.

## Explanatory note (`src/ui/ProjectsModal.tsx`)

Add a concise `.hint` paragraph in the modal footer (bilingual) so the contrast is documented where saved projects are listed:

> "Projects saved with 💾 Save live in this browser (localStorage + IndexedDB) and stay on this device. To back up or move a project — including its chat history — to another device or disk, use ⬇ Export Project / ⬆ Import Project in the toolbar."

## i18n (`src/i18n/en.ts` + `src/i18n/zh.ts`)

Add to both dictionaries (en is source of truth):
- `topbar.exportProject`, `topbar.importProject` (button tooltips)
- `notice.projectExported`, `notice.projectImported` (toasts; `projectImported` takes `{name}`)
- `error.invalidProjectBundle` (toast with `{msg}`, auto-classified as error by `showToast`)
- `projects.storageNote` (the footer explanatory note)
- Clarify `topbar.save` wording (already exists — update text)

Follow the existing dotted-key + pipe-arg toast convention (`translateMessage` in `i18n/index.ts`).

## Files touched
- `src/state/store.ts` — 2 new actions (interface + impl) + import `listSessions`.
- `src/ui/TopBar.tsx` — 2 buttons + handlers + hidden input + tooltip text.
- `src/ui/ProjectsModal.tsx` — footer note.
- `src/i18n/en.ts`, `src/i18n/zh.ts` — new keys + updated `topbar.save`.

## Verify
- Typecheck (`tsc -p tsconfig.app.json --noEmit`) + `npm run build`.
- Browser: send a mock chat message → Export Project → confirm file downloads with the chat events inside → clear browser data → Import Project → confirm the scene AND the 8 chat messages restore and are bound to a new project. Confirm scene-only Export/Import JSON still works unchanged.