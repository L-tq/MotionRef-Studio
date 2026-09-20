// Edge-case / bug-hunt smoke test for the hierarchy + constraint core
// (runs under tsx: `npx tsx smoke/hierarchy-edge.test.mjs`).
//
// Complements smoke/hierarchy.test.mjs (which covers the happy paths):
// this file probes degenerate inputs, evaluation-order corners, validator
// boundary rules and pinned-by-design semantics so regressions surface.
import assert from "node:assert/strict";
import * as THREE from "three";
import { createEmptyDocument } from "../src/core/types";
import { evaluate } from "../src/core/animation";
import { validateSceneDocument } from "../src/core/validate";
import { createScriptTarget } from "../src/core/scripting";
import {
  axisQuat,
  baseWorldOf,
  eulerFromQuat,
  matDecompose,
  matFromQuat,
  matFromTRS,
  matIdentity,
  matInvert,
  quatFromEuler,
  quatSlerp,
  samplePolyline,
} from "../src/core/xform";
import { constraintChannels } from "../src/core/types";

const near = (a, b, eps = 1e-6, what = "") => {
  if (typeof a === "number") assert.ok(Math.abs(a - b) < eps, `${what}: ${a} vs ${b}`);
  else assert.ok(a.every((v, i) => Math.abs(v - b[i]) < eps), `${what}: [${a}] vs [${b}]`);
};
const finiteVec = (v, what) => assert.ok(v.every((n) => Number.isFinite(n)), `${what} finite: [${v}]`);

/** Full object literal (all fields explicit, hierarchy.test.mjs style). */
const obj = (id, extra = {}) => ({
  id,
  name: id,
  type: "box",
  params: {},
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  scale: [1, 1, 1],
  color: "#ffffff",
  visible: true,
  ...extra,
});
const docOf = (...objects) => {
  const doc = createEmptyDocument("T");
  doc.objects.push(...objects);
  return doc;
};
const cst = (id, type, extra = {}) => ({
  id,
  type,
  params: {},
  ...extra,
});

// --- 1. xform degenerates ---------------------------------------------------------

// Singular matrix (zero scale): det === 0 → identity fallback, never NaN/Infinity.
near(matInvert(matFromTRS([1, 2, 3], [0.2, 0.3, 0.4], [0, 0, 0])), matIdentity(), 1e-12, "invert(singular) = identity");

// Negative-determinant decompose: parity against real three.js (the rotation is
// lossy by design — what matters is that we match three exactly).
for (const [pos, eul, scl] of [
  [[1, 2, 3], [0.2, 0.4, 0.6], [1, -1, 1]],
  [[0, 0, 0], [1, 0.5, 0.3], [-1, -1, -1]],
  [[2, 0, 0], [0, 1, 2], [2, -3, 1]],
]) {
  const tq = new THREE.Quaternion().setFromEuler(new THREE.Euler(eul[0], eul[1], eul[2], "XYZ"));
  const tm = new THREE.Matrix4().compose(new THREE.Vector3(...pos), tq, new THREE.Vector3(...scl));
  const dp = new THREE.Vector3(), dq = new THREE.Quaternion(), ds = new THREE.Vector3();
  tm.decompose(dp, dq, ds);
  const mine = matDecompose(matFromTRS(pos, eul, scl));
  near(mine.position, [dp.x, dp.y, dp.z], 1e-7, "neg-scale decompose pos");
  near(mine.scale, [ds.x, ds.y, ds.z], 1e-7, "neg-scale decompose scale");
  const de = new THREE.Euler().setFromQuaternion(dq, "XYZ");
  near(mine.rotation, [de.x, de.y, de.z], 1e-5, "neg-scale decompose rot");
}

// Zero scale on ONE axis: rotation becomes finite garbage (atan2 of zeros) —
// must stay finite, never NaN.
{
  const d = matDecompose(matFromTRS([0, 0, 0], [0.3, 0.8, 0.1], [1, 0, 1]));
  finiteVec(d.position, "zero-axis pos");
  finiteVec(d.rotation, "zero-axis rot");
  finiteVec(d.scale, "zero-axis scale");
}

// Antipodal quaternions encode the SAME rotation — slerp must not blow up.
{
  const q = quatFromEuler([0.3, 0.7, -0.2]);
  const out = quatSlerp(q, [-q[0], -q[1], -q[2], -q[3]], 0.7);
  near(eulerFromQuat(out), eulerFromQuat(q), 1e-6, "slerp(q, -q)");
}

// Exact gimbal lock (y = ±π/2): z collapses to 0 and the rotation must
// round-trip as a matrix even though the euler is lossy.
for (const y of [Math.PI / 2, -Math.PI / 2]) {
  const e = [0.8, y, 0];
  const out = eulerFromQuat(quatFromEuler(e));
  near(out[1], y, 1e-7, "gimbal y");
  near(out[2], 0, 1e-9, "gimbal z collapsed");
  near(matFromQuat(quatFromEuler(out)), matFromQuat(quatFromEuler(e)), 1e-7, "gimbal rotation round-trip");
}

