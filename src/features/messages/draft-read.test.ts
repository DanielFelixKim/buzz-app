// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { writeView } from "../../shared/view-state";
import { readOwnerDraft, registerComposerDraft } from "./draft-read";
const scope = "https://community.test:owner";
const thread = "a".repeat(64);
afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});
it("reads only one owner/community/channel/thread coordinate without writes", () => {
  writeView(scope, "draft:channel", "Top level");
  writeView(scope, `draft:channel:thread:${thread}`, "Thread prose");
  writeView("another:owner", "draft:channel", "Other community");
  writeView("https://community.test:other", "draft:channel", "Other owner");
  const writes = vi.spyOn(Storage.prototype, "setItem");
  expect(readOwnerDraft(scope, "channel")).toEqual({
    text: "Top level",
    recipients: [],
    source: "saved",
  });
  expect(readOwnerDraft(scope, "channel", thread)?.text).toBe("Thread prose");
  expect(readOwnerDraft(scope, "absent")).toBeUndefined();
  expect(writes).not.toHaveBeenCalled();
});
it("returns newer live prose through storage failures and retires the mounted reader", () => {
  writeView(scope, "draft:channel", "Saved prose");
  let text = "Unsaved prose";
  const stop = registerComposerDraft(scope, "draft:channel", () => ({
    text,
    recipients: [],
  }));
  try {
    expect(readOwnerDraft(scope, "channel")).toMatchObject({
      text,
      source: "composer",
    });
    const fail = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw Error("unavailable");
      });
    text = "Newer live prose";
    expect(readOwnerDraft(scope, "channel")?.text).toBe(text);
    fail.mockRestore();
  } finally {
    stop();
  }
  expect(readOwnerDraft(scope, "channel")?.text).toBe("Saved prose");
});
it("never reads sent-message editing text and reports disagreeing live editors", () => {
  writeView(scope, "draft:channel", "Unsent prose");
  const editing = registerComposerDraft(
    scope,
    "draft:channel",
    () => undefined,
  );
  const first = registerComposerDraft(scope, "draft:channel", () => ({
    text: "One",
    recipients: [],
  }));
  const second = registerComposerDraft(scope, "draft:channel", () => ({
    text: "Two",
    recipients: [],
  }));
  try {
    expect(() => readOwnerDraft(scope, "channel")).toThrow("different drafts");
  } finally {
    first();
    second();
  }
  try {
    expect(readOwnerDraft(scope, "channel")?.text).toBe("Unsent prose");
  } finally {
    editing();
  }
});
it.each([
  ["x:thread:" + thread, undefined],
  ["channel", "bad"],
  ["channel", ""],
])("rejects malformed coordinates %s %s", (channel, root) => {
  expect(() => readOwnerDraft(scope, channel!, root)).toThrow("Invalid draft");
});
it("reports storage failure and corrupt saved drafts separately from absence", () => {
  const fail = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw Error("unavailable");
  });
  expect(() => readOwnerDraft(scope, "channel")).toThrow(
    "storage is unavailable",
  );
  fail.mockRestore();
  localStorage.setItem(
    `buzz-view.v1:${JSON.stringify([scope, "draft:channel"])}`,
    "invalid JSON",
  );
  expect(() => readOwnerDraft(scope, "channel")).toThrow("cannot be read");
});
