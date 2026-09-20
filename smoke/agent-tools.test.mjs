// Agent-interface smoke test: exercises the NEW hierarchy/constraint tools
// (set_parent, manage_constraint, add_object, execute_code) through the real
// runTool() pipeline with a ToolContext that mirrors the production
// store.applyDoc semantics (validate → assign on success, SILENT revert on
// validation error) — so tool-vs-validator disagreements surface as
// post-state assertions, not just isError flags.
// Runs under tsx: `npx tsx smoke/agent-tools.test.mjs`.
import assert from "node:assert/strict";
import { runTool } from "../src/agent/tools";
import { validateSceneDocument } from "../src/core/validate";
import { createEmptyDocument, cloneDoc } from "../src/core/types";
import { createScriptTarget, createScriptingAPI } from "../src/core/scripting";
import { evaluate } from "../src/core/animation";
import { NodeSandbox } from "../server/sandboxNode";

const near = (a, b, eps = 1e-6, what = "") => {
  if (typeof a === "number") assert.ok(Math.abs(a - b) < eps, `${what}: ${a} vs ${b}`);
  else assert.ok(a.every((v, i) => Math.abs(v - b[i]) < eps), `${what}: [${a}] vs [${b}]`);
};

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
  const doc = createEmptyDocument("A");
  doc.objects.push(...objects);
  return doc;
};

/** ToolContext mirroring store.applyDoc: validate, assign on success, silently
 *  revert on error (the production behavior tool results are judged against). */
function makeCtx(startDoc, runSandbox) {
  let current = startDoc;
  const applied = [];
  const ctx = {
    getDoc: () => current,
    applyDoc(doc, label) {
      const result = validateSceneDocument(doc);
      if ("error" in result) return; // silent revert — exactly like the store
      applied.push(label);
      current = result.doc;
    },
    snapshot: async () => {
      throw new Error("snapshot not available in tests");
    },
    runSandbox: runSandbox ?? (async () => ({ ok: false, logs: [], error: "runSandbox not stubbed" })),
  };
  // Live view of the current doc for assertions (non-enumerable so spreading
  // ctx — e.g. to override runSandbox — does not freeze a stale snapshot).
  Object.defineProperty(ctx, "doc", { get: () => current });
  return { ctx, applied, get doc() { return current; } };
}
const call = (name, args, ctx) => runTool(name, JSON.stringify(args), ctx);

// --- 1. runTool dispatch -------------------------------------------------------

{
  const { ctx } = makeCtx(docOf(obj("hero")));
  const unknown = await runTool("explode_scene", "{}", ctx);
  assert.ok(unknown.isError && /unknown tool/.test(unknown.text), "unknown tool → ERROR");
  const badJson = await runTool("set_parent", "{oops", ctx);
  assert.ok(badJson.isError && /not valid JSON/.test(badJson.text), "invalid JSON args → ERROR");
  const nullArgs = await runTool("set_parent", "null", ctx);
  assert.ok(nullArgs.isError && /ERROR/.test(nullArgs.text), "null args → ERROR (not a crash)");
  assert.equal(ctx.getDoc().objects.length, 1, "doc untouched by failed dispatches");
}
console.log("1. runTool dispatch ✓");

// --- 2. set_parent tool ----------------------------------------------------------

