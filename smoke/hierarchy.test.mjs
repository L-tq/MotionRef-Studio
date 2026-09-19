// Hierarchy / empties / instances / constraints smoke test for the pure core
// (runs under tsx; imports real three.js to verify xform parity).
import assert from "node:assert/strict";
import * as THREE from "three";
import { createEmptyDocument, newId } from "../src/core/types";
import { evaluate } from "../src/core/animation";
import { validateSceneDocument } from "../src/core/validate";
import { createScriptTarget, createScriptingAPI } from "../src/core/scripting";
import {
  axisQuat,
  baseWorldOf,
  eulerFromQuat,
  matDecompose,
  matFromTRS,
  matFromQuat,
  matInvert,
  matMultiply,
  quatFromEuler,
  samplePolyline,
} from "../src/core/xform";

const near = (a, b, eps = 1e-6, what = "") => {
  if (typeof a === "number") assert.ok(Math.abs(a - b) < eps, `${what}: ${a} vs ${b}`);
  else assert.ok(a.every((v, i) => Math.abs(v - b[i]) < eps), `${what}: [${a}] vs [${b}]`);
};

// --- 1. xform parity against real three.js --------------------------------------

const rnd = (s) => {
  // Deterministic pseudo-random so failures reproduce.
  let x = s;
  return () => {
    x = (x * 1103515245 + 12345) % 2147483648;
    return x / 2147483648;
  };
};
const rand = rnd(42);

for (let i = 0; i < 200; i++) {
  const pos = [(rand() - 0.5) * 20, (rand() - 0.5) * 20, (rand() - 0.5) * 20];
  const eul = [(rand() - 0.5) * 6, (rand() - 0.5) * 6, (rand() - 0.5) * 6];
  const scl = [0.2 + rand() * 2, 0.2 + rand() * 2, 0.2 + rand() * 2];

  const tq = new THREE.Quaternion().setFromEuler(new THREE.Euler(eul[0], eul[1], eul[2], "XYZ"));
  const mq = quatFromEuler(eul);
  near([mq[0], mq[1], mq[2], mq[3]], [tq.x, tq.y, tq.z, tq.w], 1e-9, `quatFromEuler #${i}`);

  const te = new THREE.Euler().setFromQuaternion(tq, "XYZ");
  near(eulerFromQuat(mq), [te.x, te.y, te.z], 1e-6, `eulerFromQuat #${i}`);

  const tm = new THREE.Matrix4().compose(
    new THREE.Vector3(...pos),
    tq,
    new THREE.Vector3(...scl),
  );
  near(matFromTRS(pos, eul, scl), Array.from(tm.elements), 1e-9, `matFromTRS #${i}`);

  const tin = new THREE.Matrix4().copy(tm).invert();
  near(matInvert(matFromTRS(pos, eul, scl)), Array.from(tin.elements), 1e-7, `matInvert #${i}`);

  const ta = new THREE.Matrix4().compose(
    new THREE.Vector3(...pos),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(eul[1], eul[2], eul[0], "XYZ")),
    new THREE.Vector3(...scl),
  );
  const tmul = new THREE.Matrix4().multiplyMatrices(ta, tm);
  near(matMultiply(matFromTRS(pos, [eul[1], eul[2], eul[0]], scl), matFromTRS(pos, eul, scl)), Array.from(tmul.elements), 1e-8, `matMultiply #${i}`);

  const dp = new THREE.Vector3();
  const dq = new THREE.Quaternion();
  const ds = new THREE.Vector3();
  tm.decompose(dp, dq, ds);
  const my = matDecompose(matFromTRS(pos, eul, scl));
  near(my.position, [dp.x, dp.y, dp.z], 1e-7, `decompose pos #${i}`);
  near(my.scale, [ds.x, ds.y, ds.z], 1e-7, `decompose scale #${i}`);
  const de = new THREE.Euler().setFromQuaternion(dq, "XYZ");
  near(my.rotation, [de.x, de.y, de.z], 1e-5, `decompose rot #${i}`);
}

