import { afterEach, expect, it, vi } from "vitest";
import { SOUND_NAMES, isSoundName } from "./sound";
import { createSoundRegistry } from "./sounds";

afterEach(() => {
  vi.unstubAllGlobals();
});

it("playback without an Audio constructor reports null, never throws", () => {
  // Bare Node has no Audio global; delivery sound stays best-effort.
  expect(createSoundRegistry().play("doong")).toBeNull();
});

it("playback restarts a cached bundled clip", () => {
  const instances: Array<{ src: string; currentTime: number; play: unknown }> =
    [];
  const play = vi.fn(async () => {});
  vi.stubGlobal(
    "Audio",
    class {
      currentTime = 5;
      play = play;
      constructor(public src: string) {
        instances.push(this);
      }
    },
  );
  const registry = createSoundRegistry();
  const first = registry.play("ping");
  expect(instances[0]?.src).toBe("/sounds/ping.mp3");
  expect(first).toBe(instances[0]);
  expect(first?.currentTime).toBe(0);
  registry.play("ping");
  expect(instances).toHaveLength(1);
  expect(play).toHaveBeenCalledTimes(2);
  for (const name of SOUND_NAMES) registry.play(name);
  // "ping" is already cached from above, so it stays first and is not recreated.
  expect(instances.map((audio) => audio.src)).toEqual(
    ["ping", ...SOUND_NAMES.filter((name) => name !== "ping")].map(
      (name) => `/sounds/${name}.mp3`,
    ),
  );
});

it("Silent is valid and never creates or plays an audio asset", () => {
  const audio = vi.fn();
  vi.stubGlobal("Audio", audio);
  const registry = createSoundRegistry();
  expect(isSoundName("silent")).toBe(true);
  expect(registry.isAvailable("silent")).toBe(true);
  expect(registry.source("silent")).toBeNull();
  expect(registry.play("silent")).toBeNull();
  expect(audio).not.toHaveBeenCalled();
});

it("bundled sounds play from public/sounds", () => {
  const registry = createSoundRegistry();
  expect(registry.isAvailable("ping")).toBe(true);
  expect(registry.source("ping")).toBe("/sounds/ping.mp3");
});
