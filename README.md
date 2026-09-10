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
- 🎥 **Camera control** — FOV ↔ 35mm focal-length conversion, position/target, camera keyframes on the timeline, live "scene camera preview" (exact export framing).
  **相机控制** —— FOV 与 35mm 焦距换算、位置/注视点、时间轴上的相机关键帧、实时取景预览。
- ⏱ **Timeline** — per-object keyframes (position/rotation/scale/color/visibility, linear/smooth/step interpolation), draggable keys, playhead scrubbing, auto-key.
  **时间轴** —— 每对象关键帧（位置/旋转/缩放/颜色/可见性，linear/smooth/step 插值）、可拖动关键帧、播放头擦洗、自动关键帧。
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

## Agent architecture / 智能体架构

Inspired by the lightweight core of
[deepseek-harness](https://github.com/deepseek-ai/deepseek-harness):

- **Step** = one model request + the tools it calls; **turn** = steps until the model stops calling tools.
- **Wire log** — append-only OpenAI-format history projected into each request.
- **Tool registry** — JSON-schema tools executed through a guarded pipeline (unknown tool / bad JSON args / 20s timeout / thrown errors all normalize to `isError` results).
- **Sandbox seam** — `execute_code` runs in a Web Worker against a mirrored scene document; the result is committed atomically (terminate + respawn on timeout).
- **Agent Skill Guide** — a bilingual, in-app document (see Settings → preview) that becomes the system prompt and teaches the agent the tools, the Scripting API, animation semantics and the verify-with-snapshots workflow.

Tools: `get_scene_state`, `set_scene`, `add_object`, `update_object`,
`remove_object`, `set_camera`, `add_camera_keyframes`, `add_keyframes`,
`set_timeline`, `snapshot` (image feedback), `execute_code`.

## Keyboard shortcuts / 快捷键

| Key | Action |
| --- | --- |
| `Q` / `W` / `E` / `R` | select / move / rotate / scale gizmo |
| `Space` | play / pause |
| `K` | set object keyframe at playhead |
| `C` | set camera keyframe at playhead |
| `F` | frame selection |
| `Delete` | delete selected object / selected keyframe |
| `Ctrl+Z` / `Ctrl+Shift+Z` | undo / redo |
| `Ctrl+Enter` (script console) | run code |

## Notes / 说明

- Solid colors only — the renderer uses untextured `MeshStandardMaterial` and simple lighting; grid/gizmos are editor-only and excluded from snapshots/exports.
- Exports are rendered offscreen at the chosen resolution with a fixed timestep, independent of the viewport size.
- The image cap per message is a setting (default 8) — raise it to match your provider.
- Browser-only app; nothing about your scenes or keys is sent anywhere except the LLM endpoint you configure.

## License

MIT
