import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import type { Browser } from 'puppeteer-core';
import { computeLevels } from './audio.js';
import { launchBrowser, openComposition, serve, type BrowserOptions, type CompositionPage, type Engine, type NetworkPolicy } from './browser.js';
import { ensureFfmpeg, ffmpeg, ffmpegPath, probeDuration } from './ffmpeg.js';
import { buildHtml, type Caption, type ReelConfig } from './html.js';
import { preset as presetSize, type PresetName } from './presets.js';

export interface CompositionOptions extends BrowserOptions {
  /** The composition as an HTML string... */
  html?: string;
  /** ...or a path to an .html file. Its folder is served, so relative images, fonts and scripts work. */
  file?: string;
  /** Folder served at / when you pass `html` (for relative URLs). */
  baseDir?: string;
  /** Extra files, name → path on disk, served at `assets/<name>`. */
  assets?: Record<string, string>;
  /** Output size by platform: 'youtube', 'shorts', 'reel', 'tiktok', 'square', … Overridden by width/height. */
  preset?: PresetName;
  width?: number;
  height?: number;
  /** Frames per second. Default 30 (or the preset's). */
  fps?: number;
  /** Device pixel ratio: 2 renders at twice the size (sharper text, slower). Default 1. */
  scale?: number;
  /** Timed captions / lyrics / subtitles (see `parseSubtitles`). */
  captions?: Caption[];
  /** Set false to stop the runtime from adding its default caption layer. */
  captionsLayer?: boolean;
  /** Anything your page needs, exposed as `Reel.data`. */
  data?: unknown;
  /** Loudness envelope to drive --level / --beat. Computed from `audio` automatically when omitted. */
  levels?: number[];
  /** See `NetworkPolicy`. Use 'local' for untrusted HTML. Default 'allow'. */
  network?: NetworkPolicy;
  /** Temp folder for intermediate files. Default os.tmpdir(). */
  tmpDir?: string;
}

export interface AudioOptions {
  path: string;
  /** Seconds into the audio file that line up with composition time 0. Default 0. */
  offset?: number;
  /** Fade-in / fade-out length in seconds. */
  fadeIn?: number;
  fadeOut?: number;
  /** Gain multiplier, e.g. 0.8. */
  volume?: number;
}

export interface RenderProgress {
  frame: number;
  total: number;
  percent: number;
  /** Render speed so far, frames per second. */
  fps: number;
  elapsedSec: number;
  etaSec: number;
}

export interface RenderVideoOptions extends CompositionOptions {
  /** Output .mp4 path. */
  output: string;
  /** Seconds to render. Default: the audio's length (minus `start`). Required without audio. */
  duration?: number;
  /** Composition time of the first frame (render an excerpt). Default 0. */
  start?: number;
  /** A soundtrack: path or options. Muxed as AAC; the video is silent without it. */
  audio?: string | AudioOptions;
  /** Compute --level / --beat from the audio. Default true. */
  audioReactive?: boolean;
  /** Parallel browsers. Default: half the CPU cores, 1–4. */
  workers?: number;
  /** H.264 quality (lower = better, bigger). Default 18. */
  crf?: number;
  /** x264 speed/size trade-off. Default 'veryfast'. */
  encoderPreset?: 'ultrafast' | 'superfast' | 'veryfast' | 'faster' | 'fast' | 'medium' | 'slow' | 'slower';
  /** Frames handed from Chrome to ffmpeg. 'png' is lossless but slower. Default 'jpeg' (q92). */
  frameFormat?: 'jpeg' | 'png';
  signal?: AbortSignal;
  onProgress?: (p: RenderProgress) => void;
}

export interface RenderResult {
  output: string;
  frames: number;
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  engine: Engine;
  renderSec: number;
  /** Errors the page reported while rendering (uncaught exceptions, blocked requests). */
  pageErrors: string[];
}

