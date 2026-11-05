import { afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "./session";
import {
  keypair,
  message,
  metadata,
  roster,
  signed,
  type Key,
} from "./testing";
import type { RelayEvent, ReadFilter } from "./events";
import { LIVE_RESUME_LAG, type LiveCallbacks } from "./live";
import { matchesEvent } from "./projection";

const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
});

/** A relay holding `stored`, answering each read by filter. */
function setup() {
  const viewer = keypair(),
    relay = keypair(),
    alice = keypair(),
    bob = keypair();
  const stored: RelayEvent[] = [];
  let failing: Error | undefined;
  // Reads matching a held predicate wait for its release.
  const holds: {
    match: (filter: ReadFilter) => boolean;
    gate: Promise<void>;
    started: boolean;
  }[] = [];
  let live!: LiveCallbacks;
  const query = vi.fn(async (filters: readonly ReadFilter[]) => {
    for (const hold of holds)
      if (filters.some(hold.match)) {
        hold.started = true;
        await hold.gate;
      }
    if (failing) throw failing;
    return stored.filter((event) =>
      filters.some((filter) => matchesEvent(event, filter)),
    );
  });
  const owner = createRelaySession({
    viewer: viewer.pubkey,
    relayAuthor: relay.pubkey,
    query,
    media: () => undefined,
    subscribe(callbacks) {
      live = callbacks;
      return { update() {}, retry() {}, dispose() {} };
    },
  });
  owners.push(owner);
  const admit = (channelId: string, members: string[], at = 10) =>
    live.receive([
      roster(relay, channelId, members, at),
      metadata(relay, channelId, channelId, at),
    ]);
  admit("room", [viewer.pubkey, alice.pubkey, bob.pubkey]);
  return {
    ...owner,
    viewer,
    alice,
    bob,
    stored,
    query,
    admit,
    fail(error?: Error) {
      failing = error;
    },
    hold(match: (filter: ReadFilter) => boolean) {
      let release = () => {};
      const hold = {
        match,
        gate: new Promise<void>((resolve) => {
          release = resolve;
        }),
        started: false,
      };
      holds.push(hold);
      return { started: () => hold.started, release };
    },
    deliver: (events: RelayEvent[]) =>
      live.receive(events, { phase: "live", channelId: "room" }),
    feed: () => owner.session.reactionFeed.snapshot(),
  };
}
const react = (
  reactor: Key,
  target: RelayEvent,
  content = "👍",
  at = 30,
  tags: string[][] = [["p", target.pubkey]],
) =>
  signed(reactor, {
    kind: 7,
    content,
    created_at: at,
    tags: [["h", "room"], ["e", target.id], ...tags],
  });
const remove = (author: Key, id: string, at = 40) =>
  signed(author, {
    kind: 5,
    content: "",
    created_at: at,
    tags: [
      ["h", "room"],
      ["e", id],
    ],
  });

it("admits reactions to the viewer's messages with channel and author from the target", async () => {
  const h = setup();
  const mine = message(h.viewer, "room", "Ship it?", 20);
  const reply = message(h.viewer, "room", "In thread", 21, [
    ["e", mine.id, "", "reply"],
  ]);
  const reaction = react(h.alice, mine, "👍", 30);
  const threaded = react(h.bob, reply, ":party:", 31, [
    ["p", h.viewer.pubkey],
    ["emoji", "party", "https://a.test/party.png"],
  ]);
  h.stored.push(mine, reply, reaction, threaded);
  await h.session.reactionFeed.ensure();
  expect(h.feed()).toMatchObject({ status: "ready", freshness: "observed" });
  expect(h.feed().notices).toEqual([
    {
      id: threaded.id,
      reactorId: h.bob.pubkey,
      channelId: "room",
      messageId: reply.id,
      rootId: mine.id,
      targetKind: 9,
      targetContent: "In thread",
      content: ":party:",
      emoji: { shortcode: "party", url: "https://a.test/party.png" },
      createdAt: 31,
    },
    {
      id: reaction.id,
      reactorId: h.alice.pubkey,
      channelId: "room",
      messageId: mine.id,
      rootId: undefined,
      targetKind: 9,
      targetContent: "Ship it?",
      content: "👍",
      createdAt: 30,
    },
  ]);
  expect(h.query.mock.calls[0]?.[0]).toEqual([
    { kinds: [7], "#p": [h.viewer.pubkey], limit: 100 },
  ]);
});

