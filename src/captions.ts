import type { Caption } from './html.js';

const TIME = /(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/;

function seconds(stamp: string): number {
  const m = stamp.match(TIME);
  if (!m) throw new Error(`Bad timestamp: ${stamp}`);
  return (+(m[1] ?? 0)) * 3600 + +m[2] * 60 + +m[3] + +m[4].padEnd(3, '0') / 1000;
}

/**
 * Parses SRT or WebVTT subtitles into captions. Formatting tags (<i>, <b>, {\an8}, VTT voice
 * and timestamp tags) are stripped; multi-line cues are joined with a space.
 */
export function parseSubtitles(text: string): Caption[] {
  const out: Caption[] = [];
  const blocks = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    const i = lines.findIndex((l) => l.includes('-->'));
    if (i === -1) continue; // WEBVTT header, NOTE, STYLE, cue numbers without timing
    const [from, to] = lines[i].split('-->');
    const body = lines
      .slice(i + 1)
      .join(' ')
      .replace(/<[^>]+>/g, '')
      .replace(/\{\\[^}]*\}/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!body) continue;
    out.push({ start: seconds(from), end: seconds(to.trim().split(/\s+/)[0]), text: body });
  }
  return out.sort((a, b) => a.start - b.start);
}

/**
 * Turns a plain script into evenly timed captions, `wordsPerCaption` words each. Handy when you
 * have narration text but no subtitle file. Real timings (SRT from your TTS/transcriber) look better.
 */
export function captionsFromText(text: string, durationSec: number, wordsPerCaption = 4, startSec = 0): Caption[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const per = (durationSec - startSec) / words.length;
  const out: Caption[] = [];
  for (let i = 0; i < words.length; i += wordsPerCaption) {
    const chunk = words.slice(i, i + wordsPerCaption);
    out.push({ start: +(startSec + i * per).toFixed(3), end: +(startSec + (i + chunk.length) * per).toFixed(3), text: chunk.join(' ') });
  }
  return out;
}