// samplePolyline degenerate inputs.
{
  const z = samplePolyline([], 0.5);
  near(z.point, [0, 0, 0], 1e-9, "empty path point");
  near(z.tangent, [1, 0, 0], 1e-9, "empty path tangent");
  const one = samplePolyline([[5, 5, 5]], 0.3);
  near(one.point, [5, 5, 5], 1e-9, "single point path");
  const same = samplePolyline([[1, 1, 1], [1, 1, 1], [1, 1, 1]], 0.5);
  near(same.point, [1, 1, 1], 1e-9, "degenerate (all identical) path");
  near(same.tangent, [1, 0, 0], 1e-9, "degenerate path tangent");
  const line = samplePolyline([[0, 0, 0], [10, 0, 0]], 0.5);
  near(line.point, [5, 0, 0], 1e-9, "line midpoint");
  near(line.length, 10, 1e-9, "line length");
  near(samplePolyline([[0, 0, 0], [10, 0, 0]], -1).point, [0, 0, 0], 1e-9, "u<0 clamps to start");
  near(samplePolyline([[0, 0, 0], [10, 0, 0]], 2).point, [10, 0, 0], 1e-9, "u>1 clamps to end");
  near(samplePolyline([[0, 0, 0], [10, 0, 0]], 1).point, [10, 0, 0], 1e-9, "u=1 exact endpoint");
  // Leading duplicate waypoint must not break the walk.
  const dup = samplePolyline([[0, 0, 0], [0, 0, 0], [10, 0, 0]], 0.5);
  assert.ok(dup.point[0] >= 0 && dup.point[0] <= 10 && Number.isFinite(dup.point[1]), "leading-duplicate path finite");
  near(samplePolyline([[0, 0, 0], [0, 0, 0], [10, 0, 0]], 1).point, [10, 0, 0], 1e-9, "leading-duplicate end");
}

// axisQuat with the aim direction parallel to the up vector: perpendicular
// fallback fires; result stays orthonormal and still aims correctly.
for (const axis of ["+z", "+y"]) {
  const q = axisQuat(axis, [0, 1, 0], [0, 1, 0]);
  const aimed = (axis === "+z" ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0))
    .applyQuaternion(new THREE.Quaternion(q[0], q[1], q[2], q[3]));
  assert.ok(aimed.y > 0.9999, `axisQuat(${axis}) parallel-to-up still aims +y`);
  const m = matFromQuat(q);
  for (const c of [0, 4, 8]) near([m[c], m[c + 1], m[c + 2]].map(Math.abs).reduce((a, b) => a + b), 1, 1e-9, "fallback basis orthonormal");
}

// baseWorldOf on a cyclic / dangling-parent doc: must terminate, stay finite.
{
  const doc = docOf(obj("a", { parentId: "b" }), obj("b", { parentId: "a" }), obj("c", { parentId: "ghost", position: [1, 2, 3] }));
  const wa = baseWorldOf(doc, "a");
  const wc = baseWorldOf(doc, "c");
  assert.ok(wa.every((n) => Number.isFinite(n)), "baseWorldOf cyclic finite");
  near(matDecompose(wc).position, [1, 2, 3], 1e-9, "baseWorldOf dangling parent = root");
}

console.log("1. xform degenerates ✓");

// --- 2. parenting edges -------------------------------------------------------------

// Unvalidated CYCLIC parentId: emit guard terminates; the first-visited member
// is treated as a root, the other composes under it (pinned order semantics).
{
  const doc = docOf(obj("a", { parentId: "b", position: [1, 0, 0] }), obj("b", { position: [5, 0, 0] }));
  const st = evaluate(doc, 0);
  // emit(a) walks to b first → order [b, a]: b is root, a is b's child.
  near(st.objects.get("b").world.position, [5, 0, 0], 1e-9, "cycle: first-visited is root");
  near(st.objects.get("a").world.position, [6, 0, 0], 1e-9, "cycle: second composes under it");
}

// Dangling parentId → root fallback (world aliases the local pose).
{
  const doc = docOf(obj("c", { parentId: "ghost", position: [3, 1, 0] }));
  const st = evaluate(doc, 0);
  near(st.objects.get("c").world.position, [3, 1, 0], 1e-9, "dangling parent → root");
  assert.strictEqual(st.objects.get("c").world.position, st.objects.get("c").position, "root ev.world aliases local arrays (pinned)");
}

// Duplicate object ids in an unvalidated doc: no crash, last definition wins.
{
  const doc = docOf(obj("dup", { position: [1, 1, 1] }), obj("dup", { position: [2, 2, 2] }));
  const st = evaluate(doc, 0);
  near(st.objects.get("dup").position, [2, 2, 2], 1e-9, "duplicate id: last wins");
}

// Zero-scale parent: singular parent matrix — everything stays finite.
{
  const doc = docOf(
    obj("p", { position: [2, 2, 2], scale: [0, 0, 0] }),
    obj("c", { parentId: "p", position: [1, 0, 0] }),
  );
  const st = evaluate(doc, 0);
  const c = st.objects.get("c");
  near(c.world.position, [2, 2, 2], 1e-9, "zero-scale parent collapses child onto its origin");
  finiteVec(c.world.scale, "zero-scale parent child scale");
  finiteVec(c.world.rotation, "zero-scale parent child rotation");
}

