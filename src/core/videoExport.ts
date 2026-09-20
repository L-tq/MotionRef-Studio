/** Frame-exact video export.
 *
 *  Primary path: WebCodecs — frames are rendered offscreen at a fixed 1/fps
 *  timestep and encoded with an explicit per-frame timestamp (i * 1e6/fps µs),
 *  then muxed to MP4 (H.264) via mp4-muxer. Because timestamps come from the
 *  animation clock rather than the wall clock, the output duration matches the
 *  timeline exactly regardless of render speed, scene weight or tab throttling.
 *
 *  Fallback path: MediaRecorder over canvas.captureStream(0) — the recorder
 *  stamps frames by wall clock at requestFrame() time, so requests are paced
 *  against an absolute schedule anchored at export start to keep drift out.
 *  MP4 (H.264) is preferred when the browser can encode it; WebM VP9/VP8 is
 *  the fallback container there.
 */
import type { SceneDocument } from "./types";
import { renderDocFrame, type DocScene } from "./engine";
import { evaluate } from "./animation";
import { ArrayBufferTarget, Muxer } from "mp4-muxer";

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

/** H.264 codec strings tried in order: High profile first, then Baseline. */
const AVC_CANDIDATES = ["avc1.640028", "avc1.42E01E", "avc1.42001E"];

/** Return a codec string when VideoEncoder can produce H.264 at this size and
 *  rate, else null (caller falls back to MediaRecorder). */
export async function probeWebCodecsExport(
  width: number,
  height: number,
  fps: number,
): Promise<string | null> {
  if (typeof VideoEncoder === "undefined") return null;
  const bitrate = exportBitrate(width, height, fps);
  for (const codec of AVC_CANDIDATES) {
    try {
      const support = await VideoEncoder.isConfigSupported({
        codec,
        width,
        height,
        framerate: fps,
        bitrate,
      });
      if (support.supported) return codec;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

const exportBitrate = (width: number, height: number, fps: number): number =>
  Math.round(width * height * fps * 0.12);

export interface ExportOptions {
  width: number;
  height: number;
  /** Frames per second; defaults to doc.fps. */
  fps?: number;
  /** Reports frames actually committed to the output (encoder output for the
   *  WebCodecs path, requestFrame pushes for the fallback) — not frames merely
   *  rendered, so the bar stays honest while the encoder lags behind. */
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
const yieldToBrowser = () => new Promise<void>((r) => setTimeout(r, 0));
const abortError = () => new DOMException("Export aborted", "AbortError");

export async function exportVideo(doc: SceneDocument, opts: ExportOptions): Promise<ExportResult> {
  const fps = opts.fps ?? doc.fps;
  const codec = await probeWebCodecsExport(opts.width, opts.height, fps);
  if (codec) return exportViaWebCodecs(doc, opts, codec, fps);
  const picked = pickVideoMime();
  if (!picked) {
    throw new Error("No video encoder available in this browser (WebCodecs and MediaRecorder are both unavailable)");
  }
  return exportViaMediaRecorder(doc, opts, picked, fps);
}

/** Frame-exact export: encode every rendered frame with an explicit timestamp
 *  and mux the chunks to a fast-start MP4. */
async function exportViaWebCodecs(
  doc: SceneDocument,
  opts: ExportOptions,
  codec: string,
  fps: number,
): Promise<ExportResult> {
  const totalFrames = Math.max(1, Math.round(doc.duration * fps));
  const canvas = renderDocFrame(doc, 0, opts.width, opts.height);
  // Reuse one DocScene across frames (holder caches the synced THREE scene).
  const holder: { docScene?: DocScene } = {};

  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: { codec: "avc", width: opts.width, height: opts.height, frameRate: fps },
    fastStart: "in-memory",
  });

  let encodeError: Error | null = null;
  let encodedFrames = 0;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      encodedFrames += 1;
      opts.onProgress?.(encodedFrames, totalFrames);
      muxer.addVideoChunk(chunk, meta);
    },
    error: (e) => {
      encodeError = e instanceof Error ? e : new Error(String(e));
    },
  });
  encoder.configure({
    codec,
    width: opts.width,
    height: opts.height,
    framerate: fps,
    bitrate: exportBitrate(opts.width, opts.height, fps),
  });

  const keyInterval = Math.max(1, Math.round(fps * 2));
  try {
    for (let i = 0; i < totalFrames; i++) {
      if (opts.signal?.aborted) throw abortError();
      if (encodeError) throw encodeError;
      renderDocFrame(doc, i / fps, opts.width, opts.height, holder);
      const frame = new VideoFrame(canvas, {
        timestamp: Math.round((i * 1e6) / fps),
        duration: Math.round(1e6 / fps),
      });
      encoder.encode(frame, { keyFrame: i % keyInterval === 0 });
      frame.close();
      // Progress is reported from the encoder's output callback (frames
      // actually committed to the file), so the bar keeps filling through the
      // flush below while the encoder drains its queue.
      while (encoder.encodeQueueSize > 4) await yieldToBrowser();
      await yieldToBrowser();
    }
    if (encodeError) throw encodeError;
    await encoder.flush();
    opts.onProgress?.(totalFrames, totalFrames);
  } catch (err) {
    encoder.close();
    throw err;
  }
  encoder.close();
  muxer.finalize();

  return {
    blob: new Blob([target.buffer], { type: "video/mp4" }),
    mime: "video/mp4",
    ext: "mp4",
    frames: totalFrames,
  };
}

/** Wall-clock fallback for browsers without WebCodecs. requestFrame() stamps
 *  frames with the current time, so each push is anchored to an absolute
 *  schedule (start + (i+1) * frameMs) — render time and timer overshoot then
 *  delay a single frame instead of accumulating into a stretched video. */
async function exportViaMediaRecorder(
  doc: SceneDocument,
  opts: ExportOptions,
  picked: { mime: string; ext: string },
  fps: number,
): Promise<ExportResult> {
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
    videoBitsPerSecond: exportBitrate(opts.width, opts.height, fps),
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
  const start = performance.now();

  for (let i = 0; i < totalFrames; i++) {
    if (opts.signal?.aborted) {
      track.stop();
      recorder.stop();
      await done;
      throw abortError();
    }
    renderDocFrame(doc, i / fps, opts.width, opts.height, holder);
    opts.onProgress?.(i + 1, totalFrames);
    const wait = start + (i + 1) * frameMs - performance.now();
    if (wait > 0) await sleep(wait);
    track.requestFrame();
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
 *  invalid (NaN) camera poses, which would produce black output. Samples the
 *  same time grid the export will use. */
export function validateDocForExport(doc: SceneDocument, fps?: number): string | null {
  const rate = fps ?? doc.fps;
  for (let i = 0; i <= Math.round(doc.duration * rate); i += Math.max(1, Math.round(rate / 4))) {
    const state = evaluate(doc, i / rate);
    const p = state.camera.position;
    if (!Number.isFinite(p[0] + p[1] + p[2] + state.camera.fov)) {
      return `Camera is invalid at t=${(i / rate).toFixed(2)}s`;
    }
  }
  return null;
}
