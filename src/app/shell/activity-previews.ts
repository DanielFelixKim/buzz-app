/**
 * PROTOTYPE: each listed conversation's latest top-level message, for the
 * Activity sidebar's order and preview.
 *
 * Channel previews come from loaded heads, which exist only for channels this
 * device has opened, and unread evidence is the newest 500 messages across
 * many channels, so busy channels crowd quiet ones out. This asks the relay
 * for the newest few messages of each conversation that has neither, a batch
 * of per-channel filters at a time, and keeps the newest one that is not a
 * thread reply.
 */
import { useEffect, useSyncExternalStore } from "react";
import type { RelaySession } from "../../features/relay/session";
import { threadReference } from "../../features/relay/thread-reference";

export type LatestMessage = Readonly<{
  id: string;
  createdAt: number;
  authorId: string;
  content: string;
}>;

type Store = {
  latest: Map<string, LatestMessage | null>;
  asked: Set<string>;
  listeners: Set<() => void>;
  version: number;
  running: boolean;
  queue: string[];
};

const stores = new WeakMap<RelaySession, Store>();
const BATCH = 10;
const PER_CHANNEL = 6;

function storeOf(session: RelaySession): Store {
  let store = stores.get(session);
  if (!store) {
    store = {
      latest: new Map(),
      asked: new Set(),
      listeners: new Set(),
      version: 0,
      running: false,
      queue: [],
    };
    stores.set(session, store);
  }
  return store;
}

async function drain(session: RelaySession, store: Store) {
  if (store.running || !session.snapshotRead) return;
  store.running = true;
  try {
    while (store.queue.length) {
      const batch = store.queue.splice(0, BATCH);
      let events: readonly {
        id: string;
        pubkey: string;
        created_at: number;
        content: string;
        tags: readonly (readonly string[])[];
      }[] = [];
      try {
        events = await session.snapshotRead(
          batch.map((id) => ({
            kinds: [9],
            "#h": [id],
            limit: PER_CHANNEL,
          })),
          { signal: AbortSignal.timeout(10_000) },
        );
      } catch {
        // Leave these unknown; a later mount asks again.
        for (const id of batch) store.asked.delete(id);
        continue;
      }
      for (const id of batch) store.latest.set(id, null);
      for (const event of events) {
        if (threadReference(event)) continue;
        const channelId = event.tags.find((tag) => tag[0] === "h")?.[1];
        if (!channelId || !batch.includes(channelId)) continue;
        const held = store.latest.get(channelId);
        if (!held || held.createdAt < event.created_at)
          store.latest.set(channelId, {
            id: event.id,
            createdAt: event.created_at,
            authorId: event.pubkey,
            content: event.content,
          });
      }
      store.version++;
      for (const listener of store.listeners) listener();
    }
  } finally {
    store.running = false;
  }
}

/** Latest top-level messages by channel id, fetched for `wanted` once each.
 * null: asked, and the newest few messages had no top-level one. */
export function useLatestMessages(
  session: RelaySession,
  wanted: readonly string[],
): ReadonlyMap<string, LatestMessage | null> {
  const store = storeOf(session);
  useSyncExternalStore(
    (listener) => {
      store.listeners.add(listener);
      return () => store.listeners.delete(listener);
    },
    () => store.version,
    () => store.version,
  );
  const key = wanted.join(",");
  useEffect(() => {
    const fresh = key.split(",").filter((id) => id && !store.asked.has(id));
    if (!fresh.length) return;
    for (const id of fresh) store.asked.add(id);
    store.queue.push(...fresh);
    void drain(session, store);
  }, [session, store, key]);
  return store.latest;
}
