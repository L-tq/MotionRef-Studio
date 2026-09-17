/** Pure `@`-mention helpers: token parsing/ranking for the composer popup,
 *  snapshot-image merging at send time, and the compact [References] context
 *  block appended to the wire text so the model sees exact ids.
 *
 *  DOM-free (and locale-free — tokens must round-trip through the text) so it
 *  is unit-testable under tsx. */
import type { SceneDocument } from "../core/types";
import type { MentionKind, SessionEvent, SnapshotEvent, UserMention } from "./types";

/** Snapshot time formatting shared by tokens, popup labels and the reference
 *  block — one decimal is enough for a timeline position and keeps tokens
 *  short. */
export function formatSnapT(t: number): string {
  return String(Math.round(t * 10) / 10);
}

export function snapshotToken(t: number): string {
  return `@Snapshot ${formatSnapT(t)}s`;
}

export function imageToken(index: number): string {
  return `@Image ${index}`;
}

/** Token-shaped strings must be followed by a boundary so "@Box" does not
 *  match inside "@Boxing". */
function tokenEndsClean(text: string, end: number): boolean {
  if (end >= text.length) return true;
  return /[\s.,;:!?)\]}]/.test(text[end]);
}

const SNAPSHOT_RE = /^@Snapshot\s+(\d+(?:\.\d+)?)s/i;
const IMAGE_RE = /^@Image\s+(\d+)(?![\d.])/i;

/** Snapshot t matching tolerance: tokens carry one-decimal times, events may
 *  not (e.g. t=2.43 renders as "2.4"). */
const T_EPSILON = 0.051;

/** Resolve every `@token` in a sent message against the current scene.
 *  Object/camera names win by longest match (names may contain spaces and
 *  collide — ids are the only unique key); `@Snapshot <t>s` / `@Image <n>`
 *  are fixed-shape tokens. Dedupes by lowercase token; results follow text
 *  order. */
export function parseMentions(text: string, doc: SceneDocument): UserMention[] {
  const found = new Map<string, { m: UserMention; at: number }>();
  const namePositions: number[] = [];

  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "@") continue;
    if (i > 0 && !/\s/.test(text[i - 1])) continue;
    const rest = text.slice(i);
    const snap = SNAPSHOT_RE.exec(rest);
    if (snap && tokenEndsClean(text, i + snap[0].length)) {
      const token = text.slice(i, i + snap[0].length);
      const key = token.toLowerCase();
      if (!found.has(key)) found.set(key, { m: { kind: "snapshot", token, t: parseFloat(snap[1]) }, at: i });
      i += snap[0].length - 1;
      continue;
    }
    const img = IMAGE_RE.exec(rest);
    if (img && tokenEndsClean(text, i + img[0].length)) {
      const token = text.slice(i, i + img[0].length);
      const key = token.toLowerCase();
      if (!found.has(key)) found.set(key, { m: { kind: "image", token, index: parseInt(img[1], 10) }, at: i });
      i += img[0].length - 1;
      continue;
    }
    namePositions.push(i);
  }

  // Longest name first so "@Camera 2" resolves to the camera, not a shorter
  // name that happens to be a prefix.
  const objects = [...doc.objects].sort((a, b) => b.name.length - a.name.length);
  const cameras = [...doc.cameras].sort((a, b) => b.name.length - a.name.length);
  for (const at of namePositions) {
    const rest = text.slice(at + 1).toLowerCase();
    const obj = objects.find((o) => {
      const n = o.name.toLowerCase();
      return n.length > 0 && rest.startsWith(n) && tokenEndsClean(text, at + 1 + n.length);
    });
    if (obj) {
      const token = text.slice(at, at + 1 + obj.name.length);
      const key = token.toLowerCase();
      if (!found.has(key)) found.set(key, { m: { kind: "object", token, id: obj.id, name: obj.name }, at });
      continue;
    }
    const cam = cameras.find((c) => {
      const n = c.name.toLowerCase();
      return n.length > 0 && rest.startsWith(n) && tokenEndsClean(text, at + 1 + n.length);
    });
    if (cam) {
      const token = text.slice(at, at + 1 + cam.name.length);
      const key = token.toLowerCase();
      if (!found.has(key)) found.set(key, { m: { kind: "camera", token, id: cam.id, name: cam.name }, at });
    }
  }

  return [...found.values()].sort((a, b) => a.at - b.at).map((e) => e.m);
}

