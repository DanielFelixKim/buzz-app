import { newer, type EventData, type ReadFilter } from "../relay/events";
import type { Presence, PresenceStatus } from "./presence";

/** Kind 30177: an owner's record of one agent, `d` its pubkey. */
const AGENT_RECORD = 30177;
/** The reader's most filters per read; each filter is one owner's agents. */
const FILTERS = 4;
/** Agents per filter, within the reader's limit. */
const AGENTS = 100;
/** Evidence kept for agents no longer shown, so a remount reads nothing. */
const RETAINED = 1024;
/** Hosted agents publish no presence, so records are read again this often,
 * spread so a fleet that reconnected together does not refresh together. */
const refreshMs = () => 5 * 60_000 + Math.floor(Math.random() * 60_000);
/** A failed read is retried sooner, but not on every change. */
const retryMs = () => 60_000 + Math.floor(Math.random() * 5_000);

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
/** What one read found: the attested owner it asked, and the runtime its
 * newest record of the agent names, if any. */
type Evidence = { owner: string; runtime: string | undefined };

/** Agents a remote runtime runs. They wake on mentions and hold no socket, so
 * relay presence cannot show them; the owner's record is the evidence. Only a
 * record signed by the owner the agent's own profile attests counts. Display
 * only: it grants nothing and does not prove the agent is running. */
