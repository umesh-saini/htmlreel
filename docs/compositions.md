# Writing compositions

A composition is an HTML page. htmlreel injects a runtime (`window.Reel`) at the top of `<head>`, waits for fonts and images, and then calls `Reel.seek(t)` once per frame. Everything on screen must be a function of `t`.

You can also paste this page into an LLM prompt as the spec for generating compositions.

## Lifecycle

1. Your page loads. `window.Reel` already exists, so inline scripts can read `Reel.data`, `Reel.width` and so on.
2. On `DOMContentLoaded` the runtime builds the caption DOM and finds `[data-start]` scenes.
3. It waits for `document.fonts.ready` and all `<img>` elements (up to 8 s).
4. It calls `Reel.seek(t)` for each frame and captures it. Frames may be rendered **out of order and in different browsers**, so never keep state between frames.

## Time sources

| Source | Behaviour |
|---|---|
| CSS `@keyframes` animations | Paused and set to the frame time. Inside `[data-start]` they count from the scene start. |
| SVG SMIL (`<animate>`) | Paused and set to the frame time. |
| `--t`, `--p`, `--level`, `--beat` | CSS custom properties on `:root`, updated every frame. |
| `Reel.onFrame(fn)` / `window.render(t, Reel)` | Called after everything else, every frame. |
| `Date.now()`, `performance.now()` | Return virtual time (they follow `t`). |
| `Math.random()` | Seeded and reset before each frame hook, so it gives the same sequence every frame. Use `Reel.rand(seed)` for your own streams. |
| CSS `transition` | Disabled, because it depends on wall-clock time. |
| `setTimeout`, `setInterval`, `requestAnimationFrame` | **Don't use them for motion.** They don't advance with virtual time. |
| `<video>`, `<audio>` | Not synced. Pass audio with the `audio` option. |

## Scenes

```html
<section data-start="3" data-duration="2.5">…</section>
```

- Hidden (`visibility: hidden`) outside `[3, 5.5)`.
- `animation-delay: .2s` inside it means 3.2 s into the video.
- Nest freely. Each animation counts from its nearest `[data-start]` ancestor.

## Captions

Input: `[{ start, end, text }]` (seconds). Output DOM:

```html
<div id="reel-captions">
  <div class="reel-line is-active" data-reel-line style="--lp: .42; --dur: 2.3s; --li: 0; --wn: 4">
    <span class="reel-word is-spoken" style="--wi: 0">Three</span>
    <span class="reel-word is-spoken" style="--wi: 1">CSS</span>
    <span class="reel-word" style="--wi: 2">tricks</span> …
  </div>
  <div class="reel-line is-future is-next">…</div>
</div>
```

- Without your own `#reel-captions`, a default layer is added (`.reel-default`): centered, bold, near the bottom, and higher on vertical videos so it clears the Reels/TikTok UI.
- Add `<div id="reel-captions"></div>` to place and style captions yourself.
- `captionsLayer: false` turns the default layer off (use `Reel.activeCaption(t)` in `onFrame` to draw captions yourself).
- Animations on `.reel-line` count from the line's start time.

## Audio reactivity

When you pass `audio`, htmlreel computes a loudness envelope (fast attack, slow release, normalised to the track's 95th percentile):

```css
.logo  { transform: scale(calc(1 + var(--level) * .15)); }
.flash { opacity: var(--beat); }
```

```js
Reel.onFrame((t) => {
  for (let i = 0; i < 32; i++) bar(i, Reel.levelAt(t - i * 0.02)); // a trail of past levels
});
```

## Data

Everything in the `data` option is available as `Reel.data`. Use it to build one template and render many videos:

```html
<h1 id="title"></h1>
<script>document.getElementById('title').textContent = Reel.data.title;</script>
```

## Assets

- With `file: 'video/index.html'`, everything in `video/` is served, so `<img src="photo.jpg">` just works.
- With `html: '…'`, pass `baseDir`, or map files with `assets: { 'logo.png': '/abs/path/logo.png' }` and use `src="assets/logo.png"`.
- Remote URLs work with the default `network: 'allow'`. Under `network: 'local'` only Google Fonts and an explicit allowlist are reachable.

## Performance

- Every frame is a full browser paint. Big blurred layers (`filter: blur`, `backdrop-filter`) and SVG filters on moving elements are the most expensive things you can do.
- `will-change: transform` on large layers that only move keeps them as GPU textures.
- Canvas drawing in `onFrame` is cheap. DOM thrash (creating thousands of nodes per frame) is not.
- `scale: 2` paints 4× the pixels, so it is much slower. Use it for text-heavy videos only.

## A prompt template for LLM-generated compositions

```
Write one self-contained HTML document for a {width}x{height} video, {duration} seconds long.
Rules:
- Motion only via CSS @keyframes, the CSS variables --t (seconds), --p (0..1), --level and --beat (0..1 audio),
  elements with data-start/data-duration (seconds) for scenes, or Reel.onFrame((t) => …) for canvas.
- No setTimeout, setInterval, requestAnimationFrame, CSS transitions, <video> or <audio>.
- Use vmin units. Fonts: Google Fonts only. Read content from Reel.data.
- Include an empty <div id="reel-captions"></div> and style .reel-line / .reel-word / .is-active / .is-spoken.
Content: {brief}
```