{
  // 2a. Error paths.
  {
    const doc = docOf(obj("hero"), obj("target"), obj("turret"), obj("barrel", { parentId: "turret", position: [1, 0, 0] }));
    const { ctx } = makeCtx(doc);
    let r = await call("set_parent", {}, ctx);
    assert.ok(r.isError && /no object with id "undefined"/.test(r.text), "missing childId → ERROR");
    r = await call("set_parent", { childId: "nope", parentId: "target" }, ctx);
    assert.ok(r.isError && /set_parent: no object/.test(r.text), "nonexistent child → ERROR");
    r = await call("set_parent", { childId: "hero", parentId: "ghost" }, ctx);
    assert.ok(r.isError && /No object with id "ghost"/.test(r.text), "nonexistent parent → ERROR");
    r = await call("set_parent", { childId: "hero", parentId: "hero" }, ctx);
    assert.ok(r.isError && /own parent/i.test(r.text), "self-parent → ERROR");
    r = await call("set_parent", { childId: "turret", parentId: "barrel" }, ctx);
    assert.ok(r.isError && /descendant|cycle/i.test(r.text), "parenting to a descendant → ERROR");
    r = await call("set_parent", { childId: "hero", parentId: "target", keep: "banana" }, ctx);
    assert.ok(r.isError && /keep/i.test(r.text), `invalid keep → ERROR (got: ${r.text})`);
    assert.ok(!ctx.doc.objects.find((o) => o.id === "hero").parentId, "no mutation after failed calls");
  }

  // 2b. Unparent paths: "" and omitted parentId both unparent; root no-op safe.
  {
    const { ctx } = makeCtx(docOf(obj("turret", { position: [2, 0, 0] }), obj("barrel", { parentId: "turret", position: [1, 0, 0] })));
    let r = await call("set_parent", { childId: "barrel", parentId: "" }, ctx);
    assert.ok(!r.isError && /Unparented/.test(r.text), `parentId "" unparents (got: ${r.text})`);
    const barrel = ctx.doc.objects.find((o) => o.id === "barrel");
    assert.ok(!barrel.parentId, "parentId cleared");
    near(barrel.position, [3, 0, 0], 1e-9, "unparent keep-world re-bakes to world pose");
    r = await call("set_parent", { childId: "turret" }, ctx);
    assert.ok(!r.isError, "unparenting a root object is a safe no-op");
  }

  // 2c. Re-parent to the CURRENT parent: keep-world is a numeric no-op.
  {
    const doc = docOf(obj("p", { position: [1, 0, 0], rotation: [0, 0.7, 0] }), obj("c", { parentId: "p", position: [2, 1, 0], rotation: [0.3, 0, 0] }));
    const before = evaluate(doc, 0).objects.get("c").world;
    const { ctx } = makeCtx(doc);
    const r = await call("set_parent", { childId: "c", parentId: "p" }, ctx);
    assert.ok(!r.isError);
    const after = evaluate(ctx.doc, 0).objects.get("c").world;
    near(after.position, before.position, 1e-9, "same-parent: world position stable");
    near(after.rotation, before.rotation, 1e-9, "same-parent: world rotation stable");
  }

  // 2d. Keyframes are untouched by set_parent (guide promise: keys stay LOCAL).
  {
    const doc = docOf(obj("ground"), obj("flyer", { position: [5, 1, 0] }));
    doc.actions.push({ id: "act1", name: "Flight", kind: "object", objectId: "flyer", keys: [{ t: 0, position: [5, 1, 0], rotation: [0, 0, 0], scale: [1, 1, 1], interp: "linear" }, { t: 3, position: [0, 1, 0], rotation: [0, 0, 0], scale: [1, 1, 1], interp: "linear" }] });
    doc.objects.find((o) => o.id === "flyer").activeActionId = "act1";
    const { ctx } = makeCtx(doc);
    const r = await call("set_parent", { childId: "flyer", parentId: "ground" }, ctx);
    assert.ok(!r.isError);
    const after = ctx.doc.actions.find((a) => a.id === "act1");
    assert.deepEqual(after.keys, doc.actions[0].keys, "action keys byte-identical after set_parent");
    assert.equal(after.objectId, "flyer", "action still owned by the child");
  }

  // 2e. keep-world under a rotated + NON-UNIFORMLY scaled parent: decompose
  // cannot represent shear, so rotation/scale drift a little — position is
  // preserved exactly. Characterization (pinned) test.
  {
    const doc = docOf(obj("big", { scale: [1, 2, 1] }), obj("hero", { position: [3, 0, 0], rotation: [Math.PI / 4, 0, 0] }));
    const before = evaluate(doc, 0).objects.get("hero").world;
    const { ctx } = makeCtx(doc);
    const r = await call("set_parent", { childId: "hero", parentId: "big" }, ctx);
    assert.ok(!r.isError);
    const after = evaluate(ctx.doc, 0).objects.get("hero").world;
    near(after.position, before.position, 1e-9, "shear case: position preserved exactly");
    for (let i = 0; i < 3; i++) {
      assert.ok(Math.abs(after.rotation[i] - before.rotation[i]) < 1.0, `shear case: rotation drift bounded (${after.rotation[i]} vs ${before.rotation[i]})`);
      assert.ok(Math.abs(after.scale[i] - before.scale[i]) < 1.5, `shear case: scale drift bounded (${after.scale[i]} vs ${before.scale[i]})`);
    }
  }

  // 2f. Zero-scale parent (singular inverse): must stay finite, no NaN.
  {
    const doc = docOf(obj("flat", { position: [1, 1, 1], scale: [0, 0, 0] }), obj("hero", { position: [3, 0, 0] }));
    const { ctx } = makeCtx(doc);
    const r = await call("set_parent", { childId: "hero", parentId: "flat" }, ctx);
    assert.ok(!r.isError, `zero-scale parent accepted: ${r.text}`);
    const hero = ctx.doc.objects.find((o) => o.id === "hero");
    assert.ok(hero.position.every(Number.isFinite) && hero.scale.every(Number.isFinite), "zero-scale parent: finite re-bake");
  }
}
console.log("2. set_parent tool ✓");

