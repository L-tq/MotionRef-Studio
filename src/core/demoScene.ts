/** A small showcase scene: bouncing ball + orbiting companion + camera move. */
import { createEmptyDocument, newId, type SceneDocument } from "./types";

export function demoDocument(): SceneDocument {
  const doc = createEmptyDocument("Demo — Bounce & Orbit");
  doc.background = "#151521";
  doc.duration = 6;

  const ground = newId();
  doc.objects.push({
    id: ground,
    name: "Ground",
    type: "plane",
    params: { width: 24, height: 24 },
    position: [0, 0, 0],
    rotation: [-Math.PI / 2, 0, 0],
    scale: [1, 1, 1],
    color: "#23233a",
    visible: true,
  });

  const ball = newId();
  doc.objects.push({
    id: ball,
    name: "Ball",
    type: "sphere",
    params: { radius: 0.6 },
    position: [0, 0.6, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
    color: "#ff5c7c",
    visible: true,
  });
  doc.tracks[ball] = [
    { t: 0, position: [-4, 4, 0], scale: [1, 1, 1], color: "#ff5c7c", interp: "linear" },
    { t: 0.75, position: [-4, 0.6, 0], scale: [1.25, 0.7, 1.25], interp: "smooth" },
    { t: 1.0, position: [-4, 0.6, 0], scale: [1, 1, 1], interp: "linear" },
    { t: 1.8, position: [-1.4, 2.6, 0], interp: "linear" },
    { t: 2.5, position: [0, 0.6, 0], scale: [1.25, 0.7, 1.25], interp: "smooth" },
    { t: 2.75, position: [0, 0.6, 0], scale: [1, 1, 1], interp: "linear" },
    { t: 3.6, position: [2, 3.4, 0], interp: "linear" },
    { t: 4.25, position: [3.4, 0.6, 0], scale: [1.25, 0.7, 1.25], interp: "smooth" },
    { t: 4.5, position: [3.4, 0.6, 0], scale: [1, 1, 1], interp: "linear" },
    { t: 6, position: [3.4, 0.6, 0], rotation: [0, Math.PI * 2, 0], interp: "linear" },
  ];

  const moon = newId();
  doc.objects.push({
    id: moon,
    name: "Moon",
    type: "icosahedron",
    params: { radius: 0.35 },
    position: [0, 1.6, 3],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
    color: "#38bdf8",
    visible: true,
  });
  doc.onFrameScripts.push(
    "(t, f) => {\n  f.update('" + moon + "', { position: [Math.cos(t * 1.2) * 3, 1.6 + Math.sin(t * 2) * 0.4, Math.sin(t * 1.2) * 3] });\n}",
  );

  const pillar = newId();
  doc.objects.push({
    id: pillar,
    name: "Pillar",
    type: "cylinder",
    params: { radiusTop: 0.35, radiusBottom: 0.35, height: 2.4 },
    position: [-5.5, 1.2, -3.5],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
    color: "#7c5cff",
    visible: true,
  });
  const pillar2 = newId();
  doc.objects.push({
    id: pillar2,
    name: "Pillar 2",
    type: "cylinder",
    params: { radiusTop: 0.35, radiusBottom: 0.35, height: 1.6 },
    position: [5.2, 0.8, -4],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
    color: "#3ddc97",
    visible: true,
  });

  doc.cameras = [{ id: "camera", name: "Camera", position: [10, 6, 12], target: [0, 1, 0], fov: 42 }];
  doc.activeCameraId = "camera";
  doc.cameraKeys = [
    { t: 0, cameraId: "camera", position: [12, 3, 0.5], target: [0, 1, 0], fov: 38, interp: "smooth" },
    { t: 3, cameraId: "camera", position: [4, 5, 11], target: [0, 1.2, 0], fov: 42, interp: "smooth" },
    { t: 6, cameraId: "camera", position: [-6, 7, 9], target: [1, 1, 0], fov: 46, interp: "smooth" },
  ];

  return doc;
}
