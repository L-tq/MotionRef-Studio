/** Agent tool registry. Every tool has a JSON schema, executes through a
 *  guarded pipeline (validate → run → normalize), and returns text content
 *  (plus optional snapshot payloads the loop forwards as images).
 *
 *  Declarative scene tools reuse the same ScriptTarget used by the sandbox,
 *  so tools and code have identical semantics. */
import { createScriptTarget } from "../core/scripting";
import { cloneDoc, type SceneDocument } from "../core/types";
import { validateSceneDocument } from "../core/validate";
import { AGENT_SKILL_GUIDE } from "./guide";
import type { ToolSchema } from "./llmClient";
import type { SandboxResult } from "./sandbox";
import { getLocale } from "../i18n";

export interface SnapshotPayload {
  dataUrl: string;
  t: number;
  w: number;
  h: number;
}

export interface ToolContext {
  getDoc(): SceneDocument;
  /** Validated apply of a new document to the editor. */
  applyDoc(doc: SceneDocument, label: string): void;
  snapshot(time?: number, width?: number, height?: number): SnapshotPayload;
  runSandbox(code: string): Promise<SandboxResult>;
}

export interface ToolResult {
  text: string;
  isError?: boolean;
  snapshot?: SnapshotPayload;
}

export interface AgentTool {
  name: string;
  description: { en: string; zh: string };
  parameters: object;
  handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

const MAX_RESULT_CHARS = 6000;

function clip(text: string): string {
  return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n…(truncated)` : text;
}

function ok(text: string, snapshot?: SnapshotPayload): ToolResult {
  return { text: clip(text), snapshot };
}

function err(message: string): ToolResult {
  return { text: clip(`ERROR: ${message}`), isError: true };
}

/** Apply a declarative mutation through the shared ScriptTarget. */
function withDoc(ctx: ToolContext, label: string, fn: (target: ReturnType<typeof createScriptTarget>) => void): ToolResult {
  try {
    const draft = cloneDoc(ctx.getDoc());
    const target = createScriptTarget(draft);
    fn(target);
    ctx.applyDoc(target.get(), label);
    return ok("OK");
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

export function buildTools(): AgentTool[] {
  return [
    {
      name: "get_scene_state",
      description: {
        en: "Get the full scene document: objects (id, name, type, params, pose, color), keyframe tracks, camera keys, base camera, duration, fps, onFrame hooks.",
        zh: "获取完整场景文档：对象（id、名称、类型、参数、位姿、颜色）、关键帧轨道、相机关键帧、基础相机、时长、帧率、onFrame 脚本。",
      },
      parameters: { type: "object", properties: {}, additionalProperties: false },
      async handler(_args, ctx) {
        return ok(JSON.stringify(ctx.getDoc(), null, 1));
      },
    },
    {
      name: "set_scene",
      description: {
        en: "Replace the whole scene document. Must be a complete valid SceneDocument (version 1). Use for large rebuilds; prefer granular tools for edits.",
        zh: "整体替换场景文档。必须是完整合法的 SceneDocument（version 1）。大规模重建时使用；小改动请用细粒度工具。",
      },
      parameters: {
        type: "object",
        properties: {
          doc: { type: "object", description: "Complete SceneDocument JSON" },
        },
        required: ["doc"],
        additionalProperties: false,
      },
      async handler(args, ctx) {
        const result = validateSceneDocument(args.doc);
        if ("error" in result) return err(`Invalid scene document: ${result.error}`);
        ctx.applyDoc(result.doc, "agent:set_scene");
        return ok(`Scene replaced: ${result.doc.objects.length} objects, duration ${result.doc.duration}s.`);
      },
    },
    {
      name: "add_object",
      description: {
        en: "Add one geometry object. object: {type, name?, params?, position?, rotation? (radians XYZ), scale?, color? (#rrggbb), visible?}. Returns the new id.",
        zh: "添加一个几何体。object: {type, name?, params?, position?, rotation?（弧度 XYZ）, scale?, color?（#rrggbb）, visible?}。返回新 id。",
      },
      parameters: {
        type: "object",
        properties: {
          object: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["box", "sphere", "cylinder", "cone", "torus", "plane", "capsule", "ring", "tetrahedron", "octahedron", "dodecahedron", "icosahedron", "torusKnot"] },
              name: { type: "string" },
              params: { type: "object", additionalProperties: { type: "number" } },
              position: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 },
              rotation: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 },
              scale: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 },
              color: { type: "string" },
              visible: { type: "boolean" },
            },
            required: ["type"],
          },
        },
        required: ["object"],
        additionalProperties: false,
      },
      async handler(args, ctx) {
        let newId = "";
        const result = withDoc(ctx, "agent:add_object", (target) => {
          newId = target.add(args.object as Parameters<typeof target.add>[0]);
        });
        if (result.isError) return result;
        return ok(`Added object id "${newId}".`);
      },
    },
    {
      name: "update_object",
      description: {
        en: "Patch an object by id: name?, params?, position?, rotation?, scale?, color?, visible?. Unspecified properties are kept.",
        zh: "按 id 修改对象：name?、params?、position?、rotation?、scale?、color?、visible?。未指定的属性保持不变。",
      },
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          params: { type: "object", additionalProperties: { type: "number" } },
          position: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 },
          rotation: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 },
          scale: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 },
          color: { type: "string" },
          visible: { type: "boolean" },
        },
        required: ["id"],
        additionalProperties: false,
      },
      async handler(args, ctx) {
        const { id, ...patch } = args;
        const before = ctx.getDoc().objects.find((o) => o.id === id)?.name;
        const result = withDoc(ctx, "agent:update_object", (target) => {
          target.update(id as string, patch as Parameters<typeof target.update>[1]);
        });
        if (result.isError) return result;
        return ok(`Updated "${before ?? id}".`);
      },
    },
    {
      name: "remove_object",
      description: {
        en: "Remove an object (and its keyframes) by id.",
        zh: "按 id 删除对象（连同其关键帧）。",
      },
      parameters: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
      async handler(args, ctx) {
        const result = withDoc(ctx, "agent:remove_object", (target) => {
          target.remove(args.id as string);
        });
        if (result.isError) return result;
        return ok("Removed.");
      },
    },
    {
      name: "set_camera",
      description: {
        en: "Set the BASE camera pose (used when no camera keyframes exist): position [x,y,z], target [x,y,z] (lookAt), fov (vertical degrees, 45≈50mm).",
        zh: "设置基础相机位姿（无相机关键帧时生效）：position [x,y,z]、target [x,y,z]（注视点）、fov（垂直角度，45≈50mm）。",
      },
      parameters: {
        type: "object",
        properties: {
          position: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 },
          target: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 },
          fov: { type: "number" },
        },
        additionalProperties: false,
      },
      async handler(args, ctx) {
        return withDoc(ctx, "agent:set_camera", (target) => {
          target.setCamera(args as Parameters<typeof target.setCamera>[0]);
        });
      },
    },
    {
      name: "add_camera_keyframes",
      description: {
        en: "Append camera keyframes: keys: [{t (s), position?, target?, fov?, interp? (linear|smooth|step)}]. Missing fields inherit from the previous key.",
        zh: "追加相机关键帧：keys: [{t（秒）, position?, target?, fov?, interp?（linear|smooth|step）}]。缺省字段继承上一帧。",
      },
      parameters: {
        type: "object",
        properties: {
          keys: {
            type: "array",
            items: {
              type: "object",
              properties: {
                t: { type: "number" },
                position: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 },
                target: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 },
                fov: { type: "number" },
                interp: { type: "string", enum: ["linear", "smooth", "step"] },
              },
              required: ["t"],
            },
          },
        },
        required: ["keys"],
        additionalProperties: false,
      },
      async handler(args, ctx) {
        const keys = (args.keys ?? []) as Parameters<ReturnType<typeof createScriptTarget>["addCameraKeys"]>[0];
        const result = withDoc(ctx, "agent:camera_keys", (target) => {
          target.addCameraKeys(keys);
        });
        if (result.isError) return result;
        return ok(`Camera now has ${ctx.getDoc().cameraKeys.length} key(s).`);
      },
    },
    {
      name: "add_keyframes",
      description: {
        en: "Append keyframes for an object: keys: [{t (s), position?, rotation?, scale?, color?, visible?, interp?}]. Missing properties inherit from the object's previous key (or base pose for the first key).",
        zh: "为对象追加关键帧：keys: [{t（秒）, position?, rotation?, scale?, color?, visible?, interp?}]。缺省属性继承该对象上一关键帧（首帧继承基础位姿）。",
      },
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" },
          keys: {
            type: "array",
            items: {
              type: "object",
              properties: {
                t: { type: "number" },
                position: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 },
                rotation: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 },
                scale: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 },
                color: { type: "string" },
                visible: { type: "boolean" },
                interp: { type: "string", enum: ["linear", "smooth", "step"] },
              },
              required: ["t"],
            },
          },
        },
        required: ["id", "keys"],
        additionalProperties: false,
      },
      async handler(args, ctx) {
        const result = withDoc(ctx, "agent:keyframes", (target) => {
          target.addKeyframes(args.id as string, args.keys as Parameters<typeof target.addKeyframes>[1]);
        });
        if (result.isError) return result;
        const count = ctx.getDoc().tracks[args.id as string]?.length ?? 0;
        return ok(`Track now has ${count} key(s).`);
      },
    },
    {
      name: "set_timeline",
      description: {
        en: "Set clip duration (seconds, ≤300) and/or export fps (1-120). Set duration BEFORE adding keyframes beyond the current end.",
        zh: "设置片段时长（秒，≤300）和/或导出帧率（1-120）。若关键帧超出当前结尾，请先设置时长。",
      },
      parameters: {
        type: "object",
        properties: {
          duration: { type: "number" },
          fps: { type: "number" },
        },
        additionalProperties: false,
      },
      async handler(args, ctx) {
        return withDoc(ctx, "agent:timeline", (target) => {
          if (typeof args.duration === "number") target.setDuration(args.duration);
          if (typeof args.fps === "number") target.setFps(args.fps);
        });
      },
    },
    {
      name: "snapshot",
      description: {
        en: "Render the SCENE CAMERA (export framing) to an image and look at it to verify the scene. Args: time? (seconds, default current playhead), width?, height? (default derived from the scene aspect ratio, longest edge 1024). The image arrives as your next input message.",
        zh: "用场景相机（导出取景）渲染一张图片并查看以验证场景。参数：time?（秒，默认当前时间轴位置）、width?、height?（默认按场景画面比例推导，长边 1024）。图片将作为你的下一条输入消息。",
      },
      parameters: {
        type: "object",
        properties: {
          time: { type: "number" },
          width: { type: "number" },
          height: { type: "number" },
        },
        additionalProperties: false,
      },
      async handler(args, ctx) {
        const snap = ctx.snapshot(
          typeof args.time === "number" ? args.time : undefined,
          typeof args.width === "number" ? args.width : undefined,
          typeof args.height === "number" ? args.height : undefined,
        );
        return ok(`Snapshot captured at t=${snap.t.toFixed(2)}s (${snap.w}x${snap.h}). The image follows as your next message.`, snap);
      },
    },
    {
      name: "execute_code",
      description: {
        en: "Run JavaScript in the sandbox to build/animate the scene. Global `api`: add/update/remove/clear/get/find/list/keyframes/setCamera/addCameraKeys/setDuration/setFps/setAspect(ratio)/onFrame(fn)/log/params/uniqueName. See the Skill Guide for the full reference. No DOM/network/imports; 5s timeout.",
        zh: "在沙箱中运行 JavaScript 来搭建/动画化场景。全局 `api`：add/update/remove/clear/get/find/list/keyframes/setCamera/addCameraKeys/setDuration/setFps/setAspect(比例)/onFrame(fn)/log/params/uniqueName。完整参考见技能指南。无 DOM/网络/导入；5 秒超时。",
      },
      parameters: {
        type: "object",
        properties: {
          code: { type: "string", description: "JavaScript source. Can be async. Use api.log(...) to print." },
        },
        required: ["code"],
        additionalProperties: false,
      },
      async handler(args, ctx) {
        const code = String(args.code ?? "");
        if (!code.trim()) return err("Empty code");
        const result = await ctx.runSandbox(code);
        if (!result.ok) {
          return err(`${result.error ?? "execution failed"}${result.logs.length ? `\nLogs:\n${result.logs.join("\n")}` : ""}`);
        }
        ctx.applyDoc(result.doc!, "agent:execute_code");
        const doc = ctx.getDoc();
        const lines = [
          `Executed OK. Scene now: ${doc.objects.length} objects, ${Object.keys(doc.tracks).length} tracks, ${doc.cameraKeys.length} camera keys, ${doc.onFrameScripts.length} onFrame hooks.`,
        ];
        if (result.logs.length) lines.push("Logs:", ...result.logs.slice(0, 40));
        if (result.result && result.result !== "undefined") lines.push("Return:", result.result);
        return ok(lines.join("\n"));
      },
    },
  ];
}

let cachedTools: AgentTool[] | null = null;
export function getTools(): AgentTool[] {
  if (!cachedTools) cachedTools = buildTools();
  return cachedTools;
}

/** Convert to OpenAI wire tool schemas, localized. */
export function toWireTools(): ToolSchema[] {
  const locale = getLocale();
  return getTools().map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description[locale],
      parameters: tool.parameters,
    },
  }));
}

/** The system prompt: the Agent Skill Guide in the UI language. */
export function systemPrompt(): string {
  return AGENT_SKILL_GUIDE[getLocale()];
}