// Negative-scale parent: mirrored inheritance, exact values pinned.
{
  const doc = docOf(
    obj("p", { scale: [1, -1, 1] }),
    obj("c", { parentId: "p", position: [0, 1, 0] }),
  );
  near(evaluate(doc, 0).objects.get("c").world.position, [0, -1, 0], 1e-9, "negative-scale parent mirrors child");
}

// setParent to the CURRENT parent (keep world) is a numeric no-op.
{
  const doc = docOf(
    obj("p", { position: [1, 0, 0], rotation: [0, 0.7, 0] }),
    obj("c", { parentId: "p", position: [2, 1, 0], rotation: [0.3, 0, 0] }),
  );
  const before = evaluate(doc, 0).objects.get("c").world;
  createScriptTarget(doc).setParent("c", "p", "world");
  const after = evaluate(doc, 0).objects.get("c").world;
  near(after.position, before.position, 1e-9, "re-parent same parent: position stable");
  near(after.rotation, before.rotation, 1e-9, "re-parent same parent: rotation stable");
}

// evaluate is idempotent and clamps t into [0, duration].
{
  const doc = docOf(
    obj("p", { rotation: [0, 0.4, 0] }),
    obj("c", { parentId: "p", position: [2, 0, 0], constraints: [cst("t1", "track_to", { targetId: "tgt" })] }),
    obj("tgt", { position: [5, 2, 0] }),
  );
  doc.duration = 4;
  const a = evaluate(doc, 2);
  const b = evaluate(doc, 2);
  for (const [id, ev] of a.objects) {
    deepNear(ev.world, b.objects.get(id).world, `${id} idempotent`);
  }
  const t0 = evaluate(doc, 0), tNeg = evaluate(doc, -7);
  near(tNeg.objects.get("c").world.position, t0.objects.get("c").world.position, 1e-12, "t<0 clamps to 0");
  const tEnd = evaluate(doc, 99), tDur = evaluate(doc, 4);
  near(tEnd.objects.get("c").world.position, tDur.objects.get("c").world.position, 1e-12, "t>duration clamps");
}
function deepNear(a, b, what) {
  near(a.position, b.position, 1e-12, `${what} pos`);
  near(a.rotation, b.rotation, 1e-12, `${what} rot`);
  near(a.scale, b.scale, 1e-12, `${what} scale`);
}

console.log("2. parenting edges ✓");

// --- 3. constraint evaluation edges --------------------------------------------------

// 3a. Children (and grandchildren) of a CONSTRAINED parent must follow the
// constrained pose — the constraint pass recomposes every object, not just
// constraint owners. Turret aims +z at a target on +x → Ry(90°).
{
  const doc = docOf(
    obj("turret", { constraints: [cst("tt", "track_to", { targetId: "target" })] }),
    obj("barrel", { parentId: "turret", position: [1, 0, 0] }),
    obj("muzzle", { parentId: "barrel", position: [0, 1, 0] }),
    obj("target", { position: [10, 0, 0] }),
  );
  const st = evaluate(doc, 0);
  near(st.objects.get("turret").world.rotation, [0, Math.PI / 2, 0], 1e-6, "turret aims at target");
  near(st.objects.get("barrel").world.position, [0, 0, -1], 1e-6, "child follows constrained parent (world)");
  near(st.objects.get("muzzle").world.position, [0, 1, -1], 1e-6, "grandchild follows too");
  near(st.objects.get("barrel").position, [1, 0, 0], 1e-9, "child local pose untouched");
}

// 3b. Same through an instance: the instance OBJECT's world pose (what the
// engine multiplies members by) must reflect its constrained parent.
{
  const doc = docOf(obj("root", { position: [0, 5, 0] }));
  doc.collections.push({ id: "col", name: "Gate", hidden: false });
  doc.objects.push(obj("post", { collectionId: "col", position: [1, 0, 0] }));
  doc.objects.push(obj("inst", { type: "instance", instanceOf: "col", parentId: "root", position: [2, 0, 0] }));
  const before = evaluate(doc, 0).objects.get("inst").world.position;
  near(before, [2, 5, 0], 1e-9, "instance world = parent × local");
  // Now constrain the parent: the instance must move with it.
  doc.objects[0].constraints = [cst("tt", "track_to", { targetId: "target" })];
  doc.objects.push(obj("target", { position: [10, 5, 0] }));
  const st = evaluate(doc, 0);
  near(st.objects.get("root").world.rotation, [0, Math.PI / 2, 0], 1e-6, "instance parent aims");
  near(st.objects.get("inst").world.position, [0, 5, -2], 1e-6, "instance world follows constrained parent");
}

// 3c. Unknown constraint type in an UNVALIDATED doc must not crash evaluate()
// (constraintChannels falls back to no channels; the constraint is a no-op).
{
  const doc = docOf(
    obj("a", { position: [1, 2, 3], constraints: [cst("w1", "warp_drive", { targetId: "b" })] }),
    obj("b"),
  );
  const st = evaluate(doc, 0);
  near(st.objects.get("a").position, [1, 2, 3], 1e-9, "unknown constraint type: pose untouched");
  assert.ok(!st.constrained.get("a"), "unknown constraint type: no channels owned");
}

