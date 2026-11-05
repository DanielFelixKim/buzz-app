import { afterEach, expect, it, vi } from "vitest";
import type { EventTemplate } from "nostr-tools";
import type { RelayEvent } from "./events";
import type { LiveCallbacks } from "./live";
import type { Outbox } from "./outbox";
import { createPins, PIN_KIND } from "./pins";
import { matchesEvent } from "./projection";
import { createRelaySession } from "./session";
import { bounds, flush, keypair, message, signed } from "./testing";

const channelId = "11111111-1111-4111-8111-111111111111";
const viewer = keypair(),
  other = keypair(),
  relay = keypair();
const root = message(other, channelId, "Decision: ship Friday", 1);
const owners: { dispose(): void }[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
});

async function setup(
  options: { tags?: string[][]; role?: string; extra?: RelayEvent[] } = {},
) {
  const { tags = [["t", "stream"]], role = "member", extra = [] } = options;
  const events: RelayEvent[] = [
    signed(relay, {
      kind: 39000,
      created_at: 1,
      content: "",
      tags: [["d", channelId], ["name", "Updates"], ["public"], ...tags],
    }),
    signed(relay, {
      kind: 39002,
      created_at: 1,
      content: "",
      tags: [
        ["d", channelId],
        ["p", other.pubkey, "", "owner"],
        ["p", viewer.pubkey, "", role],
      ],
    }),
    root,
    ...extra,
  ];
  const published: RelayEvent[] = [];
  let live!: LiveCallbacks;
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      media: (url) => url,
      writer: {
        sign: async (template: EventTemplate) => signed(viewer, template),
        publish: async (event: RelayEvent) => {
          published.push(event);
        },
      },
      query: async (filters) =>
        filters.flatMap((filter) => [
          ...events.filter((event) => matchesEvent(event, filter)),
          ...(filter.top_level && filter["#h"]
            ? [
                bounds(relay, channelId, "head", {
                  has_more: false,
                  next_cursor: null,
                }),
              ]
            : []),
        ]),
      subscribe(callbacks) {
        live = callbacks;
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    { outboxStorage: { load: () => [], save() {} } },
  );
  owners.push(owner);
  const { session } = owner;
  session.channels.refreshList?.();
  await vi.waitFor(() => expect(session.channels.list().status).toBe("ready"));
  session.channels.ensure(channelId);
  await vi.waitFor(() =>
    expect(session.channels.window(channelId).rows).toHaveLength(
      1 + extra.filter((event) => [9, 40008].includes(event.kind)).length,
    ),
  );
  const pins = session.pins;
  if (!pins) throw new Error("Expected session.pins");
  const row = (id = root.id) => {
    const found = session.channels
      .window(channelId)
      .rows.find((item) => item.id === id);
    if (!found) throw new Error("Expected a window row");
    return found;
  };
  return {
    session,
    pins,
    row,
    published,
    receive: (...received: RelayEvent[]) => live.receive(received),
  };
}
const contentTags = (event: RelayEvent | undefined) =>
  event?.tags.filter(([name]) => name !== "client-id");
const pinOf = (
  author: ReturnType<typeof keypair>,
  target: RelayEvent,
  at = 2,
) =>
  signed(author, {
    kind: PIN_KIND,
    content: "",
    created_at: at,
    tags: [
      ["h", channelId],
      ["e", target.id],
    ],
  });
const deletionOf = (author: ReturnType<typeof keypair>, target: RelayEvent) =>
  signed(author, {
    kind: 5,
    content: "",
    created_at: 3,
    tags: [
      ["h", channelId],
      ["e", target.id],
      ["k", String(target.kind)],
    ],
  });

it("lets the viewer pin a message in a writable stream channel", async () => {
  const { pins, row } = await setup();
  expect(pins.canPin(row())).toBe(true);
});

it("refuses to pin in a DM, an archived channel or a read-only channel", async () => {
  for (const options of [
    { tags: [["t", "dm"]] },
    {
      tags: [
        ["t", "stream"],
        ["archived", "true"],
      ],
    },
    { role: "guest" },
  ]) {
    const { pins, row } = await setup(options);
    expect(pins.canPin(row()), JSON.stringify(options)).toBe(false);
  }
});

it("refuses a huddle row and a kind outside the pinnable kinds", async () => {
  const diff = signed(other, {
    kind: 40008,
    content: "@@ -1 +1 @@\n-a\n+b",
    created_at: 2,
    tags: [["h", channelId]],
  });
  const { pins, row } = await setup({ extra: [diff] });
  expect(
    pins.canPin({ ...row(), huddle: { room: "r", state: "started" } }),
  ).toBe(false);
  expect(pins.canPin(row(diff.id))).toBe(false);
});

it("refuses a message whose deletion has arrived", async () => {
  const { session, pins, row, receive } = await setup();
  const stale = row();
  receive(deletionOf(other, root));
  await vi.waitFor(() =>
    expect(session.channels.window(channelId).rows).toHaveLength(0),
  );
  expect(pins.canPin(stale)).toBe(false);
});

