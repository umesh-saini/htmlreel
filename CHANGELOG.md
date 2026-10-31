# Changelog

## 0.1.1

- Works when npm 12+ skips ffmpeg-static's install script: htmlreel falls back to a system `ffmpeg`, and otherwise fails before launching browsers with the exact fix (`npm install-scripts approve ffmpeg-static && npm rebuild ffmpeg-static`) instead of `Encoder failed: exit -2`.

## 0.1.0

First release, extracted from SangeetFlow's video renderer.

- `renderVideo`: deterministic frame-by-frame rendering in headless Chrome (BeginFrame or screenshot engine), parallel workers, H.264/AAC MP4 output.
- `renderStill(s)` for thumbnails and covers; `preview` with a play/scrub bar.
- Runtime: `--t`, `--p`, `--level`, `--beat`; `data-start` scenes; word-by-word captions; `Reel.onFrame`; frozen clocks and seeded `Math.random`.
- Platform presets for YouTube, Shorts, Instagram Reels, TikTok, Stories and square posts.
- SRT/WebVTT parsing, loudness envelopes, `findPeakWindow` for Shorts/Reels cuts.
- `network: 'local'` sandbox and `isBlankFrame` for validating AI-generated HTML.
- CLI: `render`, `still`, `preview`, `install-browser`, `doctor`, `presets`. Bundled FFmpeg.