// axisQuat aims a local axis at a direction (check via three: rotate the
// canonical axis by the quaternion, expect the direction).
for (const axis of ["+x", "-x", "+y", "-y", "+z", "-z"]) {
  const dir = [0.3, -0.5, 0.8];
  const q = axisQuat(axis, dir, [0, 1, 0]);
  const canon = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) }[axis[1]];
  if (axis[0] === "-") canon.negate();
  const v = canon.clone().applyQuaternion(new THREE.Quaternion(q[0], q[1], q[2], q[3]));
  const d = new THREE.Vector3(...dir).normalize();
  assert.ok(v.dot(d) > 0.9999, `axisQuat(${axis}) aims at dir: dot=${v.dot(d)}`);
}

console.log("1. xform parity vs three.js ✓");

// --- 2. parenting: world = parent.world × local ----------------------------------

{
  const doc = createEmptyDocument("P");
  doc.objects.push({ id: "p1", name: "Parent", type: "box", params: {}, position: [5, 0, 0], rotation: [0, Math.PI / 2, 0], scale: [1, 1, 1], color: "#ffffff", visible: true });
  doc.objects.push({ id: "c1", name: "Child", type: "box", params: {}, position: [1, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], color: "#ffffff", visible: true, parentId: "p1" });

  const st = evaluate(doc, 0);
  const child = st.objects.get("c1");
  // Parent rotated +90° about Y: child local +X becomes world -Z? Ry(90°)·[1,0,0]
  // = [cos90, 0, -sin90] = [0,0,-1] → world position [5,0,-1].
  near(child.world.position, [5, 0, -1], 1e-6, "parented world position");
  near(child.position, [1, 0, 0], 1e-9, "local pose stays local");

  // world matrix parity with three
  const tm = new THREE.Matrix4().compose(
    new THREE.Vector3(1, 0, 0),
    new THREE.Quaternion(),
    new THREE.Vector3(1, 1, 1),
  ).premultiply(
    new THREE.Matrix4().compose(
      new THREE.Vector3(5, 0, 0),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI / 2, 0, "XYZ")),
      new THREE.Vector3(1, 1, 1),
    ),
  );
  near(st.worldMats.get("c1"), Array.from(tm.elements), 1e-9, "child world matrix");

  // Deep chain: grandchild composes through both.
  doc.objects.push({ id: "g1", name: "Grandchild", type: "box", params: {}, position: [0, 2, 0], rotation: [0, 0, 0], scale: [1, 1, 1], color: "#ffffff", visible: true, parentId: "c1" });
  const st2 = evaluate(doc, 0);
  near(st2.objects.get("g1").world.position, [5, 2, -1], 1e-6, "grandchild world");

  // baseWorldOf composes base poses (unkeyed) identically.
  near(matDecompose(baseWorldOf(doc, "g1")).position, [5, 2, -1], 1e-6, "baseWorldOf");
}
console.log("2. parenting composition ✓");

// --- 3. path sampling ---------------------------------------------------------------

{
  const s = samplePolyline([[0, 0, 0], [10, 0, 0]], 0.5);
  near(s.point, [5, 0, 0], 1e-6, "two-point path midpoint");
  near(s.tangent, [1, 0, 0], 1e-3, "two-point tangent");
  const s0 = samplePolyline([[0, 0, 0], [10, 0, 0]], 0);
  near(s0.point, [0, 0, 0], 1e-6, "u=0");
  const curved = samplePolyline([[0, 0, 0], [5, 0, 0], [5, 5, 0]], 0.5);
  // Halfway along ~10.3 units of Catmull-Rom arc — x well past 5 start of turn.
  assert.ok(curved.point[0] > 4 && curved.point[0] < 5.5, `curved mid x ${curved.point[0]}`);
  assert.ok(curved.point[1] > -0.5 && curved.point[1] < 0.5, `curved mid y ${curved.point[1]}`);
}
console.log("3. path sampling ✓");

// --- 4. constraint behaviors ---------------------------------------------------------

