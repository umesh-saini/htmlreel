#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { resolveChrome } from './browser.js';
import { parseSubtitles } from './captions.js';
import { ffmpegPath, run } from './ffmpeg.js';
import { installBrowser } from './install.js';
import { PRESETS, type PresetName } from './presets.js';
import { preview, renderStill, renderVideo, type CompositionOptions } from './render.js';

const HELP = `htmlreel: render HTML/CSS into MP4 videos for YouTube, Shorts, Instagram Reels and TikTok.

Usage
  htmlreel render  <page.html> [options]     Render a video
  htmlreel still   <page.html> [options]     Render one frame (thumbnail, cover)
  htmlreel preview <page.html> [options]     Open the page with a play/scrub bar
  htmlreel install-browser                   Install the fast, deterministic render browser
  htmlreel doctor                            Show which Chrome and ffmpeg will be used
  htmlreel presets                           List output sizes

Options
  -o, --output <file>      Output file (default: <page>.mp4 / <page>.png)
  -p, --preset <name>      youtube | shorts | reel | tiktok | story | square | instagram-portrait | hd | youtube-4k
  -W, --width <px>         -H, --height <px>        --fps <n>
  -d, --duration <sec>     Length (default: the audio's length)
      --start <sec>        Composition time of the first frame
  -a, --audio <file>       Soundtrack (mp3, wav, m4a…); also drives --level / --beat
      --fade-in <sec>      --fade-out <sec>         --volume <x>
  -c, --captions <file>    Subtitles (.srt or .vtt) shown word by word
      --data <file.json>   JSON exposed to the page as Reel.data
  -t, --time <sec>         (still) the moment to capture
      --workers <n>        Parallel browsers (default: half your cores, max 4)
      --crf <n>            Quality, lower is better (default 18)
      --scale <n>          Device pixel ratio, e.g. 2 for extra-sharp text
      --network <mode>     allow (default) | local (block remote requests: for untrusted HTML)
      --gpu <mode>         off (default) | vulkan | egl
      --chrome <path>      Browser binary to use
      --no-sandbox         Run Chrome without its sandbox (Docker as root)

Examples
  htmlreel render intro.html --preset youtube --duration 8
  htmlreel render reel.html --preset reel --audio song.mp3 --captions song.srt -o reel.mp4
  htmlreel still thumb.html --preset youtube -o thumbnail.png
`;

const { values: v, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    output: { type: 'string', short: 'o' },
    preset: { type: 'string', short: 'p' },
    width: { type: 'string', short: 'W' },
    height: { type: 'string', short: 'H' },
    fps: { type: 'string' },
    duration: { type: 'string', short: 'd' },
    start: { type: 'string' },
    audio: { type: 'string', short: 'a' },
    'fade-in': { type: 'string' },
    'fade-out': { type: 'string' },
    volume: { type: 'string' },
    captions: { type: 'string', short: 'c' },
    data: { type: 'string' },
    time: { type: 'string', short: 't' },
    workers: { type: 'string' },
    crf: { type: 'string' },
    scale: { type: 'string' },
    network: { type: 'string' },
    gpu: { type: 'string' },
    chrome: { type: 'string' },
    'no-sandbox': { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
    version: { type: 'boolean', short: 'v' },
  },
});

const num = (s: string | undefined, name: string) => {
  if (s === undefined) return undefined;
  const n = Number(s);
  if (!Number.isFinite(n)) throw new Error(`--${name} must be a number (got "${s}")`);
  return n;
};

function composition(file: string): CompositionOptions {
  if (!fs.existsSync(file)) throw new Error(`File not found: ${file}`);
  if (v.preset && !(v.preset in PRESETS)) throw new Error(`Unknown preset "${v.preset}". Run \`htmlreel presets\`.`);
  if (v.network && !['allow', 'local'].includes(v.network)) throw new Error('--network must be allow or local');
  if (v.gpu && !['off', 'vulkan', 'egl'].includes(v.gpu)) throw new Error('--gpu must be off, vulkan or egl');
  return {
    file,
    preset: v.preset as PresetName | undefined,
    width: num(v.width, 'width'),
    height: num(v.height, 'height'),
    fps: num(v.fps, 'fps'),
    scale: num(v.scale, 'scale'),
    captions: v.captions ? parseSubtitles(fs.readFileSync(v.captions, 'utf8')) : undefined,
    data: v.data ? JSON.parse(fs.readFileSync(v.data, 'utf8')) : undefined,
    network: v.network as 'allow' | 'local' | undefined,
    gpu: v.gpu as 'off' | 'vulkan' | 'egl' | undefined,
    chromePath: v.chrome,
    noSandbox: v['no-sandbox'] || undefined,
  };
}

