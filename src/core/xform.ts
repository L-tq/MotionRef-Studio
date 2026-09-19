/** Hand-rolled transform math (mat4 / quat / euler / splines).
 *
 *  Conventions match three.js EXACTLY — column-major 4×4 matrices, Euler
 *  order "XYZ" (R = Rx·Ry·Rz), quaternions (x, y, z, w) — so values computed
 *  here can be handed to THREE.Matrix4.fromArray / Quaternion.set(...) and
 *  vice versa without conversion. Verified by smoke/hierarchy.test.mjs against
 *  real three.js.
 *
 *  THREE-free on purpose: this runs inside evaluate(), which also executes in
 *  the sandbox workers.
 */
import type { ObjectDesc, SceneDocument, TrackAxis, Vec3 } from "./types";

export type Mat4 = number[]; // 16 elements, column-major
export type Quat = [number, number, number, number]; // x, y, z, w

// --- small vec helpers -----------------------------------------------------------

export function vadd(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}
export function vsub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
export function vscale(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}
export function vdot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
export function vcross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
export function vlen(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}
export function vnorm(a: Vec3): Vec3 {
  const l = vlen(a);
  return l < 1e-12 ? [0, 0, 0] : [a[0] / l, a[1] / l, a[2] / l];
}

export function vlerp(a: Vec3, b: Vec3, u: number): Vec3 {
  return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
}

// --- quaternions -----------------------------------------------------------------

export function quatIdentity(): Quat {
  return [0, 0, 0, 1];
}

/** Euler XYZ (radians) → quaternion, three.js `Quaternion.setFromEuler`. */
export function quatFromEuler(e: Vec3): Quat {
  const x = e[0] / 2, y = e[1] / 2, z = e[2] / 2;
  const c1 = Math.cos(x), c2 = Math.cos(y), c3 = Math.cos(z);
  const s1 = Math.sin(x), s2 = Math.sin(y), s3 = Math.sin(z);
  return [
    s1 * c2 * c3 + c1 * s2 * s3,
    c1 * s2 * c3 - s1 * c2 * s3,
    c1 * c2 * s3 + s1 * s2 * c3,
    c1 * c2 * c3 - s1 * s2 * s3,
  ];
}

/** Quaternion → Euler XYZ (radians), three.js `Euler.setFromQuaternion`. */
export function eulerFromQuat(q: Quat): Vec3 {
  const m = matFromQuat(q);
  return eulerFromMat(m);
}

function eulerFromMat(te: Mat4): Vec3 {
  // three.js Euler._setFromRotationMatrix, order "XYZ".
  const m13 = te[8];
  const y = Math.asin(Math.min(1, Math.max(-1, m13)));
  if (Math.abs(m13) < 0.9999999) {
    return [Math.atan2(-te[9], te[10]), y, Math.atan2(-te[4], te[0])];
  }
  // Gimbal lock: x absorbs the remaining freedom around the collapsed axis.
  return [Math.atan2(te[6], te[5]), y, 0];
}