/** The `@query` range under `caret`, or null when the caret is not inside a
 *  mention token. A token starts at `@` preceded by start-of-text/whitespace;
 *  the query may contain spaces (names like "Camera 2") but not newlines, and
 *  extends to the next whitespace at/after the caret so the caret counts as
 *  "inside" anywhere within the token's last word. */
export function mentionQueryAt(
  text: string,
  caret: number,
): { start: number; end: number; query: string } | null {
  if (caret < 0 || caret > text.length) return null;
  let at = -1;
  for (let i = Math.min(caret, text.length); i > 0; i--) {
    if (text[i - 1] === "@") {
      if (i - 2 >= 0 && !/\s/.test(text[i - 2])) return null; // glued to a word
      at = i - 1;
      break;
    }
    if (text[i - 1] === "\n") return null;
  }
  if (at < 0) return null;
  let end = caret;
  while (end < text.length && !/[\s\n]/.test(text[end])) end++;
  const query = text.slice(at + 1, end);
  if (query.length > 40) return null;
  return { start: at, end, query };
}

/** One row of the suggestion popup. `token` is the exact text inserted into
 *  the composer (locale-independent so parseMentions can read it back);
 *  `label`/`sublabel` may be localized. */
export interface MentionItem {
  kind: MentionKind;
  section: "objects" | "cameras" | "snapshots" | "images";
  label: string;
  token: string;
  sublabel?: string;
  id?: string;
  t?: number;
  index?: number;
  dataUrl?: string;
}

/** Popup rows for the snapshot events of one task — newest six, newest
 *  first. */
export function snapshotMentionItems(events: SessionEvent[]): MentionItem[] {
  const snaps = events.filter((e): e is SnapshotEvent => e.type === "snapshot");
  return snaps
    .slice(-6)
    .reverse()
    .map((s) => ({
      kind: "snapshot" as const,
      section: "snapshots" as const,
      label: `Snapshot ${formatSnapT(s.t)}s`,
      token: snapshotToken(s.t),
      dataUrl: s.dataUrl,
      t: s.t,
    }));
}

/** Popup rows for re-attaching images already present in the transcript
 *  (user-sent attachments), newest first, skipping ones already pending. */
export function fromChatImageItems(events: SessionEvent[], pending: string[]): MentionItem[] {
  const seen = new Set(pending);
  const out: MentionItem[] = [];
  for (let i = events.length - 1; i >= 0 && out.length < 4; i--) {
    const e = events[i];
    if (e.type !== "user") continue;
    for (let j = e.images.length - 1; j >= 0 && out.length < 4; j--) {
      const url = e.images[j];
      if (seen.has(url)) continue;
      seen.add(url);
      out.push({
        kind: "image",
        section: "images",
        label: "",
        token: "",
        sublabel: "fromChat",
        dataUrl: url,
      });
    }
  }
  return out;
}

function rankItem(item: MentionItem, q: string): number {
  // Match against the label plus the English kind word so "snap"/"img" hit
  // even when labels are localized.
  const hay = `${item.label} ${item.kind}`.toLowerCase();
  if (hay.startsWith(q)) return 0;
  const at = hay.indexOf(` ${q}`);
  if (at >= 0) return 1;
  return hay.includes(q) ? 2 : -1;
}

/** Filter + rank popup rows for a query: startsWith beats word-start beats
 *  substring; ties keep the section order of the input. */
