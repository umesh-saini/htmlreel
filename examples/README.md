# Examples

| Example | Format | Shows |
|---|---|---|
| [youtube-intro](youtube-intro/index.html) | 16:9, 6 s | CSS keyframes, staggered text, `data-start` scenes, `--p` / `--t` driven backgrounds |
| [instagram-reel](instagram-reel/index.html) | 9:16, 10 s | Hook + tip cards, SRT captions with word highlighting, a ring pulsing with `--level` / `--beat`, story-style progress bar |
| [lyric-video](lyric-video/) | 9:16 Short | Node API, `findPeakWindow` to cut the best part of a song, canvas visualizer with `Reel.onFrame`, custom karaoke captions, `Reel.data` |

```bash
# from the repo root
npx tsx src/cli.ts render examples/youtube-intro/index.html --preset youtube --duration 6

npx tsx src/cli.ts render examples/instagram-reel/index.html --preset reel \
  --audio examples/assets/beat.mp3 --captions examples/instagram-reel/captions.srt --duration 10

npm run build && npx tsx examples/lyric-video/render.ts            # or pass your own song.mp3
```

(After `npm install htmlreel` in your own project, use `npx htmlreel …` instead of `npx tsx src/cli.ts …`.)

`assets/beat.mp3` is a synthetic 120 BPM loop generated with FFmpeg's `aevalsrc`, so it's free to use anywhere.

The lyric video is sized in `vmin` / `%` units, so it adapts to any preset (`--preset square`, `--preset youtube`, …). The intro and the Reel use `px` for one fixed size each.
