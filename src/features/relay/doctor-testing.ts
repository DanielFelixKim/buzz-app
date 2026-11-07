import { vi } from "vitest";
import { createRelaySession } from "./session";
import { keypair } from "./testing";
import type { ReadFilter, RelayEvent } from "./events";
import type { RelayData, RelaySnapshot } from "./service";
import type { LiveCallbacks } from "./live";

export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export function doctorFixture({ kit = false } = {}) {
  const viewer = keypair(),
    relayAuthor = keypair(),
    agent = keypair();
  const failures = new Map<number, unknown>();
  const query = vi.fn(
    async (filters: readonly ReadFilter[], _signal?: AbortSignal) => {
      for (const filter of filters)
        for (const kind of filter.kinds ?? [])
          if (failures.has(kind)) throw failures.get(kind);
      return [] as RelayEvent[];
    },
  );
  const sign = vi.fn(async () => {
    throw new Error("Doctor must never sign");
  });
  const publish = vi.fn(async () => {
    throw new Error("Doctor must never publish");
  });
  let live!: LiveCallbacks;
  const owner = createRelaySession({
    viewer: viewer.pubkey,
    relayAuthor: relayAuthor.pubkey,
    query,
    media: () => undefined,
    subscribe: (callbacks) => {
      live = callbacks;
      return { update() {}, retry() {}, dispose() {} };
    },
    readAgentLibrary: async () => ({
      definitions: [],
      identities: [{ pubkey: agent.pubkey, name: "Saved agent" }],
    }),
    decodeSidebarPreferences: async () => ({
      sections: [],
      assignments: {},
      starred: [],
      muted: [],
    }),
    ...(kit
      ? {
          writer: { kinds: [30078], sign, publish },
          channelKit: { prepare: sign, decode: async () => [] },
        }
      : {}),
  });
  live.state({ status: "connected", routes: [] });
  let snapshot: RelaySnapshot = {
    session: owner.session,
    status: "ready",
    generation: 0,
    viewer: viewer.pubkey,
    origin: "https://relay.test",
    scope: `https://relay.test:${viewer.pubkey}`,
  };
  const listeners = new Set<() => void>();
  const relay: RelayData = {
    snapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    retry: vi.fn(),
    disconnect: vi.fn(),
    clearCache: vi.fn(async () => {}),
  };
  return {
    owner,
    session: owner.session,
    relay,
    failures,
    query,
    sign,
    publish,
    setConnection(next: Partial<RelaySnapshot>) {
      snapshot = { ...snapshot, ...next };
      for (const listener of listeners) listener();
    },
    count: (kind: number) =>
      query.mock.calls.filter(([filters]) =>
        filters.some((filter) => filter.kinds?.includes(kind)),
      ).length,
  };
}
