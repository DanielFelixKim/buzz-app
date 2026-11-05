// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import { viewRevision } from "../../shared/view-state";
import {
  reactionSeenKey,
  readReactionSeen,
  updateReactionSeen,
} from "./reaction-seen";

const scope = "https://relay.test:viewer";
const seen = () => readReactionSeen(viewRevision(scope, reactionSeenKey));
beforeEach(() => localStorage.clear());

it("records, advances and forgets a message's seen watermark", () => {
  updateReactionSeen(scope, "m1", 30);
  updateReactionSeen(scope, "m1", 40);
  updateReactionSeen(scope, "m2", 35);
  expect([...seen()]).toEqual([
    ["m1", 40],
    ["m2", 35],
  ]);
  updateReactionSeen(scope, "m1");
  expect([...seen()]).toEqual([["m2", 35]]);
});

it("keeps the 1,000 latest writes", () => {
  for (let index = 0; index < 1001; index++)
    updateReactionSeen(scope, `m${index}`, index);
  expect(seen().size).toBe(1000);
  expect(seen().has("m0")).toBe(false);
  expect(seen().get("m1000")).toBe(1000);
});

it("ignores malformed saved entries", () => {
  localStorage.setItem(
    `buzz-view.v1:${JSON.stringify([scope, reactionSeenKey])}`,
    JSON.stringify([
      { messageId: "m1", seenThrough: 1 },
      { messageId: 2, seenThrough: 1 },
      { messageId: "m3", seenThrough: -1 },
      null,
    ]),
  );
  expect([...seen()]).toEqual([["m1", 1]]);
});

it("reports a save the device rejects", () => {
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("quota");
  });
  expect(() => updateReactionSeen(scope, "m1", 1)).toThrow(
    "Could not save Inbox reactions on this device. Try again.",
  );
});
