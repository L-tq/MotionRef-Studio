/** Offline mock provider: exercises the full harness (tool registry, sandbox,
 *  snapshots, chat events) without any network — used for testing and demos. */
import { useStore } from "../state/store";
import { newId } from "../core/types";
import { appendSnapshotFeedback, type AgentInput } from "./agentLoop";
import type { ToolContext, ToolResult } from "./tools";
import { t } from "../i18n";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const DEMO_CODE = `// Build a demo scene: ground, bouncing ball, orbiting moon, camera move.
api.clear();
const ground = api.add({ type: "plane", name: "Ground", params: { width: 24, height: 24 }, position: [0, 0, 0], rotation: [-Math.PI / 2, 0, 0], color: "#23233a" });
const ball = api.add({ type: "sphere", name: "Ball", params: { radius: 0.6 }, position: [0, 0.6, 0], color: "#ff5c7c" });
const moon = api.add({ type: "icosahedron", name: "Moon", params: { radius: 0.35 }, position: [3, 1.6, 0], color: "#38bdf8" });
api.add({ type: "cylinder", name: "Pillar", params: { radiusTop: 0.35, radiusBottom: 0.35, height: 2.4 }, position: [-5.5, 1.2, -3.5], color: "#7c5cff" });
api.add({ type: "cylinder", name: "Pillar 2", params: { radiusTop: 0.35, radiusBottom: 0.35, height: 1.6 }, position: [5.2, 0.8, -4], color: "#3ddc97" });
api.setDuration(6);
api.setFps(30);

api.keyframes(ball, [
  { t: 0,   position: [-4, 4, 0], interp: "linear" },
  { t: 0.75, position: [-4, 0.6, 0], scale: [1.25, 0.7, 1.25], interp: "smooth" },
  { t: 1.0, position: [-4, 0.6, 0], scale: [1, 1, 1] },
  { t: 1.8, position: [-1.4, 2.6, 0] },
  { t: 2.5, position: [0, 0.6, 0], scale: [1.25, 0.7, 1.25], interp: "smooth" },
  { t: 2.75, position: [0, 0.6, 0], scale: [1, 1, 1] },
  { t: 3.6, position: [2, 3.4, 0] },
  { t: 4.25, position: [3.4, 0.6, 0], scale: [1.25, 0.7, 1.25], interp: "smooth" },
  { t: 4.5, position: [3.4, 0.6, 0], scale: [1, 1, 1] },
]);

api.onFrame((time, f) => {
  f.update(moon, { position: [Math.cos(time * 1.2) * 3, 1.6 + Math.sin(time * 2) * 0.4, Math.sin(time * 1.2) * 3] });
});

api.setCamera({ position: [10, 6, 12], target: [0, 1, 0], fov: 42 });
api.addCameraKeys([
  { t: 0, position: [12, 3, 0.5], target: [0, 1, 0], fov: 38, interp: "smooth" },
  { t: 3, position: [4, 5, 11], target: [0, 1.2, 0], fov: 42, interp: "smooth" },
  { t: 6, position: [-6, 7, 9], target: [1, 1, 0], fov: 46, interp: "smooth" },
]);
api.log("scene built");`;

export async function runMockTurn(
  input: AgentInput,
  ctx: ToolContext,
  execute: (name: string, argsJson: string, ctx: ToolContext) => Promise<ToolResult>,
): Promise<void> {
  const sawImages = input.images.length > 0;

  // Stream a little opening text for realism.
  const eventId = newId("e");
  useStore.getState().sessionPush({ id: eventId, type: "assistant", text: "", step: 1 });
  const opener = sawImages
    ? `Thanks — I see ${input.images.length} reference image(s). Running the offline mock pipeline: I'll build a demo scene with a bouncing ball, an orbiting moon and a moving camera.`
    : `Running the offline mock pipeline: I'll build a demo scene with a bouncing ball, an orbiting moon and a moving camera.`;
  for (const chunk of opener.match(/.{1,24}/gs) ?? []) {
    const current = useStore.getState().session.find((e) => e.id === eventId);
    useStore.getState().sessionPatch(eventId, { text: ((current as { text?: string })?.text ?? "") + chunk } as never);
    await sleep(24);
  }

  await execute("execute_code", JSON.stringify({ code: DEMO_CODE }), ctx);
  const snap1 = await execute("snapshot", JSON.stringify({ time: 0 }), ctx);
  if (snap1.snapshot) appendSnapshotFeedback(snap1.snapshot);
  await sleep(150);
  const snap2 = await execute("snapshot", JSON.stringify({ time: 3 }), ctx);
  if (snap2.snapshot) appendSnapshotFeedback(snap2.snapshot);

  useStore.getState().sessionPush({
    id: newId("e"),
    type: "assistant",
    text:
      "Demo scene is ready (mock provider — no LLM was contacted):\n" +
      "• Ground plane, two pillars, a bouncing ball (squash & stretch keyframes)\n" +
      "• An orbiting icosahedron via api.onFrame\n" +
      "• Camera sweep with three keyframes (38° → 46° FOV)\n\n" +
      "Press Play to preview, or connect a real multimodal model in Settings for actual prompt-driven generation.",
    step: 2,
  });
  void t;
}