it("rejects reactions without the viewer's p tag, to others' messages, in other channels, or by the viewer", async () => {
  const h = setup();
  h.admit("elsewhere", [h.alice.pubkey]);
  const mine = message(h.viewer, "room", "Mine", 20);
  const theirs = message(h.alice, "room", "Theirs", 21);
  const outside = message(h.viewer, "elsewhere", "Not a member", 22);
  h.stored.push(
    mine,
    theirs,
    outside,
    react(h.alice, mine, "👍", 30, []),
    // A forged p tag cannot claim someone else's message for the viewer.
    react(h.bob, theirs, "👍", 31, [["p", h.viewer.pubkey]]),
    react(h.alice, outside, "👍", 32),
    react(h.viewer, mine, "👍", 33),
  );
  await h.session.reactionFeed.ensure();
  expect(h.feed()).toMatchObject({ status: "ready", notices: [] });
});

it("drops deleted reactions and reactions to deleted messages", async () => {
  const h = setup();
  const kept = message(h.viewer, "room", "Kept", 20);
  const gone = message(h.viewer, "room", "Gone", 21);
  const retracted = react(h.alice, kept, "👍", 30);
  const stays = react(h.bob, kept, "🎉", 31);
  h.stored.push(
    kept,
    gone,
    retracted,
    stays,
    react(h.alice, gone, "👀", 32),
    remove(h.alice, retracted.id),
    // Only the reactor can retract a reaction.
    remove(h.alice, stays.id),
    remove(h.viewer, gone.id),
  );
  await h.session.reactionFeed.ensure();
  expect(h.feed().notices.map((notice) => notice.id)).toEqual([stays.id]);
});

it("adds live reactions and removes live retractions", async () => {
  const h = setup();
  const mine = message(h.viewer, "room", "Mine", 20);
  h.stored.push(mine);
  await h.session.reactionFeed.ensure();
  expect(h.feed().notices).toEqual([]);
  const reaction = react(h.alice, mine, "👍", 30);
  h.deliver([reaction]);
  await vi.waitFor(() =>
    expect(h.feed().notices.map((notice) => notice.id)).toEqual([reaction.id]),
  );
  // A repeated delivery is the same notice.
  h.deliver([reaction]);
  h.deliver([remove(h.alice, reaction.id)]);
  expect(h.feed().notices).toEqual([]);
  h.deliver([reaction]);
  await Promise.resolve();
  expect(h.feed().notices).toEqual([]);
});

it("keeps the newest bounded notices and marks the feed stale on overflow", async () => {
  const h = setup();
  const mine = message(h.viewer, "room", "x".repeat(30 * 1024), 20);
  h.stored.push(mine);
  await h.session.reactionFeed.ensure();
  const many = Array.from({ length: 80 }, (_, index) =>
    react(h.alice, mine, `${index}`, 100 + index),
  );
  h.deliver(many);
  await vi.waitFor(() => expect(h.feed().freshness).toBe("stale"));
  const notices = h.feed().notices;
  expect(notices.length).toBeLessThan(80);
  expect(notices[0]?.createdAt).toBe(179);
});

it("keeps retained notices when a refresh fails", async () => {
  const h = setup();
  const mine = message(h.viewer, "room", "Mine", 20);
  const reaction = react(h.alice, mine, "👍", 30);
  h.stored.push(mine, reaction);
  await h.session.reactionFeed.ensure();
  h.fail(new Error("Relay unavailable"));
  await h.session.reactionFeed.refresh();
  expect(h.feed()).toMatchObject({
    status: "error",
    error: "Relay unavailable",
    notices: [{ id: reaction.id }],
  });
});

