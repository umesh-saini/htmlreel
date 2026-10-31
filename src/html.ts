import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const RUNTIME_PATH = fileURLToPath(new URL('./runtime/runtime.js', import.meta.url));
let runtimeSource: string | null = null;

/** The browser runtime that makes a page seekable (injected into every composition). */
export function runtimeScript(): string {
  return (runtimeSource ??= fs.readFileSync(RUNTIME_PATH, 'utf8'));
}

/** A timed caption / subtitle / lyric line. Times in seconds. */
export interface Caption {
  start: number;
  end: number;
  text: string;
}

/** What the page sees as `window.Reel` (see the runtime contract in the README). */
export interface ReelConfig {
  duration: number;
  width?: number;
  height?: number;
  fps?: number;
  captions?: Caption[];
  /** Set false to stop the runtime from adding its default caption layer. */
  captionsLayer?: boolean;
  /** Loudness envelope 0..1, `levelsFps` values per second (see `computeLevels`). Drives --level and --beat. */
  levels?: number[];
  levelsFps?: number;
  /** Anything your composition needs, exposed as `Reel.data`. */
  data?: unknown;
  mode?: 'render' | 'preview';
  /** Preview mode: the audio to play along. */
  audioUrl?: string;
  /** Composition time shown first (preview, and the initial frame). */
  startAt?: number;
}

/** Injects the config and runtime at the top of <head>, so `Reel` exists before your scripts run. */
export function buildHtml(compositionHtml: string, config: ReelConfig): string {
  // Safe inside <script>: no "</script>", no HTML comments, no JS line separators.
  const json = JSON.stringify(config).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  const inject = `<script>window.__REEL__=${json};</script><script>${runtimeScript()}</script>`;
  if (/<head[^>]*>/i.test(compositionHtml)) return compositionHtml.replace(/<head[^>]*>/i, (m) => `${m}${inject}`);
  if (/<html[^>]*>/i.test(compositionHtml)) return compositionHtml.replace(/<html[^>]*>/i, (m) => `${m}<head>${inject}</head>`);
  return `<!doctype html><html><head>${inject}</head><body>${compositionHtml}</body></html>`;
}
