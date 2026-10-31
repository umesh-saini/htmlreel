import { ffmpeg } from './ffmpeg.js';

const LEVEL_SAMPLE_RATE = 8000;

/**
 * A smoothed loudness envelope (0..1) with `fps` values per second, for audio-reactive visuals.
 * Pages read it as the CSS variables `--level` and `--beat`, or `Reel.levelAt(t)`.
 */
export async function computeLevels(audioPath: string, fps = 30, envelope: { attack?: number; release?: number } = {}): Promise<number[]> {
  const pcm = await ffmpeg(['-i', audioPath, '-ac', '1', '-ar', String(LEVEL_SAMPLE_RATE), '-f', 's16le', '-'], { timeoutMs: 10 * 60_000 });
  return levelsFromPcm(new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2)), LEVEL_SAMPLE_RATE, fps, envelope);
}

/** The envelope maths, separate from ffmpeg so it can be tested. */
export function levelsFromPcm(samples: Int16Array, sampleRate: number, fps: number, envelope: { attack?: number; release?: number } = {}): number[] {
  const win = Math.max(1, Math.round(sampleRate / fps));
  const rms: number[] = [];
  for (let i = 0; i < samples.length; i += win) {
    let sum = 0;
    const end = Math.min(samples.length, i + win);
    for (let j = i; j < end; j++) sum += samples[j] * samples[j];
    rms.push(Math.sqrt(sum / Math.max(1, end - i)) / 32768);
  }
  if (!rms.length) return [];

  // Normalise against the 95th percentile so a single peak doesn't flatten everything.
  const sorted = [...rms].sort((a, b) => a - b);
  const ref = sorted[Math.floor(sorted.length * 0.95)] || 1e-6;
  // Fast attack, slow release: reads as "pulse" rather than jitter.
  const attack = envelope.attack ?? 0.6;
  const release = envelope.release ?? 0.12;
  let prev = 0;
  return rms.map((v) => {
    const n = Math.min(1, v / ref);
    prev = n > prev ? prev + (n - prev) * attack : prev + (n - prev) * release;
    return Math.round(prev * 1000) / 1000;
  });
}

/**
 * The most energetic `lengthSec` window of a track: the part of a song worth cutting into a
 * Reel, Short or TikTok. Skips the first `skipSec` seconds (intros are rarely the hook).
 */
export function findPeakWindow(levels: number[], fps: number, lengthSec: number, skipSec = 5): { start: number; duration: number } {
  const totalSec = levels.length / fps;
  const duration = Math.min(lengthSec, totalSec);
  const n = Math.round(duration * fps);
  if (levels.length <= n) return { start: 0, duration };
  const minStart = Math.min(Math.round(skipSec * fps), levels.length - n);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += levels[i];
  let best = -1;
  let bestAt = 0;
  for (let i = 0; i + n <= levels.length; i++) {
    if (i > 0) sum += levels[i + n - 1] - levels[i - 1];
    if (i >= minStart && sum > best) {
      best = sum;
      bestAt = i;
    }
  }
  return { start: Math.round((bestAt / fps) * 100) / 100, duration };
}