// 3d. Stacked constraints: each entry sees the world pose the PREVIOUS one
// produced (Blender stack semantics). follow_path moves the owner to [10,0,0],
// then track_to must aim from THERE, not from the pre-stack origin.
{
  const doc = docOf(
    obj("probe", {
      constraints: [
        cst("fp", "follow_path", { params: { points: [[0, 0, 0], [10, 0, 0]], u: 1 } }),
        cst("tt", "track_to", { targetId: "mark" }),
      ],
    }),
    obj("mark", { position: [10, 5, 5] }),
  );
  const st = evaluate(doc, 0);
  near(st.objects.get("probe").position, [10, 0, 0], 1e-6, "stack: follow_path moved the owner first");
  const want = eulerFromQuat(axisQuat("+z", [0, 5, 5], [0, 1, 0]));
  near(st.objects.get("probe").rotation, want, 1e-6, "stack: track_to aims from the moved position");
}

// 3e. influence 0 owns its channels but writes nothing; enabled:false releases
// them entirely (pinned semantics — the documented way to disable).
{
  const doc = docOf(
    obj("a", { position: [5, 0, 0], constraints: [cst("l1", "limit_location", { influence: 0 })] }),
    obj("b", { position: [5, 0, 0], rotation: [2, 0, 0], constraints: [cst("l2", "limit_rotation", { enabled: false })] }),
    obj("c", { rotation: [2, 0, 0], constraints: [cst("l3", "limit_rotation", { enabled: 0 })] }),
  );
  const st = evaluate(doc, 0);
  near(st.objects.get("a").position, [5, 0, 0], 1e-9, "influence 0 writes nothing");
  assert.ok(st.constrained.get("a")?.has("position"), "influence 0 still owns the channel (pinned)");
  near(st.objects.get("b").rotation, [2, 0, 0], 1e-9, "enabled:false skips entirely");
  assert.ok(!st.constrained.get("b"), "enabled:false owns nothing");
  near(st.objects.get("c").rotation, [Math.PI / 2, 0, 0], 1e-9, "enabled:0 (non-boolean) runs (pinned)");
}

// 3f. Keyed influence: keys REPLACE the static value everywhere; before the
// first key the first key's value holds; step vs linear interp differs.
{
  const mk = (keys, staticInfluence) => docOf(
    obj("o", { position: [5, 0, 0], constraints: [cst("l", "limit_location", { influence: staticInfluence, keys })] }),
  );
  // Static 0 + single key influence 1 at t=2 → influence is 1 at t=0.
  near(evaluate(mk([{ t: 2, influence: 1 }], 0), 0).objects.get("o").position, [1, 0, 0], 1e-6, "keys override static influence (hold-first)");
  // Linear: halfway between influence 0 and 1 at t=0.5 → halfway between 5 and 1.
  near(evaluate(mk([{ t: 0, influence: 0 }, { t: 1, influence: 1 }], 1), 0.5).objects.get("o").position, [3, 0, 0], 1e-6, "linear influence blend");
  // Step: holds influence 0 until the key's own t.
  near(evaluate(mk([{ t: 0, influence: 0 }, { t: 1, influence: 1, interp: "step" }], 1), 0.5).objects.get("o").position, [5, 0, 0], 1e-6, "step holds source value");
  near(evaluate(mk([{ t: 0, influence: 0 }, { t: 1, influence: 1, interp: "step" }], 1), 1).objects.get("o").position, [1, 0, 0], 1e-6, "step reaches target at key t");
  // Unsorted keys in a DIRECT doc: segment() reads the array as-is (pinned;
  // the validator sorts on entry).
  near(evaluate(mk([{ t: 2, influence: 1 }, { t: 0, influence: 0 }], 0), 0).objects.get("o").position, [1, 0, 0], 1e-6, "unsorted keys: first array element holds");
}

