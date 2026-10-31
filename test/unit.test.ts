import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { binaryArch, buildHtml, captionsFromText, findHeadlessShell, findPeakWindow, launchHelp, levelsFromPcm, parseSubtitles, preset, PRESETS, renderVideo, serve } from '../src/index.js';

test('buildHtml injects config + runtime first thing in <head>, safely escaped', () => {
  const html = buildHtml('<html><head><title>x</title></head><body></body></html>', { duration: 3, data: { evil: '</script><script>alert(1)</script>', ls: '\u2028' } });
  const head = html.indexOf('<head>');
  assert.ok(html.indexOf('window.__REEL__=') > head && html.indexOf('window.__REEL__=') < html.indexOf('<title>'));
  assert.ok(!html.includes('</script><script>alert(1)'), 'a </script> inside data cannot break out');
  assert.ok(html.includes('\\u003c/script>'));
  assert.ok(!html.includes('\u2028'));
  assert.ok(html.includes('Reel.seek'));
});

test('buildHtml handles fragments and documents without <head>', () => {
  assert.match(buildHtml('<div>hi</div>', { duration: 1 }), /^<!doctype html><html><head><script>window.__REEL__=.*<body><div>hi<\/div><\/body><\/html>$/s);
  assert.match(buildHtml('<html lang="en"><body></body></html>', { duration: 1 }), /<html lang="en"><head><script>/);
});

test('parses SRT', () => {
  const srt = `1\r\n00:00:01,000 --> 00:00:02,500\r\n<i>Hello</i>\r\nworld\r\n\r\n2\r\n00:01:02,250 --> 00:01:04,000\r\n{\\an8}Second line\r\n`;
  assert.deepEqual(parseSubtitles(srt), [
    { start: 1, end: 2.5, text: 'Hello world' },
    { start: 62.25, end: 64, text: 'Second line' },
  ]);
});

test('parses WebVTT (headers, notes, cue ids, settings, short timestamps)', () => {
  const vtt = `WEBVTT\n\nNOTE made by hand\n\nintro\n00:00.500 --> 00:02.000 align:center line:80%\n<v Narrator>Welcome <c.yellow>back</c></v>\n\n01:00:00.000 --> 01:00:01.000\nLate\n`;
  assert.deepEqual(parseSubtitles(vtt), [
    { start: 0.5, end: 2, text: 'Welcome back' },
    { start: 3600, end: 3601, text: 'Late' },
  ]);
});

test('captionsFromText spreads words evenly', () => {
  const c = captionsFromText('one two three four five six seven', 7, 3);
  assert.deepEqual(c.map((x) => x.text), ['one two three', 'four five six', 'seven']);
  assert.equal(c[0].start, 0);
  assert.equal(c[2].end, 7);
});

test('loudness envelope: silence is 0, a loud burst rises fast and decays slowly', () => {
  const rate = 8000;
  const samples = new Int16Array(rate * 2); // 1 s silence, 0.25 s tone, silence
  for (let i = rate; i < rate * 1.25; i++) samples[i] = Math.round(Math.sin(i / 3) * 20000);
  const levels = levelsFromPcm(samples, rate, 20);
  assert.equal(levels.length, 40);
  assert.equal(levels[10], 0);
  assert.ok(levels[21] > 0.8, `attack (${levels[21]})`);
  assert.ok(levels[27] > 0.1 && levels[27] < levels[24], `release (${levels[27]})`);
});

test('findPeakWindow finds the loudest stretch after the intro', () => {
  const fps = 10;
  const levels = Array.from({ length: 600 }, (_, i) => (i < 30 ? 1 : i >= 300 && i < 400 ? 0.9 : 0.1)); // loud intro, chorus at 30 s
  assert.deepEqual(findPeakWindow(levels, fps, 10), { start: 30, duration: 10 });
  assert.deepEqual(findPeakWindow(levels.slice(0, 50), fps, 10), { start: 0, duration: 5 });
});

