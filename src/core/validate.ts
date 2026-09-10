/** Strict validation for SceneDocuments coming from untrusted sources
 *  (agent tool calls, JSON imports). Returns a normalized document or a
 *  human-readable error string. */
import { createEmptyDocument, isGeometryType, specOf, type SceneDocument } from "./types";
import { clampAspect } from "./cameraMath";

const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

function fail(what: string): string {
  return what;
}

function asVec3(v: unknown, what: string): [number, number, number] | string {
  if (!Array.isArray(v) || v.length !== 3 || !v.every((n) => typeof n === "number" && Number.isFinite(n))) {
    return `${what} must be [x, y, z]`;
  }
  return [v[0], v[1], v[2]];
}

const INTERPS = ["linear", "step", "smooth"];

export function validateSceneDocument(input: unknown): { doc: SceneDocument } | { error: string } {
  if (!input || typeof input !== "object") return { error: fail("document must be an object") };
  const raw = input as Record<string, unknown>;
  const doc = createEmptyDocument(typeof raw.name === "string" ? raw.name.slice(0, 120) : "Untitled");

  if (typeof raw.background === "string" && HEX_RE.test(raw.background)) doc.background = raw.background;
  if (typeof raw.duration === "number" && Number.isFinite(raw.duration)) doc.duration = Math.min(Math.max(raw.duration, 0.1), 300);
  if (typeof raw.fps === "number" && Number.isFinite(raw.fps)) doc.fps = Math.min(Math.max(Math.round(raw.fps), 1), 120);
  if (typeof raw.aspect === "number" && Number.isFinite(raw.aspect)) doc.aspect = +clampAspect(raw.aspect).toFixed(4);

  // Camera base
  if (raw.camera && typeof raw.camera === "object") {
    const cam = raw.camera as Record<string, unknown>;
    const p = asVec3(cam.position, "camera.position");
    if (typeof p === "string") return { error: p };
    const tg = asVec3(cam.target, "camera.target");
    if (typeof tg === "string") return { error: tg };
    let fov = 45;
    if (cam.fov !== undefined) {
      if (typeof cam.fov !== "number" || cam.fov <= 0 || cam.fov >= 180) return { error: "camera.fov must be in (0, 180)" };
      fov = cam.fov;
    }
    doc.camera = { position: p, target: tg, fov };
  }

  // Objects
  if (raw.objects !== undefined) {
    if (!Array.isArray(raw.objects)) return { error: "objects must be an array" };
    if (raw.objects.length > 2000) return { error: "too many objects (max 2000)" };
    const seen = new Set<string>();
    for (const [i, o] of raw.objects.entries()) {
      if (!o || typeof o !== "object") return { error: `objects[${i}] must be an object` };
      const obj = o as Record<string, unknown>;
      if (!isGeometryType(obj.type)) return { error: `objects[${i}].type "${String(obj.type)}" is not a basic geometry` };
      let id = typeof obj.id === "string" ? obj.id : "";
      if (!id || seen.has(id)) id = `v${i}_${Math.random().toString(36).slice(2, 8)}`;
      seen.add(id);
      const position = asVec3(obj.position ?? [0, 0, 0], `objects[${i}].position`);
      if (typeof position === "string") return { error: position };
      const rotation = asVec3(obj.rotation ?? [0, 0, 0], `objects[${i}].rotation`);
      if (typeof rotation === "string") return { error: rotation };
      const scale = asVec3(obj.scale ?? [1, 1, 1], `objects[${i}].scale`);
      if (typeof scale === "string") return { error: scale };
      const params: Record<string, number> = { ...specOf(obj.type).defaults };
      if (obj.params && typeof obj.params === "object") {
        for (const [k, v] of Object.entries(obj.params as Record<string, unknown>)) {
          if (typeof v === "number" && Number.isFinite(v)) params[k] = v;
        }
      }
      const color = typeof obj.color === "string" && HEX_RE.test(obj.color) ? obj.color : "#7c5cff";
      doc.objects.push({
        id,
        name: typeof obj.name === "string" && obj.name.trim() ? obj.name.slice(0, 80) : `${obj.type} ${i + 1}`,
        type: obj.type,
        params,
        position,
        rotation,
        scale,
        color,
        visible: obj.visible === undefined ? true : !!obj.visible,
      });
    }
  }

  const objectIds = new Set(doc.objects.map((o) => o.id));

  // Tracks
  if (raw.tracks && typeof raw.tracks === "object") {
    for (const [objectId, keys] of Object.entries(raw.tracks as Record<string, unknown>)) {
      if (!objectIds.has(objectId)) continue; // drop orphan tracks
      if (!Array.isArray(keys)) return { error: `tracks.${objectId} must be an array` };
      const clean = [];
      for (const [i, k] of keys.entries()) {
        if (!k || typeof k !== "object") return { error: `tracks.${objectId}[${i}] must be an object` };
        const key = k as Record<string, unknown>;
        if (typeof key.t !== "number" || !Number.isFinite(key.t) || key.t < 0) {
          return { error: `tracks.${objectId}[${i}].t must be a number >= 0` };
        }
        const entry: Record<string, unknown> = { t: key.t, interp: INTERPS.includes(String(key.interp)) ? key.interp : "linear" };
        for (const prop of ["position", "rotation", "scale"] as const) {
          if (key[prop] !== undefined) {
            const v = asVec3(key[prop], `tracks.${objectId}[${i}].${prop}`);
            if (typeof v === "string") return { error: v };
            entry[prop] = v;
          }
        }
        if (typeof key.color === "string" && HEX_RE.test(key.color)) entry.color = key.color;
        if (typeof key.visible === "boolean") entry.visible = key.visible;
        clean.push(entry);
      }
      clean.sort((a, b) => (a.t as number) - (b.t as number));
      doc.tracks[objectId] = clean as unknown as SceneDocument["tracks"][string];
    }
  }

  // Camera keys
  if (raw.cameraKeys !== undefined) {
    if (!Array.isArray(raw.cameraKeys)) return { error: "cameraKeys must be an array" };
    for (const [i, k] of raw.cameraKeys.entries()) {
      if (!k || typeof k !== "object") return { error: `cameraKeys[${i}] must be an object` };
      const key = k as Record<string, unknown>;
      if (typeof key.t !== "number" || !Number.isFinite(key.t) || key.t < 0) {
        return { error: `cameraKeys[${i}].t must be a number >= 0` };
      }
      const position = asVec3(key.position, `cameraKeys[${i}].position`);
      if (typeof position === "string") return { error: position };
      const target = asVec3(key.target, `cameraKeys[${i}].target`);
      if (typeof target === "string") return { error: target };
      const fov = typeof key.fov === "number" && key.fov > 0 && key.fov < 180 ? key.fov : doc.camera.fov;
      doc.cameraKeys.push({
        t: key.t,
        position,
        target,
        fov,
        interp: INTERPS.includes(String(key.interp)) ? (key.interp as "linear") : "linear",
      });
    }
    doc.cameraKeys.sort((a, b) => a.t - b.t);
  }

  // onFrame hooks
  if (raw.onFrameScripts !== undefined) {
    if (!Array.isArray(raw.onFrameScripts)) return { error: "onFrameScripts must be an array" };
    for (const src of raw.onFrameScripts.slice(0, 16)) {
      if (typeof src === "string" && src.length < 8000) doc.onFrameScripts.push(src);
    }
  }

  return { doc };
}
