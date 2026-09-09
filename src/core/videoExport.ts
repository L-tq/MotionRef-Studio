/** Deterministic frame-by-frame video export via MediaRecorder.
 *
 *  Frames are rendered offscreen at a fixed 1/fps timestep and pushed into a
 *  canvas captureStream(0) — the recorder only encodes on requestFrame(), so
 *  output timing is wall-clock paced at exactly 1000/fps ms per frame.
 *  MP4 (H.264) is preferred when the browser can encode it; WebM VP9/VP8 is
 *  the fallback.
 */
import type { SceneDocument } from "./types";
import { renderDocFrame, type DocScene } from "./engine";
import { evaluate } from "./animation";

const MIME_CANDIDATES = [
  { mime: "video/mp4;codecs=avc1.640028", ext: "mp4" },
  { mime: "video/mp4;codecs=avc1.42E01E", ext: "mp4" },
  { mime: "video/mp4", ext: "mp4" },
  { mime: "video/webm;codecs=vp9", ext: "webm" },
  { mime: "video/webm;codecs=vp8", ext: "webm" },
  { mime: "video/webm", ext: "webm" },
];

export function pickVideoMime(): { mime: string; ext: string } | null {
  if (typeof MediaRecorder === "undefined") return null;
  for (const c of MIME_CANDIDATES) {
    try {
      if (MediaRecorder.isTypeSupported(c.mime)) return c;
    } catch {
      /* keep trying */
    }
  }
  return null;
}

export interface ExportOptions {
  width: number;
  height: number;
  /** Frames per second; defaults to doc.fps. */
  fps?: number;
  onProgress?: (frame: number, total: number) => void;
  signal?: AbortSignal;
}

export interface ExportResult {
  blob: Blob;
  mime: string;
  ext: string;
  frames: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function exportVideo(doc: SceneDocument, opts: ExportOptions): Promise<ExportResult> {
  const picked = pickVideoMime();
  if (!picked) throw new Error("MediaRecorder is not available in this browser");

  const fps = opts.fps ?? doc.fps;
  const totalFrames = Math.max(1, Math.round(doc.duration * fps));
  const frameMs = 1000 / fps;

  const canvas = renderDocFrame(doc, 0, opts.width, opts.height);
  const stream = canvas.captureStream(0);
  const track = stream.getVideoTracks()[0] as (CanvasCaptureMediaStreamTrack | undefined);
  if (!track || typeof track.requestFrame !== "function") {
    throw new Error("canvas.captureStream(0) with requestFrame is not supported here");
  }

  const recorder = new MediaRecorder(stream, {
    mimeType: picked.mime,
    videoBitsPerSecond: Math.round(opts.width * opts.height * fps * 0.12),
  });
  const chunks: BlobPart[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };
  const done = new Promise<void>((resolve) => {
    recorder.onstop = () => resolve();
  });

  recorder.start();
  // Reuse one DocScene across frames (holder caches the synced THREE scene).
  const holder: { docScene?: DocScene } = {};

  for (let i = 0; i < totalFrames; i++) {
    if (opts.signal?.aborted) {
      track.stop();
      recorder.stop();
      await done;
      throw new DOMException("Export aborted", "AbortError");
    }
    const t = i / fps;
    renderDocFrame(doc, t, opts.width, opts.height, holder);
    track.requestFrame();
    opts.onProgress?.(i + 1, totalFrames);
    await sleep(frameMs);
  }

  // Let the encoder flush the last frame before stopping.
  await sleep(Math.max(frameMs * 2, 120));
  recorder.stop();
  track.stop();
  await done;

  return { blob: new Blob(chunks, { type: picked.mime }), mime: picked.mime, ext: picked.ext, frames: totalFrames };
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/** Sanity check used by the export dialog: report frames that evaluate with
 *  invalid (NaN) camera poses, which would produce black output. */
export function validateDocForExport(doc: SceneDocument): string | null {
  const fps = doc.fps;
  for (let i = 0; i <= Math.round(doc.duration * fps); i += Math.max(1, Math.round(fps / 4))) {
    const state = evaluate(doc, i / fps);
    const p = state.camera.position;
    if (!Number.isFinite(p[0] + p[1] + p[2] + state.camera.fov)) {
      return `Camera is invalid at t=${(i / fps).toFixed(2)}s`;
    }
  }
  return null;
}
