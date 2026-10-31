import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import puppeteer, { type Browser, type CDPSession, type Page } from 'puppeteer-core';

/**
 * Two capture engines:
 *  - "beginframe": chrome-headless-shell driven by HeadlessExperimental.beginFrame. Each call
 *    composites exactly one frame and returns its pixels: fully deterministic and ~2x faster.
 *    Install it with `npx htmlreel install-browser`.
 *  - "screenshot": any regular Chrome/Chromium, using Page.captureScreenshot.
 */
export type Engine = 'beginframe' | 'screenshot';

export interface BrowserOptions {
  /** Chrome / Chromium / chrome-headless-shell binary. Default: discovered (see `resolveChrome`). */
  chromePath?: string;
  /** GPU rasterisation. 'off' (software, works everywhere) | 'vulkan' | 'egl'. Default 'off'. */
  gpu?: 'off' | 'vulkan' | 'egl';
  /** Disable Chrome's sandbox (Docker as root, some CI). Default: env HTMLREEL_NO_SANDBOX=1. */
  noSandbox?: boolean;
}

/** Where `htmlreel install-browser` puts the headless shell. */
export const BROWSER_CACHE_DIR = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'htmlreel');

const SHELL_DIRS = () => [
  ...(process.env.HTMLREEL_BROWSER_DIR ? [process.env.HTMLREEL_BROWSER_DIR] : []),
  BROWSER_CACHE_DIR,
  path.resolve(process.cwd(), '.chrome'),
  path.join(os.homedir(), '.cache', 'puppeteer', 'chrome-headless-shell'),
  path.join(os.homedir(), '.cache', 'ms-playwright'),
];

const SYSTEM_CHROME = [
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

const ELF_MACHINES: Record<number, string> = { 0x03: 'ia32', 0x28: 'arm', 0x3e: 'x64', 0xb7: 'arm64' };

/**
 * The CPU architecture a Linux binary was built for (from its ELF header), or null when it is
 * not an ELF file (macOS/Windows binaries, shell wrappers like /usr/bin/chromium-browser).
 */
export function binaryArch(file: string): string | null {
  try {
    const fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(20);
    fs.readSync(fd, head, 0, 20, 0);
    fs.closeSync(fd);
    if (head.readUInt32BE(0) !== 0x7f454c46) return null; // "\x7fELF"
    const machine = head[5] === 2 ? head.readUInt16BE(18) : head.readUInt16LE(18);
    return ELF_MACHINES[machine] ?? `elf-${machine}`;
  } catch {
    return null;
  }
}

const runsHere = (file: string, cpu: string = process.arch) => {
  const arch = binaryArch(file);
  return arch === null || arch === cpu;
};

const SHELL_NAMES = new Set(['chrome-headless-shell', 'chrome-headless-shell.exe', 'headless_shell', 'headless_shell.exe']);

/** Headless-shell binaries under a folder (@puppeteer/browsers and Playwright layouts), newest first. */
function shellsIn(dir: string, depth = 4): string[] {
  if (depth < 0 || !fs.existsSync(dir)) return [];
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of entries.sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }))) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...shellsIn(p, depth - 1));
    else if (SHELL_NAMES.has(entry.name)) out.push(p);
  }
  return out;
}

/** The newest headless shell in `dirs` built for this CPU (an x64 build on an ARM server is skipped). */
export function findHeadlessShell(dirs: string[] = SHELL_DIRS(), cpu: string = process.arch): string | null {
  for (const dir of dirs) for (const bin of shellsIn(dir)) if (runsHere(bin, cpu)) return bin;
  return null;
}

const engineOf = (bin: string): Engine => (/headless[-_]shell/i.test(bin) ? 'beginframe' : 'screenshot');

/**
 * Picks the browser: `chromePath` option → HTMLREEL_CHROME / CHROME_PATH env → a headless shell
 * (htmlreel cache, ./.chrome, Puppeteer or Playwright caches) → a system Chrome/Chromium.
 */
export function resolveChrome(chromePath?: string): { path: string; engine: Engine } {
  const explicit = chromePath || process.env.HTMLREEL_CHROME || process.env.CHROME_PATH;
  if (explicit) {
    if (!fs.existsSync(explicit)) throw new Error(`Chrome not found at ${explicit}`);
    if (!runsHere(explicit)) throw new Error(`${explicit} is a ${binaryArch(explicit)} build but this machine is ${process.arch}. Run \`npx htmlreel install-browser\`.`);
    return { path: explicit, engine: engineOf(explicit) };
  }
  const shell = findHeadlessShell();
  if (shell) return { path: shell, engine: 'beginframe' };
  const sys = SYSTEM_CHROME.find((p) => fs.existsSync(p) && runsHere(p));
  if (sys) return { path: sys, engine: 'screenshot' };
  throw new Error('No Chrome found. Run `npx htmlreel install-browser` (recommended: fast and deterministic), or install Chrome/Chromium, or set HTMLREEL_CHROME.');
}