// 3g. Constraint eval order (pinned): a target LATER in doc order is read at
// its provisional (keys+hooks) pose; mutual targets are deterministic and
// order-dependent (same caveat as Blender's simplified depsgraph).
{
  const forwardDoc = docOf(
    obj("a", { constraints: [cst("cl", "copy_location", { targetId: "b" })] }),
    obj("b", { position: [5, 0, 0], constraints: [cst("ll", "limit_location", { params: { min: [2, -1, -1], max: [2, 1, 1] } })] }),
  );
  near(evaluate(forwardDoc, 0).objects.get("a").position, [5, 0, 0], 1e-6, "forward target read pre-constraint (pinned)");
  const backwardDoc = docOf(
    obj("b", { position: [5, 0, 0], constraints: [cst("ll", "limit_location", { params: { min: [2, -1, -1], max: [2, 1, 1] } })] }),
    obj("a", { constraints: [cst("cl", "copy_location", { targetId: "b" })] }),
  );
  near(evaluate(backwardDoc, 0).objects.get("a").position, [2, 0, 0], 1e-6, "backward target read post-constraint");
  // Mutual copy_location, both doc orders.
  const m1 = docOf(
    obj("ma", { position: [1, 0, 0], constraints: [cst("x", "copy_location", { targetId: "mb" })] }),
    obj("mb", { position: [5, 0, 0], constraints: [cst("y", "copy_location", { targetId: "ma" })] }),
  );
  near(evaluate(m1, 0).objects.get("ma").position, [5, 0, 0], 1e-6, "mutual [A,B]: A follows provisional B");
  near(evaluate(m1, 0).objects.get("mb").position, [5, 0, 0], 1e-6, "mutual [A,B]: B follows final A");
  const m2 = docOf(
    obj("mb", { position: [5, 0, 0], constraints: [cst("y", "copy_location", { targetId: "ma" })] }),
    obj("ma", { position: [1, 0, 0], constraints: [cst("x", "copy_location", { targetId: "mb" })] }),
  );
  near(evaluate(m2, 0).objects.get("ma").position, [1, 0, 0], 1e-6, "mutual [B,A]: A follows final B");
  near(evaluate(m2, 0).objects.get("mb").position, [1, 0, 0], 1e-6, "mutual [B,A]: B follows provisional A");
}

// 3h. Self-targeting constraints: guarded no-ops / feedback, never crashes.
{
  const doc = docOf(
    obj("t", { rotation: [0.5, 0, 0], constraints: [cst("s1", "track_to", { targetId: "t" })] }),
    obj("c", { position: [3, 0, 0], constraints: [cst("s2", "copy_location", { targetId: "c" })] }),
    obj("f", { position: [3, 0, 0], constraints: [cst("s3", "transformation", { targetId: "f", params: { from: "position.x", to: "position.y", factor: 2 } })] }),
  );
  const st = evaluate(doc, 0);
  near(st.objects.get("t").rotation, [0.5, 0, 0], 1e-9, "track_to self: zero direction guard");
  near(st.objects.get("c").position, [3, 0, 0], 1e-9, "copy_location self: no-op");
  near(st.objects.get("f").position, [3, 6, 0], 1e-9, "transformation self: maps its own channel (feedback pinned)");
}

// 3i. follow_path: u beyond [0,1] (static and keyed) clamps to the endpoints;
// degenerate point sets collapse to a point.
{
  const mkPath = (u, keys) => docOf(
    obj("o", { constraints: [cst("fp", "follow_path", { params: { points: [[0, 0, 0], [10, 0, 0]], u }, keys })] }),
  );
  near(evaluate(mkPath(-1), 0).objects.get("o").position, [0, 0, 0], 1e-9, "u=-1 clamps to start");
  near(evaluate(mkPath(2), 0).objects.get("o").position, [10, 0, 0], 1e-9, "u=2 clamps to end");
  near(evaluate(mkPath(0, [{ t: 0, u: -5 }]), 0).objects.get("o").position, [0, 0, 0], 1e-9, "keyed u=-5 clamps");
  const degenerate = docOf(obj("o", { constraints: [cst("fp", "follow_path", { params: { points: [[1, 1, 1], [1, 1, 1], [1, 1, 1]], u: 0.5 } })] }));
  near(evaluate(degenerate, 0).objects.get("o").position, [1, 1, 1], 1e-9, "degenerate path collapses");
}

// 3j. limit_* semantics (pinned): min>max is silently swapped, clamping is on
// the RAW LOCAL value, limits are LOCAL not world, limit_scale default min.
{
  const doc = docOf(
    // min>max → lo=1, hi=5: 0 lifts to 1, 3 passes through, 9 drops to 5.
    obj("lo", { position: [0, 3, 9], constraints: [cst("l", "limit_location", { params: { min: [5, 5, 5], max: [1, 1, 1] } })] }),
    // Local, not world: parent at [10,0,0]; child local 0.5 is inside [-1,1].
    obj("parent", { position: [10, 0, 0] }),
    obj("child", { parentId: "parent", position: [0.5, 0, 0], constraints: [cst("l2", "limit_location")] }),
    // Raw clamp without euler wrap: 4 rad → π/2 (not 4-2π).
    obj("rot", { rotation: [4, 0, 0], constraints: [cst("l3", "limit_rotation")] }),
    // limit_scale default min 0.1 lifts zero scale.
    obj("scl", { scale: [0, 0, 0], constraints: [cst("l4", "limit_scale")] }),
  );
  const st = evaluate(doc, 0);
  near(st.objects.get("lo").position, [1, 3, 5], 1e-9, "min>max swapped");
  near(st.objects.get("child").position, [0.5, 0, 0], 1e-9, "limits are local");
  near(st.objects.get("child").world.position, [10.5, 0, 0], 1e-9, "limits do not touch the parent offset");
  near(st.objects.get("rot").rotation, [Math.PI / 2, 0, 0], 1e-9, "raw rotation clamp (no wrap)");
  near(st.objects.get("scl").scale, [0.1, 0.1, 0.1], 1e-9, "limit_scale default min 0.1");
}