it("refuses a message the viewer already pinned but not one only someone else pinned", async () => {
  const { pins, row, receive } = await setup();
  const theirs = pinOf(other, root, 2);
  receive(theirs);
  await vi.waitFor(() => expect(row().pinnedBy).toHaveLength(1));
  expect(pins.canPin(row())).toBe(true);
  expect(pins.ownPin(row())).toBeUndefined();
  const mine = pinOf(viewer, root, 3);
  receive(mine);
  await vi.waitFor(() => expect(row().pinnedBy).toHaveLength(2));
  expect(pins.canPin(row())).toBe(false);
  expect(pins.ownPin(row())).toEqual({
    id: mine.id,
    messageId: root.id,
    pinnedBy: viewer.pubkey,
    pinnedAt: 3,
  });
});

it("pins by publishing a kind 40004 event and returns its operation id", async () => {
  const { session, pins, published } = await setup();
  const id = pins.pin(channelId, root.id);
  expect(session.outbox?.snapshot().map((item) => item.event.id)).toContain(id);
  await vi.waitFor(() => expect(published).toHaveLength(1));
  expect(published[0]).toMatchObject({ id, kind: PIN_KIND, content: "" });
  expect(contentTags(published[0])).toEqual([
    ["h", channelId],
    ["e", root.id],
  ]);
});

it("refuses to pin a message outside the channel or an unloaded one", async () => {
  const { pins } = await setup();
  expect(() => pins.pin("elsewhere", root.id)).toThrow();
  expect(() => pins.pin(channelId, "f".repeat(64))).toThrow(
    "Load the message before pinning it",
  );
});

it("unpins by deleting the viewer's pin with its kind and returns the operation id", async () => {
  const { session, pins, row, published, receive } = await setup();
  const mine = pinOf(viewer, root);
  receive(mine);
  await vi.waitFor(() => expect(row().pinnedBy).toHaveLength(1));
  const id = pins.unpin(mine.id);
  expect(session.outbox?.snapshot().map((item) => item.event.id)).toContain(id);
  await vi.waitFor(() => expect(published).toHaveLength(1));
  expect(published[0]).toMatchObject({ id, kind: 5 });
  expect(contentTags(published[0])).toEqual([
    ["h", channelId],
    ["e", mine.id],
    ["k", "40004"],
  ]);
});

it("unpin refuses an event that is not a pin and a pin the viewer did not sign", async () => {
  const { pins, row, receive } = await setup();
  const theirs = pinOf(other, root);
  receive(theirs);
  await vi.waitFor(() => expect(row().pinnedBy).toHaveLength(1));
  expect(() => pins.unpin(root.id)).toThrow();
  expect(() => pins.unpin(theirs.id)).toThrow(/Only your own/);
});

it("keeps one snapshot until the pins change and notifies subscribers on a live pin and its deletion", async () => {
  const { pins, row, receive } = await setup();
  const empty = pins.snapshot(channelId);
  expect(empty).toEqual([]);
  expect(pins.snapshot(channelId)).toBe(empty);
  const listener = vi.fn();
  const stop = pins.subscribe(channelId, listener);

  receive(message(other, channelId, "Unrelated", 2));
  await flush();
  expect(pins.snapshot(channelId)).toBe(empty);
  expect(listener).not.toHaveBeenCalled();

  const mine = pinOf(viewer, root);
  receive(mine);
  await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(1));
  const pinned = pins.snapshot(channelId);
  expect(pinned).toEqual([
    { id: mine.id, messageId: root.id, pinnedBy: viewer.pubkey, pinnedAt: 2 },
  ]);
  expect(pins.snapshot(channelId)).toBe(pinned);
  expect(row().pinnedBy).toHaveLength(1);

  receive(deletionOf(viewer, mine));
  await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(2));
  expect(pins.snapshot(channelId)).toEqual([]);

  stop();
  receive(pinOf(other, root, 9));
  await flush();
  expect(listener).toHaveBeenCalledTimes(2);
});

it("reads a channel's pins through the session, newest first", async () => {
  const later = message(other, channelId, "Second decision", 4);
  const first = pinOf(viewer, root, 5),
    second = pinOf(other, later, 6);
  const { pins } = await setup({ extra: [later, first, second] });
  expect((await pins.read(channelId)).map((pin) => pin.id)).toEqual([
    second.id,
    first.id,
  ]);
});

it("unpins a pin that only a relay read returned, and refuses another member's", async () => {
  const mine = pinOf(viewer, root, 5),
    theirs = pinOf(other, root, 6);
  const events = [root, mine, theirs];
  const sent: unknown[] = [];
  const pins = createPins({
    viewer: viewer.pubkey,
    outbox: {
      supports: () => true,
      send: (input: unknown) => {
        sent.push(input);
        return "deletion";
      },
    } as unknown as Outbox,
    channels: {} as Parameters<typeof createPins>[0]["channels"],
    canWrite: () => true,
    find: () => undefined,
    observed: () => [],
    read: async (filters) =>
      filters.flatMap((filter) =>
        events.filter((event) => matchesEvent(event, filter)),
      ),
    remove: () => {
      throw new Error("The session does not hold the pin");
    },
  });
  expect(() => pins.unpin(mine.id)).toThrow("Load the pin before unpinning it");
  await pins.read(channelId);
  expect(pins.unpin(mine.id)).toBe("deletion");
  expect(sent).toEqual([
    {
      kind: 5,
      content: "",
      tags: [
        ["h", channelId],
        ["e", mine.id],
        ["k", "40004"],
      ],
    },
  ]);
  expect(() => pins.unpin(theirs.id)).toThrow(/Only your own/);
});
