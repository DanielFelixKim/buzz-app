import { getPublicKey } from "nostr-tools";
import { afterEach, assert, expect, it, vi } from "vitest";
import { createRelaySession } from "./session";
import type { LiveCallbacks } from "./live";
import type { ReadFilter, RelayEvent } from "./events";
import { byteSize } from "./budget";
import { ReadError } from "./errors";
import {
  bounds,
  keypair,
  message,
  metadata,
  roster,
  scriptedTransport,
  signed,
} from "./testing";

const HOUR = 3600;
const DAY = 24 * HOUR;
const T0 = 1_700_000_000;
const newestFirst = (a: RelayEvent, b: RelayEvent) =>
  b.created_at - a.created_at || a.id.localeCompare(b.id);

/** A session over an auto-answering relay holding `count` hourly messages in channel "c". */
function harness({
  count = 300,
  maxHistoryRows,
  maxHistoryBytes,
  spacing = HOUR,
  prepared,
}: {
  count?: number;
  maxHistoryRows?: number;
  maxHistoryBytes?: number;
  spacing?: number;
  prepared?: boolean;
} = {}) {
  const relay = keypair(),
    viewer = keypair(),
    alice = keypair();
  const history = Array.from({ length: count }, (_, i) =>
    message(alice, "c", `m${i}`, T0 + i * spacing),
  );
  const reads: ReadFilter[] = [];
  const gate: {
    hold?: Promise<void> | undefined;
    failHead?: boolean;
    denied?: boolean;
    aux?: RelayEvent[];
    notices?: RelayEvent[];
  } = {};
  let live!: LiveCallbacks;
  const base = scriptedTransport(viewer.pubkey, relay.pubkey);
  const owner = createRelaySession(
    {
      ...base.transport,
      async query(filters, signal) {
        const filter = filters[0];
        if (filter?.kinds?.includes(40099))
          return (gate.notices ?? [])
            .filter(
              (event) =>
                filter.until === undefined ||
                event.created_at < filter.until ||
                (event.created_at === filter.until &&
                  event.id > (filter.before_id ?? "")),
            )
            .slice(0, filter.limit);
        if (!filter?.top_level) return [];
        reads.push(filter);
        await gate.hold;
        signal?.throwIfAborted();
        if (gate.denied) throw new ReadError("denied", "Access denied");
        if (gate.failHead && filter.until === undefined)
          throw new Error("offline");
        const cursor =
          filter.until !== undefined && filter.before_id
            ? { createdAt: filter.until, eventId: filter.before_id }
            : null;
        const ordered = [...history].sort(newestFirst);
        const after = cursor
          ? ordered.filter(
              (row) =>
                row.created_at < cursor.createdAt ||
                (row.created_at === cursor.createdAt &&
                  row.id > cursor.eventId),
            )
          : ordered;
        const rows = after.slice(0, filter.limit);
        const hasMore = after.length > filter.limit;
        const last = rows.at(-1);
        return [
          ...rows,
          ...(filter.include_aux ? (gate.aux ?? []) : []),
          bounds(
            relay,
            "c",
            cursor ? `${cursor.createdAt}:${cursor.eventId}` : "head",
            {
              has_more: hasMore,
              next_cursor:
                hasMore && last
                  ? { created_at: last.created_at, id: last.id }
                  : null,
            },
          ),
        ];
      },
      subscribe(callbacks) {
        live = callbacks;
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    {
      now: () => (T0 + count * HOUR) * 1000,
      ...(maxHistoryRows ? { maxHistoryRows } : {}),
      ...(maxHistoryBytes ? { maxHistoryBytes } : {}),
      ...(prepared ? { prepared } : {}),
    },
  );
  const channels = owner.session.channels;
  assert.exists(channels.seek);
  assert.exists(channels.loadNewer);
  assert.exists(channels.attach);
  const window = () => channels.window("c");
  const times = () => window().rows.map((row) => row.createdAt);
  const open = async () => {
    live.receive([
      roster(relay, "c", [viewer.pubkey]),
      metadata(relay, "c", "C"),
    ]);
    channels.ensure("c");
    await vi.waitFor(() => expect(window().status).toBe("ready"));
  };
  const seek = (from: number, signal = new AbortController().signal) =>
    (channels.seek as NonNullable<typeof channels.seek>)("c", from, signal);
  return {
    relay,
    alice,
    owner,
    channels,
    history,
    reads,
    gate,
    get live() {
      return live;
    },
    window,
    times,
    open,
    seek,
  };
}

let current: ReturnType<typeof harness> | undefined;
const setup = (options?: Parameters<typeof harness>[0]) => {
  current = harness(options);
  return current;
};
afterEach(() => {
  current?.owner.dispose();
  current = undefined;
});

it("seek installs a segment and resolves the first row at or after from", async () => {
  const h = setup();
  await h.open();
  const from = T0 + 5 * DAY + 1;
  const id = await h.seek(from);
  expect(id).toBe(h.history[5 * 24 + 1]?.id);
  expect(h.window().hasNewer).toBe(true);
  expect(h.times()[0]).toBeLessThan(from);
  expect(h.times()).not.toContain(T0 + 299 * HOUR);
});

it("seek resolves the newest row when nothing is at or after from", async () => {
  const h = setup();
  await h.open();
  const id = await h.seek(T0 + 299 * HOUR + 1);
  expect(id).toBe(h.history[299]?.id);
  expect(h.window().hasNewer).toBeFalsy();
});

it("seek uses held rows without reading", async () => {
  const h = setup();
  await h.open();
  const reads = h.reads.length;
  const id = await h.seek(T0 + 295 * HOUR);
  expect(id).toBe(h.history[295]?.id);
  expect(h.reads).toHaveLength(reads);
});

it("an aborted seek leaves the window unchanged", async () => {
  const h = setup();
  await h.open();
  const before = h.window();
  let release!: () => void;
  h.gate.hold = new Promise((resolve) => {
    release = resolve;
  });
  const controller = new AbortController();
  const pending = h.seek(T0 + DAY, controller.signal);
  controller.abort();
  release();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(h.window()).toBe(before);
});

it("loadOlder pages a detached window from its older cursor", async () => {
  const h = setup();
  await h.open();
  await h.seek(T0 + 9 * DAY);
  const oldest = h.times()[0];
  assert.exists(oldest);
  h.channels.loadOlder("c");
  await vi.waitFor(() => expect(h.times()[0]).toBeLessThan(oldest));
  expect(h.reads.at(-1)).toMatchObject({ until: oldest });
  expect(h.window().hasNewer).toBe(true);
});

it("loadNewer extends the segment and reattaches at the head", async () => {
  const h = setup();
  await h.open();
  await h.seek(T0 + 2 * DAY);
  const newest = () => h.times().at(-1) ?? 0;
  for (let step = 0; h.window().hasNewer && step < 20; step++) {
    const before = newest();
    h.channels.loadNewer?.("c");
    await vi.waitFor(() => expect(h.window().loadingNewer).toBeFalsy());
    expect(newest()).toBeGreaterThan(before);
  }
  expect(h.window().hasNewer).toBeFalsy();
  expect(newest()).toBe(T0 + 299 * HOUR);
  // Contiguous: one row per hour from the segment's oldest to the head.
  const times = h.times();
  expect(
    times.every((at, i) => i === 0 || at - (times[i - 1] ?? 0) === HOUR),
  ).toBe(true);
});

it.each([
  { maxHistoryRows: 40 },
  { maxHistoryBytes: 12_000 },
  { maxHistoryRows: 40, spacing: 0 },
])(
  "slides through older history and back to the head within %j",
  async (limit) => {
    const h = setup({ count: 100, ...limit });
    await h.open();
    const ordered = [...h.history].sort(newestFirst).reverse();
    const seen = new Set(h.window().rows.map((row) => row.id));
    const bounded = () => {
      const ids = new Set(h.window().rows.map((row) => row.id));
      expect(ids.size).toBeLessThanOrEqual(limit.maxHistoryRows ?? 2400);
      expect(
        byteSize(h.history.filter((event) => ids.has(event.id))),
      ).toBeLessThanOrEqual(limit.maxHistoryBytes ?? 8 * 1024 * 1024);
    };
    for (let step = 0; h.window().hasMore && step < 10; step++) {
      const before = h.window().rows.map((row) => row.id);
      h.channels.loadOlder("c");
      await vi.waitFor(() => expect(h.window().loadingOlder).toBe(false));
      expect(h.window().historyLimited).toBeFalsy();
      expect(h.window().rows.map((row) => row.id)).not.toEqual(before);
      for (const row of h.window().rows) seen.add(row.id);
      bounded();
    }
    expect(h.window().hasMore).toBe(false);
    expect(seen.size).toBe(100);
    expect(h.window().rows.map((row) => row.id)).toContain(ordered[0]?.id);
    expect(h.window().hasNewer).toBe(true);
    const evicted = ordered.at(-1);
    assert.exists(evicted);
    h.live.receive([evicted]);
    expect(h.window().rows.map((row) => row.id)).not.toContain(evicted.id);
    const forward = new Set(h.window().rows.map((row) => row.id));
    for (let step = 0; h.window().hasNewer && step < 10; step++) {
      const before = h.window().rows.map((row) => row.id);
      h.channels.loadNewer?.("c");
      await vi.waitFor(() => expect(h.window().loadingNewer).toBeFalsy());
      expect([
        h.window().rows.map((row) => row.id),
        !!h.window().hasNewer,
      ]).not.toEqual([before, true]);
      for (const row of h.window().rows) forward.add(row.id);
      bounded();
    }
    expect(h.window().hasNewer).toBeFalsy();
    expect(forward.size).toBe(100);
    expect(h.window().rows.map((row) => row.id)).toContain(evicted.id);
    h.channels.loadOlder("c");
    await vi.waitFor(() => expect(h.window().loadingOlder).toBe(false));
    expect(h.window().historyLimited).toBeFalsy();
    bounded();
  },
);

it("keeps both retained messages at a sliding boundary's second", async () => {
  const h = setup({ count: 60, maxHistoryRows: 40, spacing: 0 });
  await h.open();
  for (let page = 0; page < 2; page++) {
    h.channels.loadOlder("c");
    await vi.waitFor(() => expect(h.window().loadingOlder).toBe(false));
  }
  const retained = [...h.history].sort(newestFirst).slice(20);
  const [boundary, neighbor] = retained;
  assert.exists(boundary);
  assert.exists(neighbor);
  expect(boundary.created_at).toBe(neighbor.created_at);
  expect(h.window().rows.map((row) => row.id)).toEqual(
    expect.arrayContaining([boundary.id, neighbor.id]),
  );
  expect(h.window().rows).toHaveLength(40);
  expect(h.window().hasNewer).toBe(true);
});

it("loadNewer trims the oldest rows past maxHistoryRows", async () => {
  const h = setup({ maxHistoryRows: 100 });
  await h.open();
  await h.seek(T0 + DAY);
  for (let step = 0; h.window().rows.length < 100 && step < 10; step++) {
    h.channels.loadNewer?.("c");
    await vi.waitFor(() => expect(h.window().loadingNewer).toBeFalsy());
  }
  h.channels.loadNewer?.("c");
  await vi.waitFor(() => expect(h.window().loadingNewer).toBeFalsy());
  expect(h.window().rows.length).toBeLessThanOrEqual(100);
  expect(h.window().hasMore).toBe(true);
  const oldest = h.window().rows[0];
  assert.exists(oldest);
  h.channels.loadOlder("c");
  await vi.waitFor(() =>
    expect(h.reads.at(-1)).toMatchObject({
      until: oldest.createdAt,
      before_id: oldest.id,
    }),
  );
});

it("accept keeps live rows above a detached ceiling out of the window", async () => {
  const h = setup();
  await h.open();
  await h.seek(T0 + 3 * DAY);
  const held = h.window().rows.at(-1);
  assert.exists(held);
  const fresh = message(h.alice, "c", "fresh", T0 + 300 * HOUR);
  h.live.receive([fresh]);
  expect(h.window().rows.map((row) => row.id)).not.toContain(fresh.id);
  h.live.receive([
    signed(h.alice, {
      kind: 7,
      content: "+",
      created_at: T0 + 300 * HOUR,
      tags: [
        ["h", "c"],
        ["e", held.id],
        ["p", held.authorId],
      ],
    }),
  ]);
  await vi.waitFor(() =>
    expect(h.window().rows.at(-1)?.reactions.length).toBe(1),
  );
});

it("catchUp returns a detached window to its head", async () => {
  const h = setup();
  await h.open();
  await h.seek(T0 + 3 * DAY);
  h.live.state({ status: "connected", routes: [] });
  h.live.established("c");
  await vi.waitFor(() => expect(h.window().hasNewer).toBeFalsy());
  await vi.waitFor(() => expect(h.times().at(-1)).toBe(T0 + 299 * HOUR));
  expect(h.times()[0]).toBeGreaterThan(T0 + 3 * DAY);
});

it("a failed catch-up keeps the detached segment", async () => {
  const h = setup();
  await h.open();
  await h.seek(T0 + 3 * DAY);
  const segment = h.times();
  h.gate.failHead = true;
  const reads = h.reads.length;
  h.live.state({ status: "connected", routes: [] });
  h.live.established("c");
  await vi.waitFor(() =>
    expect(h.reads.slice(reads).some((read) => read.until === undefined)).toBe(
      true,
    ),
  );
  await vi.waitFor(() => expect(h.window().error).toBeDefined());
  expect(h.times()).toEqual(segment);
  expect(h.window().hasNewer).toBe(true);
});

it("catch-up cancels a detached window's newer page", async () => {
  const h = setup();
  await h.open();
  await h.seek(T0 + 3 * DAY);
  let release!: () => void;
  h.gate.hold = new Promise((resolve) => {
    release = resolve;
  });
  h.channels.loadNewer?.("c");
  expect(h.window().loadingNewer).toBe(true);
  h.live.state({ status: "connected", routes: [] });
  h.live.established("c");
  release();
  h.gate.hold = undefined;
  await vi.waitFor(() => expect(h.times().at(-1)).toBe(T0 + 299 * HOUR));
  await vi.waitFor(() => expect(h.window().loadingNewer).toBeFalsy());
  expect(h.window().hasNewer).toBeFalsy();
  expect(h.times().at(-1)).toBe(T0 + 299 * HOUR);
});

it("a detached segment does not become the channel preview", async () => {
  const h = setup();
  await h.open();
  const preview = () =>
    h.channels.list().channels.find((channel) => channel.id === "c")?.preview;
  await vi.waitFor(() => expect(preview()).toBe("m299"));
  await h.seek(T0 + 3 * DAY);
  expect(preview()).toBe("m299");
  h.channels.attach?.("c");
  await vi.waitFor(() => expect(h.window().hasNewer).toBeFalsy());
  expect(preview()).toBe("m299");
});

it("live messages move the channel preview while detached", async () => {
  const h = setup();
  await h.open();
  const preview = () =>
    h.channels.list().channels.find((channel) => channel.id === "c")?.preview;
  await vi.waitFor(() => expect(preview()).toBe("m299"));
  await h.seek(T0 + 3 * DAY);
  h.live.receive([message(h.alice, "c", "fresh", T0 + 300 * HOUR)]);
  await vi.waitFor(() => expect(preview()).toBe("fresh"));
  expect(h.window().hasNewer).toBe(true);
});

it.each([
  ["a page", false],
  ["a prepared head", true],
])(
  "a live row that lands while attach reads %s is kept",
  async (_, prepared) => {
    const h = setup({ prepared });
    await h.open();
    await h.seek(T0 + 3 * DAY);
    let release!: () => void;
    h.gate.hold = new Promise((resolve) => {
      release = resolve;
    });
    const reads = h.reads.length;
    h.channels.attach?.("c");
    // The relay answered before `fresh` was published; it arrives live.
    await vi.waitFor(() => expect(h.reads.length).toBeGreaterThan(reads));
    const fresh = message(h.alice, "c", "fresh", T0 + 299 * HOUR + 1800);
    h.live.receive([fresh]);
    release();
    h.gate.hold = undefined;
    await vi.waitFor(() => expect(h.window().hasNewer).toBeFalsy());
    expect(h.window().rows.map((row) => row.id)).toContain(fresh.id);
  },
);

it("a live row that lands while the last newer page loads is kept", async () => {
  const h = setup();
  await h.open();
  await h.seek(T0 + 3 * DAY);
  const fresh = message(h.alice, "c", "fresh", T0 + 299 * HOUR + 1800);
  for (let page = 0; page < 10 && h.window().hasNewer; page++) {
    let release!: () => void;
    h.gate.hold = new Promise((resolve) => {
      release = resolve;
    });
    h.channels.loadNewer?.("c");
    // The relay answered before `fresh` was published; it arrives live.
    await vi.waitFor(() => expect(h.reads.length).toBeGreaterThan(0));
    h.live.receive([fresh]);
    release();
    h.gate.hold = undefined;
    await vi.waitFor(() => expect(h.window().loadingNewer).toBeFalsy());
  }
  expect(h.window().hasNewer).toBeFalsy();
  expect(h.window().rows.map((row) => row.id)).toContain(fresh.id);
});

it("attach replaces the segment with the head", async () => {
  const h = setup();
  await h.open();
  await h.seek(T0 + 3 * DAY);
  h.channels.attach?.("c");
  await vi.waitFor(() => expect(h.window().hasNewer).toBeFalsy());
  expect(h.times().at(-1)).toBe(T0 + 299 * HOUR);
  expect(h.times()[0]).toBeGreaterThan(T0 + 3 * DAY);
});

it("rows received before a seek stay out of its segment", async () => {
  const h = setup();
  await h.open();
  const fresh = message(h.alice, "c", "fresh", T0 + 300 * HOUR);
  h.live.receive([fresh]);
  await vi.waitFor(() =>
    expect(h.window().rows.map((row) => row.id)).toContain(fresh.id),
  );
  await h.seek(T0 + 3 * DAY);
  expect(h.window().rows.map((row) => row.id)).not.toContain(fresh.id);
});

it("live rows do not crowd a detached segment out of the history budget", async () => {
  const h = setup({ maxHistoryRows: 250 });
  await h.open();
  await h.seek(T0 + 10 * DAY);
  expect(h.window().rows.length).toBe(200);
  const oldest = h.window().rows[0]?.id;
  h.live.receive(
    Array.from({ length: 60 }, (_, i) =>
      message(h.alice, "c", `fresh${i}`, T0 + 300 * HOUR + i),
    ),
  );
  expect(h.window().rows[0]?.id).toBe(oldest);
});

it("keeps the joining row when live eviction overlaps an older page", async () => {
  const h = setup({ count: 100, maxHistoryRows: 40 });
  await h.open();
  h.channels.loadOlder("c");
  await vi.waitFor(() => expect(h.window().loadingOlder).toBe(false));
  const joining = h.window().rows[0];
  assert.exists(joining);
  let release!: () => void;
  h.gate.hold = new Promise((resolve) => {
    release = resolve;
  });
  h.channels.loadOlder("c");
  h.live.receive([message(h.alice, "c", "fresh", T0 + 100 * HOUR)]);
  release();
  h.gate.hold = undefined;
  await vi.waitFor(() => expect(h.window().loadingOlder).toBe(false));
  expect(h.window().rows.map((row) => row.id)).toContain(joining.id);
});

it("preserves a slid reader when its route reconnects", async () => {
  const h = setup({ count: 100, maxHistoryRows: 40 });
  await h.open();
  h.channels.loadOlder("c");
  await vi.waitFor(() => expect(h.window().loadingOlder).toBe(false));
  h.channels.loadOlder("c");
  await vi.waitFor(() => expect(h.window().loadingOlder).toBe(false));
  const retained = h.window().rows.map((row) => row.id);
  const reads = h.reads.length;
  h.live.state({ status: "connected", routes: [] });
  h.live.established("c");
  await vi.waitFor(() => expect(h.reads.length).toBeGreaterThan(reads));
  await vi.waitFor(() => expect(h.window().freshness).toBe("verified"));
  expect(h.window().rows.map((row) => row.id)).toEqual(retained);
});

it("purges retained channel rows when forward paging is denied", async () => {
  const h = setup({ count: 100, maxHistoryRows: 40 });
  await h.open();
  for (let step = 0; step < 3; step++) {
    h.channels.loadOlder("c");
    await vi.waitFor(() => expect(h.window().loadingOlder).toBe(false));
  }
  expect(h.window().rows.length).toBeGreaterThan(0);
  expect(h.window().hasNewer).toBe(true);
  h.gate.denied = true;
  h.channels.loadNewer?.("c");
  await vi.waitFor(() => expect(h.window().error).toBeDefined());
  expect(h.window().rows).toEqual([]);
  expect(h.window().status).toBe("error");
  expect(h.window().loadingNewer).toBeFalsy();
});

it("releases cancelled forward paging after reconnect without losing the reader", async () => {
  const h = setup({ count: 100, maxHistoryRows: 40 });
  await h.open();
  h.live.state({ status: "connected", routes: [] });
  h.live.established("c");
  await vi.waitFor(() => expect(h.window().freshness).toBe("verified"));
  for (let i = 0; i < 3; i++) {
    h.channels.loadOlder("c");
    await vi.waitFor(() => expect(h.window().loadingOlder).toBe(false));
  }
  const retained = h.window().rows.map((row) => row.id);
  let release!: () => void;
  h.gate.hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reads = h.reads.length;
  h.channels.loadNewer?.("c");
  await vi.waitFor(() => expect(h.reads.length).toBeGreaterThan(reads));
  expect(h.window().loadingNewer).toBe(true);
  try {
    h.live.state({ status: "retrying", routes: [] });
  } finally {
    h.gate.hold = undefined;
    release();
  }
  h.live.state({ status: "connected", routes: [] });
  h.live.established("c");
  await vi.waitFor(() => expect(h.window().loadingNewer).toBeFalsy());
  expect(h.window().rows.map((row) => row.id)).toEqual(retained);
  h.channels.loadNewer?.("c");
  await vi.waitFor(() => expect(h.window().loadingNewer).toBeFalsy());
  expect(h.window().error).toBeUndefined();
  expect(h.window().rows.map((row) => row.id)).not.toEqual(retained);
});
it("releases cancelled older paging after reconnect without losing the reader", async () => {
  const h = setup({ count: 500, maxHistoryRows: 40 });
  await h.open();
  h.live.state({ status: "connected", routes: [] });
  h.live.established("c");
  await vi.waitFor(() => expect(h.window().freshness).toBe("verified"));
  for (let i = 0; i < 12; i++) {
    h.channels.loadOlder("c");
    await vi.waitFor(() => expect(h.window().loadingOlder).toBe(false));
  }
  const retained = h.window().rows.map((row) => row.id);
  let release!: () => void;
  h.gate.hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reads = h.reads.length;
  h.channels.loadOlder("c");
  await vi.waitFor(() => expect(h.reads.length).toBeGreaterThan(reads));
  expect(h.window().loadingOlder).toBe(true);
  try {
    h.live.state({ status: "retrying", routes: [] });
  } finally {
    h.gate.hold = undefined;
    release();
  }
  h.live.state({ status: "connected", routes: [] });
  h.live.established("c");
  await vi.waitFor(() => expect(h.window().loadingOlder).toBeFalsy());
  expect(h.window().rows.map((row) => row.id)).toEqual(retained);
  h.channels.loadOlder("c");
  await vi.waitFor(() => expect(h.window().loadingOlder).toBeFalsy());
  expect(h.window().error).toBeUndefined();
  expect(h.window().rows.map((row) => row.id)).not.toEqual(retained);
});

it("loads newer across a sliding boundary with more than a page in one second", async () => {
  const h = setup({ count: 300, spacing: 0, maxHistoryRows: 40 });
  await h.open();
  for (let step = 0; h.window().hasMore && step < 20; step++) {
    h.channels.loadOlder("c");
    await vi.waitFor(() => expect(h.window().loadingOlder).toBe(false));
  }
  expect(h.window().hasMore).toBe(false);
  const seen = new Set(h.window().rows.map((row) => row.id));
  for (let step = 0; h.window().hasNewer && step < 30; step++) {
    h.channels.loadNewer?.("c");
    await vi.waitFor(() => expect(h.window().loadingNewer).toBeFalsy());
    expect(h.window().error).toBeUndefined();
    expect(h.window().rows.length).toBeLessThanOrEqual(40);
    for (const row of h.window().rows) seen.add(row.id);
  }
  expect(h.window().hasNewer).toBeFalsy();
  expect(seen.size).toBe(300);
});

it.each(["older", "newer"])(
  "keeps deleted reaction overlays while paging %s",
  async (direction) => {
    const h = setup({ count: 100, maxHistoryRows: 40 });
    await h.open();
    const target = h.history[direction === "older" ? 60 : 90];
    assert.exists(target);
    const reaction = signed(h.alice, {
      kind: 7,
      content: "+",
      created_at: T0 + 101 * HOUR,
      tags: [
        ["h", "c"],
        ["e", target.id],
        ["p", target.pubkey],
      ],
    });
    const deletion = signed(h.alice, {
      kind: 5,
      content: "",
      created_at: T0 + 102 * HOUR,
      tags: [
        ["h", "c"],
        ["e", reaction.id],
      ],
    });
    h.gate.aux = [deletion, reaction];
    for (let i = 0; i < 2; i++) {
      h.channels.loadOlder("c");
      await vi.waitFor(() => expect(h.window().loadingOlder).toBe(false));
    }
    if (direction === "newer") {
      h.channels.loadNewer?.("c");
      await vi.waitFor(() => expect(h.window().loadingNewer).toBeFalsy());
    }
    const row = h.window().rows.find((row) => row.id === target.id);
    assert.exists(row);
    expect(row.reactions).toHaveLength(0);
  },
);

it.each([false, true])(
  "preserves a slid segment beyond reconnect catch-up coverage after forward paging: %s",
  async (forward) => {
    const h = setup({ count: 200, spacing: 2 * HOUR, maxHistoryRows: 40 });
    await h.open();
    h.live.state({ status: "connected", routes: [] });
    h.live.established("c");
    await vi.waitFor(() =>
      expect(h.owner.session.live?.snapshot().heads).toContainEqual({
        channelId: "c",
        state: "verified",
      }),
    );
    for (let step = 0; h.window().hasMore && step < 100; step++) {
      h.channels.loadOlder("c");
      await vi.waitFor(() => expect(h.window().loadingOlder).toBe(false), {
        interval: 1,
      });
    }
    expect(h.window().hasMore).toBe(false);
    if (forward) {
      h.channels.loadNewer?.("c");
      await vi.waitFor(() => expect(h.window().loadingNewer).toBeFalsy());
    }
    const retained = h.window().rows.map((row) => row.id);
    h.live.state({ status: "connected", routes: [] });
    h.live.state({ status: "retrying", routes: [] });
    expect(h.window().freshness).toBe("cached");
    h.live.state({ status: "connected", routes: [] });
    h.live.established("c");
    await vi.waitFor(() =>
      expect(h.owner.session.live?.snapshot().heads).toContainEqual({
        channelId: "c",
        state: "deferred",
      }),
    );
    expect(h.window().freshness).toBe("cached");
    expect(h.window().rows.map((row) => row.id)).toEqual(retained);
    h.channels.attach?.("c");
    await vi.waitFor(() => expect(h.window().hasNewer).toBeFalsy());
    expect(h.window().rows.at(-1)?.id).toBe(h.history.at(-1)?.id);
  },
);

it("traverses omitted dense-second pages when a newer page fits the allowance", async () => {
  const h = setup({ count: 1000, spacing: 0, maxHistoryRows: 600 });
  await h.open();
  for (let step = 0; h.window().hasMore && step < 100; step++) {
    h.channels.loadOlder("c");
    await vi.waitFor(() => expect(h.window().loadingOlder).toBe(false), {
      interval: 1,
    });
  }
  expect(h.window().hasMore).toBe(false);
  const seen = new Set(h.window().rows.map((row) => row.id));
  for (let step = 0; h.window().hasNewer && step < 100; step++) {
    h.channels.loadNewer?.("c");
    await vi.waitFor(() => expect(h.window().loadingNewer).toBeFalsy(), {
      interval: 1,
    });
    expect(h.window().error).toBeUndefined();
    for (const row of h.window().rows) seen.add(row.id);
  }
  expect(h.window().hasNewer).toBeFalsy();
  expect(seen.size).toBe(1000);
});

it("continues membership-notice descent after the history window slides", async () => {
  const h = setup({ count: 100, maxHistoryRows: 40 });
  const notice = (time: number, target: string) =>
    signed(h.relay, {
      kind: 40099,
      created_at: time,
      tags: [["h", "c"]],
      content: JSON.stringify({
        type: "member_joined",
        actor: h.alice.pubkey,
        target,
      }),
    });
  const target = notice(T0 + 45 * HOUR, h.alice.pubkey);
  h.gate.notices = [
    ...Array.from({ length: 500 }, (_, i) =>
      notice(T0 + 50 * HOUR, i.toString(16).padStart(64, "0")),
    ),
    target,
  ].sort(newestFirst);
  await h.open();
  for (let step = 0; step < 2; step++) {
    h.channels.loadOlder("c");
    await vi.waitFor(() => expect(h.window().loadingOlder).toBe(false));
  }
  expect(h.window().hasNewer).toBe(true);
  await vi.waitFor(() =>
    expect(h.window().rows.map((row) => row.id)).toContain(target.id),
  );
});

it("does not resurrect a joining message deleted and evicted during an older read", async () => {
  const h = setup({ count: 100, maxHistoryRows: 40 });
  await h.open();
  h.channels.loadOlder("c");
  await vi.waitFor(() => expect(h.window().loadingOlder).toBe(false));
  const joining = h.window().rows[0];
  assert.exists(joining);
  let release!: () => void;
  h.gate.hold = new Promise((resolve) => {
    release = resolve;
  });
  h.channels.loadOlder("c");
  h.live.receive([
    signed(h.alice, {
      kind: 5,
      created_at: T0 + 101 * HOUR,
      tags: [
        ["h", "c"],
        ["e", joining.id],
      ],
      content: "",
    }),
  ]);
  h.live.receive(
    Array.from({ length: 60 }, (_, i) =>
      message(h.alice, "c", `new${i}`, T0 + 102 * HOUR + i),
    ),
  );
  release();
  h.gate.hold = undefined;
  await vi.waitFor(() => expect(h.window().loadingOlder).toBe(false));
  expect(
    h.window().rows.find((row) => row.id === joining.id)?.content,
  ).not.toBe(joining.content);
});

it("retains a rendered anchor that fits with shared-second older rows", async () => {
  const h = setup({ count: 60, maxHistoryRows: 40, spacing: 0 });
  await h.open();
  h.channels.loadOlder("c");
  await vi.waitFor(() => expect(h.window().loadingOlder).toBe(false));
  const anchor = h.window().rows[20]?.id;
  assert.exists(anchor);
  h.channels.loadOlder("c", anchor);
  await vi.waitFor(() => expect(h.window().loadingOlder).toBe(false));
  expect(h.window().rows.map((row) => row.id)).toContain(anchor);
  const nextAnchor = h.window().rows.at(-1)?.id;
  assert.exists(nextAnchor);
  h.channels.loadOlder("c", nextAnchor);
  await vi.waitFor(() => expect(h.window().loadingOlder).toBe(false));
  expect(h.window().rows.map((row) => row.id)).toContain(nextAnchor);
  expect(h.window().hasMore).toBe(false);
});

it("retains a rendered anchor that fits with shared-second newer rows", async () => {
  const h = setup({ count: 60, maxHistoryRows: 40, spacing: 0 });
  await h.open();
  for (let step = 0; h.window().hasMore && step < 5; step++) {
    h.channels.loadOlder("c");
    await vi.waitFor(() => expect(h.window().loadingOlder).toBe(false));
  }
  const anchor = h.window().rows[19]?.id;
  assert.exists(anchor);
  h.channels.loadNewer?.("c", anchor);
  await vi.waitFor(() => expect(h.window().loadingNewer).toBeFalsy());
  expect(h.window().rows.map((row) => row.id)).toContain(anchor);
  const nextAnchor = h.window().rows[0]?.id;
  assert.exists(nextAnchor);
  for (let step = 0; h.window().hasNewer && step < 4; step++) {
    h.channels.loadNewer?.("c", nextAnchor);
    await vi.waitFor(() => expect(h.window().loadingNewer).toBeFalsy());
    expect(h.window().rows.map((row) => row.id)).toContain(nextAnchor);
  }
  expect(h.window().hasNewer).toBeFalsy();
});

it("hands off a rendered anchor when preserving it would repeat the older cursor", async () => {
  const h = setup({ count: 0 });
  const secret = new Uint8Array(32).fill(1);
  const alice = { secret, pubkey: getPublicKey(secret) };
  const payload = "x".repeat(128 * 1024);
  const tags = [
    ["ms", "100"],
    ["metadata", payload],
  ];
  const rows = Array.from({ length: 79 }, (_, i) =>
    message(alice, "c", `dense${i}`, T0, tags),
  );
  const firstId = [...rows].sort(newestFirst)[0]?.id;
  assert.exists(firstId);
  // This signed ms=0 row sorts first both in rendered order and relay ID order.
  const anchor = message(alice, "c", "anchor3", T0, [
    ["ms", "0"],
    ["metadata", payload],
  ]);
  expect(anchor.id < firstId).toBe(true);
  h.history.push(...rows, anchor);
  await h.open();
  expect(h.window().rows[0]?.id).toBe(anchor.id);
  const seen = new Set(h.window().rows.map((row) => row.id));
  for (let step = 0; h.window().hasMore && step < 5; step++) {
    const before = h.window().rows.map((row) => row.id);
    h.channels.loadOlder("c", h.window().rows[0]?.id);
    await vi.waitFor(() => expect(h.window().loadingOlder).toBe(false));
    expect(h.window().rows.map((row) => row.id)).not.toEqual(before);
    for (const row of h.window().rows) seen.add(row.id);
    const ids = new Set(h.window().rows.map((row) => row.id));
    expect(
      byteSize(h.history.filter((event) => ids.has(event.id))),
    ).toBeLessThanOrEqual(8 * 1024 * 1024);
  }
  expect(h.window().hasMore).toBe(false);
  expect(seen.size).toBe(80);
  for (let step = 0; h.window().hasNewer && step < 5; step++) {
    h.channels.loadNewer?.("c", h.window().rows.at(-1)?.id);
    await vi.waitFor(() => expect(h.window().loadingNewer).toBeFalsy());
    expect(h.window().error).toBeUndefined();
  }
  expect(h.window().hasNewer).toBeFalsy();
  expect(h.window().rows.map((row) => row.id)).toContain(anchor.id);
});