// 3k. copy_* approximations (pinned).
{
  const doc = docOf(
    obj("sp", { scale: [2, 2, 2] }),
    obj("sc", { parentId: "sp", constraints: [cst("cs", "copy_scale", { targetId: "st" })] }),
    obj("st", { scale: [3, 1, 1] }),
    obj("inv", { position: [1, 0, 0], constraints: [cst("cl", "copy_location", { targetId: "ti", params: { invert: true } })] }),
    obj("ti", { position: [4, 0, 0] }),
    obj("cr", { constraints: [cst("cr", "copy_rotation", { targetId: "crt" })] }),
    obj("crt", { rotation: [0.2, 0.4, 0.6] }),
  );
  const st = evaluate(doc, 0);
  // World-decomposed target scale lands in LOCAL space → compounds with parent.
  near(st.objects.get("sc").scale, [3, 1, 1], 1e-9, "copy_scale writes world scale locally (pinned)");
  near(st.objects.get("sc").world.scale, [6, 2, 2], 1e-9, "copy_scale compounds with parent scale");
  // invert mirrors about the WORLD origin (pinned).
  near(st.objects.get("inv").position, [-4, 0, 0], 1e-9, "copy_location invert mirrors about origin");
  near(st.objects.get("cr").rotation, [0.2, 0.4, 0.6], 1e-9, "copy_rotation copies target euler");
}

// 3l. child_of with a malformed inverse (wrong length): solver falls back to
// identity → glues the owner onto the target (pinned asymmetry with validator).
{
  const doc = docOf(
    obj("o", { position: [9, 0, 0], constraints: [cst("co", "child_of", { targetId: "t", params: { inverse: [1, 2, 3] } })] }),
    obj("t", { position: [2, 0, 0] }),
  );
  near(evaluate(doc, 0).objects.get("o").position, [2, 0, 0], 1e-9, "malformed inverse → identity → glue");
}

// 3m. Hook + constraint writing the SAME channel: constraints run after hooks
// and win; both ownership maps list the channel. A NaN-writing hook degrades
// gracefully (no crash).
{
  const doc = docOf(obj("hero", { position: [0, 0, 0], constraints: [cst("l", "limit_location")] }));
  doc.onFrameScripts = ["(t, f) => f.update(f.find('hero'), { position: [5, 0, 0] })"];
  const st = evaluate(doc, 0);
  near(st.objects.get("hero").position, [1, 0, 0], 1e-9, "constraint clamps the hook value");
  assert.ok(st.hooked.get("hero")?.has("position") && st.constrained.get("hero")?.has("position"), "channel owned by both hook and constraint");
  const nanDoc = docOf(obj("n"));
  nanDoc.onFrameScripts = ["(t, f) => f.update(f.find('n'), { position: [NaN, 0, 0] })"];
  const nst = evaluate(nanDoc, 0);
  assert.ok(typeof nst.objects.get("n").position[0] === "number", "NaN hook does not crash evaluate");
}

console.log("3. constraint evaluation edges ✓");

// --- 4. constraintChannels ↔ solver table (drift guard) -------------------------------

const chans = (type, params = {}) => constraintChannels({ id: "x", type, params, influence: 1 });
assert.deepEqual(chans("track_to"), ["rotation"]);
assert.deepEqual(chans("follow_path"), ["position"]);
assert.deepEqual(chans("follow_path", { followRotation: true }), ["position", "rotation"]);
assert.deepEqual(chans("child_of"), ["position", "rotation"]);
assert.deepEqual(chans("child_of", { useLoc: false }), ["rotation"]);
assert.deepEqual(chans("child_of", { useLoc: false, useRot: false }), []);
assert.deepEqual(chans("child_of", { useScale: true }), ["position", "rotation", "scale"]);
assert.deepEqual(chans("limit_location"), ["position"]);
assert.deepEqual(chans("limit_rotation"), ["rotation"]);
assert.deepEqual(chans("limit_scale"), ["scale"]);
assert.deepEqual(chans("copy_location"), ["position"]);
assert.deepEqual(chans("copy_rotation"), ["rotation"]);
assert.deepEqual(chans("copy_scale"), ["scale"]);
for (const comp of ["position", "rotation", "scale"]) {
  for (const ax of ["x", "y", "z"]) assert.deepEqual(chans("transformation", { to: `${comp}.${ax}` }), [comp]);
}
assert.deepEqual(chans("warp_drive"), [], "unknown type owns nothing (no crash)");

console.log("4. constraintChannels table ✓");

// --- 5. validator rules ----------------------------------------------------------------

const V = (raw) => validateSceneDocument({ ...createEmptyDocument("V"), ...raw });

// 3-cycle: only the first doc-order member is re-rooted; the rest keep parents.
{
  const r = V({
    objects: [
      { ...obj("a", { parentId: "c" }), type: "box" },
      { ...obj("b", { parentId: "a" }), type: "box" },
      { ...obj("c", { parentId: "b" }), type: "box" },
    ],
  });
  assert.ok(!("error" in r), `3-cycle validates: ${r.error ?? ""}`);
  const byId = Object.fromEntries(r.doc.objects.map((o) => [o.id, o]));
  assert.ok(!byId.a.parentId, "3-cycle: first member re-rooted");
  assert.equal(byId.b.parentId, "a");
  assert.equal(byId.c.parentId, "b");
}

