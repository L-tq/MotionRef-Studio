# MotionRef Studio

**A browser-based 3D animation generator driven by a multimodal LLM agent.**
基于多模态大模型智能体驱动的浏览器端 3D 动画生成器。

The scenes it produces use **only basic geometries and solid colors**, and the
rendered clips are meant as **reference videos for AI video-generation models**
(Minimax H3, Seedance 2.5, …). A built-in agent builds and animates scenes from
your prompts and reference images; a full manual editor lets you review, tweak
and override everything it does.

场景仅由**基础几何体与纯色**构成，渲染片段用作 **AI 视频生成模型的参考视频**。内置智能体可根据你的文字与参考图搭建并动画化场景；同时提供完整的手动编辑器，可随时审查、微调或覆盖智能体的工作。

---

## Features / 功能

- 🤖 **Multimodal agent chat** — describe the scene, attach sketches/photos (file, paste, drag, or "attach current view"); watch snapshots stream back as it works; iterate with follow-up text or images.
  **多模态智能体对话** —— 描述场景、附加草图/照片（文件、粘贴、拖拽或“附加当前画面”）；快照实时回流；可继续用文字或图片迭代。
- 🧱 **Manual 3D editing** — add/remove/rename 13 basic geometries, gizmos (move/rotate/scale), inspector for transforms, geometry params and colors, hierarchy panel, undo/redo.
  **手动 3D 编辑** —— 13 种基础几何体的增删改、变换手柄、属性检查器、层级面板、撤销/重做。
- 🪟 **Collapsible layout** — small triangle tabs on the viewport edges toggle the left, right, and timeline panels; panel sizes and visibility are remembered.
  **可折叠布局** —— 视口边缘的小三角形按钮可收起/展开左、右面板与时间线，面板尺寸与可见性会自动记忆。
- 🎥 **Camera control** — multiple scene cameras with an active one (Blender-style: the active camera is what preview/snapshot/export render), camera-cut markers on the timeline (the view hard-cuts to each marker's camera from its time until the next marker — during preview *and* export), FOV ↔ 35mm focal-length conversion, position/target, per-camera keyframes on the timeline and in the graph editor, editor frustum markers for every camera, live "scene camera preview" (exact export framing).
  **相机控制** —— 多场景相机 + 活动相机（Blender 风格：预览/快照/导出始终渲染活动相机）、时间轴镜头切换标记（从标记时刻起硬切到其相机，预览与导出一致）、FOV 与 35mm 焦距换算、位置/注视点、时间轴与曲线编辑器中的分相机关键帧、每台相机的编辑器取景线框、实时取景预览。
- ⏱ **Timeline** — per-object keyframes (position/rotation/scale/color/visibility, linear/smooth/step interpolation), draggable keys, playhead scrubbing, auto-key recording (● Add & Replace / Replace modes: transform an object while the timeline plays and every swept frame gets a key; a recording pass stops at the end instead of looping).
  **时间轴** —— 每对象关键帧（位置/旋转/缩放/颜色/可见性，linear/smooth/step 插值）、可拖动关键帧、播放头擦洗、自动关键帧录制（● 添加并替换 / 仅替换：播放中直接拖动物体即可逐帧录制关键帧；录制播放到末尾自动停止，不循环）。
- 🎬 **Action editor** — Blender-style actions: keyframes live in named actions owned by one object or camera; each owner has one ACTIVE action (what plays/edits) and different owners' active actions play simultaneously. Manage create/duplicate/rename/delete/activate in the new bottom-panel editor, with an editable dopesheet of every action's channel summary (keys stay draggable/deletable, even on non-active actions).
  **动作编辑器** —— Blender 风格的动作：关键帧保存在命名动作中，每个动作属于一个对象或相机；每个所有者有一个“活动动作”（参与播放/编辑），不同所有者的活动动作同时播放。在底部面板的新编辑器中创建/复制/重命名/删除/切换动作，可查看所有动作的通道摘要（关键帧仍可拖动/删除，非活动动作也可以）。
- 📈 **Curve graph editor** — per-channel value curves with box selection (drag on empty space, Shift adds), Select all / Deselect all buttons, multi-key drag in time and value, per-axis Delete/retime (moving or deleting e.g. Position X leaves every other axis and property keyed where it was), and Gaussian smoothing (≈, adjustable σ) applied to exactly the selected points.
  **曲线图表编辑器** —— 按通道显示数值曲线，支持框选（空白处拖动，Shift 追加）、全选/取消全选按钮、多关键点整体调整时间与数值、按轴删除/改时间（移动或删除如位置 X 不影响其他轴和其他属性的关键帧），以及高斯平滑（≈，σ 可调，仅作用于选中的关键点）。
- ⌨ **Sandboxed scripting** — the agent and you share one Scripting API (`api.add(...)`, `api.keyframes(...)`, `api.onFrame((t, f) => ...)`) running in a Web Worker sandbox (no DOM/network, 5s timeout).
  **沙箱脚本** —— 智能体与你共用一套脚本 API，运行于 Web Worker 沙箱（无 DOM/网络，5 秒超时）。
- 🎬 **Deterministic video export** — frame-by-frame offscreen rendering at fixed timestep → MP4 (H.264 when supported) or WebM fallback; 16:9 / 9:16 / 1:1 presets.
  **确定性视频导出** —— 固定时间步的逐帧离屏渲染 → 优先 MP4（H.264），否则 WebM；16:9 / 9:16 / 1:1 预设。
- 💾 **Projects** — save/load to browser localStorage, export/import scene JSON.
  **项目管理** —— 本地保存/加载，场景 JSON 导入/导出。
- 🌐 **Fully bilingual UI (EN / 简体中文)** — including the embedded Agent Skill Guide.
  **完整中英双语界面** —— 包括内置的智能体技能指南。

## Quick start / 快速开始

```bash
npm install
npm run dev        # open the printed URL
```

On first visit you'll be asked for your **multimodal LLM** connection (any
OpenAI-compatible endpoint — DeepSeek, Zhipu GLM-4.xV, OpenRouter, OpenAI,
vLLM, Ollama, …):

