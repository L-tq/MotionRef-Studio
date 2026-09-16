// Marker feature smoke test for the pure-TS core (runs under esbuild-bundle).
import assert from "node:assert/strict";
import { createEmptyDocument, defaultCameraDesc, activeCameraIdAt, defaultMarkerName } from "../src/core/types";
import { evaluate } from "../src/core/animation";
import { validateSceneDocument } from "../src/core/validate";
import { createScriptTarget, createScriptingAPI } from "../src/core/scripting";

// --- 1. activeCameraIdAt basics ------------------------------------------------
const doc = createEmptyDocument("T");
doc.duration = 6;
doc.cameras.push({ id: "camB", name: "B", position: [1, 1, 1], target: [0, 0, 0], fov: 40 });
doc.markers.push({ id: "mk1", name: "Cut", t: 3, cameraId: "camB" });

assert.equal(activeCameraIdAt(doc, 0), "camera", "before first marker: manual active camera");
assert.equal(activeCameraIdAt(doc, 2.99), "camera");
assert.equal(activeCameraIdAt(doc, 3), "camB", "cut applies exactly at marker time");
assert.equal(activeCameraIdAt(doc, 6), "camB", "holds until the end");

// --- 2. evaluate() resolves the camera per frame -------------------------------
const ev0 = evaluate(doc, 0);
const ev35 = evaluate(doc, 3.5);
assert.equal(ev0.cameraId, "camera");
assert.deepEqual(ev0.camera.position, [8, 6, 10]);
assert.equal(ev35.cameraId, "camB", "evaluated cameraId follows the marker");
assert.deepEqual(ev35.camera.position, [1, 1, 1], "evaluated pose is the marker camera's");

// Multiple markers: last one at/before t wins.
doc.markers.push({ id: "mk2", name: "Back", t: 5, cameraId: "camera" });
assert.equal(activeCameraIdAt(doc, 4.9), "camB");
assert.equal(activeCameraIdAt(doc, 5), "camera");

// --- 3. validation: legacy docs get markers [], orphan markers dropped ---------
const legacy = validateSceneDocument({ version: 1, name: "old", duration: 4, fps: 30, objects: [], camera: { position: [1, 2, 3], target: [0, 0, 0], fov: 45 } });
assert.ok("doc" in legacy);
assert.deepEqual(legacy.doc.markers, [], "legacy docs normalize to an empty marker list");

const dirty = validateSceneDocument({
  version: 1, name: "dirty", duration: 4, fps: 30, objects: [],
  cameras: [{ id: "camera", name: "Camera", position: [0, 0, 0], target: [0, 0, 0], fov: 45 }],
  activeCameraId: "camera",
  markers: [
    { id: "a", name: "ok", t: 1, cameraId: "camera" },
    { id: "b", name: "orphan", t: 2, cameraId: "ghost" },
    { id: "c", name: "bad-t", t: -3, cameraId: "camera" }, // hard error
  ],
});
assert.ok("error" in dirty, "negative marker t is rejected");

const dropped = validateSceneDocument({
  version: 1, name: "d", duration: 4, fps: 30, objects: [],
  cameras: [{ id: "camera", name: "Camera", position: [0, 0, 0], target: [0, 0, 0], fov: 45 }],
  markers: [{ id: "a", name: "ok", t: 1, cameraId: "camera" }, { id: "b", name: "orphan", t: 2, cameraId: "ghost" }],
});
assert.ok("doc" in dropped);
assert.equal(dropped.doc.markers.length, 1, "orphan-camera marker dropped silently");
assert.equal(dropped.doc.markers[0].id, "a");

// --- 4. scripting API (same surface the sandbox mirrors) ------------------------
const doc2 = createEmptyDocument("S");
doc2.cameras.push({ id: "camB", name: "B", position: [5, 5, 5], target: [0, 0, 0], fov: 30 });
const target = createScriptTarget(doc2);
const api = createScriptingAPI(target, () => {});

const mkId = api.addMarker({ t: 2, cameraId: "camB", name: "Cut to B" });
assert.equal(doc2.markers.length, 1);
assert.equal(doc2.markers[0].cameraId, "camB");

api.updateMarker(mkId, { t: 1.5, name: "Earlier" });
assert.equal(doc2.markers[0].t, 1.5);
assert.equal(doc2.markers[0].name, "Earlier");

assert.throws(() => api.addMarker({ t: 1, cameraId: "nope" }), /No camera with id/, "unknown camera throws");
assert.throws(() => api.updateMarker("ghost-id", { t: 1 }), /No marker with id/, "unknown marker throws");

// Sorting stays intact when adding out of order.
api.addMarker({ t: 0.5, cameraId: "camera" });
assert.deepEqual(doc2.markers.map((m) => m.t), [0.5, 1.5]);

// removeCamera strips bound markers.
api.removeCamera("camB");
assert.equal(doc2.markers.length, 1, "markers bound to a removed camera are dropped");
assert.equal(doc2.markers[0].cameraId, "camera");

api.removeMarker(doc2.markers[0].id);
assert.equal(doc2.markers.length, 0);

// --- 5. defaultMarkerName -------------------------------------------------------
const doc3 = createEmptyDocument("N");
assert.equal(defaultMarkerName(doc3), "Marker");
doc3.markers.push({ id: "x", name: "Marker", t: 0, cameraId: defaultCameraDesc().id });
assert.equal(defaultMarkerName(doc3), "Marker 2");

console.log("All marker smoke tests passed ✓");
