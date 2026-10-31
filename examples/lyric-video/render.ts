/**
 * Programmatic rendering: a YouTube Short / Instagram Reel cut from the loudest part of a song,
 * with karaoke lyrics and an audio-reactive visualizer.
 *
 *   npx tsx examples/lyric-video/render.ts [song.mp3]
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeLevels, findPeakWindow, renderVideo, type Caption } from 'htmlreel';

const here = path.dirname(fileURLToPath(import.meta.url));
const song = process.argv[2] ?? path.join(here, '../assets/beat.mp3');

// 1. Find the most energetic 8 seconds: the part of the song worth posting.
const levels = await computeLevels(song, 30);
const { start, duration } = findPeakWindow(levels, 30, 8, 0);
console.log(`Using ${start}s – ${(start + duration).toFixed(1)}s of the track`);

// 2. Lyrics in song time (from your SRT, a transcription service, or typed by hand).
const lyric = (s: number, e: number, text: string): Caption => ({ start: start + s, end: start + e, text });
const captions = [lyric(0.2, 2.6, 'Turn the page into a picture'), lyric(2.8, 5.2, 'every frame a line of code'), lyric(5.4, 7.8, 'press render, let it roll')];

// 3. Render: `start` makes composition time = song time, so lyrics, levels and audio line up.
const result = await renderVideo({
  file: path.join(here, 'index.html'),
  preset: 'shorts',
  audio: { path: song, fadeIn: 0.3, fadeOut: 0.8 },
  levels,
  start,
  duration,
  captions,
  data: { title: 'Render the Night', artist: 'htmlreel demo' },
  output: path.join(here, 'lyric-video.mp4'),
  onProgress: (p) => process.stdout.write(`\r${p.percent}%  ${p.fps} fps`),
});
console.log(`\n✓ ${result.output} (${result.frames} frames in ${result.renderSec.toFixed(1)}s)`);