export function quatMultiply(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    ax * bw + aw * bx + ay * bz - az * by,
    ay * bw + aw * by + az * bx - ax * bz,
    az * bw + aw * bz + ax * by - ay * bx,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

export function quatConjugate(q: Quat): Quat {
  return [-q[0], -q[1], -q[2], q[3]];
}

export function quatNormalize(q: Quat): Quat {
  const l = Math.hypot(q[0], q[1], q[2], q[3]);
  return l < 1e-12 ? [0, 0, 0, 1] : [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

export function quatSlerp(a: Quat, b: Quat, t: number): Quat {
  let [bx, by, bz, bw] = b;
  let dot = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
  if (dot < 0) {
    // Shortest path.
    bx = -bx; by = -by; bz = -bz; bw = -bw;
    dot = -dot;
  }
  if (dot > 0.9995) {
    return quatNormalize([a[0] + (bx - a[0]) * t, a[1] + (by - a[1]) * t, a[2] + (bz - a[2]) * t, a[3] + (bw - a[3]) * t]);
  }
  const theta0 = Math.acos(dot);
  const theta = theta0 * t;
  const sin0 = Math.sin(theta0);
  const s0 = Math.sin(theta0 - theta) / sin0;
  const s1 = Math.sin(theta) / sin0;
  return [a[0] * s0 + bx * s1, a[1] * s0 + by * s1, a[2] * s0 + bz * s1, a[3] * s0 + bw * s1];
}

/** Rotation aligning the given local axis with `dir`, keeping the frame as
 *  close to `up` as possible (a Blender-style Track To basis: aim z keeps +y
 *  up, aim y keeps +z up, aim x keeps +y up). */
export function axisQuat(axis: TrackAxis, dir: Vec3, up: Vec3): Quat {
  const slot = axis[1] === "x" ? 0 : axis[1] === "y" ? 1 : 2;
  const sign = axis[0] === "-" ? -1 : 1;
  const upSlot = slot === 1 ? 2 : 1; // aim y → up z, otherwise up y
  const d = vnorm(dir);
  const b: Vec3[] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  b[slot] = vscale(d, sign);
  // Orthogonalize the up hint against the aim axis.
  let u = vsub(up, vscale(b[slot], vdot(up, b[slot])));
  if (vlen(u) < 1e-6) {
    // dir parallel to up — any perpendicular fallback.
    u = vcross(b[slot], Math.abs(b[slot][1]) > 0.9 ? [1, 0, 0] : [0, 1, 0]);
  }
  b[upSlot] = vnorm(u);
  const third = 3 - slot - upSlot;
  // Complete a right-handed basis: cyclic (x→y→z) cross order decides the
  // direction of the remaining axis.
  b[third] = (slot + 1) % 3 === upSlot ? vcross(b[slot], b[upSlot]) : vcross(b[upSlot], b[slot]);
  return quatFromMat3(b[0], b[1], b[2]);
}

// --- matrices ---------------------------------------------------------------------

export function matIdentity(): Mat4 {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

/** Rotation-only matrix from three orthonormal COLUMN vectors. */
function quatFromMat3(x: Vec3, y: Vec3, z: Vec3): Quat {
  const m = matIdentity();
  m[0] = x[0]; m[1] = x[1]; m[2] = x[2];
  m[4] = y[0]; m[5] = y[1]; m[6] = y[2];
  m[8] = z[0]; m[9] = z[1]; m[10] = z[2];
  return quatFromMat(m);
}

/** Rotation part of a (column-major) matrix → quaternion, three.js
 *  `Quaternion.setFromRotationMatrix`. */
export function quatFromMat(m: Mat4): Quat {
  const m11 = m[0], m12 = m[4], m13 = m[8];
  const m21 = m[1], m22 = m[5], m23 = m[9];
  const m31 = m[2], m32 = m[6], m33 = m[10];
  const trace = m11 + m22 + m33;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1.0);
    return [(m32 - m23) * s, (m13 - m31) * s, (m21 - m12) * s, 0.25 / s];
  }
  if (m11 > m22 && m11 > m33) {
    const s = 2.0 * Math.sqrt(1.0 + m11 - m22 - m33);
    return [0.25 * s, (m12 + m21) / s, (m13 + m31) / s, (m32 - m23) / s];
  }
  if (m22 > m33) {
    const s = 2.0 * Math.sqrt(1.0 + m22 - m11 - m33);
    return [(m12 + m21) / s, 0.25 * s, (m23 + m32) / s, (m13 - m31) / s];
  }
  const s = 2.0 * Math.sqrt(1.0 + m33 - m11 - m22);
  return [(m13 + m31) / s, (m23 + m32) / s, 0.25 * s, (m21 - m12) / s];
}

/** Matrix from a rotation quaternion, three.js `Matrix4.makeRotationFromQuaternion`. */
export function matFromQuat(q: Quat): Mat4 {
  const [x, y, z, w] = quatNormalize(q);
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, yy = y * y2, zz = z * z2;
  const xy = x * y2, xz = x * z2, yz = y * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  return [
    1 - (yy + zz), xy + wz, xz - wy, 0,
    xy - wz, 1 - (xx + zz), yz + wx, 0,
    xz + wy, yz - wx, 1 - (xx + yy), 0,
    0, 0, 0, 1,
  ];
}

/** T·R·S compose from an Euler-XYZ pose, three.js `Matrix4.compose`. */
export function matFromTRS(position: Vec3, rotation: Vec3, scale: Vec3): Mat4 {
  const q = quatFromEuler(rotation);
  const m = matFromQuat(q);
  for (let c = 0; c < 3; c++) {
    const s = c === 0 ? scale[0] : c === 1 ? scale[1] : scale[2];
    m[c * 4 + 0] *= s;
    m[c * 4 + 1] *= s;
    m[c * 4 + 2] *= s;
  }
  m[12] = position[0];
  m[13] = position[1];
  m[14] = position[2];
  return m;
}

export function matMultiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Array(16).fill(0) as Mat4;
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = sum;
    }
  }
  return out;
}

