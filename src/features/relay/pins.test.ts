import { afterEach, expect, it } from "vitest";
import { foldMessages } from "./fold";
import { CHANNEL_KINDS, type LiveCallbacks } from "./live";
import {
  PIN_KIND,
  pinTemplate,
  readChannelPins,
  validatePinTemplate,
} from "./pins";
import { rowProfileIds } from "./membership";
import { createMessages } from "./messages";
import { PublishRejected, type Outbox } from "./outbox";
import { createRelaySession } from "./session";
import {
  flush,
  keypair,
  message,
  roster,
  scriptedTransport,
  signed,
} from "./testing";
import type { ReadFilter, RelayEvent } from "./events";

const viewer = keypair(),
  other = keypair(),
  relay = keypair();
const root = message(other, "c", "Decision: ship Friday", 1);
const pin = (author = viewer, time = 2, tags = [["h", "c"]]) =>
  signed(author, {
    kind: PIN_KIND,
    content: "",
    created_at: time,
    tags: [...tags, ["e", root.id]],
  });
const unpin = (target: RelayEvent, author = viewer, kind = 5) =>
  signed(author, {
    kind,
    content: "",
    created_at: 3,
    tags: [
      ["h", "c"],
      ["e", target.id],
      ["k", String(PIN_KIND)],
    ],
  });
const fold = (events: RelayEvent[]) =>
  foldMessages("c", relay.pubkey, [root, ...events])[0]?.pinnedBy;
const owners: { dispose(): void }[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
});

it("builds and validates the single pin shape", () => {
  expect(pinTemplate("c", root.id)).toEqual({
    kind: 40004,
    content: "",
    tags: [
      ["h", "c"],
      ["e", root.id],
    ],
  });
  const valid = pinTemplate("c", root.id);
  for (const malformed of [
    { ...valid, content: "note" },
    { ...valid, tags: [...valid.tags, ["p", other.pubkey]] },
    { ...valid, tags: [...valid.tags, ["e", root.id]] },
    { ...valid, tags: [["h", "c"]] },
    {
      ...valid,
      tags: [
        ["h", "c"],
        ["e", root.id, "", "reply"],
      ],
    },
    { ...valid, kind: 7 },
  ])
    expect(() => validatePinTemplate(malformed)).toThrow("Malformed pin");
  expect(() => pinTemplate("c", "not-an-id")).toThrow("Malformed pin");
  expect(() => pinTemplate("", root.id)).toThrow("Malformed pin");
});

it("folds pins earliest first and drops deleted, foreign-channel and malformed pins", () => {
  const mine = pin(viewer, 5),
    theirs = pin(other, 4);
  expect(fold([mine, theirs])).toEqual([
    { id: theirs.id, messageId: root.id, pinnedBy: other.pubkey, pinnedAt: 4 },
    { id: mine.id, messageId: root.id, pinnedBy: viewer.pubkey, pinnedAt: 5 },
  ]);
  expect(fold([mine, unpin(mine)])).toBeUndefined();
  expect(fold([mine, unpin(mine, viewer, 9005)])).toBeUndefined();
  // A deletion by someone else is not the pin author's removal.
  expect(fold([mine, unpin(mine, other)])).toHaveLength(1);
  expect(fold([pin(viewer, 2, [["h", "elsewhere"]])])).toBeUndefined();
  expect(
    fold([
      signed(viewer, {
        kind: PIN_KIND,
        content: "note",
        tags: [
          ["h", "c"],
          ["e", root.id],
        ],
      }),
    ]),
  ).toBeUndefined();
  expect(fold([])).toBeUndefined();
});

it("live channel subscriptions carry pins", () => {
  expect(CHANNEL_KINDS).toContain(PIN_KIND);
});

