/** Output sizes for the platforms people publish to. */
export const PRESETS = {
  /** YouTube, Vimeo, LinkedIn, websites: 16:9 Full HD. */
  youtube: { width: 1920, height: 1080, fps: 30 },
  /** 16:9 4K. */
  'youtube-4k': { width: 3840, height: 2160, fps: 30 },
  /** 16:9 720p: fast drafts. */
  hd: { width: 1280, height: 720, fps: 30 },
  /** YouTube Shorts: 9:16. */
  shorts: { width: 1080, height: 1920, fps: 30 },
  /** Instagram Reels: 9:16. */
  reel: { width: 1080, height: 1920, fps: 30 },
  /** TikTok: 9:16. */
  tiktok: { width: 1080, height: 1920, fps: 30 },
  /** Instagram / Facebook Stories, WhatsApp Status: 9:16. */
  story: { width: 1080, height: 1920, fps: 30 },
  /** Instagram feed portrait: 4:5. */
  'instagram-portrait': { width: 1080, height: 1350, fps: 30 },
  /** Instagram / LinkedIn / X square: 1:1. */
  square: { width: 1080, height: 1080, fps: 30 },
} as const;

export type PresetName = keyof typeof PRESETS;

export function preset(name: string): { width: number; height: number; fps: number } {
  const p = (PRESETS as Record<string, { width: number; height: number; fps: number }>)[name];
  if (!p) throw new Error(`Unknown preset "${name}". Use one of: ${Object.keys(PRESETS).join(', ')}`);
  return { ...p };
}
