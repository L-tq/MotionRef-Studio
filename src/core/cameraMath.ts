/** FOV <-> focal length conversion for a 35mm full-frame sensor (36x24mm).
 *  Three.js PerspectiveCamera.fov is the VERTICAL fov, so we use the 24mm
 *  sensor height: fov = 2 * atan(12 / focal_mm). */
export const SENSOR_HALF_HEIGHT_MM = 12;

export function fovToFocal(fovDeg: number): number {
  const fovRad = (fovDeg * Math.PI) / 180;
  return SENSOR_HALF_HEIGHT_MM / Math.tan(fovRad / 2);
}

export function focalToFov(focalMm: number): number {
  const clamped = Math.min(Math.max(focalMm, 1), 2000);
  return (2 * Math.atan(SENSOR_HALF_HEIGHT_MM / clamped) * 180) / Math.PI;
}

/** Common cinematic focal lengths for UI presets. */
export const FOCAL_PRESETS = [14, 24, 35, 50, 85];

/** Framing aspect ratios (width / height) offered as UI presets. */
export const ASPECT_PRESETS = [16 / 9, 9 / 16, 1, 4 / 3, 21 / 9];

export const ASPECT_MIN = 0.2;
export const ASPECT_MAX = 5;

export function clampAspect(a: number): number {
  return Math.min(Math.max(a, ASPECT_MIN), ASPECT_MAX);
}

/** Human label for an aspect ratio: matches a common ratio, else "1.85". */
export function aspectLabel(aspect: number): string {
  const known: Array<[string, number]> = [
    ["16:9", 16 / 9],
    ["9:16", 9 / 16],
    ["1:1", 1],
    ["4:3", 4 / 3],
    ["3:2", 3 / 2],
    ["21:9", 21 / 9],
  ];
  for (const [label, value] of known) {
    if (Math.abs(aspect - value) < 0.01) return label;
  }
  return aspect.toFixed(2);
}

/** Even, renderer-friendly pixel dimensions for an aspect ratio where the
 *  LONGER edge is capped at `longEdge` (16:9/1280 → 1280x720, 9:16/1920 →
 *  1080x1920). */
export function aspectDims(aspect: number, longEdge = 1280): { w: number; h: number } {
  const a = clampAspect(aspect);
  const w = a >= 1 ? longEdge : Math.round(longEdge * a);
  const h = a >= 1 ? Math.round(longEdge / a) : longEdge;
  return { w: Math.max(2, Math.round(w / 2) * 2), h: Math.max(2, Math.round(h / 2) * 2) };
}
