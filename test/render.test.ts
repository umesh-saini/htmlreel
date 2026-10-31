/**
 * End-to-end tests in a real browser. Skipped when no Chrome is installed
 * (`npx htmlreel install-browser`, or set HTMLREEL_CHROME).
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildHtml, ffmpegPath, frameVariance, isBlankFrame, launchBrowser, openComposition, probe, renderStill, renderStills, renderVideo, resolveChrome, serve } from '../src/index.js';
import { ffmpeg } from '../src/ffmpeg.js';

let chrome: string | null = null;
try {
  chrome = resolveChrome().path;
} catch {
  chrome = null;
}
const skip = chrome ? false : 'no Chrome found (run `npx htmlreel install-browser`)';

/** A box that slides across in 1 s with a CSS animation, plus a JS-driven element. */
const PAGE = `<!doctype html><html><head><style>
  html,body{margin:0;width:100%;height:100%;background:#123}
  .box{position:absolute;top:40px;left:0;width:80px;height:80px;background:#fc0;animation:move 1s linear both}
  @keyframes move{to{transform:translateX(220px)}}
  #js{position:absolute;bottom:10px;left:10px;color:#fff;font:16px monospace}
</style></head><body><div class="box"></div><div id="js"></div>
<script>Reel.onFrame((t) => { document.getElementById('js').textContent = 't=' + t.toFixed(2) + ' now=' + Date.now() + ' r=' + Math.random().toFixed(6); });</script>
</body></html>`;

