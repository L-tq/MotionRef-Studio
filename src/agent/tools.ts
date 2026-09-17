/** Agent tool registry. Every tool has a JSON schema, executes through a
 *  guarded pipeline (validate → run → normalize), and returns text content
 *  (plus optional snapshot payloads the loop forwards as images).
 *
 *  Declarative scene tools reuse the same ScriptTarget used by the sandbox,
 *  so tools and code have identical semantics.
 *
 *  This module must stay DOM-free: the Node studio server imports the same
 *  registry + runTool() pipeline so built-in and external agents execute
 *  through ONE implementation. Locale-dependent helpers live in wire.ts. */
import { createScriptTarget } from "../core/scripting";
import { cloneDoc, type SceneDocument } from "../core/types";
import { validateSceneDocument } from "../core/validate";
import type { SandboxResult, ToolSchema } from "./types";

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
  /** Async so the studio server can relay rendering to a browser client. */
  snapshot(time?: number, width?: number, height?: number): Promise<SnapshotPayload>;
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
  /** Read-only tools (get_scene_state, snapshot) never mutate the document
   *  and therefore skip the studio server's edit lock. */
  readOnly?: boolean;
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
      readOnly: true,
      description: {
        en: "Get the full scene document: objects (id, name, type, params, pose, color, collectionId), collections, markers (camera cuts), keyframe tracks, camera keys, cameras + activeCameraId, duration, fps, onFrame hooks.",
        zh: "获取完整场景文档：对象（id、名称、类型、参数、位姿、颜色、collectionId）、集合、标记（镜头切换）、关键帧轨道、相机关键帧、相机列表 + activeCameraId、时长、帧率、onFrame 脚本。",
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
        en: "Add one geometry object. object: {type, name?, params?, position?, rotation? (radians XYZ), scale?, color? (#rrggbb), visible?, collectionId? (Outliner collection, see get_scene_state → collections)}. Returns the new id.",
        zh: "添加一个几何体。object: {type, name?, params?, position?, rotation?（弧度 XYZ）, scale?, color?（#rrggbb）, visible?, collectionId?（大纲集合，见 get_scene_state → collections）}。返回新 id。",
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
              collectionId: { type: "string", description: "Outliner collection id to file the object under" },
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
        en: "Patch an object by id: name?, params?, position?, rotation?, scale?, color?, visible?, collectionId? (move it into an Outliner collection; collections are created via execute_code api.addCollection or set_scene). Unspecified properties are kept.",
        zh: "按 id 修改对象：name?、params?、position?、rotation?、scale?、color?、visible?、collectionId?（移入某个大纲集合；集合需先用 execute_code 的 api.addCollection 或 set_scene 创建）。未指定的属性保持不变。",
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
          collectionId: { type: "string", description: "Outliner collection id to move the object into" },
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
        en: "Set the ACTIVE camera's base pose (used when it has no keyframes): position [x,y,z], target [x,y,z] (lookAt), fov (vertical degrees, 45≈50mm). Preview/snapshot/export always render the active camera.",
        zh: "设置活动相机的基础位姿（该相机无关键帧时生效）：position [x,y,z]、target [x,y,z]（注视点）、fov（垂直角度，45≈50mm）。预览/快照/导出始终使用活动相机。",
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
      name: "add_camera",
      description: {
        en: "Add a new scene camera: {name?, position?, target?, fov?, setActive?}. Cameras are Blender-style; the ACTIVE one is what snapshots render. Returns the new camera id.",
        zh: "添加一台新的场景相机：{name?, position?, target?, fov?, setActive?}。相机为 Blender 风格；快照渲染“活动”相机。返回新相机 id。",
      },
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          position: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 },
          target: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 },
          fov: { type: "number" },
          setActive: { type: "boolean", description: "Also make it the active camera (default false)" },
        },
        additionalProperties: false,
      },
      async handler(args, ctx) {
        let camId = "";
        const result = withDoc(ctx, "agent:add_camera", (target) => {
          const { setActive, ...cam } = args as { setActive?: boolean };
          camId = target.addCamera(cam as Parameters<typeof target.addCamera>[0]);
          if (setActive) target.setActiveCamera(camId);
        });
        if (result.isError) return result;
        return ok(`Added camera id "${camId}"${args.setActive ? " (now active)" : ""}.`);
      },
    },
    {
      name: "set_active_camera",
      description: {
        en: "Set which scene camera is ACTIVE — preview, snapshots and export render it. Camera-cut markers (manage_marker) override this from their time onward. Pass a camera id from get_scene_state (doc.cameras).",
        zh: "设置哪台场景相机是“活动”相机——预览、快照和导出都渲染它。镜头切换标记（manage_marker）会从其时间起覆盖此设置。传入 get_scene_state 中的相机 id（doc.cameras）。",
      },
      parameters: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
      async handler(args, ctx) {
        const result = withDoc(ctx, "agent:set_active_camera", (target) => {
          target.setActiveCamera(args.id as string);
        });
        if (result.isError) return result;
        const cam = ctx.getDoc().cameras.find((c) => c.id === args.id);
        return ok(`Active camera: "${cam?.name ?? args.id}".`);
      },
    },
    {
      name: "manage_marker",
      description: {
        en: "Manage CAMERA-CUT MARKERS on the timeline (Blender-style). A marker pins a camera from its time t onward: preview/snapshot/export CUT to that camera at t and keep it until the next marker; before the first marker the active camera renders. ops: add (t + cameraId required, name?), update / delete (id required, from get_scene_state → markers). Use markers for multi-angle edits (e.g. wide master shot, then a close-up cut at t=3).",
        zh: "管理时间轴上的“镜头切换标记”（Blender 风格）。标记从其时间 t 起固定一台相机：预览/快照/导出在 t 处硬切到该相机并保持到下一个标记；第一个标记之前渲染活动相机。op：add（必填 t + cameraId，可选 name）、update / delete（必填 id，来自 get_scene_state → markers）。需要多机位剪辑时使用（如全景主镜头，t=3 切近景）。",
      },
      parameters: {
        type: "object",
        properties: {
          op: { type: "string", enum: ["add", "update", "delete"] },
          t: { type: "number", description: "Marker time in seconds (add only; also updatable)" },
          cameraId: { type: "string", description: "Camera id that renders from this marker on (add; also updatable)" },
          name: { type: "string", description: "Marker name (add / update)" },
          id: { type: "string", description: "Marker id (update / delete, from get_scene_state → markers)" },
        },
        required: ["op"],
        additionalProperties: false,
      },
      async handler(args, ctx) {
        const op = String(args.op ?? "");
        if (op === "add") {
          if (typeof args.t !== "number" || !Number.isFinite(args.t) || args.t < 0) return err("add requires a numeric t >= 0 (seconds)");
          if (typeof args.cameraId !== "string" || !args.cameraId) return err("add requires cameraId (see get_scene_state → cameras)");
          let mkId = "";
          const result = withDoc(ctx, "agent:marker_add", (target) => {
            mkId = target.addMarker({
              t: args.t as number,
              cameraId: args.cameraId as string,
              name: typeof args.name === "string" ? args.name : undefined,
            });
          });
          if (result.isError) return result;
          const doc = ctx.getDoc();
          const mk = doc.markers.find((m) => m.id === mkId);
          const cam = doc.cameras.find((c) => c.id === args.cameraId);
          return ok(`Added marker "${mk?.name}" (id ${mkId}) at t=${(args.t as number).toFixed(2)}s → camera "${cam?.name ?? args.cameraId}". The view cuts to it from that time on.`);
        }
        if (typeof args.id !== "string" || !args.id) {
          return err(`op "${op}" requires a marker id (see get_scene_state → markers)`);
        }
        if (op === "update") {
          const patch: { name?: string; t?: number; cameraId?: string } = {};
          if (typeof args.name === "string") patch.name = args.name;
          if (typeof args.t === "number") patch.t = args.t;
          if (typeof args.cameraId === "string") patch.cameraId = args.cameraId;
          if (!Object.keys(patch).length) return err("update requires at least one of name / t / cameraId");
          const result = withDoc(ctx, "agent:marker_update", (target) => {
            target.updateMarker(args.id as string, patch);
          });
          if (result.isError) return result;
          return ok(`Updated marker ${args.id}.`);
        }
        if (op === "delete") {
          const result = withDoc(ctx, "agent:marker_delete", (target) => {
            target.removeMarker(args.id as string);
          });
          if (result.isError) return result;
          return ok(`Deleted marker ${args.id}.`);
        }
        return err(`Unknown op "${op}" — use add|update|delete`);
      },
    },
    {
      name: "manage_action",
      description: {
        en: "Manage keyframe ACTIONS (Blender-style). Each action is a named keyframe group owned by ONE object or camera; only an owner's ACTIVE action plays/edits. ops: create (owner {objectId} or {cameraId} required, name?), duplicate / rename / delete / setActive (id required, from get_scene_state → actions). add_keyframes/add_camera_keys write into the owner's ACTIVE action unless actionId is passed.",
        zh: "管理关键帧动作（Blender 风格）。每个动作是属于单个对象或相机的命名关键帧组；所有者只有“活动动作”参与播放/编辑。op：create（必填 owner {objectId} 或 {cameraId}，可选 name）、duplicate / rename / delete / setActive（必填 id，来自 get_scene_state → actions）。add_keyframes/add_camera_keys 默认写入所有者的活动动作，除非传入 actionId。",
      },
      parameters: {
        type: "object",
        properties: {
          op: { type: "string", enum: ["create", "duplicate", "rename", "delete", "setActive"] },
          owner: {
            type: "object",
            properties: {
              objectId: { type: "string", description: "Owner object id (create only)" },
              cameraId: { type: "string", description: "Owner camera id (create only)" },
            },
            additionalProperties: false,
          },
          id: { type: "string", description: "Action id (all ops except create)" },
          name: { type: "string", description: "Action name (create / rename)" },
        },
        required: ["op"],
        additionalProperties: false,
      },
      async handler(args, ctx) {
        const op = String(args.op ?? "");
        if (op === "create") {
          const owner = (args.owner ?? {}) as { objectId?: string; cameraId?: string };
          if (!owner.objectId && !owner.cameraId) return err("create needs owner: { objectId } or { cameraId }");
          let actId = "";
          const result = withDoc(ctx, "agent:action_create", (target) => {
            const normalized = owner.objectId ? { objectId: owner.objectId } : { cameraId: owner.cameraId as string };
            actId = target.createAction(normalized, typeof args.name === "string" ? args.name : undefined);
          });
          if (result.isError) return result;
          const act = ctx.getDoc().actions.find((a) => a.id === actId);
          return ok(`Created action "${act?.name}" (id ${actId}); it is now that owner's active action. Add keys with add_keyframes/add_camera_keys.`);
        }
        if (typeof args.id !== "string" || !args.id) {
          return err(`op "${op}" requires an action id (see get_scene_state → actions)`);
        }
        if (op === "duplicate") {
          let copyId = "";
          const result = withDoc(ctx, "agent:action_duplicate", (target) => {
            copyId = target.duplicateAction(args.id as string);
          });
          if (result.isError) return result;
          return ok(`Duplicated action ${args.id} → ${copyId} (the copy is now active).`);
        }
        if (op === "rename") {
          if (typeof args.name !== "string" || !args.name.trim()) return err("rename requires name");
          const result = withDoc(ctx, "agent:action_rename", (target) => {
            target.renameAction(args.id as string, args.name as string);
          });
          if (result.isError) return result;
          return ok(`Renamed action ${args.id} to "${args.name}".`);
        }
        if (op === "delete") {
          const result = withDoc(ctx, "agent:action_delete", (target) => {
            target.removeAction(args.id as string);
          });
          if (result.isError) return result;
          return ok(`Deleted action ${args.id} (its keyframes are gone).`);
        }
        if (op === "setActive") {
          const result = withDoc(ctx, "agent:action_setActive", (target) => {
            target.setActiveAction(args.id as string);
          });
          if (result.isError) return result;
          return ok(`Action ${args.id} is now its owner's active action.`);
        }
        return err(`Unknown op "${op}" — use create|duplicate|rename|delete|setActive`);
      },
    },
    {
      name: "add_camera_keyframes",
      description: {
        en: "Append camera keyframes: keys: [{t (s), position?, target?, fov?, interp? (linear|smooth|step)}]. Missing fields inherit from the previous key of that camera. Keys go into the camera's ACTIVE action (created if it has none); cameraId? targets one scene camera (default: active), actionId? targets a specific action.",
        zh: "追加相机关键帧：keys: [{t（秒）, position?, target?, fov?, interp?（linear|smooth|step）}]。缺省字段继承该相机上一帧。关键帧写入该相机的活动动作（没有则自动创建）；cameraId? 可指定某台场景相机（默认活动相机），actionId? 可指定某个动作。",
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
          cameraId: { type: "string", description: "Target camera id (default: active camera)" },
          actionId: { type: "string", description: "Target action id (default: that camera's active action)" },
        },
        required: ["keys"],
        additionalProperties: false,
      },
      async handler(args, ctx) {
        const keys = (args.keys ?? []) as Parameters<ReturnType<typeof createScriptTarget>["addCameraKeys"]>[0];
        const cameraId = typeof args.cameraId === "string" ? args.cameraId : undefined;
        const actionId = typeof args.actionId === "string" ? args.actionId : undefined;
        const result = withDoc(ctx, "agent:camera_keys", (target) => {
          target.addCameraKeys(keys, cameraId, actionId);
        });
        if (result.isError) return result;
        const doc = ctx.getDoc();
        const cid = cameraId ?? doc.activeCameraId;
        const owned = doc.actions.filter((a) => a.kind === "camera" && a.cameraId === cid);
        const total = owned.reduce((n, a) => n + a.keys.length, 0);
        const cam = doc.cameras.find((c) => c.id === cid);
        return ok(`Camera "${cam?.name ?? cid}" now has ${total} key(s) across ${owned.length} action(s).`);
      },
    },
    {
      name: "add_keyframes",
      description: {
        en: "Append keyframes for an object: keys: [{t (s), position?, rotation?, scale?, color?, visible?, interp?}]. Missing properties inherit from the object's previous key (or base pose for the first key). Keys go into the object's ACTIVE action (created if it has none); actionId? targets a specific action.",
        zh: "为对象追加关键帧：keys: [{t（秒）, position?, rotation?, scale?, color?, visible?, interp?}]。缺省属性继承该对象上一关键帧（首帧继承基础位姿）。关键帧写入该对象的活动动作（没有则自动创建）；actionId? 可指定某个动作。",
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
          actionId: { type: "string", description: "Target action id (default: that object's active action)" },
        },
        required: ["id", "keys"],
        additionalProperties: false,
      },
      async handler(args, ctx) {
        const actionId = typeof args.actionId === "string" ? args.actionId : undefined;
        const result = withDoc(ctx, "agent:keyframes", (target) => {
          target.addKeyframes(args.id as string, args.keys as Parameters<typeof target.addKeyframes>[1], actionId);
        });
        if (result.isError) return result;
        const owned = ctx.getDoc().actions.filter((a) => a.kind === "object" && a.objectId === args.id);
        const count = owned.reduce((n, a) => n + a.keys.length, 0);
        return ok(`Object now has ${count} key(s) across ${owned.length} action(s).`);
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
      readOnly: true,
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
        const snap = await ctx.snapshot(
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
        en: "Run JavaScript in the sandbox to build/animate the scene. Global `api`: add/update/remove/clear/addCollection(name)/get/find/list/keyframes(id,keys,actionId?)/setCamera/addCamera/addCameraKeys(keys,cameraId?,actionId?)/setActiveCamera/updateCamera/removeCamera/addMarker({t,cameraId,name?})/updateMarker(id,patch)/removeMarker(id)/createAction(owner,name?)/renameAction/duplicateAction/removeAction/setActiveAction/setDuration/setFps/setAspect(ratio)/onFrame(fn)/log/params/uniqueName. See the Skill Guide for the full reference. No DOM/network/imports; 5s timeout.",
        zh: "在沙箱中运行 JavaScript 来搭建/动画化场景。全局 `api`：add/update/remove/clear/addCollection(name)/get/find/list/keyframes(id,keys,actionId?)/setCamera/addCamera/addCameraKeys(keys,cameraId?,actionId?)/setActiveCamera/updateCamera/removeCamera/addMarker({t,cameraId,name?})/updateMarker(id,patch)/removeMarker(id)/createAction(owner,name?)/renameAction/duplicateAction/removeAction/setActiveAction/setDuration/setFps/setAspect(比例)/onFrame(fn)/log/params/uniqueName。完整参考见技能指南。无 DOM/网络/导入；5 秒超时。",
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
        const keyCount = doc.actions.reduce((n, a) => n + a.keys.length, 0);
        const lines = [
          `Executed OK. Scene now: ${doc.objects.length} objects, ${doc.actions.length} actions (${keyCount} keys), ${doc.onFrameScripts.length} onFrame hooks.`,
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

/** The guarded tool pipeline shared by the browser agent loop, the mock
 *  provider and the studio server (MCP + relayed built-in calls): unknown
 *  tool / bad JSON args / timeout / thrown errors all normalize to isError
 *  results the model can read. */
export async function runTool(name: string, argsJson: string, ctx: ToolContext): Promise<ToolResult> {
  const tool = getTools().find((tl) => tl.name === name);
  if (!tool) {
    return { text: `ERROR: unknown tool "${name}"`, isError: true };
  }
  let args: Record<string, unknown>;
  try {
    args = argsJson ? (JSON.parse(argsJson) as Record<string, unknown>) : {};
  } catch (err) {
    return { text: `ERROR: arguments are not valid JSON (${err instanceof Error ? err.message : String(err)}). Received: ${argsJson.slice(0, 400)}`, isError: true };
  }
  try {
    return await Promise.race([
      tool.handler(args, ctx),
      new Promise<ToolResult>((_, reject) =>
        setTimeout(() => reject(new Error("tool timed out after 20s")), 20_000),
      ),
    ]);
  } catch (err) {
    return { text: `ERROR: ${err instanceof Error ? err.message : String(err)}`, isError: true };
  }
}

/** Convert to OpenAI wire tool schemas for a given locale. */
export function toolsForLocale(locale: "en" | "zh"): ToolSchema[] {
  return getTools().map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description[locale],
      parameters: tool.parameters,
    },
  }));
}
