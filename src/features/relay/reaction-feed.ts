import { listByteSize } from "./budget";
import type { ChannelQueries } from "./contracts";
import { validReactionContent, type CustomEmoji } from "./emoji";
import type { RelayEvent, ReadFilter } from "./events";
import { deletionApplies } from "./fold";
import type { RelayReader } from "./reader";
import { threadReference } from "./thread-reference";

/** One verified reaction to a message the viewer wrote. */
export type ReactionNotice = Readonly<{
  /** The kind 7 event id. */
  id: string;
  reactorId: string;
  /** From the verified target, never the reaction's own tags. */
  channelId: string;
  messageId: string;
  rootId?: string | undefined;
  targetKind: number;
  /** The target body as fetched; later edits are not tracked. */
  targetContent: string;
  content: string;
  emoji?: CustomEmoji | undefined;
  createdAt: number;
}>;
export type ReactionFeedSnapshot = Readonly<{
  status: "idle" | "loading" | "ready" | "error";
  error?: string | undefined;
  /** Newest first, deletions applied. */
  notices: readonly ReactionNotice[];
  freshness: "unknown" | "observed" | "stale";
}>;

const targetKinds = [9, 40002, 40008];
const deletionKinds = [5, 9005];
const maxNotices = 1000;
const maxBytes = 2 * 1024 * 1024;
const maxUnmatched = 1000;
const cursorOf = (event: RelayEvent) => ({
  until: event.created_at,
  before_id: event.id,
});
// NIP-25: the reacted-to event is the last `e` tag.
const targetOf = (event: RelayEvent) =>
  event.tags.filter((tag) => tag[0] === "e").at(-1)?.[1];
const older = (event: RelayEvent, cursor: ReturnType<typeof cursorOf>) =>
  event.created_at < cursor.until ||
  (event.created_at === cursor.until && event.id > cursor.before_id);
type Target = Pick<
  ReactionNotice,
  "channelId" | "messageId" | "rootId" | "targetKind" | "targetContent"
>;
/** The fields `deletionApplies` reads from a retained notice's event. */
const deletable = (id: string, kind: number, pubkey: string) => ({
  id,
  kind,
  pubkey,
  tags: [],
  content: "",
  created_at: 0,
});
const newestFirst = (a: ReactionNotice, b: ReactionNotice) =>
  b.createdAt - a.createdAt || a.id.localeCompare(b.id);

/** Bounded, verified reactions addressed to the viewer by NIP-25 `p` tag.
 * A reaction's tags are unsigned claims about its target: authorship and channel
 * come only from the fetched target message. */