- **Base URL** — e.g. `https://api.deepseek.com` (a `/v1` suffix is handled automatically)
- **API key** — stored only in your browser's localStorage, sent per-request
- **Model** — must support vision (images), e.g. `glm-4.5v`, `deepseek-vl2`, `gpt-4o`
- **Connection** — *Vercel proxy* (default; avoids CORS) or *direct*

No key handy? Pick **Mock (offline demo)** to watch the full agent pipeline
build a demo scene without any network.

首次访问会要求连接你的**多模态大模型**（任意 OpenAI 兼容接口）。密钥仅存于浏览器 localStorage；也可选择**模拟（离线演示）**体验完整流程。

## Deploy to Vercel / 部署到 Vercel

```bash
npm i -g vercel
vercel          # preview
vercel --prod   # production
```

The repo is a plain Vite app plus one edge function (`api/llm.ts`) used as a
dumb passthrough proxy when "Vercel proxy" connection mode is selected. The
proxy forwards `{baseUrl, apiKey, path, payload}` to your endpoint and streams
the SSE response back; it stores nothing. (Or import the repo in the Vercel
dashboard — framework preset is auto-detected.)

## Local Studio Mode (external agents via MCP) / 本地工作室模式（MCP 外部智能体）

Besides the browser-only deployment, you can run MotionRef Studio as a **local
studio server** that owns the scene document and exposes an **MCP endpoint**,
so your own coding agent — ZCode, Claude Code, Codex, OpenCode, DeepSeek
Harness — can drive it headlessly while you watch and hand-edit in the Web UI:

```bash
npm run studio                  # build + serve the Web UI + MCP on 127.0.0.1:8787
npm run studio:serve            # skip the build step
npm run studio -- --workspace /path/to/agent-workspace   # where projects are saved
npm run studio:dev              # vite (HMR) + studio server side by side
```

**本地工作室模式**：`npm run studio` 启动本地服务器（默认 `127.0.0.1:8787`），它拥有场景文档、撤销历史与编辑锁，通过 MCP 端点供外部编码智能体（ZCode、Claude Code、Codex、OpenCode、DeepSeek Harness）驱动；同时提供完整 Web UI 供查看与手动编辑。

### How it fits together / 工作方式

- **One execution path.** The built-in agent's tool calls are relayed to the
  server and run through the *same* tool registry + guarded pipeline the MCP
  endpoint uses; the system prompt is the *same Agent Skill Guide* (only the
  header/footer adapt to the runtime). Internal and external agents behave
  identically by construction. **内置与外部智能体共用同一条工具执行管线与同一份技能指南，行为天然一致。**
- **Server-authoritative.** The browser tab is a synced client: your edits
  apply optimistically and are confirmed by the server; every writer shares
  one validated document and one undo history. **服务器为唯一权威，浏览器是同步客户端。**
- **Single-writer edit lock.** While an agent is editing, other agents and
  other tabs are **view-only** (a banner says who holds the lock; reads,
  playback and scrubbing always work). Waiting writers retry for a few
  seconds, crashed holders are reclaimed by an idle timeout, and "Force
  unlock" is the escape hatch. **任一智能体编辑时，其他智能体与用户均为只读；空闲超时自动回收，可强制解锁。**
- **Projects are workspace files.** Each project is a `.mrsproj.json` bundle
  in the workspace (default `--workspace`, else `~/.motionref-studio/projects`);
  the stdio bridge adopts the launching agent's working directory on first
  contact. Manually created projects — and Save on an unsaved scene — prompt
  for a name and save directory. External agents can see and version these
  files next to their code. **项目保存为工作区中的 JSON 文件，可与智能体代码一起版本管理。**
