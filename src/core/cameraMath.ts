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