/** General 4×4 inverse (cofactor expansion), three.js `Matrix4.invert`. */
export function matInvert(m: Mat4): Mat4 {
  const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = m;
  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;
  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) return matIdentity();
  det = 1 / det;
  return [
    (a11 * b11 - a12 * b10 + a13 * b09) * det,
    (a02 * b10 - a01 * b11 - a03 * b09) * det,
    (a31 * b05 - a32 * b04 + a33 * b03) * det,
    (a22 * b04 - a21 * b05 - a23 * b03) * det,
    (a12 * b08 - a10 * b11 - a13 * b07) * det,
    (a00 * b11 - a02 * b08 + a03 * b07) * det,
    (a32 * b02 - a30 * b05 - a33 * b01) * det,
    (a20 * b05 - a22 * b02 + a23 * b01) * det,
    (a10 * b10 - a11 * b08 + a13 * b06) * det,
    (a01 * b08 - a00 * b10 - a03 * b06) * det,
    (a30 * b04 - a31 * b02 + a33 * b00) * det,
    (a21 * b02 - a20 * b04 - a23 * b00) * det,
    (a11 * b07 - a10 * b09 - a12 * b06) * det,
    (a00 * b09 - a01 * b07 + a02 * b06) * det,
    (a31 * b01 - a30 * b03 - a32 * b00) * det,
    (a20 * b03 - a21 * b01 + a22 * b00) * det,
  ];
}

export interface TRS {
  position: Vec3;
  rotation: Vec3; // Euler XYZ radians
  scale: Vec3;
}

/** TRS decompose, three.js `Matrix4.decompose` (negative determinant flips sx). */
export function matDecompose(m: Mat4): TRS {
  let sx = Math.hypot(m[0], m[1], m[2]);
  const sy = Math.hypot(m[4], m[5], m[6]);
  const sz = Math.hypot(m[8], m[9], m[10]);
  const det =
    m[0] * (m[5] * m[10] - m[6] * m[9]) - m[4] * (m[1] * m[10] - m[2] * m[9]) + m[8] * (m[1] * m[6] - m[2] * m[5]);
  if (det < 0) sx = -sx;
  const r = matIdentity();
  const invX = sx !== 0 ? 1 / sx : 0;
  const invY = sy !== 0 ? 1 / sy : 0;
  const invZ = sz !== 0 ? 1 / sz : 0;
  for (let i = 0; i < 3; i++) {
    r[i] = m[i] * invX;
    r[4 + i] = m[4 + i] * invY;
    r[8 + i] = m[8 + i] * invZ;
  }
  return {
    position: [m[12], m[13], m[14]],
    rotation: eulerFromMat(r),
    scale: [sx, sy, sz],
  };
}