test('presets', () => {
  assert.deepEqual(preset('reel'), { width: 1080, height: 1920, fps: 30 });
  assert.deepEqual(preset('youtube'), { width: 1920, height: 1080, fps: 30 });
  assert.throws(() => preset('vhs'), /Unknown preset "vhs"/);
  for (const p of Object.values(PRESETS)) assert.ok(p.width % 2 === 0 && p.height % 2 === 0, 'H.264-friendly sizes');
});

/** A file that starts like an ELF binary for the given e_machine. */
function fakeElf(file: string, machine: number) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const b = Buffer.alloc(64);
  b.writeUInt32BE(0x7f454c46, 0);
  b[4] = 2;
  b[5] = 1;
  b.writeUInt16LE(machine, 18);
  fs.writeFileSync(file, b);
}

test('reads CPU architecture from ELF headers', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-'));
  fakeElf(path.join(dir, 'x64'), 0x3e);
  fakeElf(path.join(dir, 'arm64'), 0xb7);
  fs.writeFileSync(path.join(dir, 'wrapper'), '#!/bin/sh\nexec chromium "$@"\n');
  assert.equal(binaryArch(path.join(dir, 'x64')), 'x64');
  assert.equal(binaryArch(path.join(dir, 'arm64')), 'arm64');
  assert.equal(binaryArch(path.join(dir, 'wrapper')), null);
  assert.equal(binaryArch(path.join(dir, 'missing')), null);
});

test('on ARM, skips an x86-64 headless shell and finds the ARM build', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-'));
  const wrong = path.join(root, 'chrome-headless-shell/linux_arm-156.0.0.0/chrome-headless-shell-linux64/chrome-headless-shell');
  fakeElf(wrong, 0x3e);
  assert.equal(findHeadlessShell([root], 'arm64'), null);
  const right = path.join(root, 'playwright/chromium_headless_shell-1248/chrome-headless-shell-linux-arm64/chrome-headless-shell');
  fakeElf(right, 0xb7);
  assert.equal(findHeadlessShell([root], 'arm64'), right);
  assert.equal(findHeadlessShell([root], 'x64'), wrong);
});

test('explains common Chrome launch failures', () => {
  assert.match(launchHelp('[FATAL:zygote_host_impl_linux.cc(130)] No usable sandbox!')!, /noSandbox/);
  assert.match(launchHelp('error while loading shared libraries: libnss3.so: cannot open shared object file')!, /libnss3\.so.*install-deps/);
  assert.match(launchHelp('chrome-headless-shell: 1: Syntax error: "(" unexpected')!, /another CPU/);
  assert.equal(launchHelp('something else'), null);
});

test('the file server serves virtual files and the root folder, and blocks path traversal', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'serve-'));
  fs.writeFileSync(path.join(root, 'a.css'), 'body{}');
  const secret = path.join(path.dirname(root), `secret-${path.basename(root)}.txt`);
  fs.writeFileSync(secret, 'nope');
  const s = await serve({ root, files: { '/index.html': '<p>hi</p>', '/assets/x.svg': { file: path.join(root, 'a.css') } } });
  try {
    const get = (p: string) => fetch(s.origin + p);
    assert.equal(await (await get('/index.html')).text(), '<p>hi</p>');
    const css = await get('/a.css');
    assert.equal(css.headers.get('content-type'), 'text/css; charset=utf-8');
    assert.equal((await get('/assets/x.svg')).headers.get('content-type'), 'text/css; charset=utf-8');
    assert.equal((await get(`/..%2F${path.basename(secret)}`)).status, 404);
    assert.equal((await get('/missing.png')).status, 404);
  } finally {
    await s.close();
  }
});

test('a missing ffmpeg fails fast with instructions (npm 12+ skips ffmpeg-static\'s download)', async () => {
  const prev = process.env.FFMPEG_PATH;
  process.env.FFMPEG_PATH = path.join(os.tmpdir(), 'no-such-dir', 'ffmpeg');
  try {
    await assert.rejects(
      renderVideo({ html: '<p>x</p>', width: 64, height: 64, duration: 1, output: path.join(os.tmpdir(), 'never.mp4') }),
      /install-scripts approve ffmpeg-static/
    );
  } finally {
    if (prev === undefined) delete process.env.FFMPEG_PATH;
    else process.env.FFMPEG_PATH = prev;
  }
});
