import { newer, type EventData, type ReadFilter } from "../relay/events";
import type { Presence, PresenceStatus } from "./presence";

/** Kind 30177: an owner's record of one agent, `d` its pubkey. */
const AGENT_RECORD = 30177;
/** Agents per read; each names its owner, so a read stays bounded. */
const BATCH = 100;
/** Hosted agents publish no presence, so records are read again this often. */
const REFRESH_MS = 5 * 60_000;

type Deps = {
  /** The verified NIP-OA owner of an agent's winning kind 0, if any. */
  owner(pubkey: string): string | undefined;
  /** Notifies when profile heads, and so owners, change. */
  subscribeOwners(listener: () => void): () => void;
  read(
    filters: readonly ReadFilter[],
    signal: AbortSignal,
  ): Promise<readonly EventData[]>;
  notify(listener: () => void): void;
};

/** Agents a remote runtime runs. They wake on mentions and hold no socket, so
 * relay presence cannot show them; the owner's record is the evidence. Only a
 * record signed by the owner the agent's own profile attests counts. Display
 * only: it grants nothing and does not prove the agent is running. */
export function createHostedAgents(deps: Deps) {
  const listeners = new Map<string, Set<() => void>>();
  let hosted: ReadonlySet<string> = new Set();
  let runtimes: ReadonlySet<string> = new Set();
  /** Each tracked agent's owner as last read, so an owner change reads again. */
  let readOwners = new Map<string, string>();
  let connected = false,
    closed = false;
  let controller: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let queued: ReturnType<typeof setTimeout> | undefined;
  function publish(next: ReadonlySet<string>) {
    const changed = new Set<string>();
    for (const key of next) if (!hosted.has(key)) changed.add(key);
    for (const key of hosted) if (!next.has(key)) changed.add(key);
    hosted = next;
    for (const key of changed)
      for (const listener of listeners.get(key) ?? []) deps.notify(listener);
  }
  function owners() {
    const found = new Map<string, string>();
    for (const key of listeners.keys()) {
      const owner = deps.owner(key);
      if (owner && owner !== key) found.set(key, owner);
    }
    return found;
  }
  /** Coalesces demand and owner changes into one read. */
  function queue() {
    if (queued || closed || !listeners.size) return;
    queued = setTimeout(() => {
      queued = undefined;
      void read();
    }, 100);
  }
  async function read() {
    clearTimeout(timer);
    controller?.abort();
    controller = undefined;
    if (closed) return;
    const current = owners();
    if (!connected || !runtimes.size || !current.size) {
      // Disconnected, like observed presence, shows no status.
      readOwners = current;
      publish(new Set());
      return;
    }
    const owned = new AbortController();
    controller = owned;
    const keys = [...current.keys()];
    try {
      const events: EventData[] = [];
      for (let at = 0; at < keys.length; at += BATCH) {
        // One filter per owner, so another owner's records cannot fill a limit.
        const byOwner = new Map<string, string[]>();
        for (const key of keys.slice(at, at + BATCH)) {
          const owner = current.get(key);
          if (owner) byOwner.set(owner, [...(byOwner.get(owner) ?? []), key]);
        }
        events.push(
          ...(await deps.read(
            [...byOwner].map(([owner, agents]) => ({
              kinds: [AGENT_RECORD],
              authors: [owner],
              "#d": agents,
              limit: agents.length,
            })),
            owned.signal,
          )),
        );
        if (owned.signal.aborted) return;
      }
      // The newest record of each agent by its attested owner decides.
      const heads = new Map<string, EventData>();
      for (const event of events) {
        const d = event.tags.find((tag) => tag[0] === "d")?.[1];
        if (
          event.kind !== AGENT_RECORD ||
          !d ||
          current.get(d) !== event.pubkey
        )
          continue;
        heads.set(d, newer(heads.get(d), event));
      }
      const next = new Set<string>();
      for (const [key, event] of heads) {
        const runtime = event.tags.find((tag) => tag[0] === "runtime")?.[1];
        if (runtime && runtimes.has(runtime)) next.add(key);
      }
      readOwners = current;
      publish(next);
    } catch {
      // A failed read keeps prior evidence. Only the next refresh retries, so
      // profile changes cannot turn a failing relay into a read loop.
      if (!owned.signal.aborted) readOwners = current;
    } finally {
      if (controller === owned) controller = undefined;
      if (!closed && !owned.signal.aborted && listeners.size)
        timer = setTimeout(() => void read(), REFRESH_MS);
    }
  }
  /** Whether an agent's attested owner changed since the last read. */
  function stale() {
    const current = owners();
    return (
      current.size !== readOwners.size ||
      [...current].some(([key, owner]) => readOwners.get(key) !== owner)
    );
  }
  const stopOwners = deps.subscribeOwners(() => {
    if (stale()) queue();
  });
  return {
    hosted: (key: string) => hosted.has(key),
    /** The runtimes, by agent type key, that run agents remotely. */
    remoteRuntimes(keys: Iterable<string>) {
      const next = new Set(keys);
      if (
        next.size === runtimes.size &&
        [...next].every((key) => runtimes.has(key))
      )
        return;
      runtimes = next;
      queue();
    },
    subscribe(key: string, listener: () => void) {
      if (closed || !/^[0-9a-f]{64}$/.test(key)) return () => {};
      let set = listeners.get(key);
      if (!set) {
        set = new Set();
        listeners.set(key, set);
        if (stale()) queue();
      }
      set.add(listener);
      return () => {
        const current = listeners.get(key);
        if (!current?.delete(listener) || current.size) return;
        listeners.delete(key);
        readOwners.delete(key);
        if (hosted.has(key))
          publish(new Set([...hosted].filter((other) => other !== key)));
        if (!listeners.size) {
          clearTimeout(timer);
          clearTimeout(queued);
          queued = undefined;
          controller?.abort();
        }
      };
    },
    connected(value: boolean) {
      if (connected === value || closed) return;
      connected = value;
      queue();
    },
    /** Drops evidence read under earlier access and reads again. */
    clear() {
      controller?.abort();
      readOwners = new Map();
      publish(new Set());
      queue();
    },
    dispose() {
      closed = true;
      stopOwners();
      clearTimeout(timer);
      clearTimeout(queued);
      controller?.abort();
      listeners.clear();
      hosted = new Set();
    },
  };
}
export type HostedAgents = ReturnType<typeof createHostedAgents>;

/** Presence that shows hosted agents online whatever the relay reports. Every
 * other subject, the viewer included, keeps its observed status. */
export function withHostedAgents(
  presence: Presence,
  hosted: HostedAgents,
): HostedPresence {
  return {
    ...presence,
    status(key: string): PresenceStatus {
      return hosted.hosted(key) ? "online" : presence.status(key);
    },
    subscribe(key: string, listener: () => void, profile = false) {
      const stopPresence = presence.subscribe(key, listener, profile);
      const stopHosted = hosted.subscribe(key, listener);
      return () => {
        stopPresence();
        stopHosted();
      };
    },
    connected(value: boolean) {
      presence.connected(value);
      hosted.connected(value);
    },
    clear(publication?: boolean) {
      presence.clear(publication);
      hosted.clear();
    },
    dispose() {
      presence.dispose();
      hosted.dispose();
    },
    remoteRuntimes: hosted.remoteRuntimes,
  };
}
/** Presence that can learn which runtimes are remote; absent in test doubles. */
export type HostedPresence = Presence & {
  remoteRuntimes?(keys: Iterable<string>): void;
};