export function transformPoint(m: Mat4, p: Vec3): Vec3 {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];
}

export function transformDir(m: Mat4, v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[4] * v[1] + m[8] * v[2],
    m[1] * v[0] + m[5] * v[1] + m[9] * v[2],
    m[2] * v[0] + m[6] * v[1] + m[10] * v[2],
  ];
}

/** The rotation part of a matrix as a quaternion. */
export function quatOfMat(m: Mat4): Quat {
  return quatFromMat3(
    vnorm([m[0], m[1], m[2]]),
    vnorm([m[4], m[5], m[6]]),
    vnorm([m[8], m[9], m[10]]),
  );
}

/** World matrix of an object's BASE pose (no keyframes/hooks/constraints),
 *  composing the parent chain. Used when baking parent offsets (set-parent
 *  keep-world, child_of "set inverse"). */
export function baseWorldOf(doc: SceneDocument, id: string): Mat4 {
  const byId = new Map(doc.objects.map((o) => [o.id, o] as const));
  const chain: ObjectDesc[] = [];
  const seen = new Set<string>();
  let cur = byId.get(id);
  while (cur) {
    if (seen.has(cur.id)) break; // defensive: cyclic doc
    seen.add(cur.id);
    chain.push(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  let m = matIdentity();
  // chain is collected child-upward; compose ancestors-first (world = root × … × child).
  for (const o of [...chain].reverse()) m = matMultiply(m, matFromTRS(o.position, o.rotation, o.scale));
  return m;
}

// --- path sampling (follow_path) ----------------------------------------------------

export interface PathSample {
  point: Vec3;
  /** Unit tangent (direction of travel at u). */
  tangent: Vec3;
  /** Total polyline length (constant per point set). */
  length: number;
}

/** Sample a Catmull-Rom spline through `points`, parameterized by arc length:
 *  u ∈ [0, 1] → position along the whole path. Two points degrade to a
 *  straight line. End control points are clamped (the curve passes through
 *  every waypoint). */
export function samplePolyline(points: Vec3[], u: number): PathSample {
  const n = points.length;
  const uu = Math.min(1, Math.max(0, u));
  if (n === 0) return { point: [0, 0, 0], tangent: [1, 0, 0], length: 0 };
  if (n === 1) return { point: [...points[0]], tangent: [1, 0, 0], length: 0 };
  const lens: number[] = [];
  let total = 0;
  for (let i = 0; i < n - 1; i++) {
    const l = vlen(vsub(points[i + 1], points[i]));
    lens.push(l);
    total += l;
  }
  if (total < 1e-9) return { point: [...points[0]], tangent: [1, 0, 0], length: 0 };
  const s = uu * total;
  let i = 0;
  let acc = 0;
  while (i < n - 2 && acc + lens[i] < s) {
    acc += lens[i];
    i += 1;
  }
  const localT = lens[i] > 1e-9 ? (s - acc) / lens[i] : 0;
  const at = (t: number): Vec3 => {
    if (n === 2) return vlerp(points[0], points[1], t);
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(n - 1, i + 2)];
    const t2 = t * t;
    const t3 = t2 * t;
    return [
      0.5 * (2 * p1[0] + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
      0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
      0.5 * (2 * p1[2] + (-p0[2] + p2[2]) * t + (2 * p0[2] - 5 * p1[2] + 4 * p2[2] - p3[2]) * t2 + (-p0[2] + 3 * p1[2] - 3 * p2[2] + p3[2]) * t3),
    ];
  };
  const h = 1e-3;
  const point = at(localT);
  const tangent = vnorm(vsub(at(Math.min(1, localT + h)), at(Math.max(0, localT - h))));
  return { point, tangent: tangent[0] === 0 && tangent[1] === 0 && tangent[2] === 0 ? [1, 0, 0] : tangent, length: total };
}