const withExt = (file: string, ext: string) => path.join(path.dirname(file), path.basename(file, path.extname(file)) + ext);
const fmtTime = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

async function main() {
  const [cmd, file] = positionals;
  if (v.version) {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    return console.log(pkg.version);
  }
  if (v.help || !cmd) return console.log(HELP);

  switch (cmd) {
    case 'render': {
      if (!file) throw new Error('Usage: htmlreel render <page.html> [options]');
      const output = v.output ?? withExt(file, '.mp4');
      const audio = v.audio ? { path: v.audio, fadeIn: num(v['fade-in'], 'fade-in'), fadeOut: num(v['fade-out'], 'fade-out'), volume: num(v.volume, 'volume') } : undefined;
      const tty = process.stderr.isTTY;
      const res = await renderVideo({
        ...composition(file),
        output,
        audio,
        duration: num(v.duration, 'duration'),
        start: num(v.start, 'start'),
        workers: num(v.workers, 'workers'),
        crf: num(v.crf, 'crf'),
        onProgress: (p) => {
          const bar = '█'.repeat(Math.round(p.percent / 4)).padEnd(25, '░');
          const line = `${bar} ${String(p.percent).padStart(3)}%  frame ${p.frame}/${p.total}  ${p.fps} fps  eta ${fmtTime(p.etaSec)}`;
          if (tty) process.stderr.write(`\r${line}`);
          else if (p.percent % 10 === 0) console.error(line);
        },
      });
      if (tty) process.stderr.write('\n');
      for (const e of res.pageErrors) console.warn(`page: ${e}`);
      console.log(`✓ ${res.output}  ${res.width}x${res.height} @ ${res.fps}fps, ${res.durationSec.toFixed(1)}s, ${res.frames} frames in ${res.renderSec.toFixed(1)}s (${res.engine})`);
      return;
    }
    case 'still': {
      if (!file) throw new Error('Usage: htmlreel still <page.html> [options]');
      const res = await renderStill({ ...composition(file), output: v.output ?? withExt(file, '.png'), time: num(v.time, 'time') ?? 0, duration: num(v.duration, 'duration') });
      for (const e of res.pageErrors) console.warn(`page: ${e}`);
      console.log(`✓ ${res.output}`);
      return;
    }
    case 'preview': {
      if (!file) throw new Error('Usage: htmlreel preview <page.html> [options]');
      const p = await preview({ ...composition(file), audio: v.audio, duration: num(v.duration, 'duration') ?? (v.audio ? undefined : 10) });
      console.log(`Preview: ${p.url}\n(Space plays/pauses. Ctrl+C to stop.)`);
      process.on('SIGINT', () => p.close().then(() => process.exit(0)));
      return new Promise(() => undefined);
    }
    case 'install-browser':
      return installBrowser();
    case 'doctor': {
      try {
        const c = resolveChrome(v.chrome);
        console.log(`browser  ${c.path}\nengine   ${c.engine}${c.engine === 'screenshot' ? '  (run `htmlreel install-browser` for the faster, deterministic beginframe engine)' : ''}`);
      } catch (err) {
        console.log(`browser  ✗ ${(err as Error).message}`);
      }
      try {
        const out = await run(ffmpegPath(), ['-version'], { timeoutMs: 10_000 });
        console.log(`ffmpeg   ${ffmpegPath()}\n         ${out.stdout.toString().split('\n')[0]}`);
      } catch (err) {
        console.log(`ffmpeg   ✗ ${(err as Error).message}`);
      }
      console.log(`node     ${process.version} (${process.platform}-${process.arch})`);
      return;
    }
    case 'presets':
      for (const [name, p] of Object.entries(PRESETS)) console.log(`${name.padEnd(20)} ${p.width}x${p.height} @ ${p.fps}fps`);
      return;
    default:
      throw new Error(`Unknown command "${cmd}". Run \`htmlreel --help\`.`);
  }
}

main().catch((err) => {
  console.error(`htmlreel: ${(err as Error).message}`);
  process.exit(1);
});