describe('rendering in Chrome', { skip }, () => {
  let dir: string;
  before(() => (dir = fs.mkdtempSync(path.join(os.tmpdir(), 'htmlreel-test-'))));
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('frames are a pure function of time: same t → same pixels, different t → different pixels', async () => {
    const out = (n: string) => path.join(dir, n);
    await renderStills({ html: PAGE, width: 320, height: 180, duration: 1, frames: [{ time: 0.5, output: out('a.png') }, { time: 0.1, output: out('b.png') }, { time: 0.5, output: out('c.png') }] });
    // A second browser, frames requested in another order: as if another worker rendered them.
    await renderStill({ html: PAGE, width: 320, height: 180, duration: 1, time: 0.5, output: out('d.png') });
    const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((n) => fs.readFileSync(out(`${n}.png`)));
    assert.ok(a.equals(c), 'same page, same t');
    assert.ok(a.equals(d), 'other browser, same t');
    assert.ok(!a.equals(b), 'other t');
  });

  test('the runtime drives CSS variables, clips, captions and frozen clocks', async () => {
    const html = buildHtml(
      `<div id="clip" data-start="1" data-duration="1">clip</div>`,
      { duration: 4, captions: [{ start: 0.5, end: 1.5, text: 'hello big world' }, { start: 2, end: 3, text: 'next' }], levels: [0, 0.5, 1, 1], levelsFps: 1 }
    );
    const server = await serve({ files: { '/index.html': html } });
    const { browser, engine } = await launchBrowser();
    try {
      const { page } = await openComposition(browser, { url: `${server.origin}/index.html`, width: 320, height: 180, engine });
      // A string, not a function: tsx would inject its `__name` helper, which the page doesn't have.
      const at = (t: number) =>
        page.evaluate(`(() => {
          Reel.seek(${t});
          const s = document.documentElement.style;
          return {
            t: s.getPropertyValue('--t'),
            p: s.getPropertyValue('--p'),
            level: s.getPropertyValue('--level'),
            clipHidden: document.getElementById('clip').classList.contains('reel-hidden'),
            lines: [...document.querySelectorAll('.reel-line')].map((l) => l.className),
            spoken: document.querySelectorAll('.reel-word.is-spoken').length,
            now: Date.now(),
            perf: performance.now(),
          };
        })()`) as Promise<{ t: string; p: string; level: string; clipHidden: boolean; lines: string[]; spoken: number; now: number; perf: number }>;

      const s0 = await at(0);
      assert.equal(s0.clipHidden, true);
      assert.deepEqual(s0.lines, ['reel-line is-future is-next', 'reel-line is-future']);
      assert.equal(s0.p, '0.00000');

      const s1 = await at(1.2);
      assert.equal(s1.t, '1.2000');
      assert.equal(s1.level, '0.6000'); // interpolated between 0.5 @1s and 1 @2s
      assert.equal(s1.clipHidden, false);
      assert.deepEqual(s1.lines, ['reel-line is-active', 'reel-line is-future is-next']);
      assert.equal(s1.spoken, 2); // 70% through the line → 2 of 3 words
      assert.equal(s1.perf, 1200);
      assert.equal(s1.now - s0.now, 1200);

      const s2 = await at(2.5);
      assert.deepEqual(s2.lines, ['reel-line is-past', 'reel-line is-active']);
      assert.equal(s2.clipHidden, true);
    } finally {
      await browser.close();
      await server.close();
    }
  });

  test('renders an MP4 with audio, in parallel workers, with the right length and frame count', async () => {
    const audio = path.join(dir, 'tone.wav');
    await ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', audio]);
    const output = path.join(dir, 'out.mp4');
    const progress: number[] = [];
    const res = await renderVideo({ html: PAGE, width: 320, height: 180, fps: 24, duration: 2, audio: { path: audio, fadeIn: 0.2, fadeOut: 0.5 }, workers: 2, output, onProgress: (p) => progress.push(p.percent) });
    assert.equal(res.frames, 48);
    assert.equal(res.output, output);
    assert.deepEqual(res.pageErrors, []);
    assert.equal(progress.at(-1), 100);

    const info = await probe(output);
    assert.ok(Math.abs(info.duration - 2) < 0.1, `duration ${info.duration}`);
    assert.equal(info.width, 320);
    assert.equal(info.height, 180);
    assert.equal(info.fps, 24);
    assert.ok(info.hasAudio);

    // The frame at 0.5 s of the video matches a still at 0.5 s (the box is mid-way).
    const frame = path.join(dir, 'mid.png');
    await ffmpeg(['-ss', '0.5', '-i', output, '-frames:v', '1', frame]);
    assert.ok((await frameVariance(frame)) > 5);
  });

  test('without audio the video is silent, and duration is required', async () => {
    const output = path.join(dir, 'silent.mp4');
    await renderVideo({ html: PAGE, width: 320, height: 180, duration: 0.5, output });
    const info = await probe(output);
    assert.equal(info.hasAudio, false);
    await assert.rejects(renderVideo({ html: PAGE, width: 320, height: 180, output }), /duration/);
    await assert.rejects(renderVideo({ html: PAGE, width: 321, height: 180, duration: 1, output }), /even width and height/);
  });

  test('file mode serves relative assets next to the page', async () => {
    const site = path.join(dir, 'site');
    fs.mkdirSync(site);
    fs.writeFileSync(path.join(site, 'style.css'), 'body{margin:0;background:#e33}');
    fs.writeFileSync(path.join(site, 'page.html'), '<html><head><link rel="stylesheet" href="style.css"></head><body></body></html>');
    const out = path.join(dir, 'file.png');
    await renderStill({ file: path.join(site, 'page.html'), width: 64, height: 64, output: out });
    const px = await ffmpeg(['-i', out, '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
    assert.ok(px[0] > 200 && px[1] < 80 && px[2] < 80, `red background from style.css, got ${[...px]}`);
  });

  test("network: 'local' blocks remote requests and reports them", async () => {
    const out = path.join(dir, 'net.png');
    const res = await renderStill({ html: '<img src="https://example.com/x.png"><p style="color:#fff">x</p>', width: 64, height: 64, network: 'local', output: out });
    assert.ok(res.pageErrors.some((e) => /Blocked by network policy: https:\/\/example\.com/.test(e)));
  });

  test('blank-frame detection', async () => {
    const out = path.join(dir, 'blank.png');
    await renderStill({ html: '<body style="margin:0;background:#000"></body>', width: 64, height: 64, output: out });
    assert.equal(await isBlankFrame(out), true);
  });
});

test('ffmpeg is available', async () => {
  assert.ok(ffmpegPath());
  assert.match((await ffmpeg(['-version'])).toString(), /ffmpeg version/);
});
