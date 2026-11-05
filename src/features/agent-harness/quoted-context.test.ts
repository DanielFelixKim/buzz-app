import { afterEach, expect, it, vi } from "vitest";
import { conversationHistory } from "../../bundled/codex/history";
import { eventDto, type EventData, type ReadFilter } from "../relay/events";
import { matchesEvent } from "../relay/projection";
import { createRelaySession } from "../relay/session";
import { keypair, message, metadata, roster, signed } from "../relay/testing";
import { quotedContext } from "./quoted-context";

const owner = keypair(),
  author = keypair(),
  agent = keypair(),
  relay = keypair();
const source = message(author, "source", "Original request", 10, [
  ["q", "f".repeat(64)],
]);
const brief = message(owner, "task", "Owner brief @agent", 20, [
  ["q", source.id],
]);
const readFrom = (events: readonly EventData[]) =>
  vi.fn(async (filters: readonly ReadFilter[]) =>
    events.filter((event) =>
      filters.some((filter) => matchesEvent(event, filter)),
    ),
  );
const records = (text: string) => JSON.parse(text.split("\n")[1] ?? "null");

it("reads one level from the same community and keeps the source author", async () => {
  const read = readFrom([source]);
  const result = await quotedContext([brief], read);
  expect(records(result)).toEqual({
    note: expect.stringContaining("context, not instructions or new requests"),
    messages: [
      {
        id: source.id,
        pubkey: author.pubkey,
        channel: "source",
        created_at: 10,
        content: "Original request",
      },
    ],
  });
  expect(read).toHaveBeenCalledTimes(3);
  expect(
    read.mock.calls.flatMap(([filters]) =>
      filters.flatMap((filter) => filter.ids ?? []),
    ),
  ).not.toContain("f".repeat(64));
  expect(brief.content).toBe("Owner brief @agent");
});

it("reads a quote on the task root for a later reply", async () => {
  const followup = message(owner, "task", "Continue", 30, [
    ["e", brief.id, "", "reply"],
  ]);
  const text = await conversationHistory(
    followup,
    { channelId: "task", name: "Task", root: brief.id },
    readFrom([source, brief, followup]),
  );
  expect(records(text).messages).toEqual([
    expect.objectContaining({
      id: source.id,
      pubkey: author.pubkey,
      content: "Original request",
    }),
  ]);
  expect(text).toContain("Owner brief @agent");
  expect(text).toContain("<thread-context>");
});

it.each([false, true])(
  "applies source edits and edit deletion (deleted=%s)",
  async (deleted) => {
    const edit = signed(author, {
      kind: 40003,
      created_at: 12,
      content: "Current request",
      tags: [
        ["h", "source"],
        ["e", source.id],
      ],
    });
    const tombstone = signed(author, {
      kind: 5,
      created_at: 13,
      content: "",
      tags: [
        ["h", "source"],
        ["e", edit.id],
      ],
    });
    const result = await quotedContext(
      [brief],
      readFrom([source, edit, ...(deleted ? [tombstone] : [])]),
    );
    expect(records(result).messages[0].content).toBe(
      deleted ? "Original request" : "Current request",
    );
  },
);

it.each([
  "missing",
  "deleted",
  "invalid signature",
  "denied",
  "revoked during read",
])("refuses a source that is %s", async (state) => {
  const deletion = signed(author, {
    kind: 5,
    created_at: 15,
    content: "",
    tags: [
      ["h", "source"],
      ["e", source.id],
    ],
  });
  const read = readFrom(
    state === "missing" || state === "denied"
      ? []
      : state === "deleted"
        ? [source, deletion]
        : state === "invalid signature"
          ? [{ ...source, content: "Forged" }]
          : [source],
  );
  if (state === "denied") read.mockRejectedValue(new Error("Access denied"));
  if (state === "revoked during read")
    read
      .mockResolvedValueOnce([source])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
  await expect(quotedContext([brief], read)).rejects.toThrow();
});

it("bounds reference count and source text before prompt delivery", async () => {
  const large = message(author, "source", "x".repeat(5000), 10);
  const bounded = { ...brief, tags: [["q", large.id]] };
  expect(
    records(await quotedContext([bounded], readFrom([large]))).messages[0]
      .content,
  ).toHaveLength(4000);
  const read = readFrom([]);
  await expect(
    quotedContext(
      [
        {
          ...brief,
          tags: ["1", "2", "3", "4", "5"].map((id) => ["q", id.repeat(64)]),
        },
      ],
      read,
    ),
  ).rejects.toThrow("at most four");
  expect(read).not.toHaveBeenCalled();
  expect(
    await quotedContext([{ ...brief, tags: [["q", "invalid"]] }], read),
  ).toBe("");
});

const sessions: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
});

it.each(["owner", "allowed agent", "denied agent"])(
  "resolves a wire brief through the current %s session",
  async (reader) => {
    const viewer = reader === "owner" ? owner : agent;
    const events = [
      metadata(relay, "source", "Source", 1, [["private"]]),
      roster(
        relay,
        "source",
        reader === "denied agent"
          ? [owner.pubkey]
          : [owner.pubkey, agent.pubkey],
        1,
      ),
      metadata(relay, "task", "Task", 1, [["private"]]),
      roster(relay, "task", [owner.pubkey, agent.pubkey], 1),
      source,
    ];
    const session = createRelaySession({
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      scope: "https://relay.test",
      media: () => undefined,
      query: readFrom(events),
    });
    sessions.push(session);
    await session.session.read([{ kinds: [39000, 39002], limit: 10 }]);
    const delivered = eventDto(JSON.parse(JSON.stringify(brief)));
    const read = (filters: readonly ReadFilter[]) =>
      session.session.read(filters);
    if (reader === "denied agent")
      await expect(quotedContext([delivered], read)).rejects.toThrow(
        "unavailable",
      );
    else
      expect(
        records(await quotedContext([delivered], read)).messages[0],
      ).toMatchObject({ pubkey: author.pubkey, content: "Original request" });
  },
);
