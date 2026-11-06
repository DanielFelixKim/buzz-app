import { expect, it } from "vitest";
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  parsePreferences,
} from "./preferences";

const stored = {
  enabled: true,
  notifyWhileViewing: false,
  sound: true,
  categories: { mention: true, direct: true, thread: false },
};

it("values saved before per-category sounds restore with the defaults", () => {
  expect(parsePreferences(stored).sounds).toEqual(
    DEFAULT_NOTIFICATION_PREFERENCES.sounds,
  );
});

it.each([
  { mention: "ping", direct: "unison", thread: "doop", agent: "doodone" },
  {
    mention: "silent",
    direct: "silent",
    thread: "silent",
    agent: "silent",
  },
])(
  "saved sound choices round-trip and unknown names reject the payload: %j",
  (sounds) => {
    expect(
      parsePreferences(JSON.parse(JSON.stringify({ ...stored, sounds })))
        .sounds,
    ).toEqual(sounds);
    expect(() => parsePreferences({ ...stored, sounds: "ping" })).toThrow(
      "Invalid notification sounds",
    );
    expect(() =>
      parsePreferences({ ...stored, sounds: { mention: "klaxon" } }),
    ).toThrow("Invalid notification sounds");
  },
);

it("validates and isolates quiet conversation preferences while restoring older settings", () => {
  const saved = {
    ...DEFAULT_NOTIFICATION_PREFERENCES,
    quietConversations: [
      { communityOrigin: "wss://EXAMPLE.test/", channelId: "solo-123" },
    ],
  };
  expect(parsePreferences(saved).quietConversations).toEqual([
    { communityOrigin: "https://example.test", channelId: "solo-123" },
  ]);
  for (const quietConversations of [
    null,
    {},
    [{ communityOrigin: "https://example.test/path", channelId: "chat" }],
    [{ communityOrigin: "https://example.test", channelId: "../chat" }],
    Array(1001).fill(saved.quietConversations[0]),
  ])
    expect(() => parsePreferences({ ...saved, quietConversations })).toThrow();
});