it("retires notices when the viewer leaves the target's channel", async () => {
  const h = setup();
  const mine = message(h.viewer, "room", "Mine", 20);
  h.stored.push(mine, react(h.alice, mine, "👍", 30));
  await h.session.reactionFeed.ensure();
  expect(h.feed().notices).toHaveLength(1);
  h.admit("room", [h.alice.pubkey], 50);
  await h.session.reactionFeed.refresh();
  expect(h.feed().notices).toEqual([]);
});

it("drops a reaction retracted while its target lookup is in flight", async () => {
  const h = setup();
  const mine = message(h.viewer, "room", "Mine", 20);
  h.stored.push(mine);
  await h.session.reactionFeed.ensure();
  const lookup = h.hold((filter) => !!filter.ids);
  const reaction = react(h.alice, mine, "👍", 30);
  // Admitted from the same lookup: proof the lookup finished.
  const kept = react(h.bob, mine, "🎉", 31);
  h.deliver([reaction, kept]);
  await vi.waitFor(() => expect(lookup.started()).toBe(true));
  h.deliver([remove(h.alice, reaction.id)]);
  lookup.release();
  await vi.waitFor(() =>
    expect(h.feed().notices.map((notice) => notice.id)).toEqual([kept.id]),
  );
});

it("reads nothing for live reactions until Inbox asks", async () => {
  const h = setup();
  const mine = message(h.viewer, "room", "Mine", 20);
  h.stored.push(mine);
  h.deliver([react(h.alice, mine, "👍", 30)]);
  await Promise.resolve();
  expect(h.query).not.toHaveBeenCalled();
  expect(h.feed().notices).toEqual([]);
});

it("uses the last e tag as the target and rejects oversized content", async () => {
  const h = setup();
  const mine = message(h.viewer, "room", "Mine", 20);
  const other = message(h.alice, "room", "Theirs", 19);
  const reaction = signed(h.alice, {
    kind: 7,
    content: "👍",
    created_at: 30,
    tags: [
      ["e", other.id],
      ["e", mine.id],
      ["p", h.viewer.pubkey],
    ],
  });
  h.stored.push(mine, other, reaction, react(h.bob, mine, "x".repeat(65), 31));
  await h.session.reactionFeed.ensure();
  expect(h.feed().notices.map((notice) => notice.id)).toEqual([reaction.id]);
});

it.each(["clear", "purge", "dispose"] as const)(
  "%s retires an in-flight refresh without publishing its notices",
  async (action) => {
    const h = setup();
    const mine = message(h.viewer, "room", "Mine", 20);
    h.stored.push(mine, react(h.alice, mine, "👍", 30));
    const lookup = h.hold((filter) => !!filter.ids);
    const work = h.session.reactionFeed.ensure();
    await vi.waitFor(() => expect(lookup.started()).toBe(true));
    h.session.reactionFeed[action]();
    lookup.release();
    await work;
    expect(h.feed()).toMatchObject({ status: "idle", notices: [] });
  },
);

it("stale keeps verified notices, drops an in-flight live lookup, and reconnect refreshes", async () => {
  const h = setup();
  const mine = message(h.viewer, "room", "Mine", 20);
  const first = react(h.alice, mine, "👍", 30);
  h.stored.push(mine, first);
  await h.session.reactionFeed.ensure();
  // A message no notice names yet, so its reaction needs a lookup.
  const later = message(h.viewer, "room", "Later", 25);
  h.stored.push(later);
  const lookup = h.hold((filter) => !!filter.ids);
  const second = react(h.bob, later, "🎉", Math.floor(Date.now() / 1000));
  h.deliver([second]);
  await vi.waitFor(() => expect(lookup.started()).toBe(true));
  h.session.reactionFeed.stale();
  lookup.release();
  await Promise.resolve();
  expect(h.feed()).toMatchObject({
    status: "idle",
    freshness: "stale",
    notices: [{ id: first.id }],
  });
  // Stored after the first catch-up, so the resumed read's window holds it.
  h.stored.push(second);
  h.session.reactionFeed.reconnect();
  await vi.waitFor(() =>
    expect(h.feed()).toMatchObject({
      status: "ready",
      freshness: "observed",
    }),
  );
  expect(h.feed().notices.map((notice) => notice.id)).toEqual([
    second.id,
    first.id,
  ]);
});