it("a live pin marks its message and a live removal clears it", () => {
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let live!: LiveCallbacks;
  const owner = createRelaySession(
    {
      ...wire.transport,
      subscribe(callbacks) {
        live = callbacks;
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    { outboxStorage: { load: () => [], save() {} } },
  );
  owners.push(owner);
  owner.session.channels.ensure("c");
  const mine = pin();
  live.receive([roster(relay, "c", [viewer.pubkey], 1), root, mine]);
  expect(owner.session.channels.window("c").rows[0]?.pinnedBy).toEqual([
    { id: mine.id, messageId: root.id, pinnedBy: viewer.pubkey, pinnedAt: 2 },
  ]);
  live.receive([unpin(mine)]);
  expect(owner.session.channels.window("c").rows[0]?.pinnedBy).toBeUndefined();
});

it("removes only the viewer's own pin, with its kind", () => {
  const mine = pin(),
    theirs = pin(other);
  const sent: unknown[] = [];
  const messages = createMessages(
    {
      supports: () => true,
      send: (input: unknown) => {
        sent.push(input);
        return { id: "deletion", persisted: Promise.resolve() };
      },
    } as unknown as Outbox,
    viewer.pubkey,
    (id) => [root, mine, theirs].find((event) => event.id === id),
    () => [],
    () => {},
  );
  expect(() => messages.remove([theirs.id])).toThrow(/Only your own/);
  messages.remove([mine.id]);
  expect(sent).toEqual([
    {
      kind: 5,
      content: "",
      tags: [
        ["h", "c"],
        ["e", mine.id],
        ["k", "40004"],
      ],
    },
  ]);
});

it("a pin shows before the relay confirms it and reverts when refused", async () => {
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let live!: LiveCallbacks;
  let refuse!: (error: Error) => void;
  const owner = createRelaySession(
    {
      ...wire.transport,
      writer: {
        sign: async (template) => signed(viewer, template),
        publish: () =>
          new Promise<never>((_, reject) => {
            refuse = reject;
          }),
      },
      subscribe(callbacks) {
        live = callbacks;
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    { outboxStorage: { load: () => [], save() {} } },
  );
  owners.push(owner);
  owner.session.channels.ensure("c");
  live.receive([roster(relay, "c", [viewer.pubkey], 1), root]);
  const id = owner.session.pins?.pin("c", root.id);
  expect(owner.session.channels.window("c").rows[0]?.pinnedBy).toMatchObject([
    { id, messageId: root.id, pinnedBy: viewer.pubkey },
  ]);
  await flush();
  await flush();
  refuse(new PublishRejected("blocked: guests cannot pin"));
  await flush();
  await flush();
  expect(owner.session.outbox?.snapshot()[0]?.delivery).toBe("failed");
  expect(owner.session.channels.window("c").rows[0]?.pinnedBy).toBeUndefined();
});

it("demands the pinner's profile with the pinned row", () => {
  const row = foldMessages("c", relay.pubkey, [root, pin(viewer)])[0];
  expect(row && rowProfileIds(row)).toContain(viewer.pubkey);
});

it("reads a channel's live pins newest first and drops pins it cannot verify", async () => {
  const later = message(other, "c", "Second decision", 4);
  const elsewhere = message(other, "elsewhere", "Other channel", 4);
  const gone = message(other, "c", "Deleted", 4);
  const pinOf = (target: RelayEvent, time: number, author = viewer) =>
    signed(author, {
      kind: PIN_KIND,
      content: "",
      created_at: time,
      tags: [
        ["h", "c"],
        ["e", target.id],
      ],
    });
  const first = pinOf(root, 5),
    second = pinOf(later, 6),
    removed = pinOf(later, 7, other),
    foreign = pinOf(elsewhere, 8),
    orphan = pinOf(gone, 9);
  const events = [
    root,
    later,
    elsewhere,
    first,
    second,
    removed,
    foreign,
    orphan,
    unpin(removed, other),
    signed(other, {
      kind: 5,
      content: "",
      tags: [
        ["h", "c"],
        ["e", gone.id],
        ["k", "9"],
      ],
    }),
  ];
  const filters: unknown[] = [];
  const read = async (requested: readonly ReadFilter[]) => {
    filters.push(...requested);
    const [filter] = requested;
    return events.filter(
      (event) =>
        (!filter?.ids || filter.ids.includes(event.id)) &&
        (!filter?.kinds || filter.kinds.includes(event.kind)) &&
        (!filter?.["#h"] ||
          event.tags.some(
            ([name, id]) => name === "h" && filter["#h"]?.includes(id ?? ""),
          )) &&
        (!filter?.["#e"] ||
          event.tags.some(
            ([name, id]) => name === "e" && filter["#e"]?.includes(id ?? ""),
          )),
    );
  };
  const pins = await readChannelPins(
    { read },
    "c",
    new AbortController().signal,
  );
  expect(pins.map((pin) => pin.id)).toEqual([second.id, first.id]);
  expect(filters[0]).toEqual({ kinds: [40004], "#h": ["c"], limit: 200 });
  expect(
    await readChannelPins(
      { read: async () => [] },
      "c",
      new AbortController().signal,
    ),
  ).toEqual([]);
});