export function createReactionFeed({
  viewer,
  channels,
  reader,
  signingAuthority,
  notify = (listener) => listener(),
}: {
  viewer: string;
  channels: ChannelQueries;
  reader: RelayReader;
  signingAuthority?: string | undefined;
  notify?: (listener: () => void) => void;
}) {
  let closed = false;
  let epoch = 0;
  let work: Promise<void> | undefined;
  let controller: AbortController | undefined;
  let requested = false;
  // Live target lookups outlive no reset; refresh owns `controller`.
  let liveReads = new AbortController();
  const notices = new Map<string, ReactionNotice>();
  // Deleted reaction and target ids, so a late copy cannot re-add them.
  const deleted = new Set<string>();
  // Deletions of reactions or targets not yet admitted, such as a retraction
  // that arrives while its reaction's target lookup is in flight.
  const unmatched = new Map<string, RelayEvent[]>();
  const retracted = (id: string, kind: number, pubkey: string) =>
    (unmatched.get(id) ?? []).some((deletion) =>
      deletionApplies(deletion, deletable(id, kind, pubkey), signingAuthority),
    );
  let snapshot: ReactionFeedSnapshot = Object.freeze({
    status: "idle",
    notices: Object.freeze([]),
    freshness: "unknown",
  });
  const listeners = new Set<() => void>();
  const member = (channelId: string) =>
    channels
      .list()
      .channels.some(
        (channel) =>
          channel.id === channelId &&
          !channel.huddle &&
          !channel.cached &&
          !channel.archived &&
          channel.members?.includes(viewer),
      );
  function publish(patch: Partial<ReactionFeedSnapshot>) {
    if (closed) return;
    snapshot = Object.freeze({ ...snapshot, ...patch });
    for (const listener of listeners) notify(listener);
  }
  function publishNotices(patch: Partial<ReactionFeedSnapshot> = {}) {
    const sorted = [...notices.values()].sort(newestFirst);
    let overflow = false;
    while (
      sorted.length > maxNotices ||
      (sorted.length && listByteSize(sorted) > maxBytes)
    ) {
      const oldest = sorted.pop();
      if (oldest) notices.delete(oldest.id);
      overflow = true;
    }
    publish({
      ...patch,
      notices: Object.freeze(sorted),
      ...(overflow ? { freshness: "stale" as const } : {}),
    });
  }
  const candidate = (event: RelayEvent) =>
    event.kind === 7 &&
    event.pubkey !== viewer &&
    !notices.has(event.id) &&
    !deleted.has(event.id) &&
    event.tags.some(([name, value]) => name === "p" && value === viewer) &&
    validReactionContent(event.content) &&
    !!targetOf(event);
  /** Verified targets for these reactions, from retained notices or the relay. */
  async function targetsFor(
    reactions: readonly RelayEvent[],
    signal: AbortSignal,
  ) {
    const known = new Map<string, Target>();
    for (const notice of notices.values())
      known.set(notice.messageId, {
        channelId: notice.channelId,
        messageId: notice.messageId,
        rootId: notice.rootId,
        targetKind: notice.targetKind,
        targetContent: notice.targetContent,
      });
    const missing = [
      ...new Set(
        reactions
          .map((event) => targetOf(event) ?? "")
          .filter((id) => id && !known.has(id) && !deleted.has(id)),
      ),
    ];
    const fetched: RelayEvent[] = [];
    for (let start = 0; start < missing.length; start += 100) {
      const ids = missing.slice(start, start + 100);
      fetched.push(
        ...(await reader.read([{ ids, limit: ids.length }], { signal })),
      );
    }
    for (const target of fetched) {
      const hs = target.tags.filter(([name]) => name === "h");
      const channelId = hs[0]?.[1];
      if (
        !missing.includes(target.id) ||
        target.pubkey !== viewer ||
        !targetKinds.includes(target.kind) ||
        hs.length !== 1 ||
        !channelId ||
        !member(channelId)
      )
        continue;
      known.set(target.id, {
        channelId,
        messageId: target.id,
        rootId: threadReference(target)?.rootId,
        targetKind: target.kind,
        targetContent: target.content,
      });
    }
    return known;
  }
  function admit(
    reactions: readonly RelayEvent[],
    targets: Awaited<ReturnType<typeof targetsFor>>,
  ) {
    for (const event of reactions) {
      const target = targets.get(targetOf(event) ?? "");
      if (!target || !candidate(event)) continue;
      if (
        retracted(event.id, 7, event.pubkey) ||
        retracted(target.messageId, target.targetKind, viewer)
      ) {
        deleted.add(event.id);
        continue;
      }
      const shortcode = event.content.match(/^:([^:\s]+):$/)?.[1];
      const emojiTag = event.tags.find(
        ([name, code, url]) =>
          name === "emoji" && code === shortcode && typeof url === "string",
      );
      notices.set(event.id, {
        ...target,
        id: event.id,
        reactorId: event.pubkey,
        content: event.content,
        ...(emojiTag?.[1] && emojiTag[2]
          ? { emoji: { shortcode: emojiTag[1], url: emojiTag[2] } }
          : {}),
        createdAt: event.created_at,
      });
    }
  }
  /** Drop notices these deletions retire; true when any notice left. */
  function applyDeletions(events: readonly RelayEvent[]) {
    let changed = false;
    for (const deletion of events) {
      if (!deletionKinds.includes(deletion.kind)) continue;
      for (const [name, id] of deletion.tags) {
        if (name !== "e" || !id) continue;
        unmatched.set(id, [...(unmatched.get(id) ?? []), deletion]);
        for (const oldest of unmatched.keys()) {
          if (unmatched.size <= maxUnmatched) break;
          unmatched.delete(oldest);
        }
        const reaction = notices.get(id);
        if (
          reaction &&
          deletionApplies(
            deletion,
            deletable(id, 7, reaction.reactorId),
            signingAuthority,
          )
        ) {
          notices.delete(id);
          deleted.add(id);
          changed = true;
        }
        const target = [...notices.values()].find(
          (notice) => notice.messageId === id,
        );
        if (
          target &&
          deletionApplies(
            deletion,
            deletable(id, target.targetKind, viewer),
            signingAuthority,
          )
        ) {
          for (const notice of [...notices.values()])
            if (notice.messageId === id) notices.delete(notice.id);
          deleted.add(id);
          changed = true;
        }
      }
    }
    return changed;
  }
  async function deletionsFor(ids: readonly string[], signal: AbortSignal) {
    const collected: RelayEvent[] = [];
    for (let start = 0; start < ids.length; start += 500) {
      const batch = ids.slice(start, start + 500);
      let cursor: ReturnType<typeof cursorOf> | undefined;
      for (;;) {
        const page = [
          ...(await reader.read(
            [
              {
                kinds: deletionKinds,
                "#e": batch,
                limit: 500,
                ...(cursor ?? {}),
              },
            ],
            { signal },
          )),
        ].sort(
          (a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id),
        );
        const previous = cursor;
        if (previous && page.some((event) => !older(event, previous)))
          throw new Error("Reaction updates did not advance. Retry inbox.");
        collected.push(...page);
        if (collected.length > 2000)
          throw new Error(
            "Reaction updates exceed the read budget. Retry inbox.",
          );
        const last = page.at(-1);
        // Authorized responses can have short pages. Only empty ends the walk.
        if (!last) break;
        cursor = cursorOf(last);
      }
    }
    return collected;
  }
  async function refresh() {
    if (closed) return;
    if (work) return work;
    requested = true;
    const generation = epoch;
    const owned = new AbortController();
    controller = owned;
    work = (async () => {
      try {
        const filter: ReadFilter = { kinds: [7], "#p": [viewer], limit: 100 };
        const reactions = (
          await reader.read([filter], { signal: owned.signal })
        ).filter(candidate);
        const targets = await targetsFor(reactions, owned.signal);
        const ids = [
          ...new Set([
            ...reactions.map((event) => event.id),
            ...notices.keys(),
            ...targets.keys(),
          ]),
        ];
        const deletions = await deletionsFor(ids, owned.signal);
        if (closed || generation !== epoch) return;
        admit(reactions, targets);
        applyDeletions(deletions);
        // Leaving a channel retires its retained reactions.
        for (const notice of notices.values())
          if (!member(notice.channelId)) notices.delete(notice.id);
        publishNotices({
          status: "ready",
          error: undefined,
          freshness: "observed",
        });
      } catch (error) {
        if (closed || generation !== epoch || owned.signal.aborted) return;
        publish({
          status: "error",
          error:
            error instanceof Error ? error.message : "Reactions unavailable",
        });
      }
    })().finally(() => {
      if (controller === owned) {
        controller = undefined;
        work = undefined;
      }
    });
    if (generation === epoch && controller === owned)
      publish({ status: "loading", error: undefined });
    return work;
  }
  /** Verified live events of any kind; deduped by id here. */
  function accept(events: readonly RelayEvent[]) {
    if (closed) return;
    if (applyDeletions(events)) publishNotices();
    const reactions = events.filter(candidate);
    // Before Inbox asks, its first refresh reads these anyway.
    if (!requested || !reactions.length) return;
    const generation = epoch;
    // A failed live lookup is recovered by the next refresh's #p read.
    void targetsFor(reactions, liveReads.signal)
      .then((targets) => {
        if (closed || generation !== epoch) return;
        admit(reactions, targets);
        publishNotices();
      })
      .catch(() => {});
  }
  function retire() {
    epoch++;
    controller?.abort();
    liveReads.abort();
    liveReads = new AbortController();
  }
  function reset() {
    retire();
    controller = undefined;
    work = undefined;
    notices.clear();
    deleted.clear();
    unmatched.clear();
    publish({
      status: "idle",
      error: undefined,
      notices: Object.freeze([]),
      freshness: "unknown",
    });
  }
  return Object.freeze({
    snapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    ensure: () =>
      work ?? (snapshot.status === "idle" ? refresh() : Promise.resolve()),
    refresh,
    accept,
    /** Retained notices stay verified; only completeness is lost. */
    stale() {
      retire();
      controller = undefined;
      work = undefined;
      publish({ status: "idle", error: undefined, freshness: "stale" });
    },
    reconnect() {
      if (requested) void refresh();
    },
    clear: reset,
    // Access loss can retire any retained target's channel.
    purge: reset,
    dispose() {
      closed = true;
      retire();
      controller = undefined;
      work = undefined;
      notices.clear();
      deleted.clear();
      unmatched.clear();
      snapshot = Object.freeze({
        status: "idle",
        notices: Object.freeze([]),
        freshness: "unknown",
      });
      listeners.clear();
    },
  });
}