const objBase = (id, extra = {}) => ({
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

{
  // track_to: aim +z at a target on +x → yaw +90°.
  const doc = createEmptyDocument("T");
  doc.objects.push(objBase("turret"), objBase("enemy", { position: [10, 0, 0] }));
  doc.objects[0].constraints = [{ id: "c1", type: "track_to", targetId: "enemy", params: { axis: "+z" }, influence: 1 }];
  const st = evaluate(doc, 0);
  near(st.objects.get("turret").rotation, [0, Math.PI / 2, 0], 1e-4, "track_to yaw");

  // Parented owner: local rotation is parent-relative but world aims correctly
  // (from the turret's world position [0,0,5] toward the enemy at [10,0,0]).
  doc.objects.push(objBase("ship", { position: [0, 0, 5], rotation: [0, Math.PI, 0] }));
  doc.objects[0].parentId = "ship";
  const st2 = evaluate(doc, 0);
  const q = new THREE.Quaternion()
    .setFromEuler(new THREE.Euler(0, Math.PI, 0))
    .multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(...st2.objects.get("turret").rotation)));
  const aim = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
  const want = new THREE.Vector3(10, 0, -5).normalize();
  assert.ok(aim.dot(want) > 0.999, `parented track_to world aim: ${aim.toArray()} vs ${want.toArray()}`);
  assert.ok(st2.constrained.get("turret").has("rotation"), "track_to marks rotation constrained");
}
{
  // follow_path: keyframed u drives traversal.
  const doc = createEmptyDocument("F");
  doc.objects.push(objBase("car"));
  doc.objects[0].constraints = [
    {
      id: "c1",
      type: "follow_path",
      params: { points: [[0, 0, 0], [10, 0, 0]] },
      keys: [
        { t: 0, u: 0 },
        { t: 6, u: 1 },
      ],
    },
  ];
  near(evaluate(doc, 0).objects.get("car").position, [0, 0, 0], 1e-6, "follow_path u@0");
  near(evaluate(doc, 3).objects.get("car").position, [5, 0, 0], 1e-6, "follow_path u@mid");
  near(evaluate(doc, 6).objects.get("car").position, [10, 0, 0], 1e-6, "follow_path u@end");
}
{
  // child_of: identity inverse → owner glued to the target; keyed influence blends.
  const doc = createEmptyDocument("C");
  doc.objects.push(objBase("ball", { position: [0, 0, 0] }), objBase("hand", { position: [3, 0, 0] }));
  const id16 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  doc.objects[0].constraints = [
    { id: "c1", type: "child_of", targetId: "hand", params: { inverse: id16 }, influence: 1 },
  ];
  near(evaluate(doc, 0).objects.get("ball").world.position, [3, 0, 0], 1e-5, "child_of glues to target");

  doc.objects[0].constraints[0].influence = 0.5;
  near(evaluate(doc, 0).objects.get("ball").world.position, [1.5, 0, 0], 1e-5, "child_of influence 0.5");

  doc.objects[0].constraints[0].influence = 0;
  doc.objects[0].constraints[0].keys = [
    { t: 0, influence: 0 },
    { t: 2, influence: 1 },
  ];
  near(evaluate(doc, 1).objects.get("ball").world.position, [1.5, 0, 0], 1e-5, "keyed influence at t=1");

  // A baked set-inverse (ballWorld × handWorld⁻¹) keeps the current offset —
  // the object follows the target's motion without jumping.
  const baked = matMultiply(matFromTRS([0, 0, 0], [0, 0, 0], [1, 1, 1]), matInvert(matFromTRS([3, 0, 0], [0, 0, 0], [1, 1, 1])));
  doc.objects[0].constraints[0].keys = undefined;
  doc.objects[0].constraints[0].influence = 1;
  doc.objects[0].constraints[0].params.inverse = baked;
  near(evaluate(doc, 0).objects.get("ball").world.position, [0, 0, 0], 1e-5, "baked inverse keeps offset");
  doc.objects[1].position = [5, 0, 0]; // hand moves +2 in x
  near(evaluate(doc, 0).objects.get("ball").world.position, [2, 0, 0], 1e-5, "baked inverse follows delta");
}
{
  // limit_rotation clamps a hinge.
  const doc = createEmptyDocument("L");
  doc.objects.push(objBase("door", { rotation: [0, 2, 0] }));
  doc.objects[0].constraints = [{ id: "c1", type: "limit_rotation", params: { min: [0, 0, 0], max: [0, Math.PI / 2, 0] }, influence: 1 }];
  near(evaluate(doc, 0).objects.get("door").rotation[1], Math.PI / 2, 1e-6, "limit_rotation clamps to max");
}
{
  // copy_location copies world position.
  const doc = createEmptyDocument("K");
  doc.objects.push(objBase("a"), objBase("b", { position: [4, 5, 6] }));
  doc.objects[0].constraints = [{ id: "c1", type: "copy_location", targetId: "b", params: {}, influence: 1 }];
  near(evaluate(doc, 0).objects.get("a").world.position, [4, 5, 6], 1e-6, "copy_location");
}
{
  // transformation: target rotation.x × factor drives owner position.y.
  const doc = createEmptyDocument("X");
  doc.objects.push(objBase("chassis"), objBase("wheel", { rotation: [Math.PI, 0, 0] }));
  doc.objects[0].constraints = [{ id: "c1", type: "transformation", targetId: "wheel", params: { from: "rotation.x", to: "position.y", factor: 2 }, influence: 1 }];
  near(evaluate(doc, 0).objects.get("chassis").position[1], 2 * Math.PI, 1e-6, "transformation mapping");
}
console.log("4. constraint behaviors ✓");