// Depth boundary: 64 ancestors survive, 65 re-roots only the deepest object.
{
  const chain = (n) => Array.from({ length: n }, (_, i) => ({ ...obj(`n${i}`, { parentId: i ? `n${i - 1}` : undefined }), type: "box" }));
  const ok64 = V({ objects: chain(65) }); // n64 has 64 ancestors
  assert.ok(!("error" in ok64));
  assert.equal(ok64.doc.objects.find((o) => o.id === "n64").parentId, "n63", "64-deep chain survives");
  const deep = V({ objects: chain(66) }); // n65 has 65 ancestors
  assert.ok(!("error" in deep));
  const n65 = deep.doc.objects.find((o) => o.id === "n65");
  assert.ok(!n65.parentId, "65-deep: deepest re-rooted");
  assert.equal(deep.doc.objects.find((o) => o.id === "n64").parentId, "n63", "65-deep: rest of the chain intact");
}

// Self-parent / dangling parent re-root silently.
{
  const r = V({ objects: [{ ...obj("s", { parentId: "s" }), type: "box" }, { ...obj("d", { parentId: "ghost" }), type: "box" }] });
  assert.ok(!("error" in r));
  assert.ok(!r.doc.objects.some((o) => o.parentId), "self/dangling parents dropped");
}

// Duplicate constraint ids across (and within) objects get deduped — every
// other entity type is suffix-renamed on collision; constraints must match.
{
  const r = V({
    objects: [
      { ...obj("o1", { constraints: [cst("c1", "track_to", { targetId: "o2" }), cst("c1", "limit_location")] }), type: "box" },
      { ...obj("o2", { constraints: [cst("c1", "limit_scale")] }), type: "box" },
    ],
  });
  assert.ok(!("error" in r), `dup constraint ids validate: ${r.error ?? ""}`);
  const ids = r.doc.objects.flatMap((o) => (o.constraints ?? []).map((c) => c.id));
  assert.equal(ids.length, 3, "all three constraints survive");
  assert.equal(new Set(ids).size, 3, "constraint ids deduped on collision");
}

// Instance validity is DOC-ORDER INDEPENDENT: an instance whose collection
// contains a (doomed) instance member is dropped in either order.
{
  const mk = (order) => {
    const objects = order === "instFirst"
      ? [obj("inst", { type: "instance", instanceOf: "col1" }), obj("m2", { type: "instance", instanceOf: "colX", collectionId: "col1" }), obj("post", { collectionId: "col1" })]
      : [obj("m2", { type: "instance", instanceOf: "colX", collectionId: "col1" }), obj("inst", { type: "instance", instanceOf: "col1" }), obj("post", { collectionId: "col1" })];
    return V({
      collections: [{ id: "col1", name: "C1", hidden: false }],
      objects: objects.map((o) => ({ ...o, type: o.type })),
    });
  };
  for (const order of ["instFirst", "memberFirst"]) {
    const r = mk(order);
    assert.ok(!("error" in r), `${order} validates`);
    const ids = r.doc.objects.map((o) => o.id);
    assert.ok(!ids.includes("inst"), `${order}: instance-of-collection-with-instance dropped`);
    assert.ok(!ids.includes("m2"), `${order}: dead-target instance dropped`);
    assert.ok(ids.includes("post"), `${order}: plain member survives`);
  }
}

// Constraint targeting a dropped instance cascades away.
{
  const r = V({
    collections: [{ id: "col1", name: "C1", hidden: false }],
    objects: [
      obj("hero", { constraints: [cst("tt", "track_to", { targetId: "gone" })] }),
      obj("gone", { type: "instance", instanceOf: "colX" }),
    ],
  });
  assert.ok(!("error" in r));
  assert.equal(r.doc.objects.length, 1);
  assert.ok(!r.doc.objects[0].constraints, "constraint on dropped target removed");
}

// Malformed child_of inverse silently ignored (identity fallback at solve).
{
  const r = V({ objects: [obj("o", { constraints: [cst("co", "child_of", { targetId: "t", params: { inverse: [1, 2, 3] } })] }), obj("t")] });
  assert.ok(!("error" in r), "short inverse validates");
  assert.ok(r.doc.objects[0].constraints[0].params.inverse === undefined, "malformed inverse dropped");
}

// u accepts any finite (clamped later at solve); influence clamps and
// hard-errors on non-numbers.
{
  const r = V({ objects: [obj("o", { constraints: [cst("fp", "follow_path", { params: { points: [[0, 0, 0], [1, 0, 0]], u: -5 }, influence: 2 })] })] });
  assert.ok(!("error" in r));
  const c = r.doc.objects[0].constraints[0];
  assert.equal(c.params.u, -5, "u unclamped at validation (pinned)");
  assert.equal(c.influence, 1, "influence clamped to 1");
  const bad = V({ objects: [obj("o", { constraints: [cst("fp", "follow_path", { influence: "high" })] })] });
  assert.ok("error" in bad && /influence/.test(bad.error), "non-number influence hard-errors");
}

