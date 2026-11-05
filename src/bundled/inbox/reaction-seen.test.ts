// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import { viewRevision } from "../../shared/view-state";
import {
  reactionSeenKey,
  reactionsUnseen,
  readReactionSeen,
  updateReactionSeen,
} from "./reaction-seen";

const scope = "https://relay.test:viewer";
const seen = () => readReactionSeen(viewRevision(scope, reactionSeenKey));
const through = () =>
  [...seen()].map(([messageId, entry]) => [messageId, entry.through]);
beforeEach(() => localStorage.clear());

it("records, advances and forgets a message's seen watermark", () => {
  updateReactionSeen(scope, "m1", { through: 30, ids: ["r1"] });
  updateReactionSeen(scope, "m1", { through: 40, ids: ["r2"] });
  updateReactionSeen(scope, "m2", { through: 35, ids: ["r3"] });
  expect(through()).toEqual([
    ["m1", 40],
    ["m2", 35],
  ]);
  expect([...(seen().get("m1")?.ids ?? [])]).toEqual(["r2"]);
  updateReactionSeen(scope, "m1");
  expect(through()).toEqual([["m2", 35]]);
});

it("treats a reaction at the watermark second as unseen unless its id was seen", () => {
  updateReactionSeen(scope, "m1", { through: 40, ids: ["r1"] });
  const entry = seen().get("m1");
  expect(reactionsUnseen(entry, 39, ["r0"])).toBe(false);
  expect(reactionsUnseen(entry, 40, ["r1"])).toBe(false);
  expect(reactionsUnseen(entry, 40, ["r1", "r2"])).toBe(true);
  expect(reactionsUnseen(entry, 41, ["r3"])).toBe(true);
  expect(reactionsUnseen(undefined, 1, ["r4"])).toBe(true);
});

it("keeps the 1,000 latest writes", () => {
  for (let index = 0; index < 1001; index++)
    updateReactionSeen(scope, `m${index}`, { through: index, ids: [] });
  expect(seen().size).toBe(1000);
  expect(seen().has("m0")).toBe(false);
  expect(seen().get("m1000")?.through).toBe(1000);
});

it("ignores malformed saved entries", () => {
  localStorage.setItem(
    `buzz-view.v1:${JSON.stringify([scope, reactionSeenKey])}`,
    JSON.stringify([
      { messageId: "m1", seenThrough: 1, seenIds: ["r1"] },
      { messageId: 2, seenThrough: 1, seenIds: [] },
      { messageId: "m3", seenThrough: -1, seenIds: [] },
      { messageId: "m4", seenThrough: 1, seenIds: [4] },
      { messageId: "m5", seenThrough: 1 },
      null,
    ]),
  );
  expect(through()).toEqual([["m1", 1]]);
});

it("reports a save the device rejects", () => {
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("quota");
  });
  expect(() =>
    updateReactionSeen(scope, "m1", { through: 1, ids: [] }),
  ).toThrow("Could not save Inbox reactions on this device. Try again.");
});
