// @mention feature smoke test for the pure helpers in src/agent/mentions.ts
// (DOM-free; runs under tsx like markers.test.mjs).
import assert from "node:assert/strict";
import { createEmptyDocument } from "../src/core/types";
import {
  filterMentionItems,
  formatSnapT,
  fromChatImageItems,
  imageToken,
  mentionQueryAt,
  mergeSnapshotImages,
  parseMentions,
  referencesBlock,
  snapshotMentionItems,
  snapshotToken,
  splitByMentions,
} from "../src/agent/mentions";

// --- fixture scene ---------------------------------------------------------------------------
const doc = createEmptyDocument("T");
doc.objects.push(
  { id: "o1", name: "Box", type: "box", params: {}, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], color: "#ffffff", visible: true },
  { id: "o2", name: "Box 2", type: "box", params: {}, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], color: "#ffffff", visible: true },
  { id: "o3", name: "Knot", type: "torusKnot", params: {}, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], color: "#ffffff", visible: true },
);
doc.cameras[0].name = "Camera 1";
doc.cameras.push({ id: "cam2", name: "Camera 2", position: [1, 1, 1], target: [0, 0, 0], fov: 40 });
doc.activeCameraId = "cam2";

// --- 1. parseMentions: names, longest match, boundaries --------------------------------------
const m1 = parseMentions("spin @Box 2 around", doc);
assert.deepEqual(m1.map((m) => [m.kind, m.token]), [["object", "@Box 2"]], "longest name wins over prefix");

const m2 = parseMentions("spin @Box around", doc);
assert.equal(m2[0].id, "o1", "shorter name matches when longest does not fit");

const m3 = parseMentions("email me at box@example.com", doc);
assert.equal(m3.length, 0, "@ glued to a word is not a trigger");

const m4 = parseMentions("@knot and @KNOT", doc);
assert.equal(m4.length, 1, "case-insensitive, deduped");
assert.equal(m4[0].id, "o3");

const m5 = parseMentions("use @Camera 2 please", doc);
assert.equal(m5[0].kind, "camera", "camera names parse");
assert.equal(m5[0].id, "cam2");

const m6 = parseMentions("line1\n@Knot", doc);
assert.equal(m6.length, 1, "@ after a newline triggers");

const m7 = parseMentions("compare @Box and @Boxing", doc);
assert.equal(m7.length, 1, "no partial-name match (@Boxing)");
assert.equal(m7[0].id, "o1");

// --- 2. parseMentions: snapshot / image tokens ------------------------------------------------
const m8 = parseMentions("check @Snapshot 2.4s and @Image 3", doc);
assert.deepEqual(
  m8.map((m) => [m.kind, m.token, m.t, m.index]),
  [
    ["snapshot", "@Snapshot 2.4s", 2.4, undefined],
    ["image", "@Image 3", undefined, 3],
  ],
  "structured tokens parse with payload",
);

const m9 = parseMentions("@snapshot 2.4s lowercase", doc);
assert.equal(m9.length, 1, "structured tokens are case-insensitive");

const m10 = parseMentions("@Snapshot 2.4seconds", doc);
assert.equal(m10.length, 0, "snapshot token needs the s suffix");

// mixed structured + names, order preserved
const m11 = parseMentions("@Snapshot 2.4s shows @Knot and @Camera 2", doc);
assert.deepEqual(m11.map((m) => m.kind), ["snapshot", "object", "camera"]);

// duplicate snapshot references dedupe
const m12 = parseMentions("@Snapshot 2.4s again @Snapshot 2.4s", doc);
assert.equal(m12.length, 1);

// --- 3. mentionQueryAt: caret token detection -------------------------------------------------
assert.deepEqual(mentionQueryAt("hello @Kno", 10), { start: 6, end: 10, query: "Kno" });
assert.deepEqual(mentionQueryAt("@", 1), { start: 0, end: 1, query: "" });
assert.deepEqual(mentionQueryAt("a @b c", 6), { start: 2, end: 6, query: "b c" }, "spaces allowed inside the query");
assert.equal(mentionQueryAt("hi@Kno", 6), null, "@ glued to a word");
assert.deepEqual(mentionQueryAt("@Knot tail", 5), { start: 0, end: 5, query: "Knot" }, "caret before the trailing space is inside");
assert.deepEqual(mentionQueryAt("@Knot tail", 8), { start: 0, end: 10, query: "Knot tail" }, "past the token: unmatched query filters out");
assert.deepEqual(mentionQueryAt("@Kno|t".replace("|", ""), 4), { start: 0, end: 5, query: "Knot" }, "caret mid-word counts");
assert.deepEqual(mentionQueryAt("text\n@Kno", 9), { start: 5, end: 9, query: "Kno" });
assert.equal(mentionQueryAt(`@${"x".repeat(41)}`, 43), null, "overlong queries are ignored");
assert.equal(mentionQueryAt("no token", 3), null);

