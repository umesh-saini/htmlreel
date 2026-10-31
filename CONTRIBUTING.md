# Contributing

Thanks for helping. The most useful contributions are bug reports with a **minimal HTML file**, new examples, runtime features (e.g. frame-synced `<video>`), and performance work.

## Setup

```bash
git clone https://github.com/umesh-saini/htmlreel && cd htmlreel
npm install
npx tsx src/cli.ts install-browser   # once
npm test                             # unit tests + real renders in Chrome
npm run cli -- render examples/youtube-intro/index.html --preset hd --duration 6
```

## Layout

| Path | |
|---|---|
| `src/runtime/runtime.js` | The in-page runtime (`window.Reel`). Plain ES5-ish JS, no build step. |
| `src/render.ts` | `renderVideo`, `renderStill(s)`, `preview` |
| `src/browser.ts` | Chrome discovery, BeginFrame / screenshot capture, file server, network policy |
| `src/audio.ts`, `src/captions.ts` | Loudness envelope, peak window, SRT/VTT |
| `src/cli.ts` | The `htmlreel` command |
| `examples/` | Example compositions (also used for the README GIFs: `npm run examples`) |

## Guidelines

- **Determinism is the product.** Anything that makes frames depend on wall-clock time, render order or worker count is a bug. `test/render.test.ts` checks that the same `t` gives byte-identical frames across browsers.
- Keep dependencies minimal (today: `puppeteer-core`, `ffmpeg-static`).
- Run `npm run typecheck && npm test` before pushing.

## Releasing (maintainers)

1. Update `CHANGELOG.md`, bump `version` in `package.json`.
2. `git tag vX.Y.Z && git push --tags`. The Release workflow publishes to npm with provenance (via npm trusted publishing, or an `NPM_TOKEN` secret).