it("reconnect resumes from the last catch-up instead of rereading retained deletions", async () => {
  const h = setup();
  const now = Math.floor(Date.now() / 1000);
  const mine = message(h.viewer, "room", "Mine", 20);
  const other = message(h.viewer, "room", "Other", 21);
  const kept = react(h.alice, mine, "👍", 30);
  const retracted = react(h.bob, other, "🎉", 31);
  h.stored.push(mine, other, kept, retracted);
  await h.session.reactionFeed.ensure();
  expect(h.feed().notices).toHaveLength(2);

  h.query.mockClear();
  h.session.reactionFeed.stale();
  h.session.reactionFeed.reconnect();
  await vi.waitFor(() => expect(h.feed().status).toBe("ready"));
  // Unchanged: one reaction read and one deletion read, both from the cursor;
  // deletions stay scoped to the retained reactions and messages.
  expect(h.query).toHaveBeenCalledTimes(2);
  const filters = h.query.mock.calls.flatMap(([filters]) => filters);
  expect(filters.every((filter) => filter.since !== undefined)).toBe(true);
  expect(filters[1]?.["#e"]).toEqual(
    expect.arrayContaining([kept.id, retracted.id, mine.id, other.id]),
  );
  expect(filters[0]?.since).toBeLessThanOrEqual(now - LIVE_RESUME_LAG);

  // Changes while disconnected: a new reaction and a retraction.
  const arrived = react(h.bob, mine, "🎉", now);
  h.stored.push(arrived, remove(h.bob, retracted.id, now));
  h.session.reactionFeed.stale();
  h.session.reactionFeed.reconnect();
  await vi.waitFor(() =>
    expect(h.feed().notices.map((notice) => notice.id)).toEqual([
      arrived.id,
      kept.id,
    ]),
  );
});

it("reconnect falls back to a full read when the resumed window exceeds a page", async () => {
  const h = setup();
  const now = Math.floor(Date.now() / 1000);
  const mine = message(h.viewer, "room", "Mine", 20);
  h.stored.push(mine);
  await h.session.reactionFeed.ensure();
  h.stored.push(
    ...Array.from({ length: 101 }, (_, index) =>
      react(h.alice, mine, `${index}`, now - index),
    ),
  );
  h.query.mockClear();
  h.session.reactionFeed.reconnect();
  await vi.waitFor(() => expect(h.feed().status).toBe("ready"));
  const filters = h.query.mock.calls.flatMap(([filters]) => filters);
  expect(
    filters.some(
      (filter) => filter.kinds?.includes(7) && filter.since === undefined,
    ),
  ).toBe(true);
  expect(h.feed().notices.length).toBeGreaterThan(0);
});

it("an explicit refresh rereads in full after a catch-up", async () => {
  const h = setup();
  const mine = message(h.viewer, "room", "Mine", 20);
  h.stored.push(mine, react(h.alice, mine, "👍", 30));
  await h.session.reactionFeed.ensure();
  h.query.mockClear();
  await h.session.reactionFeed.refresh();
  const filters = h.query.mock.calls.flatMap(([filters]) => filters);
  expect(filters.some((filter) => filter.since !== undefined)).toBe(false);
  expect(filters.some((filter) => filter["#e"])).toBe(true);
});

it("the session clears retained notices with its cache", async () => {
  const h = setup();
  const mine = message(h.viewer, "room", "Mine", 20);
  h.stored.push(mine, react(h.alice, mine, "👍", 30));
  await h.session.reactionFeed.ensure();
  expect(h.feed().notices).toHaveLength(1);
  await h.clearCache();
  expect(h.feed()).toMatchObject({ status: "idle", notices: [] });
});