- **Snapshots render in the browser — headless agents auto-exit headless.**
  WebGL rendering only exists in the Web UI, so the `snapshot` tool relays to
  a connected tab; when none is connected the server **opens one in your
  default browser automatically** and waits for it (opt out with
  `--no-open-browser`) — the first headless snapshot takes a few extra
  seconds while the browser starts. The image comes back as MCP image
  content *and* a file under `<workspace>/.motionref/snapshots/`.
  **快照由浏览器渲染；无浏览器时服务器会自动打开一个（`--no-open-browser` 可关闭），首个快照会多等几秒。**

### Connecting an external agent / 接入外部智能体

The server prints its URLs at startup; the token lives in
`~/.motionref-studio/config.json`, and Settings → **External Agents (MCP)** in
the Web UI shows copy-paste snippets with the token filled in:

| Agent | Config |
| --- | --- |
| ZCode | `mcp.json`: `{"mcpServers": {"motionref": {"url": "http://127.0.0.1:8787/mcp", "headers": {"Authorization": "Bearer <token>"}}}}` |
| Claude Code | `claude mcp add --transport http motionref http://127.0.0.1:8787/mcp --header "Authorization: Bearer <token>"` |
| Codex | `~/.codex/config.toml`: `[mcp_servers.motionref]` with `url` + `http_headers` |
| OpenCode | `opencode.json`: `{"mcp": {"motionref": {"type": "remote", "url": "...", "headers": {...}}}}` |
| DeepSeek Harness / any stdio client | `npm run mcp` (stdio bridge; also `--url`/`--token`) |

Security posture: the server binds `127.0.0.1` only, `/mcp` requires the
bearer token, `/studio/*` and the WebSocket refuse foreign origins, and the
LLM proxy port of `api/llm.ts` is unchanged. 服务器仅监听环回地址，MCP 需要令牌，跨源请求被拒绝。

## Agent architecture / 智能体架构

Inspired by the lightweight core of
[deepseek-harness](https://github.com/deepseek-ai/deepseek-harness):

- **Step** = one model request + the tools it calls; **turn** = steps until the model stops calling tools.
- **Wire log** — append-only OpenAI-format history projected into each request.
- **Tool registry** — JSON-schema tools executed through a guarded pipeline (unknown tool / bad JSON args / 20s timeout / thrown errors all normalize to `isError` results).
- **Sandbox seam** — `execute_code` runs in a Web Worker against a mirrored scene document; the result is committed atomically (terminate + respawn on timeout).
- **Agent Skill Guide** — a bilingual, in-app document (see Settings → preview) that becomes the system prompt and teaches the agent the tools, the Scripting API, animation semantics and the verify-with-snapshots workflow.

Tools: `get_scene_state`, `set_scene`, `add_object`, `update_object`,
`add_camera`, `set_active_camera`, `set_camera`, `manage_action`, `manage_marker`, `add_camera_keyframes`, `add_keyframes`,
`set_timeline`, `snapshot` (image feedback), `execute_code`.

## Keyboard shortcuts / 快捷键

| Key | Action |
| --- | --- |
| `Q` / `W` / `E` / `R` | select / move / rotate / scale gizmo |
| `Space` | play / pause |
| `K` | set object keyframe at playhead |
| `C` | set camera keyframe at playhead |
| `M` | add camera-cut marker at playhead |
| `F` | frame selection |
| `Shift+F` | walk mode (Blender-style first-person navigation) |
| `Delete` | delete selected object / selected keyframe |
| `Ctrl+Z` / `Ctrl+Shift+Z` | undo / redo |
| `Ctrl+Enter` (script console) | run code |

Walk mode: `W/A/S/D` move on the ground plane, `Q/E` move down/up, mouse looks around (pointer lock), `Shift` slows down, scroll wheel or `+/−` changes speed while moving, `Esc` exits. In scene camera preview, walk flies the scene camera itself (like Blender): left click confirms the new camera pose into the document, right click cancels. The viewport also has a Blender-style navigation gizmo (top-right, Z-up labels): hover an axis dot for its name, click to snap to that view (the dim blue dot for bottom). The gizmo presents Blender's Z-up convention — the scene document itself stays Y-up.

## Notes / 说明

- Solid colors only — the renderer uses untextured `MeshStandardMaterial` and simple lighting; grid/gizmos are editor-only and excluded from snapshots/exports.
- Exports are rendered offscreen at the chosen resolution with a fixed timestep, independent of the viewport size.
- The image cap per message is a setting (default 8) — raise it to match your provider.
- In the default (Vercel/browser-only) deployment nothing about your scenes or keys is sent anywhere except the LLM endpoint you configure. Local Studio Mode additionally keeps everything on your machine: the server binds to `127.0.0.1` and project files stay in your workspace.

## License

AGPL-3.0 — see [LICENSE](./LICENSE).
