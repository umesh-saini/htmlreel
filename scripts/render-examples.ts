/**
 * Renders the examples and regenerates the README GIFs in docs/media.
 *   npm run examples
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSubtitles, renderVideo } from '../src/index.js';
import { ffmpeg } from '../src/ffmpeg.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'examples', 'out');
const media = path.join(root, 'docs', 'media');
fs.mkdirSync(media, { recursive: true });

async function gif(video: string, width: number, name: string) {
  const vf = `fps=12,scale=${width}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`;
  await ffmpeg(['-i', video, '-vf', vf, path.join(media, name)]);
  console.log(`  → docs/media/${name}`);
}

const log = (name: string) => (p: { percent: number; fps: number }) => process.stdout.write(`\r${name}: ${p.percent}% (${p.fps} fps)   `);

const intro = await renderVideo({ file: path.join(root, 'examples/youtube-intro/index.html'), preset: 'youtube', duration: 6, output: path.join(out, 'youtube-intro.mp4'), onProgress: log('youtube-intro') });
console.log(`\n✓ ${intro.output}`);
await gif(intro.output, 640, 'youtube-intro.gif');

const reel = await renderVideo({
  file: path.join(root, 'examples/instagram-reel/index.html'),
  preset: 'reel',
  duration: 10,
  audio: path.join(root, 'examples/assets/beat.mp3'),
  captions: parseSubtitles(fs.readFileSync(path.join(root, 'examples/instagram-reel/captions.srt'), 'utf8')),
  output: path.join(out, 'instagram-reel.mp4'),
  onProgress: log('instagram-reel'),
});
console.log(`\n✓ ${reel.output}`);
await gif(reel.output, 300, 'instagram-reel.gif');

console.log('Lyric video: npx tsx examples/lyric-video/render.ts (needs `npm run build` first), then convert examples/lyric-video/lyric-video.mp4.');
