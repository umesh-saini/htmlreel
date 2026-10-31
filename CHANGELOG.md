# Changelog

## 0.1.0

First release, extracted from SangeetFlow's video renderer.

- `renderVideo`: deterministic frame-by-frame rendering in headless Chrome (BeginFrame or screenshot engine), parallel workers, H.264/AAC MP4 output.
- `renderStill(s)` for thumbnails and covers; `preview` with a play/scrub bar.
- Runtime: `--t`, `--p`, `--level`, `--beat`; `data-start` scenes; word-by-word captions; `Reel.onFrame`; frozen clocks and seeded `Math.random`.
- Platform presets for YouTube, Shorts, Instagram Reels, TikTok, Stories and square posts.
- SRT/WebVTT parsing, loudness envelopes, `findPeakWindow` for Shorts/Reels cuts.
- `network: 'local'` sandbox and `isBlankFrame` for validating AI-generated HTML.
- CLI: `render`, `still`, `preview`, `install-browser`, `doctor`, `presets`. Bundled FFmpeg.
