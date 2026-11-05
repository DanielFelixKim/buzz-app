import { createHash } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "nostr-tools/utils";
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
const readFrom = <T extends EventData>(events: readonly T[]) =>
  vi.fn(async (filters: readonly ReadFilter[]) =>
    events.filter((event) =>
      filters.some((filter) => matchesEvent(event, filter)),
    ),
  );
const records = (text: string) => JSON.parse(text.split("\n")[1] ?? "null");

it("reads one level from the same community and keeps the source author", async () => {
  const read = readFrom([source]);
  const result = await quotedContext([brief], read, { owner: owner.pubkey });
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
    undefined,
    undefined,
    owner.pubkey,
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
      { owner: owner.pubkey },
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
  await expect(
    quotedContext([brief], read, { owner: owner.pubkey }),
  ).rejects.toThrow();
});

it("bounds reference count and source text before prompt delivery", async () => {
  const large = message(author, "source", "x".repeat(5000), 10);
  const bounded = message(owner, "task", "Brief", 20, [["q", large.id]]);
  expect(
    records(
      await quotedContext([bounded], readFrom([large]), {
        owner: owner.pubkey,
      }),
    ).messages[0].content,
  ).toHaveLength(4000);
  const read = readFrom([]);
  await expect(
    quotedContext(
      [
        message(
          owner,
          "task",
          "Brief",
          20,
          ["1", "2", "3", "4", "5"].map((id) => ["q", id.repeat(64)]),
        ),
      ],
      read,
      { owner: owner.pubkey },
    ),
  ).rejects.toThrow("at most four");
  expect(read).not.toHaveBeenCalled();
  expect(
    await quotedContext(
      [message(owner, "task", "Brief", 20, [["q", "invalid"]])],
      read,
      { owner: owner.pubkey },
    ),
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
      await expect(
        quotedContext([delivered], read, { owner: owner.pubkey }),
      ).rejects.toThrow("unavailable");
    else
      expect(
        records(await quotedContext([delivered], read, { owner: owner.pubkey }))
          .messages[0],
      ).toMatchObject({ pubkey: author.pubkey, content: "Original request" });
  },
);

it("expands only signed owner quotes from historical messages", async () => {
  const other = message(
    author,
    "task",
    "Other reply",
    15,
    ["1", "2", "3", "4", "5"].map((id) => ["q", id.repeat(64)]),
  );
  const read = readFrom([source]);
  const result = await quotedContext([brief, other], read, {
    owner: owner.pubkey,
  });
  expect(records(result).messages).toHaveLength(1);
  expect(await quotedContext([other], read, { owner: owner.pubkey })).toBe("");
  read.mockClear();
  await expect(
    quotedContext([{ ...brief, content: "Forged owner quote" }], read, {
      owner: owner.pubkey,
    }),
  ).rejects.toThrow("invalidly signed");
  expect(read).not.toHaveBeenCalled();
});

it.each(["edit", "delete"])(
  "applies a reference-only source %s",
  async (kind) => {
    const overlay = signed(author, {
      kind: kind === "edit" ? 40003 : 5,
      created_at: 15,
      content: "Current request",
      tags: [["e", source.id]],
    });
    const result = quotedContext([brief], readFrom([source, overlay]), {
      owner: owner.pubkey,
    });
    if (kind === "delete") await expect(result).rejects.toThrow("unavailable");
    else
      expect(records(await result).messages[0].content).toBe("Current request");
  },
);

it.each([true, false])(
  "uses source owner edits only with verified profile authority (attested=%s)",
  async (attested) => {
    const auth = bytesToHex(
      schnorr.sign(
        createHash("sha256")
          .update(`nostr:agent-auth:${agent.pubkey}:`)
          .digest(),
        owner.secret,
      ),
    );
    const profile = eventDto(
      signed(agent, {
        kind: 0,
        created_at: 1,
        content: "{}",
        tags: attested ? [["auth", owner.pubkey, "", auth]] : [],
      }),
    );
    const original = message(agent, "source", "Agent source", 10);
    const edit = signed(owner, {
      kind: 40003,
      created_at: 11,
      content: "Owner edit",
      tags: [
        ["h", "source"],
        ["e", original.id],
      ],
    });
    const request = message(owner, "task", "Brief", 20, [["q", original.id]]);
    const result = await quotedContext([request], readFrom([original, edit]), {
      owner: owner.pubkey,
      profiles: {
        profiles: async () => {},
        profile: (id) => (id === agent.pubkey ? profile : undefined),
      },
    });
    expect(records(result).messages[0]).toMatchObject({
      pubkey: agent.pubkey,
      content: attested ? "Owner edit" : "Agent source",
    });
  },
);