// --- 5. validator: hierarchy/instance/constraint rules -------------------------------

{
  const base = createEmptyDocument("V");
  base.collections.push({ id: "col1", name: "Assembly" });
  const good = structuredClone(base);
  good.objects.push(
    objBase("root", { type: "empty" }),
    objBase("child", { parentId: "root" }),
    objBase("inst", { type: "instance", instanceOf: "col1", collectionId: "col1" }),
    objBase("member", { collectionId: "col1" }),
  );
  // The instance must NOT be a member of its own collection (recursion)…
  good.objects[2].collectionId = undefined;
  good.objects[1].constraints = [{ id: "k1", type: "track_to", targetId: "member", params: { axis: "+y" }, influence: 0.5 }];
  const ok = validateSceneDocument(good);
  assert.ok(!("error" in ok), `valid doc rejected: ${ok.error}`);
  assert.equal(ok.doc.objects.length, 4, "all objects survive");
  assert.equal(ok.doc.objects[1].constraints.length, 1, "constraint survives");
  assert.equal(ok.doc.objects[1].constraints[0].params.axis, "+y");

  // Cyclic parenting re-roots the child.
  const cyc = structuredClone(good);
  cyc.objects[0].parentId = "child";
  const rc = validateSceneDocument(cyc);
  assert.ok(!("error" in rc));
  assert.equal(rc.doc.objects[0].parentId, undefined, "cycle broken at the root object");
  assert.equal(rc.doc.objects[1].parentId, "root", "valid arm untouched");

  // Orphan constraint targets drop the constraint.
  const orph = structuredClone(good);
  orph.objects[3].id = "gone";
  const ro = validateSceneDocument(orph);
  assert.ok(!("error" in ro));
  assert.equal(ro.doc.objects[1].constraints, undefined, "orphan-target constraint dropped");

  // Instance with a dead collection target is dropped whole.
  const dead = structuredClone(good);
  dead.collections = [];
  const rd = validateSceneDocument(dead);
  assert.ok(!("error" in rd));
  assert.ok(!rd.doc.objects.some((o) => o.type === "instance"), "dead-target instance dropped");
  assert.equal(rd.doc.objects.length, 3);

  // Recursive instancing (instance inside the instanced collection) is banned.
  const rec = structuredClone(good);
  rec.objects[2].collectionId = "col1"; // instance is a member of its own target
  const rr = validateSceneDocument(rec);
  assert.ok(!("error" in rr));
  assert.ok(!rr.doc.objects.some((o) => o.type === "instance"), "recursive instance dropped");

  // Malformed constraint hard-errors (agent feedback).
  const bad = structuredClone(good);
  bad.objects[1].constraints = [{ id: "k1", type: "warp_drive", params: {}, influence: 1 }];
  assert.ok("error" in validateSceneDocument(bad), "unknown constraint type errors");

  // Old documents (no new fields) validate unchanged.
  const legacy = validateSceneDocument(createEmptyDocument("Old"));
  assert.ok(!("error" in legacy));
}
console.log("5. validator rules ✓");

// --- 6. hooks stay local; constraints run after hooks -------------------------------

{
  const doc = createEmptyDocument("H");
  doc.objects.push(objBase("p", { position: [2, 0, 0] }), objBase("c", { parentId: "p" }));
  doc.onFrameScripts.push(`(t, f) => { f.update("c", { position: [1, t, 0] }); }`);
  const st = evaluate(doc, 2);
  near(st.objects.get("c").position, [1, 2, 0], 1e-6, "hook writes local");
  near(st.objects.get("c").world.position, [3, 2, 0], 1e-6, "hooked local composes with parent");
}
console.log("6. hook locality ✓");

