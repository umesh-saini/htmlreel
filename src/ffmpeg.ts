import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

let resolvedFfmpeg: string | null = null;

/** ffmpeg to use: `FFMPEG_PATH`, else the bundled ffmpeg-static binary, else `ffmpeg` on PATH. */
export function ffmpegPath(): string {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  if (resolvedFfmpeg) return resolvedFfmpeg;
  try {
    const bundled = createRequire(import.meta.url)('ffmpeg-static') as string | null;
    // The binary is downloaded by ffmpeg-static's install script, which npm 12+ skips unless approved.
    if (bundled && fs.existsSync(bundled)) return (resolvedFfmpeg = bundled);
  } catch {
    // not installed (optional on unsupported platforms)
  }
  return (resolvedFfmpeg = 'ffmpeg');
}

export const FFMPEG_MISSING_HELP =
  'ffmpeg not found. The bundled ffmpeg-static binary was not downloaded (npm 12+ blocks install scripts until approved). Fix it with ' +
  '`npm install-scripts approve ffmpeg-static && npm rebuild ffmpeg-static`, or install ffmpeg on your system, or set FFMPEG_PATH.';

let ffmpegChecked = false;

/** Fails fast, with instructions, when no runnable ffmpeg exists. */
export async function ensureFfmpeg(): Promise<void> {
  if (ffmpegChecked) return;
  await run(ffmpegPath(), ['-version'], { timeoutMs: 15_000 });
  ffmpegChecked = true;
}

/** Runs a binary and resolves with stdout; rejects with the tail of stderr on failure. */
export function run(bin: string, args: string[], opts: { cwd?: string; timeoutMs?: number; allowFailure?: boolean } = {}): Promise<{ stdout: Buffer; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let err = '';
    const timer = opts.timeoutMs ? setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs) : null;
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => (err = (err + c.toString()).slice(-8000)));
    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return reject(e);
      reject(new Error(bin === ffmpegPath() ? FFMPEG_MISSING_HELP : `${bin} not found.`));
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      const result = { stdout: Buffer.concat(out), stderr: err, code: code ?? -1 };
      if (code === 0 || opts.allowFailure) resolve(result);
      else reject(new Error(`${bin.split(/[\\/]/).pop()} exited with code ${code}: ${err.trim().split('\n').slice(-3).join(' | ')}`));
    });
  });
}

export async function ffmpeg(args: string[], opts?: { cwd?: string; timeoutMs?: number }): Promise<Buffer> {
  return (await run(ffmpegPath(), ['-hide_banner', '-loglevel', 'error', '-y', ...args], opts)).stdout;
}

export interface MediaInfo {
  duration: number;
  hasVideo: boolean;
  hasAudio: boolean;
  width?: number;
  height?: number;
  fps?: number;
}

/** Reads duration and streams from ffmpeg's banner (no ffprobe needed). */
export async function probe(filePath: string): Promise<MediaInfo> {
  const { stderr } = await run(ffmpegPath(), ['-hide_banner', '-i', filePath], { allowFailure: true, timeoutMs: 30_000 });
  const d = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!d) throw new Error(`Could not read ${filePath}: ${stderr.trim().split('\n').pop() ?? 'unknown format'}`);
  const video = stderr.match(/Stream #.*?Video:.*?(\d{2,5})x(\d{2,5})(?:.*?([\d.]+) fps)?/);
  return {
    duration: +d[1] * 3600 + +d[2] * 60 + +d[3],
    hasVideo: !!video,
    hasAudio: /Stream #.*?Audio:/.test(stderr),
    ...(video ? { width: +video[1], height: +video[2], ...(video[3] ? { fps: +video[3] } : {}) } : {}),
  };
}

export async function probeDuration(filePath: string): Promise<number> {
  const { duration } = await probe(filePath);
  if (!(duration > 0)) throw new Error(`${filePath} has no duration. Is it a valid audio/video file?`);
  return duration;
}