// --- 4. snapshot/image item builders -----------------------------------------------------------
const events = [
  { id: "e1", type: "user", text: "hi", images: ["data:a"] },
  { id: "e2", type: "snapshot", dataUrl: "data:s1", t: 1, width: 10, height: 10 },
  { id: "e3", type: "assistant", text: "ok", step: 1 },
  { id: "e4", type: "snapshot", dataUrl: "data:s2", t: 2.43, width: 10, height: 10 },
  { id: "e5", type: "user", text: "look", images: ["data:b", "data:a"] },
];
const snaps = snapshotMentionItems(events);
assert.equal(snaps.length, 2, "both snapshots listed");
assert.equal(snaps[0].t, 2.43, "newest first");
assert.equal(snaps[0].token, "@Snapshot 2.4s", "token label uses one decimal");
assert.equal(formatSnapT(2.43), "2.4");

const fromChat = fromChatImageItems(events, ["data:a"]);
assert.equal(fromChat.length, 1, "pending images are excluded, duplicates collapsed");
assert.equal(fromChat[0].dataUrl, "data:b");

// --- 5. filterMentionItems ranking -------------------------------------------------------------
const items = [
  ...doc.objects.map((o) => ({ kind: "object", section: "objects", label: o.name, token: `@${o.name}`, id: o.id })),
  ...doc.cameras.map((c) => ({ kind: "camera", section: "cameras", label: c.name, token: `@${c.name}`, id: c.id })),
  ...snapshotMentionItems(events),
];
assert.equal(filterMentionItems(items, "").length, items.length, "empty query keeps everything");
const f1 = filterMentionItems(items, "box");
assert.deepEqual(f1.map((i) => i.label), ["Box", "Box 2"]);
const f2 = filterMentionItems(items, "snap");
assert.deepEqual(f2.map((i) => i.label), ["Snapshot 2.4s", "Snapshot 1s"], "kind word matches even though labels differ");
const f3 = filterMentionItems(items, "camera 2");
assert.equal(f3[0].label, "Camera 2");
assert.equal(filterMentionItems(items, "zzz").length, 0);

// --- 6. mergeSnapshotImages --------------------------------------------------------------------
const merged = mergeSnapshotImages(["data:p1"], parseMentions("see @Snapshot 2.4s", doc), events, 8);
assert.deepEqual(merged, ["data:p1", "data:s2"], "referenced snapshot appended");

const merged2 = mergeSnapshotImages(["data:p1", "data:s2"], parseMentions("see @Snapshot 2.4s", doc), events, 8);
assert.deepEqual(merged2, ["data:p1", "data:s2"], "no duplicate attachment");

const merged3 = mergeSnapshotImages(["a", "b", "c"], parseMentions("@Snapshot 1s", doc), events, 3);
assert.deepEqual(merged3, ["a", "b", "c"], "cap respected");

const merged4 = mergeSnapshotImages([], parseMentions("@Snapshot 9.9s", doc), events, 8);
assert.deepEqual(merged4, [], "unknown snapshot time resolves to nothing");

// tolerance: event t=2.43 matches token 2.4
const merged5 = mergeSnapshotImages([], parseMentions("@Snapshot 2.4s", doc), events, 8);
assert.deepEqual(merged5, ["data:s2"]);

// --- 7. referencesBlock -------------------------------------------------------------------------
const refs = referencesBlock(parseMentions("@Knot @Camera 2 @Snapshot 2.4s @Image 2", doc), doc, 2);
assert.equal(
  refs,
  [
    "[References]",
    '- Object "Knot" — id: o3, type: torusKnot',
    '- Camera "Camera 2" — id: cam2 (active camera)',
    "- Snapshot @ 2.4s (attached as an image)",
    "- @Image 2 (attached as an image)",
  ].join("\n"),
);

const refsMissing = referencesBlock([{ kind: "object", token: "@Ghost", id: "gone", name: "Ghost" }], doc, 1);
assert.match(refsMissing, /not found in the current scene/);
const refsBadIndex = referencesBlock([{ kind: "image", token: "@Image 5", index: 5 }], doc, 2);
assert.match(refsBadIndex, /not attached/);
assert.equal(referencesBlock([], doc), "");

// --- 8. splitByMentions -------------------------------------------------------------------------
const mentions = parseMentions("move @Knot next to @Box 2", doc);
const parts = splitByMentions("move @Knot next to @Box 2", mentions);
assert.deepEqual(
  parts.map((p) => (typeof p === "string" ? p : p.token)),
  ["move ", "@Knot", " next to ", "@Box 2"],
);
assert.equal(splitByMentions("plain text", []).length, 1);
assert.deepEqual(splitByMentions("no real @mention", parseMentions("no real @mention", doc)), ["no real @mention"]);

// --- 9. token helpers ---------------------------------------------------------------------------
assert.equal(imageToken(3), "@Image 3");
assert.equal(snapshotToken(2), "@Snapshot 2s");
assert.equal(snapshotToken(2.45), "@Snapshot 2.5s");
// round-trip: generated tokens reparse
const rt = parseMentions(`see ${snapshotToken(2.45)} and ${imageToken(3)}`, doc);
assert.deepEqual(rt.map((m) => [m.kind, m.t, m.index]), [
  ["snapshot", 2.5, undefined],
  ["image", undefined, 3],
]);

console.log("All mention smoke tests passed ✓");