// --- 3. manage_constraint tool ----------------------------------------------------

{
  // 3a. op dispatch: unknown/missing op must ERROR (no silent no-op success).
  {
    const { ctx } = makeCtx(docOf(obj("hero")));
    let r = await call("manage_constraint", { op: "banana", objectId: "hero" }, ctx);
    assert.ok(r.isError && /op/i.test(r.text), `unknown op → ERROR (got: ${r.text})`);
    r = await call("manage_constraint", { objectId: "hero" }, ctx);
    assert.ok(r.isError, "missing op → ERROR");
    assert.ok(!ctx.doc.objects[0].constraints, "no constraints created by bogus ops");
  }

  // 3b. add: type/target validation.
  {
    const { ctx } = makeCtx(docOf(obj("hero"), obj("target")));
    let r = await call("manage_constraint", { op: "add", objectId: "hero", type: "warp_drive", targetId: "target" }, ctx);
    assert.ok(r.isError && /Unknown constraint type/.test(r.text), "unknown type → ERROR");
    for (const type of ["track_to", "child_of", "copy_location", "transformation"]) {
      r = await call("manage_constraint", { op: "add", objectId: "hero", type }, ctx);
      assert.ok(r.isError && /targetId/i.test(r.text), `${type} without targetId → ERROR (got: ${r.text})`);
    }
    assert.ok(!ctx.doc.objects[0].constraints, "no phantom constraints persisted");
    r = await call("manage_constraint", { op: "add", objectId: "hero", type: "track_to", targetId: "ghost" }, ctx);
    assert.ok(r.isError && /no object with id "ghost"/.test(r.text), "dead targetId → ERROR");
    r = await call("manage_constraint", { op: "add", objectId: "ghost", type: "limit_scale" }, ctx);
    assert.ok(r.isError && /No object with id "ghost"/.test(r.text), "dead owner → ERROR");
    // Targetless types are fine.
    r = await call("manage_constraint", { op: "add", objectId: "hero", type: "limit_location" }, ctx);
    assert.ok(!r.isError, "limit_location without target OK");
    assert.equal(ctx.doc.objects[0].constraints.length, 1);
  }

  // 3c. add: influence normalization — out-of-range clamps, non-number errors
  // cleanly instead of silently reverting the whole apply later.
  {
    const { ctx } = makeCtx(docOf(obj("hero"), obj("target")));
    let r = await call("manage_constraint", { op: "add", objectId: "hero", type: "track_to", targetId: "target", influence: 5 }, ctx);
    assert.ok(!r.isError, "influence 5 accepted (clamped)");
    assert.equal(ctx.doc.objects[0].constraints[0].influence, 1, "influence clamped to 1 in persisted doc");
    r = await call("manage_constraint", { op: "add", objectId: "hero", type: "track_to", targetId: "target", influence: "0.5" }, ctx);
    assert.ok(r.isError && /influence/i.test(r.text), `string influence → clean ERROR (got: ${r.text})`);
  }

  // 3d. add: garbage params — the tool layer accepts them; the validator then
  // rejects the WHOLE apply which silently reverts (pinned architecture —
  // applyDoc is fire-and-forget). Assert the post-state stays consistent.
  {
    const { ctx } = makeCtx(docOf(obj("hero"), obj("target")));
    const r = await call("manage_constraint", { op: "add", objectId: "hero", type: "follow_path", params: { points: [[0, 0, 0]] } }, ctx);
    assert.ok(!r.isError, "tool layer accepts garbage params (pinned)");
    assert.ok(!ctx.doc.objects[0].constraints, "validator rejected the apply — doc unchanged (silent revert pinned)");
    assert.equal(ctx.doc.objects.length, 2, "revert restores the full doc");
  }

  // 3e. update paths.
  {
    const doc = docOf(obj("hero"), obj("target"));
    doc.objects[0].constraints = [{ id: "c1", type: "track_to", name: "Aim", enabled: true, influence: 1, targetId: "target", params: {} }];
    const { ctx } = makeCtx(doc);
    let r = await call("manage_constraint", { op: "update", objectId: "hero", id: "nope" }, ctx);
    assert.ok(r.isError && /No constraint with id "nope"/.test(r.text), "update unknown constraint → ERROR");
    r = await call("manage_constraint", { op: "update", objectId: "target", id: "c1" }, ctx);
    assert.ok(r.isError && /No constraint with id "c1" on object "target"/.test(r.text), "wrong owner → ERROR");
    r = await call("manage_constraint", { op: "update", objectId: "hero", id: "c1" }, ctx);
    assert.ok(!r.isError, "empty patch is a no-op OK (pinned)");
    r = await call("manage_constraint", { op: "update", objectId: "hero", id: "c1", targetId: "ghost" }, ctx);
    assert.ok(r.isError && /targetId/.test(r.text), "update to dead target → ERROR");
    r = await call("manage_constraint", { op: "update", objectId: "hero", id: "c1", influence: "0.5" }, ctx);
    assert.ok(r.isError && /influence/i.test(r.text), `update with string influence → ERROR (got: ${r.text})`);
    r = await call("manage_constraint", { op: "update", objectId: "hero", id: "c1", influence: -3 }, ctx);
    assert.ok(!r.isError);
    assert.equal(ctx.doc.objects[0].constraints[0].influence, 0, "update influence clamps to 0");
    r = await call("manage_constraint", { op: "setInverse", objectId: "hero", id: "c1" }, ctx);
    assert.ok(r.isError && /child_of/.test(r.text), "setInverse on non-child_of → ERROR");
  }

  // 3f. setKeys paths.
  {
    const doc = docOf(obj("hero"), obj("target"));
    doc.objects[0].constraints = [{ id: "c1", type: "follow_path", enabled: true, influence: 1, params: { points: [[0, 0, 0], [10, 0, 0]] } }];
    const { ctx } = makeCtx(doc);
    // Null element must be skipped, not crash.
    let r = await call("manage_constraint", { op: "setKeys", objectId: "hero", id: "c1", keys: [{ t: 0, u: 0 }, { t: 2, u: 1 }, null] }, ctx);
    assert.ok(!r.isError, `setKeys with null element OK (got: ${r.text})`);
    assert.equal(ctx.doc.objects[0].constraints[0].keys.length, 2, "null key entry skipped");
    r = await call("manage_constraint", { op: "setKeys", objectId: "hero", id: "c1", keys: Array.from({ length: 257 }, (_, i) => ({ t: i })) }, ctx);
    assert.ok(r.isError && /256/.test(r.text), "257 keys → ERROR");
    r = await call("manage_constraint", { op: "setKeys", objectId: "hero", id: "c1", keys: [{ t: 2, influence: 1 }, { t: 0, influence: 0 }] }, ctx);
    assert.ok(!r.isError);
    assert.deepEqual(ctx.doc.objects[0].constraints[0].keys.map((k) => k.t), [0, 2], "keys stored sorted");
    r = await call("manage_constraint", { op: "setKeys", objectId: "hero", id: "c1", keys: [] }, ctx);
    assert.ok(!r.isError);
    assert.ok(ctx.doc.objects[0].constraints[0].keys === undefined, "empty keys clears the track (pinned)");
    r = await call("manage_constraint", { op: "setKeys", objectId: "hero", id: "c1", keys: [{ t: 0, u: -2 }, { t: 1, u: 5, interp: "wobble" }] }, ctx);
    assert.ok(!r.isError);
    const keys = ctx.doc.objects[0].constraints[0].keys;
    assert.equal(keys[0].u, -2, "u out of [0,1] persists (pinned; clamped at solve)");
    assert.equal(keys[1].interp, "linear", "unknown interp normalized by the validator (pinned)");
    r = await call("manage_constraint", { op: "setKeys", objectId: "hero", id: "c1", keys: [{ t: 1, influence: 1 }, { t: 1, influence: 0 }] }, ctx);
    assert.ok(!r.isError && ctx.doc.objects[0].constraints[0].keys.length === 2, "duplicate key t persists");
  }

  // 3g. delete paths + per-object cap.
  {
    const doc = docOf(obj("hero"), obj("target"));
    doc.objects[0].constraints = Array.from({ length: 32 }, (_, i) => ({ id: `c${i}`, type: "limit_scale", enabled: true, influence: 1, params: {} }));
    const { ctx } = makeCtx(doc);
    let r = await call("manage_constraint", { op: "add", objectId: "hero", type: "limit_scale" }, ctx);
    assert.ok(r.isError && /32 constraints/.test(r.text), "33rd constraint → ERROR");
    r = await call("manage_constraint", { op: "delete", objectId: "hero", id: "nope" }, ctx);
    assert.ok(r.isError && /No constraint/.test(r.text), "delete unknown → ERROR");
    for (let i = 0; i < 32; i++) await call("manage_constraint", { op: "delete", objectId: "hero", id: `c${i}` }, ctx);
    assert.ok(!("constraints" in ctx.doc.objects[0]) || ctx.doc.objects[0].constraints === undefined, "constraints key removed with the last constraint");
  }

  // 3h. child_of auto-baked inverse through the tool: attaching does not move
  // the owner; it then follows the target's base-pose deltas.
  {
    const doc = docOf(obj("hero", { position: [3, 1, 0] }), obj("target", { position: [1, 0, 0] }));
    const { ctx } = makeCtx(doc);
    let r = await call("manage_constraint", { op: "add", objectId: "hero", type: "child_of", targetId: "target" }, ctx);
    assert.ok(!r.isError, "child_of add OK");
    const cid = ctx.doc.objects[0].constraints[0].id;
    near(evaluate(ctx.doc, 0).objects.get("hero").world.position, [3, 1, 0], 1e-9, "child_of attach: no jump");
    r = await call("update_object", { id: "target", position: [5, 0, 0] }, ctx);
    assert.ok(!r.isError);
    near(evaluate(ctx.doc, 0).objects.get("hero").world.position, [7, 1, 0], 1e-9, "child_of follows target delta");
    r = await call("manage_constraint", { op: "update", objectId: "hero", id: cid, setInverse: true }, ctx);
    assert.ok(!r.isError, "setInverse re-bake OK");
    // setInverse bakes from CURRENT BASE poses (documented): the owner's base
    // world is [3,1,0] and the target's base is now [5,0,0], so the offset
    // re-bakes to that relationship (owner snaps back to its base world).
    near(evaluate(ctx.doc, 0).objects.get("hero").world.position, [3, 1, 0], 1e-9, "setInverse re-bakes from base poses");
  }
}
console.log("3. manage_constraint tool ✓");