export function filterMentionItems(items: MentionItem[], query: string): MentionItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  const scored: { item: MentionItem; rank: number }[] = [];
  items.forEach((item, i) => {
    const rank = rankItem(item, q);
    if (rank >= 0) scored.push({ item, rank: rank * 1000 + i });
  });
  scored.sort((a, b) => a.rank - b.rank);
  return scored.map((s) => s.item);
}

/** Append the dataUrls of referenced snapshots to the turn's image list
 *  (deduped, capped at `limit`). Order of `images` is preserved — `@Image n`
 *  indexes into it. */
export function mergeSnapshotImages(
  images: string[],
  mentions: UserMention[],
  events: SessionEvent[],
  limit: number,
): string[] {
  const out = [...images];
  const seen = new Set(out);
  for (const m of mentions) {
    if (m.kind !== "snapshot" || m.t === undefined || out.length >= limit) continue;
    let url: string | undefined;
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.type === "snapshot" && Math.abs(e.t - m.t) < T_EPSILON) {
        url = e.dataUrl;
        break;
      }
    }
    if (url && !seen.has(url)) {
      seen.add(url);
      out.push(url);
    }
  }
  return out;
}

/** Compact machine-readable context for the model — appended to the wire text
 *  only (the visible transcript keeps the text as typed). Empty when there
 *  are no mentions. `imageCount` lets image references be flagged when the
 *  indexed attachment no longer exists. */
export function referencesBlock(mentions: UserMention[], doc: SceneDocument, imageCount?: number): string {
  if (!mentions.length) return "";
  const lines: string[] = ["[References]"];
  for (const m of mentions) {
    if (m.kind === "object") {
      const o = doc.objects.find((x) => x.id === m.id);
      if (o) lines.push(`- Object "${o.name}" — id: ${o.id}, type: ${o.type}`);
      else lines.push(`- Object "${m.name ?? m.token}" — not found in the current scene`);
    } else if (m.kind === "camera") {
      const c = doc.cameras.find((x) => x.id === m.id);
      if (c) lines.push(`- Camera "${c.name}" — id: ${c.id}${c.id === doc.activeCameraId ? " (active camera)" : ""}`);
      else lines.push(`- Camera "${m.name ?? m.token}" — not found in the current scene`);
    } else if (m.kind === "snapshot") {
      lines.push(`- Snapshot @ ${m.t !== undefined ? formatSnapT(m.t) : "?"}s (attached as an image)`);
    } else {
      const missing = imageCount !== undefined && (m.index === undefined || m.index > imageCount);
      lines.push(`- ${imageToken(m.index ?? 0)}${missing ? " (referenced, but not attached)" : " (attached as an image)"}`);
    }
  }
  return lines.join("\n");
}

export type MentionPart = string | UserMention;

/** Split sent text into plain segments and mention tokens (for chip
 *  rendering in the user bubble). Unmatched mentions are dropped. */
export function splitByMentions(text: string, mentions: UserMention[]): MentionPart[] {
  if (!mentions.length || !text) return [text];
  const lower = text.toLowerCase();
  const parts: MentionPart[] = [];
  let pos = 0;
  const remaining = [...mentions];
  while (pos < text.length && remaining.length) {
    let bestIdx = -1;
    let best: UserMention | null = null;
    for (const m of remaining) {
      const idx = lower.indexOf(m.token.toLowerCase(), pos);
      if (idx >= 0 && (bestIdx < 0 || idx < bestIdx)) {
        bestIdx = idx;
        best = m;
      }
    }
    if (!best) break;
    if (bestIdx > pos) parts.push(text.slice(pos, bestIdx));
    parts.push(best);
    pos = bestIdx + best.token.length;
    remaining.splice(remaining.indexOf(best), 1);
  }
  if (pos < text.length) parts.push(text.slice(pos));
  return parts;
}