function size(o: CompositionOptions) {
  const p = o.preset ? presetSize(o.preset) : { width: 1920, height: 1080, fps: 30 };
  const width = o.width ?? p.width;
  const height = o.height ?? p.height;
  const fps = o.fps ?? p.fps;
  if (!(width > 0 && height > 0)) throw new Error('width and height must be positive');
  if (!(fps > 0 && fps <= 120)) throw new Error('fps must be between 1 and 120');
  return { width, height, fps };
}

interface Workspace {
  url: string;
  tmp: string;
  close: () => Promise<void>;
}

/** Serves the playable page (in memory) next to the composition's own files, plus a temp folder. */
async function workspace(o: CompositionOptions, config: ReelConfig, extraFiles: Record<string, { file: string }> = {}): Promise<Workspace> {
  if (!o.html && !o.file) throw new Error('Pass `html` (a string) or `file` (a path to an .html file).');
  const source = o.html ?? fs.readFileSync(o.file!, 'utf8');
  const root = o.file ? path.dirname(path.resolve(o.file)) : o.baseDir;
  const entry = `/__htmlreel_${crypto.randomBytes(6).toString('hex')}.html`;
  const files: Record<string, string | { file: string }> = { [entry]: buildHtml(source, config), ...extraFiles };
  for (const [name, file] of Object.entries(o.assets ?? {})) {
    if (!fs.existsSync(file)) throw new Error(`Asset "${name}" not found: ${file}`);
    files[`/assets/${name}`] = { file: path.resolve(file) };
  }
  const server = await serve({ root, files });
  const tmp = fs.mkdtempSync(path.join(o.tmpDir ?? os.tmpdir(), 'htmlreel-'));
  return {
    url: server.origin + entry,
    tmp,
    close: async () => {
      await server.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}

function reelConfig(o: CompositionOptions, extra: Partial<ReelConfig> & { duration: number }): ReelConfig {
  const { width, height, fps } = size(o);
  return {
    width,
    height,
    fps,
    captions: o.captions ?? [],
    ...(o.captionsLayer === false ? { captionsLayer: false } : {}),
    levels: o.levels ?? [],
    levelsFps: fps,
    data: o.data ?? {},
    mode: 'render',
    ...extra,
  };
}

async function openPage(browser: Browser, engine: Engine, url: string, o: CompositionOptions, format: 'jpeg' | 'png'): Promise<CompositionPage> {
  const { width, height } = size(o);
  return openComposition(browser, { url, width, height, engine, network: o.network, format, scale: o.scale });
}

const abortError = () => Object.assign(new Error('Render cancelled'), { name: 'AbortError' });

/**
 * Renders an HTML composition to an H.264 MP4.
 *
 * Frames are rendered in parallel: each worker runs its own browser and pipes frames into its own
 * ffmpeg segment; segments are joined losslessly and muxed with the audio.
 */
export async function renderVideo(o: RenderVideoOptions): Promise<RenderResult> {
  const { width, height, fps } = size(o);
  const scale = o.scale ?? 1;
  const outW = Math.round(width * scale);
  const outH = Math.round(height * scale);
  if (outW % 2 || outH % 2) throw new Error(`H.264 needs an even width and height (got ${outW}x${outH}).`);
  await ensureFfmpeg();

  const audio: AudioOptions | null = typeof o.audio === 'string' ? { path: o.audio } : (o.audio ?? null);
  if (audio && !fs.existsSync(audio.path)) throw new Error(`Audio not found: ${audio.path}`);
  const start = o.start ?? 0;
  const offset = audio?.offset ?? 0;
  let duration = o.duration;
  if (duration === undefined) {
    if (!audio) throw new Error('Pass `duration` (seconds), or an `audio` track to take the length from.');
    duration = (await probeDuration(audio.path)) - offset - start;
  }
  if (!(duration > 0)) throw new Error(`Nothing to render: duration is ${duration}s.`);

  let levels = o.levels;
  if (!levels && audio && o.audioReactive !== false) {
    levels = await computeLevels(audio.path, fps);
    if (offset) levels = levels.slice(Math.round(offset * fps));
  }

  const total = Math.max(1, Math.round(duration * fps));
  const defaultWorkers = Math.max(1, Math.min(4, Math.floor(os.cpus().length / 2)));
  const workers = Math.max(1, Math.min(o.workers ?? defaultWorkers, Math.ceil(total / 30)));
  const per = Math.ceil(total / workers);
  const format = o.frameFormat ?? 'jpeg';
  const config = reelConfig({ ...o, levels }, { duration: start + duration, startAt: start });
  const ws = await workspace(o, config);
  const t0 = Date.now();
  const pageErrors: string[] = [];
  let engineUsed: Engine = 'screenshot';
  let done = 0;
  let lastPct = -1;
  const report = () => {
    const pct = Math.floor((done / total) * 100);
    if (pct === lastPct || !o.onProgress) return;
    lastPct = pct;
    const elapsedSec = (Date.now() - t0) / 1000;
    const speed = done / Math.max(elapsedSec, 1e-3);
    o.onProgress({ frame: done, total, percent: pct, fps: Math.round(speed * 10) / 10, elapsedSec, etaSec: Math.round((total - done) / Math.max(speed, 1e-3)) });
  };

  try {
    const segments = await Promise.all(
      Array.from({ length: workers }, async (_, w) => {
        const a = w * per;
        const b = Math.min(total, a + per);
        if (a >= b) return null;
        const seg = path.join(ws.tmp, `seg_${w}.mp4`);
        const { browser, engine } = await launchBrowser(o);
        engineUsed = engine;
        try {
          const { frameAt, errors } = await openPage(browser, engine, ws.url, o, format);
          const ff = spawn(
            ffmpegPath(),
            ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', format === 'png' ? 'png' : 'mjpeg', '-i', '-',
              '-c:v', 'libx264', '-preset', o.encoderPreset ?? 'veryfast', '-crf', String(o.crf ?? 18), '-pix_fmt', 'yuv420p', '-g', String(Math.round(fps * 2)), seg],
            { stdio: ['pipe', 'ignore', 'pipe'] }
          );
          let ffErr = '';
          ff.stderr.on('data', (c: Buffer) => (ffErr = (ffErr + c.toString()).slice(-2000)));
          const closed = new Promise<number>((resolve) => ff.on('close', (code) => resolve(code ?? -1)));
          let dead = false;
          ff.stdin.on('error', () => (dead = true));
          ff.on('error', () => (dead = true));

          for (let f = a; f < b && !dead; f++) {
            if (o.signal?.aborted) {
              ff.kill('SIGKILL');
              throw abortError();
            }
            const buf = await frameAt(start + f / fps);
            if (!ff.stdin.write(buf)) await Promise.race([new Promise((r) => ff.stdin.once('drain', r)), closed]);
            done++;
            report();
          }
          ff.stdin.end();
          const code = await closed;
          if (dead || code !== 0) throw new Error(`Encoder failed (worker ${w}): ${ffErr.trim().split('\n').pop() || `exit ${code}`}`);
          pageErrors.push(...errors);
          return seg;
        } finally {
          await browser.close().catch(() => undefined);
        }
      })
    );

    fs.writeFileSync(path.join(ws.tmp, 'segments.txt'), segments.filter(Boolean).map((s) => `file '${path.basename(s!)}'`).join('\n'));
    const output = path.resolve(o.output);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    const filters: string[] = [];
    if (audio?.volume !== undefined) filters.push(`volume=${audio.volume}`);
    if (audio?.fadeIn) filters.push(`afade=t=in:st=0:d=${audio.fadeIn}`);
    if (audio?.fadeOut) filters.push(`afade=t=out:st=${Math.max(0, duration - audio.fadeOut).toFixed(3)}:d=${audio.fadeOut}`);
    await ffmpeg(
      [
        '-f', 'concat', '-safe', '0', '-i', 'segments.txt',
        ...(audio
          ? ['-ss', (offset + start).toFixed(3), '-t', duration.toFixed(3), '-i', path.resolve(audio.path), '-map', '0:v:0', '-map', '1:a:0',
              '-c:v', 'copy', ...(filters.length ? ['-af', filters.join(',')] : []), '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-shortest']
          : ['-map', '0:v:0', '-c:v', 'copy']),
        '-movflags', '+faststart',
        output,
      ],
      { cwd: ws.tmp, timeoutMs: 60 * 60_000 }
    );
    report();
    return { output, frames: total, durationSec: duration, width: outW, height: outH, fps, engine: engineUsed, renderSec: (Date.now() - t0) / 1000, pageErrors: [...new Set(pageErrors)] };
  } finally {
    await ws.close();
  }
}

export interface StillOptions extends CompositionOptions {
  /** Composition time in seconds. Default 0. */
  time?: number;
  /** .png or .jpg path. The format follows the extension. */
  output: string;
  /** Composition length, for --p and captions. Default: time + 1. */
  duration?: number;
}

/**
 * Captures single frames: thumbnails, cover images, poster frames, or test snapshots.
 * Opens the page once for all of them.
 */
export async function renderStills(o: CompositionOptions & { duration?: number; frames: Array<{ time: number; output: string }> }): Promise<{ pageErrors: string[] }> {
  const maxT = Math.max(0, ...o.frames.map((f) => f.time));
  const ws = await workspace(o, reelConfig(o, { duration: o.duration ?? maxT + 1 }));
  const { browser, engine } = await launchBrowser(o);
  try {
    // One page per format so PNG and JPEG outputs can be mixed.
    const pages = new Map<'png' | 'jpeg', CompositionPage>();
    for (const f of o.frames) {
      const format = /\.png$/i.test(f.output) ? 'png' : 'jpeg';
      if (!pages.has(format)) pages.set(format, await openPage(browser, engine, ws.url, o, format));
      fs.mkdirSync(path.dirname(path.resolve(f.output)), { recursive: true });
      fs.writeFileSync(f.output, await pages.get(format)!.frameAt(f.time));
    }
    return { pageErrors: [...new Set([...pages.values()].flatMap((p) => p.errors))] };
  } finally {
    await browser.close().catch(() => undefined);
    await ws.close();
  }
}

export async function renderStill(o: StillOptions): Promise<{ output: string; pageErrors: string[] }> {
  const { pageErrors } = await renderStills({ ...o, frames: [{ time: o.time ?? 0, output: o.output }] });
  return { output: o.output, pageErrors };
}

/** Standard deviation of a downscaled grayscale frame. Near zero means a blank / flat frame. */
export async function frameVariance(imagePath: string): Promise<number> {
  const raw = await ffmpeg(['-i', imagePath, '-vf', 'scale=64:36', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { timeoutMs: 20_000 });
  if (!raw.length) return 0;
  let sum = 0;
  for (const v of raw) sum += v;
  const mean = sum / raw.length;
  let sq = 0;
  for (const v of raw) sq += (v - mean) ** 2;
  return Math.sqrt(sq / raw.length);
}

/** True when a frame is (almost) one flat colour: a broken composition, or a page that failed to load. */
export async function isBlankFrame(imagePath: string, threshold = 3): Promise<boolean> {
  return (await frameVariance(imagePath)) < threshold;
}

/**
 * Serves the composition with a play/scrub bar for the browser (no Chrome needed).
 * `duration` defaults to the audio length.
 */
export async function preview(o: CompositionOptions & { duration?: number; audio?: string }): Promise<{ url: string; close: () => Promise<void> }> {
  const { fps } = size(o);
  const duration = o.duration ?? (o.audio ? await probeDuration(o.audio) : undefined);
  if (!duration) throw new Error('Pass `duration`, or `audio` to take the length from.');
  const levels = o.levels ?? (o.audio ? await computeLevels(o.audio, fps) : []);
  const audioPath = o.audio ? `/__htmlreel_audio${path.extname(o.audio)}` : undefined;
  const ws = await workspace(o, { ...reelConfig({ ...o, levels }, { duration }), mode: 'preview', ...(audioPath ? { audioUrl: audioPath } : {}) }, audioPath ? { [audioPath]: { file: path.resolve(o.audio!) } } : {});
  return { url: ws.url, close: ws.close };
}