// --- 4. execute_code sandbox semantics ---------------------------------------------

// Inline mirror of src/agent/sandboxWorker.ts (the worker itself binds
// `self`, so it cannot be imported under Node) — same denylist + atomicity.
const FORBIDDEN = [/\bimport\s*[(\s]/, /\bfetch\s*\(/, /XMLHttpRequest/, /WebSocket/, /\bnew\s+Worker\b/, /importScripts/, /\brequire\s*\(/, /navigator\s*\./, /location\s*\./];
const mimicSandbox = async (code, doc) => {
  const logs = [];
  const fmt = (v) => (typeof v === "string" ? v : (() => { try { return JSON.stringify(v) ?? String(v); } catch { return String(v); } })());
  try {
    for (const re of FORBIDDEN) if (re.test(code)) throw new Error(`Forbidden API in sandbox code (pattern ${re}) — no network/DOM/imports allowed.`);
    const mirror = cloneDoc(doc);
    const target = createScriptTarget(mirror);
    const api = createScriptingAPI(target, (...args) => logs.push(args.map(fmt).join(" ")));
    // eslint-disable-next-line no-new-func
    const fn = new Function("api", `"use strict";\nreturn (async () => {\n${code}\n})();`);
    const result = await fn(api);
    return { ok: true, doc: mirror, logs, result: fmt(result) };
  } catch (err) {
    return { ok: false, logs, error: `${err.name}: ${err.message}` };
  }
};

{
  // 4a. Denylist: code AND comments are scanned (comments are not stripped — pinned).
  const mk = () => {
    const h = makeCtx(docOf(obj("hero"), obj("target")), null);
    // runSandbox reads the CURRENT doc (fresh mirror per run, like production).
    const wrapped = { ctx: { ...h.ctx, runSandbox: (code) => mimicSandbox(code, h.doc) } };
    return { ...h, ctx: wrapped.ctx };
  };
  let r = await call("execute_code", { code: `fetch("http://x")` }, mk().ctx);
  assert.ok(r.isError && /Forbidden/.test(r.text), "fetch rejected");
  r = await call("execute_code", { code: `// harmless comment mentioning fetch(x)` }, mk().ctx);
  assert.ok(r.isError && /Forbidden/.test(r.text), "denylist scans comments too (pinned)");
  r = await call("execute_code", { code: `require("fs")` }, mk().ctx);
  assert.ok(r.isError && /Forbidden/.test(r.text), "require rejected");

  // 4b. Atomicity: a run that throws discards ALL of its mutations.
  {
    const h = mk();
    const r = await call("execute_code", { code: `api.add({ type: "box" }); throw new Error("boom");` }, h.ctx);
    assert.ok(r.isError && /boom/.test(r.text), "throwing code → ERROR");
    assert.equal(h.doc.objects.length, 2, "mutations rolled back (atomicity)");
  }

  // 4c. Committed runs are visible to the next run.
  {
    const h = mk();
    let r = await call("execute_code", { code: `api.add({ type: "box", name: "Extra" });` }, h.ctx);
    assert.ok(!r.isError && /3 objects/.test(r.text), "first run commits");
    r = await call("execute_code", { code: `api.log(api.get().objects.length);` }, h.ctx);
    assert.ok(!r.isError && r.text.includes("3"), `second run sees the committed doc (${r.text.split("\n")[0]})`);
  }

  // 4d. Sandbox output that fails validation is silently reverted while the
  // tool reports success (pinned applyDoc architecture — documented, not fixed).
  {
    const h = mk();
    const r = await call("execute_code", { code: `api.get().objects[0].position = "nope";` }, h.ctx);
    assert.ok(!r.isError, "run itself succeeds");
    assert.ok(Array.isArray(h.doc.objects[0].position), "invalid mirror silently reverted (pinned)");
  }

  // 4e. api-layer validation errors surface as clean ERRORs (layer agreement).
  {
    const h = mk();
    let r = await call("execute_code", { code: `api.add({ type: "banana" });` }, h.ctx);
    assert.ok(r.isError && /Unknown geometry type/.test(r.text), "api.add rejects unknown type");
    r = await call("execute_code", { code: `api.setParent("hero", null, "banana");` }, h.ctx);
    assert.ok(r.isError && /keep/.test(r.text), "api.setParent rejects bad keep");
    r = await call("execute_code", { code: `api.addConstraint("hero", { type: "track_to" });` }, h.ctx);
    assert.ok(r.isError && /targetId/i.test(r.text), `api.addConstraint requires targetId (got: ${r.text})`);
    r = await call("execute_code", { code: `api.addConstraint("hero", { type: "warp_drive" });` }, h.ctx);
    assert.ok(r.isError && /Unknown constraint type/.test(r.text), "api.addConstraint rejects unknown type");
  }

  // 4f. api.find: exact, unique partial, ambiguous.
  {
    const doc = docOf(obj("hero"), obj("target"), obj("boxA"), obj("boxB"));
    const h = makeCtx(doc, null);
    const wrapped = { ctx: { ...h.ctx, runSandbox: (code) => mimicSandbox(code, h.doc) } };
    let r = await call("execute_code", { code: `api.log(api.find("hero")); api.log(api.find("tar"));` }, wrapped.ctx);
    assert.ok(!r.isError && r.text.includes("hero") && r.text.includes("target"), "find exact + unique partial");
    r = await call("execute_code", { code: `api.find("box");` }, wrapped.ctx);
    assert.ok(r.isError && /ambiguous/i.test(r.text), "find ambiguous throws");
  }
}
console.log("4. execute_code sandbox (mimic) ✓");

// 4g. The REAL Node sandbox worker (same code path the studio server uses):
// denylist, atomicity, timeout + recovery.
{
  const sb = new NodeSandbox();
  try {
    const base = docOf(obj("hero"));
    let r = await sb.run("fetch('http://x')", base);
    assert.ok(!r.ok && /Forbidden/.test(r.error ?? ""), "NodeSandbox: fetch rejected");
    r = await sb.run("api.add({ type: 'box' }); throw new Error('boom');", base);
    assert.ok(!r.ok && /boom/.test(r.error ?? ""), "NodeSandbox: error run");
    assert.equal((r.doc ?? base).objects.length, 1, "NodeSandbox: failed run returns no doc (atomicity)");
    r = await sb.run("api.add({ type: 'box' }); return api.get().objects.length;", base);
    assert.ok(r.ok, `NodeSandbox: success run (${r.error ?? ""})`);
    assert.equal(r.doc.objects.length, 2, "NodeSandbox: doc mirrored back");
    assert.equal(r.result, "2", "NodeSandbox: return value stringified");
    r = await sb.run("while (true) {}", base);
    assert.ok(!r.ok && /timeout/i.test(r.error ?? ""), `NodeSandbox: infinite loop times out (${r.error ?? ""})`);
    r = await sb.run("return 1 + 1;", base);
    assert.ok(r.ok && r.result === "2", "NodeSandbox: worker recovered after timeout");
  } finally {
    sb.dispose();
  }
}
console.log("5. NodeSandbox worker ✓");

// --- 6. add_object tool (empty / instance / parentId) -------------------------------

{
  // 6a. empty anchor.
  {
    const { ctx } = makeCtx(docOf(obj("hero")));
    const r = await call("add_object", { object: { type: "empty", name: "Anchor", position: [1, 2, 3] } }, ctx);
    assert.ok(!r.isError && /Added object id/.test(r.text), "empty add OK");
    const added = ctx.doc.objects.find((o) => o.type === "empty");
    assert.ok(added, "empty persisted");
    near(added.position, [1, 2, 3], 1e-9, "empty position");
    assert.ok(typeof added.params.size === "number", "empty gets catalog param defaults");
  }

  // 6b. instance: valid / missing / dead / recursive targets.
  {
    const doc = docOf(obj("post"));
    doc.collections.push({ id: "col", name: "Gate" });
    doc.objects[0].collectionId = "col";
    const { ctx } = makeCtx(doc);
    let r = await call("add_object", { object: { type: "instance", instanceOf: "col", position: [5, 0, 0] } }, ctx);
    assert.ok(!r.isError, "valid instance OK");
    assert.equal(ctx.doc.objects.find((o) => o.type === "instance").instanceOf, "col");
    r = await call("add_object", { object: { type: "instance" } }, ctx);
    assert.ok(r.isError && /instanceOf/.test(r.text), "instance without instanceOf → ERROR");
    r = await call("add_object", { object: { type: "instance", instanceOf: "nope" } }, ctx);
    assert.ok(r.isError && /instanceOf/.test(r.text), "dead instanceOf → ERROR");
    // Recursive: put an instance member into a NEW collection, then instance it.
    doc.collections.push({ id: "col2", name: "Nested" });
    const h2 = makeCtx(structuredClone({ ...doc, objects: [...doc.objects.map((o) => ({ ...o }))] }));
    const nested = h2.doc;
    nested.objects.push({ ...obj("innerInst", { type: "instance", instanceOf: "col", collectionId: "col2" }) });
    r = await call("add_object", { object: { type: "instance", instanceOf: "col2" } }, h2.ctx);
    assert.ok(r.isError && /recursive/i.test(r.text), "instancing a collection that contains an instance → ERROR");
  }

  // 6c. parentId on add (LOCAL pose semantics).
  {
    const doc = docOf(obj("p", { position: [10, 0, 0], rotation: [0, Math.PI / 2, 0] }));
    const { ctx } = makeCtx(doc);
    const r = await call("add_object", { object: { type: "box", parentId: "p", position: [1, 0, 0] } }, ctx);
    assert.ok(!r.isError, "add with parentId OK");
    const child = ctx.doc.objects.find((o) => o.parentId === "p");
    near(child.position, [1, 0, 0], 1e-9, "stored pose is LOCAL");
    near(evaluate(ctx.doc, 0).objects.get(child.id).world.position, [10, 0, -1], 1e-9, "world = parent × local");
    const r2 = await call("add_object", { object: { type: "box", parentId: "ghost" } }, ctx);
    assert.ok(r2.isError && /parentId/i.test(r2.text), "dead parentId → ERROR");
  }

  // 6d. Unknown geometry type: the tool layer accepts (target.add has no type
  // check) but the validator rejects the whole apply → silent revert while the
  // tool claims success (pinned; tracked as future hardening).
  {
    const { ctx } = makeCtx(docOf(obj("hero")));
    const r = await call("add_object", { object: { type: "banana" } }, ctx);
    assert.ok(!r.isError, "unknown geometry type: tool says OK (pinned)");
    assert.equal(ctx.doc.objects.length, 1, "validator reverted the apply — count unchanged (pinned)");
  }
}
console.log("6. add_object tool ✓");

console.log("All agent-tools smoke tests passed ✓");
