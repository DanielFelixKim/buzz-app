import { composerSchema, projectComposerDocument } from "./composer-document";
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { recoveryFor } from "./composer-accepted";
import { createRelaySession } from "../relay/session";
import { typedDraft } from "./composer-testing";
import { mentionDraft } from "./mention-draft";
import { writeView } from "../../shared/view-state";
import {
  captureSubmittedDrafts,
  readOwnerDraft,
  registerComposerDraft,
} from "./draft-read";
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
    markdown: "Top level",
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
it.each<[string, string | undefined]>([
  [`x:thread:${thread}`, undefined],
  ["channel", "bad"],
  ["channel", ""],
])("rejects malformed coordinates %s %s", (channel, root) => {
  expect(() => readOwnerDraft(scope, channel, root)).toThrow("Invalid draft");
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

function linkedDraft(href: string) {
  const doc = composerSchema.node("doc", null, [
    composerSchema.node("paragraph", null, [
      composerSchema.text("docs", [composerSchema.marks.link.create({ href })]),
      composerSchema.text(" "),
      composerSchema.text("@Ada", [
        composerSchema.marks.recipient.create({
          pubkey: "b".repeat(64),
          name: "Ada",
        }),
      ]),
    ]),
  ]);
  return projectComposerDocument(doc).draft;
}
it("preserves rich-link destinations without shifting text recipient offsets", () => {
  writeView(scope, "draft:channel", linkedDraft("https://example.com/docs"));
  expect(readOwnerDraft(scope, "channel")).toMatchObject({
    text: "docs @Ada",
    markdown: "[docs](https://example.com/docs) @Ada",
    recipients: [{ pubkey: "b".repeat(64), name: "Ada", start: 5, end: 9 }],
  });
});
it("detects conflicting rich links with identical displayed labels", () => {
  const first = registerComposerDraft(scope, "draft:channel", () =>
    linkedDraft("https://example.com/one"),
  );
  const second = registerComposerDraft(scope, "draft:channel", () =>
    linkedDraft("https://example.com/two"),
  );
  try {
    expect(() => readOwnerDraft(scope, "channel")).toThrow("different drafts");
  } finally {
    first();
    second();
  }
});

it("excludes remembered recipient seeds but preserves typed recipient drafts", () => {
  const recipient = { pubkey: "b".repeat(64), name: "Ada", start: 0, end: 4 };
  const seed = { text: "@Ada", recipients: [recipient] };
  writeView(scope, "draft:channel", seed);
  expect(readOwnerDraft(scope, "channel")).toBeUndefined();
  writeView(scope, "draft:channel", typedDraft(seed));
  expect(readOwnerDraft(scope, "channel")?.text).toBe("@Ada");
});

it("suppresses accepted sibling snapshots while preserving newer live prose", () => {
  const store = createRelaySession(null);
  const sent = mentionDraft("Submitted caption");
  writeView(scope, "draft:channel", sent);
  recoveryFor(store.session).set(`${scope}:draft:channel`, {
    next: mentionDraft(""),
    revision: JSON.stringify(sent),
  });
  let current = sent;
  const stop = registerComposerDraft(scope, "draft:channel", () => current);
  captureSubmittedDrafts(scope, "draft:channel", sent)();
  try {
    expect(
      readOwnerDraft(scope, "channel", undefined, store.session)?.text ?? "",
    ).toBe("");
    current = mentionDraft("Newer unsaved caption");
    expect(
      readOwnerDraft(scope, "channel", undefined, store.session)?.text,
    ).toBe(current.text);
  } finally {
    stop();
    store.dispose();
  }
});

it("retires only snapshots captured before acceptance, preserving identical later edits", () => {
  let current = mentionDraft("Submitted caption");
  const sent = current;
  const stop = registerComposerDraft(scope, "draft:channel", () => current);
  try {
    const accept = captureSubmittedDrafts(scope, "draft:channel", sent);
    expect(readOwnerDraft(scope, "channel")?.text).toBe(sent.text);
    current = mentionDraft(sent.text);
    accept();
    expect(readOwnerDraft(scope, "channel")?.text).toBe(sent.text);
    current = sent;
    expect(readOwnerDraft(scope, "channel")).toBeUndefined();
  } finally {
    stop();
  }
});

it("does not retire different link destinations or another draft coordinate", () => {
  const sent = linkedDraft("https://example.com/one");
  const other = linkedDraft("https://example.com/two");
  const stops = [
    registerComposerDraft(scope, "draft:channel", () => sent),
    registerComposerDraft(scope, "draft:channel", () => other),
    registerComposerDraft(scope, "draft:other", () => sent),
  ];
  try {
    captureSubmittedDrafts(scope, "draft:channel", sent)();
    expect(readOwnerDraft(scope, "channel")?.markdown).toContain(
      "https://example.com/two",
    );
    expect(readOwnerDraft(scope, "other")?.markdown).toContain(
      "https://example.com/one",
    );
  } finally {
    for (const stop of stops) stop();
  }
});