// --- 7. scripting: setParent + constraint management -------------------------------

{
  const doc = createEmptyDocument("S");
  const target = createScriptTarget(doc);
  const api = createScriptingAPI(target, () => {});

  const parent = target.add({ type: "box", name: "Parent", position: [4, 0, 0], rotation: [0, Math.PI / 2, 0] });
  const child = target.add({ type: "box", name: "Child", position: [6, 0, 0] }); // world [6,0,0]

  target.setParent(child, parent, "world");
  let st = evaluate(doc, 0);
  near(st.objects.get(child).world.position, [6, 0, 0], 1e-6, "setParent keep-world");
  // Local pose re-baked: parent Ry(90°) at [4,0,0] maps +z→+x, so local = [0,0,2].
  near(doc.objects.find((o) => o.id === child).position, [0, 0, 2], 1e-5, "keep-world local re-bake");

  // Cycle rejection (while child is still parented, re-parenting the ancestor
  // under the child would loop).
  assert.throws(() => target.setParent(parent, child), /cycle|descendant/i, "cycle parenting rejected");

  target.setParent(child, null, "world");
  near(doc.objects.find((o) => o.id === child).position, [6, 0, 0], 1e-6, "unparent keep-world");

  // child_of addConstraint auto-bakes the inverse: attaching does not move the ball.
  const hand = target.add({ type: "box", name: "Hand", position: [3, 0, 0] });
  const ball = target.add({ type: "sphere", name: "Ball", position: [1, 0, 0] });
  const cid = target.addConstraint(ball, { type: "child_of", targetId: hand });
  st = evaluate(doc, 0);
  near(st.objects.get(ball).world.position, [1, 0, 0], 1e-5, "child_of keeps offset on attach");
  target.update(hand, { position: [5, 0, 0] }); // hand moves +2
  st = evaluate(doc, 0);
  near(st.objects.get(ball).world.position, [3, 0, 0], 1e-5, "child_of follows the target delta");

  // api surface passthrough.
  api.updateConstraint(ball, cid, { influence: 0.5 });
  api.constraintKeys(ball, cid, [
    { t: 0, influence: 0 },
    { t: 2, influence: 1 },
  ]);
  near(evaluate(doc, 1).objects.get(ball).world.position, [2, 0, 0], 1e-4, "api keyed influence");
  api.removeConstraint(ball, cid);
  assert.equal(doc.objects.find((o) => o.id === ball).constraints, undefined, "constraint removed");

  // Empty + instance via api.add.
  const anchor = api.add({ type: "empty", name: "Root", position: [0, 1, 0] });
  const col = api.addCollection("Assembly");
  const member = api.add({ type: "box", collectionId: col, position: [0, 0, 0] });
  // Masters stay visible; the COLLECTION is hidden instead (view-layer
  // exclusion — instances of hidden collections still render).
  doc.collections.find((c) => c.id === col).hidden = true;
  const inst = api.add({ type: "instance", name: "Copy", instanceOf: col, position: [8, 0, 0] });
  assert.throws(() => api.add({ type: "instance", instanceOf: "nope" }), /instanceOf/i, "instance needs a real collection");
  st = evaluate(doc, 0);
  near(st.objects.get(inst).world.position, [8, 0, 0], 1e-6, "instance evaluates as an object");
  // The doc round-trips through the validator with everything intact.
  const ok = validateSceneDocument(doc);
  assert.ok(!("error" in ok), `scripted doc rejected: ${ok.error}`);
  assert.ok(ok.doc.objects.some((o) => o.id === anchor && o.type === "empty"));
  assert.ok(ok.doc.objects.some((o) => o.id === inst && o.type === "instance"));
  assert.equal(ok.doc.collections.find((c) => c.id === col).hidden, true, "collection hidden flag survives");

  // Deleting a parent moves children up to ITS parent, keep-world.
  api.setParent(child, parent, "world"); // child under parent at [5,0,0] world
  target.remove(parent);
  near(doc.objects.find((o) => o.id === child).position, [6, 0, 0], 1e-6, "remove re-parents keep-world");
  assert.equal(doc.objects.find((o) => o.id === child).parentId, undefined, "re-rooted");
}
console.log("7. scripting api ✓");

console.log("All hierarchy/constraint smoke tests passed ✓");