// Numeric boundaries: points 2..256 ok / 1 and 257 error; constraint keys
// 256 ok / 257 error; 32 constraints ok / 33 error; key t beyond duration ok.
{
  const line = (n) => Array.from({ length: n }, (_, i) => [i, 0, 0]);
  assert.ok(!("error" in V({ objects: [obj("o", { constraints: [cst("fp", "follow_path", { params: { points: line(256) } })] })] })), "256 points ok");
  assert.ok("error" in V({ objects: [obj("o", { constraints: [cst("fp", "follow_path", { params: { points: line(257) } })] })] }), "257 points error");
  assert.ok("error" in V({ objects: [obj("o", { constraints: [cst("fp", "follow_path", { params: { points: line(1) } })] })] }), "1 point error");
  const keys = (n) => Array.from({ length: n }, (_, i) => ({ t: i, influence: 0.5 }));
  assert.ok(!("error" in V({ objects: [obj("o", { constraints: [cst("l", "limit_location", { keys: keys(256) })] })] })), "256 keys ok");
  assert.ok("error" in V({ objects: [obj("o", { constraints: [cst("l", "limit_location", { keys: keys(257) })] })] }), "257 keys error");
  const many = (n) => Array.from({ length: n }, (_, i) => cst(`c${i}`, "limit_scale"));
  assert.ok(!("error" in V({ objects: [obj("o", { constraints: many(32) })] })), "32 constraints ok");
  assert.ok("error" in V({ objects: [obj("o", { constraints: many(33) })] }), "33 constraints error");
  const late = V({ objects: [obj("o", { constraints: [cst("l", "limit_location", { keys: [{ t: 9999, influence: 1 }] })] })] });
  assert.ok(!("error" in late), "key t beyond duration accepted");
}

// Silent coercions (pinned): non-string constraint name dropped, unknown key
// interp becomes linear, duplicate key t survives.
{
  const r = V({ objects: [obj("o", { constraints: [cst("l", "limit_location", { name: 42, keys: [{ t: 1, influence: 0.5, interp: "wobble" }, { t: 1, influence: 1 }] })] })] });
  assert.ok(!("error" in r));
  const c = r.doc.objects[0].constraints[0];
  assert.ok(c.name === undefined, "non-string name dropped");
  assert.equal(c.keys[0].interp, "linear", "unknown interp coerced");
  assert.equal(c.keys.length, 2, "duplicate key t kept");
}

// Zero / negative object scales validate; evaluation stays finite.
{
  const r = V({ objects: [{ ...obj("z", { scale: [0, 0, 0] }), type: "box" }, { ...obj("m", { scale: [-1, 1, 1] }), type: "box" }] });
  assert.ok(!("error" in r), "zero/negative scale validate");
  const st = evaluate(r.doc, 0);
  finiteVec(st.objects.get("z").world.scale, "zero scale evaluates finite");
  finiteVec(st.objects.get("m").world.scale, "negative scale evaluates finite");
}

console.log("5. validator rules ✓");

// --- 6. hook find() + hook isolation ---------------------------------------------------

// find() must prefer an EXACT name over a doc-order-earlier partial match.
{
  const doc = docOf(obj("arm", { position: [0, 0, 0] }), obj("a", { position: [0, 0, 0] }));
  doc.onFrameScripts = ["(t, f) => f.update(f.find('a'), { position: [9, 9, 9] })"];
  const st = evaluate(doc, 0);
  near(st.objects.get("a").position, [9, 9, 9], 1e-9, "find prefers exact match");
  near(st.objects.get("arm").position, [0, 0, 0], 1e-9, "partial shadow does not move");
  // Partial matching still works when unambiguous.
  const doc2 = docOf(obj("arm", { position: [0, 0, 0] }));
  doc2.onFrameScripts = ["(t, f) => f.update(f.find('ar'), { position: [1, 2, 3] })"];
  near(evaluate(doc2, 0).objects.get("arm").position, [1, 2, 3], 1e-9, "unique partial match");
}

// Identical hook sources share ONE compiled entry + state object (pinned).
{
  const src = "(t, f, state) => { state.n = (state.n ?? 0) + 1; if (state.n >= 2) f.update(f.find('x'), { position: [7, 7, 7] }); }";
  const doc = docOf(obj("x", { position: [0, 0, 0] }));
  doc.onFrameScripts = [src, src];
  near(evaluate(doc, 0).objects.get("x").position, [7, 7, 7], 1e-9, "duplicate sources share state (2nd run fires)");
}

// A throwing hook is isolated; later hooks still run and its error is reported.
{
  const doc = docOf(obj("x", { position: [0, 0, 0] }));
  doc.onFrameScripts = ["(t, f) => { throw new Error('boom'); }", "(t, f) => f.update(f.find('x'), { position: [4, 4, 4] })"];
  const errors = [];
  const st = evaluate(doc, 0, errors);
  near(st.objects.get("x").position, [4, 4, 4], 1e-9, "later hook still runs");
  assert.equal(errors.length, 1, "throwing hook reported");
}

console.log("6. hook find() + isolation ✓");

console.log("All hierarchy-edge smoke tests passed ✓");