const GPU_ARGS: Record<string, string[]> = {
  off: [],
  vulkan: ['--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'],
  egl: ['--use-gl=egl', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'],
};

const BEGIN_FRAME_ARGS = [
  '--deterministic-mode',
  '--enable-begin-frame-control',
  '--run-all-compositor-stages-before-draw',
  '--disable-new-content-rendering-timeout',
  '--disable-threaded-animation',
  '--disable-threaded-scrolling',
  '--disable-checker-imaging',
];

export async function launchBrowser(opts: BrowserOptions = {}): Promise<{ browser: Browser; engine: Engine }> {
  const { path: executablePath, engine } = resolveChrome(opts.chromePath);
  const gpu = opts.gpu ?? ((process.env.HTMLREEL_GPU as BrowserOptions['gpu']) || 'off');
  const args = [
    '--no-first-run',
    '--disable-extensions',
    '--hide-scrollbars',
    '--mute-audio',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--font-render-hinting=none',
    '--force-color-profile=srgb',
    '--disable-dev-shm-usage',
    ...(GPU_ARGS[gpu] ?? []),
    ...(engine === 'beginframe' ? BEGIN_FRAME_ARGS : []),
  ];
  if (opts.noSandbox ?? /^(1|true)$/i.test(process.env.HTMLREEL_NO_SANDBOX ?? '')) args.push('--no-sandbox', '--disable-setuid-sandbox');
  try {
    const browser = await puppeteer.launch({ executablePath, headless: engine === 'beginframe' ? 'shell' : true, args, protocolTimeout: 120_000 });
    return { browser, engine };
  } catch (err) {
    throw new Error(launchHelp((err as Error).message) ?? (err as Error).message);
  }
}

/** Turns the common "Chrome won't start on this machine" failures into instructions. */
export function launchHelp(message: string): string | null {
  if (/No usable sandbox/i.test(message)) {
    return 'Chrome could not start its sandbox (Ubuntu 23.10+ restricts user namespaces; Docker as root has no sandbox). Run `npx htmlreel install-browser` and the sudo command it prints, or set noSandbox: true / HTMLREEL_NO_SANDBOX=1.';
  }
  const lib = message.match(/error while loading shared libraries: ([^\s:]+)/);
  if (lib) return `Chrome is missing the system library ${lib[1]}. Install Chrome's dependencies once: sudo npx -y playwright install-deps chromium`;
  if (/Syntax error: "\(" unexpected|Exec format error/i.test(message)) return `This Chrome was built for another CPU (this machine is ${process.arch}). Run \`npx htmlreel install-browser\`.`;
  return null;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
};

export interface ServeOptions {
  /** Directory served at /. Optional when everything comes from `files`. */
  root?: string;
  /** Virtual files: URL path → contents (string/Buffer) or an absolute file path ({ file }). Checked first. */
  files?: Record<string, string | Buffer | { file: string }>;
}

/** Serves a directory (plus virtual files) on 127.0.0.1 with a random port, for the duration of a render. */
export async function serve(opts: ServeOptions): Promise<{ origin: string; close: () => Promise<void> }> {
  const rootAbs = opts.root ? path.resolve(opts.root) : null;
  const files = opts.files ?? {};
  const server = http.createServer((req, res) => {
    let urlPath: string;
    try {
      urlPath = decodeURIComponent(new URL(req.url || '/', 'http://x').pathname);
    } catch {
      return void res.writeHead(400).end();
    }
    const send = (body: Buffer | string | fs.ReadStream, name: string) => {
      res.writeHead(200, { 'content-type': MIME[path.extname(name).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' });
      if (body instanceof fs.ReadStream) body.pipe(res);
      else res.end(body);
    };
    const virtual = files[urlPath];
    if (virtual !== undefined) {
      if (typeof virtual === 'object' && !Buffer.isBuffer(virtual)) return send(fs.createReadStream(virtual.file), virtual.file);
      return send(virtual, urlPath);
    }
    if (!rootAbs) return void res.writeHead(404).end();
    const file = path.resolve(rootAbs, '.' + urlPath);
    if (!file.startsWith(rootAbs + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return void res.writeHead(404).end();
    send(fs.createReadStream(file), file);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/**
 * Network policy for the page:
 *  - 'allow' (default): anything (remote images, fonts, CDNs).
 *  - 'local': only the local server, data: and blob: URLs, plus Google Fonts. Use it for untrusted
 *    or AI-generated HTML so a page cannot reach your network.
 *  - a list: like 'local', plus URL prefixes / regexes you allow.
 */
export type NetworkPolicy = 'allow' | 'local' | Array<string | RegExp>;

const GOOGLE_FONTS = [/^https:\/\/fonts\.googleapis\.com\//, /^https:\/\/fonts\.gstatic\.com\//];

export interface CompositionPage {
  page: Page;
  engine: Engine;
  /** Errors the page reported (uncaught exceptions, frame hook errors). */
  errors: string[];
  /** Seeks to `t` seconds and returns the frame. */
  frameAt: (t: number) => Promise<Buffer>;
}

export interface OpenOptions {
  url: string;
  width: number;
  height: number;
  engine: Engine;
  network?: NetworkPolicy;
  format?: 'jpeg' | 'png';
  /** JPEG quality. Default 92. */
  quality?: number;
  /** Device pixel ratio (2 renders twice the pixels, sharper text). Default 1. */
  scale?: number;
}

/** Opens a page built with `buildHtml` and waits until the runtime is ready (fonts and images loaded). */
export async function openComposition(browser: Browser, o: OpenOptions): Promise<CompositionPage> {
  const page = o.engine === 'beginframe' ? await (await browser.createBrowserContext()).newPage() : await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(`Uncaught: ${(err as Error).message ?? String(err)}`.slice(0, 400)));
  page.on('console', (msg) => {
    if (msg.type() === 'error' && /^htmlreel:/.test(msg.text())) errors.push(msg.text().slice(0, 400));
  });

  const network = o.network ?? 'allow';
  if (network !== 'allow') {
    const origin = new URL(o.url).origin;
    const extra = Array.isArray(network) ? network : [];
    const allowed = (url: string) =>
      url.startsWith(origin + '/') || url.startsWith('data:') || url.startsWith('blob:') || GOOGLE_FONTS.some((re) => re.test(url)) ||
      extra.some((rule) => (typeof rule === 'string' ? url.startsWith(rule) : rule.test(url)));
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (allowed(req.url())) req.continue().catch(() => undefined);
      else {
        errors.push(`Blocked by network policy: ${req.url().slice(0, 200)}`);
        req.abort('blockedbyclient').catch(() => undefined);
      }
    });
  }

  await page.setViewport({ width: o.width, height: o.height, deviceScaleFactor: o.scale ?? 1 });
  await page.goto(o.url, { waitUntil: 'load', timeout: 60_000 });
  // Interval polling: under BeginFrame control requestAnimationFrame only fires when we ask for a frame.
  await page.waitForFunction('window.__REEL_READY__ === true', { timeout: 30_000, polling: 100 });

  const format = o.format ?? 'jpeg';
  const quality = format === 'jpeg' ? (o.quality ?? 92) : undefined;
  const seek = (t: number) => page.evaluate((time: number) => (globalThis as any).Reel.seek(time), t);

  if (o.engine === 'screenshot') {
    return {
      page,
      engine: o.engine,
      errors,
      frameAt: async (t) => {
        await seek(t);
        return Buffer.from(await page.screenshot({ type: format, quality, optimizeForSpeed: true }));
      },
    };
  }

  const cdp: CDPSession = await page.createCDPSession();
  await cdp.send('HeadlessExperimental.enable' as any);
  await cdp.send('HeadlessExperimental.beginFrame' as any, {} as any); // first layout
  let last: Buffer | null = null;
  const begin = async (): Promise<string | undefined> =>
    ((await cdp.send('HeadlessExperimental.beginFrame' as any, { screenshot: { format, ...(quality ? { quality } : {}) } } as any)) as any).screenshotData;

  return {
    page,
    engine: o.engine,
    errors,
    frameAt: async (t) => {
      await seek(t);
      let data = await begin();
      if (!data && !last) {
        // Nothing changed since the warm-up frame: force damage once so we get pixels.
        await page.evaluate(() => {
          const s = (globalThis as any).document.body.style;
          s.outline = s.outline ? '' : '0px solid transparent';
        });
        data = await begin();
      }
      if (data) last = Buffer.from(data, 'base64');
      if (!last) throw new Error('Chrome produced no frame');
      return last; // no damage → identical to the previous frame
    },
  };
}
