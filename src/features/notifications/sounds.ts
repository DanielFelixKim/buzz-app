import { SOUND_NAMES, type SoundRef } from "./sound";

export interface SoundRegistry {
  /** Known and playable now; Silent counts as available. */
  isAvailable(ref: SoundRef): boolean;
  /** Media URL for a fresh element, or null for Silent and unavailable refs. */
  source(ref: SoundRef): string | null;
  /** Restarts the cached element, or returns null for Silent and unavailable refs. */
  play(ref: SoundRef): HTMLAudioElement | null;
}

const BUNDLED: ReadonlySet<string> = new Set(SOUND_NAMES);

export function createSoundRegistry(): SoundRegistry {
  const elements = new Map<string, HTMLAudioElement>();
  const source = (ref: SoundRef) =>
    BUNDLED.has(ref) ? `/sounds/${ref}.mp3` : null;
  return {
    isAvailable: (ref) => ref === "silent" || BUNDLED.has(ref),
    source,
    play(ref) {
      const url = source(ref);
      if (!url) return null;
      try {
        let audio = elements.get(url);
        if (!audio) {
          audio = new Audio(url);
          elements.set(url, audio);
        }
        audio.currentTime = 0;
        audio.play().catch(() => {
          // Best-effort — user may not have interacted with the page yet.
        });
        return audio;
      } catch {
        // Best-effort only.
        return null;
      }
    },
  };
}