export function createHostedAgents(deps: Deps) {
  const listeners = new Map<string, Set<() => void>>();
  /** By agent, in least recently read order. */
  const evidence = new Map<string, Evidence>();
  let runtimes: ReadonlySet<string> = new Set();
  let connected = false,
    closed = false;
  let controller: AbortController | undefined;
  /** One timer for the next read, whether demand, retry or refresh. */
  let timer: ReturnType<typeof setTimeout> | undefined;
  let due = Infinity;
  /** When the next read asks about every shown agent again. */
  let refreshAt = 0;
  /** After a failure, demand waits for the retry too. */
  let backoffUntil = 0;
  const shown = (key: string) => {
    const owner = connected ? deps.owner(key) : undefined;
    const found = owner ? evidence.get(key) : undefined;
    return (
      !!found &&
      found.owner === owner &&
      !!found.runtime &&
      runtimes.has(found.runtime)
    );
  };
  /** Runs `update` and notifies each shown agent whose badge it changed. */
  function updating(update: () => void) {
    const before = new Map(
      [...listeners.keys()].map((key) => [key, shown(key)]),
    );
    update();
    for (const [key, was] of before)
      if (listeners.has(key) && was !== shown(key))
        for (const listener of listeners.get(key) ?? []) deps.notify(listener);
  }
  /** Shown agents with an attested owner whose evidence is missing or was
   * read for another owner; on a refresh, every shown agent with an owner. */
  function wanted(refreshing = false) {
    const found = new Map<string, string>();
    for (const key of listeners.keys()) {
      const owner = deps.owner(key);
      if (
        owner &&
        owner !== key &&
        (refreshing || evidence.get(key)?.owner !== owner)
      )
        found.set(key, owner);
    }
    return found;
  }
  /** Moves the next read earlier, never later. */
  function schedule(at: number) {
    if (closed || !listeners.size || at >= due) return;
    clearTimeout(timer);
    due = at;
    timer = setTimeout(
      () => {
        timer = undefined;
        due = Infinity;
        void read();
      },
      Math.max(0, at - Date.now()),
    );
  }
  /** Coalesces demand and owner changes into one read. A read under way is
   * not cancelled: the next one asks only about what it did not. */
  function queue(delay = 100) {
    if (wanted().size) schedule(Math.max(Date.now() + delay, backoffUntil));
  }
  /** Keeps the refresh scheduled while agents are shown. */
  const arm = () => refreshAt && schedule(refreshAt);
  async function read() {
    if (closed || controller || !connected || !runtimes.size) return;
    // Timers may fire a moment early; a read that close to the refresh is it.
    const refreshing = Date.now() + 5 >= refreshAt;
    const wants = wanted(refreshing);
    if (refreshing) refreshAt = Date.now() + refreshMs();
    const owned = new AbortController();
    controller = owned;
    try {
      const owners = new Map<string, string[]>();
      for (const [key, owner] of wants)
        owners.set(owner, [...(owners.get(owner) ?? []), key]);
      const filters: ReadFilter[] = [];
      for (const [owner, agents] of owners)
        for (let at = 0; at < agents.length; at += AGENTS) {
          const chunk = agents.slice(at, at + AGENTS);
          filters.push({
            kinds: [AGENT_RECORD],
            authors: [owner],
            "#d": chunk,
            limit: chunk.length,
          });
        }
      for (let at = 0; at < filters.length; at += FILTERS) {
        const batch = filters.slice(at, at + FILTERS);
        const events = await deps.read(batch, owned.signal);
        if (owned.signal.aborted) return;
        // The newest record of each agent by its attested owner decides.
        const heads = new Map<string, EventData>();
        for (const event of events) {
          const d = event.tags.find((tag) => tag[0] === "d")?.[1];
          if (event.kind === AGENT_RECORD && d && wants.get(d) === event.pubkey)
            heads.set(d, newer(heads.get(d), event));
        }
        updating(() => {
          for (const filter of batch)
            for (const key of filter["#d"] ?? []) {
              evidence.delete(key);
              evidence.set(key, {
                owner: filter.authors?.[0] ?? "",
                runtime: heads
                  .get(key)
                  ?.tags.find((tag) => tag[0] === "runtime")?.[1],
              });
            }
          for (const key of evidence.keys()) {
            if (evidence.size <= RETAINED) break;
            if (!listeners.has(key)) evidence.delete(key);
          }
        });
      }
      backoffUntil = 0;
    } catch {
      // A failed read keeps prior evidence and waits for the retry, so
      // neither demand nor profile changes turn a failing relay into a loop.
      if (owned.signal.aborted) return;
      backoffUntil = refreshAt = Date.now() + retryMs();
    } finally {
      if (controller === owned) controller = undefined;
    }
    queue();
    arm();
  }
  const stopOwners = deps.subscribeOwners(() => {
    // An owner change can hide a badge at once; its new owner is then read.
    updating(() => {});
    queue();
  });
  return {
    hosted: shown,
    /** The runtimes, by agent type key, that run agents remotely. */
    remoteRuntimes(keys: Iterable<string>) {
      const next = new Set(keys);
      if (
        next.size === runtimes.size &&
        [...next].every((key) => runtimes.has(key))
      )
        return;
      updating(() => {
        runtimes = next;
      });
      queue();
      arm();
    },
    subscribe(key: string, listener: () => void) {
      if (closed || !/^[0-9a-f]{64}$/.test(key)) return () => {};
      let set = listeners.get(key);
      if (!set) {
        set = new Set();
        listeners.set(key, set);
      }
      set.add(listener);
      queue();
      arm();
      return () => {
        const current = listeners.get(key);
        if (!current?.delete(listener) || current.size) return;
        // Evidence stays, so showing the agent again reads nothing.
        listeners.delete(key);
        if (!listeners.size) {
          clearTimeout(timer);
          timer = undefined;
          due = Infinity;
        }
      };
    },
    connected(value: boolean) {
      if (connected === value || closed) return;
      updating(() => {
        connected = value;
      });
      if (!value) {
        controller?.abort();
        controller = undefined;
        return;
      }
      // A reconnect keeps evidence and spreads its reads, so a fleet that
      // reconnected together does not read together.
      const spread = 1000 + Math.floor(Math.random() * 4000);
      queue(spread);
      if (refreshAt) schedule(Math.max(refreshAt, Date.now() + spread));
    },
    /** Drops evidence read under earlier access and reads again. */
    clear() {
      controller?.abort();
      controller = undefined;
      updating(() => evidence.clear());
      queue();
    },
    dispose() {
      closed = true;
      stopOwners();
      clearTimeout(timer);
      controller?.abort();
      listeners.clear();
      evidence.clear();
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
    limited: (key: string) => !hosted.hosted(key) && presence.limited(key),
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
