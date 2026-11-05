import type { EventTemplate } from "nostr-tools";
import type {
  ChannelMessage,
  ChannelQueries,
  ChannelWindow,
  PinRecord,
} from "./contracts";
import type { EventData, ReadFilter } from "./events";
import { deletionApplies } from "./fold";
import type { Outbox } from "./outbox";

/** A channel member's pin of one channel message (relay `KIND_STREAM_MESSAGE_PINNED`). */
export const PIN_KIND = 40004;
/** Message kinds a pin may target; the relay validator accepts the same set. */
export const PINNABLE_KINDS: readonly number[] = [9, 40002];
/** One page of a channel's pins. New pins have no cap, so a channel past it
 * lists only the newest; the relay returns newest first. */
export const PIN_READ_LIMIT = 200;
const HEX64 = /^[0-9a-f]{64}$/;

const named = (event: Pick<EventData, "tags">, name: string) =>
  event.tags.filter((tag) => tag[0] === name);

/** One `h`, one `e` and no content. Signers also accept the outbox's
 * `client-id`; readers ignore other tags. Mirrors `valid_pin` in
 * `src-tauri/src/relay.rs` and `validPin` in `browser-host/relay-broker.mjs`. */
function pinTarget(event: Pick<EventData, "kind" | "content" | "tags">) {
  if (event.kind !== PIN_KIND || event.content !== "") return undefined;
  const channels = named(event, "h");
  const targets = named(event, "e");
  const channel = channels[0];
  const target = targets[0];
  if (
    channels.length !== 1 ||
    targets.length !== 1 ||
    channel?.length !== 2 ||
    target?.length !== 2 ||
    !channel[1] ||
    !HEX64.test(target[1] ?? "")
  )
    return undefined;
  return { channelId: channel[1], messageId: target[1] as string };
}

type PinTemplate = Pick<EventTemplate, "kind" | "content" | "tags">;

export function validatePinTemplate(event: PinTemplate): void {
  if (
    !pinTarget(event) ||
    !event.tags.every((tag) => tag[0] === "h" || tag[0] === "e")
  )
    throw new Error("Malformed pin");
}

export function pinTemplate(channelId: string, messageId: string): PinTemplate {
  const template = {
    kind: PIN_KIND,
    content: "",
    tags: [
      ["h", channelId],
      ["e", messageId],
    ],
  };
  validatePinTemplate(template);
  return template;
}

/** The live pins of `message`, earliest first. A pin counts only when it names
 * this message in this channel; deleted pins and pins of other kinds drop. */
export function messagePins(
  message: Pick<EventData, "id" | "kind">,
  channelId: string,
  overlays: readonly EventData[],
  deleted: (event: EventData) => boolean,
): readonly PinRecord[] {
  if (!PINNABLE_KINDS.includes(message.kind)) return [];
  return overlays
    .filter((event) => {
      const target = pinTarget(event);
      return (
        target?.channelId === channelId &&
        target.messageId === message.id &&
        !deleted(event)
      );
    })
    .sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id))
    .map((event) =>
      Object.freeze({
        id: event.id,
        messageId: message.id,
        pinnedBy: event.pubkey,
        pinnedAt: event.created_at,
      }),
    );
}

/** A channel's live pins, one per pin event, newest pin first. A pin drops
 * when its author deleted it, or its target is missing, deleted, not a
 * pinnable message or in another channel, so a pin cannot surface another
 * channel's message. */
export async function readChannelPins(
  session: {
    read(
      filters: readonly ReadFilter[],
      options: { signal: AbortSignal },
    ): Promise<readonly EventData[]>;
  },
  channelId: string,
  signal: AbortSignal,
): Promise<readonly PinRecord[]> {
  const pins = (
    await session.read(
      [{ kinds: [PIN_KIND], "#h": [channelId], limit: PIN_READ_LIMIT }],
      { signal },
    )
  ).filter((event) => pinTarget(event)?.channelId === channelId);
  if (!pins.length) return [];
  const messageIds = [
    ...new Set(pins.map((event) => pinTarget(event)?.messageId ?? "")),
  ];
  const [targets, deletions] = await Promise.all([
    session.read([{ ids: messageIds, limit: messageIds.length }], { signal }),
    session.read(
      [
        {
          kinds: [5, 9005],
          "#e": [...pins.map((event) => event.id), ...messageIds],
          limit: 500,
        },
      ],
      { signal },
    ),
  ]);
  const deleted = (event: EventData) =>
    deletions.some(
      (deletion) =>
        deletion.tags.some(([name, id]) => name === "e" && id === event.id) &&
        deletionApplies(deletion, event, undefined),
    );
  return targets
    .filter(
      (target) =>
        messageIds.includes(target.id) &&
        target.tags.some(([name, id]) => name === "h" && id === channelId) &&
        !deleted(target),
    )
    .flatMap((target) => messagePins(target, channelId, pins, deleted))
    .sort((a, b) => b.pinnedAt - a.pinnedAt || a.id.localeCompare(b.id));
}

/** What a plugin may do with a channel's pins; see `docs/channels.md`. */
export type SessionPins = Readonly<{
  /** Live pins from the channel's folded window, in row order, earliest pin
   * first within a row. The same array until the pins change. */
  snapshot(channelId: string): readonly PinRecord[];
  /** Calls `listener` when `snapshot` returns a different array. */
  subscribe(channelId: string, listener: () => void): () => void;
  /** The channel's pins read from the relay, newest first; see `readChannelPins`. */
  read(channelId: string, signal?: AbortSignal): Promise<readonly PinRecord[]>;
  canPin(message: ChannelMessage): boolean;
  /** The viewer's pin on `message`. */
  ownPin(message: ChannelMessage): PinRecord | undefined;
  /** Queues the pin; returns the outbox operation id, which is the pin's event id. */
  pin(channelId: string, messageId: string): string;
  /** Queues the removal of the viewer's pin; returns the outbox operation id. */
  unpin(pinId: string): string;
}>;

const NO_PINS: readonly PinRecord[] = Object.freeze([]);
const samePin = (left: PinRecord, right: PinRecord) =>
  left.id === right.id &&
  left.messageId === right.messageId &&
  left.pinnedBy === right.pinnedBy &&
  left.pinnedAt === right.pinnedAt;

export function createPins({
  viewer,
  outbox,
  channels,
  canWrite,
  find,
  observed,
  read,
  remove,
}: {
  viewer: string | undefined;
  outbox: Outbox | undefined;
  channels: Pick<ChannelQueries, "list" | "window" | "subscribeWindow">;
  canWrite(channelId: string): boolean;
  /** A message or pin event the session still holds. */
  find(id: string): EventData | undefined;
  /** Live and queued events, to find a deletion that has not reached a window. */
  observed(): readonly EventData[];
  read(
    filters: readonly ReadFilter[],
    options: { signal: AbortSignal },
  ): Promise<readonly EventData[]>;
  /** `messages.remove`: queues the deletion and returns its operation id. */
  remove(eventIds: readonly string[]): string;
}): SessionPins {
  const snapshots = new Map<
    string,
    { window: ChannelWindow; pins: readonly PinRecord[] }
  >();
  const snapshot = (channelId: string) => {
    const window = channels.window(channelId);
    const known = snapshots.get(channelId);
    if (known?.window === window) return known.pins;
    const current = window.rows.flatMap((row) => row.pinnedBy ?? []);
    const pins =
      known &&
      known.pins.length === current.length &&
      known.pins.every((pin, index) =>
        samePin(pin, current[index] as PinRecord),
      )
        ? known.pins
        : current.length
          ? Object.freeze(current)
          : NO_PINS;
    snapshots.set(channelId, { window, pins });
    return pins;
  };
  const ownPin = (message: ChannelMessage) =>
    viewer
      ? message.pinnedBy?.find((pin) => pin.pinnedBy === viewer)
      : undefined;
  const deleted = (event: EventData) =>
    observed().some(
      (item) =>
        item.tags.some(([name, id]) => name === "e" && id === event.id) &&
        deletionApplies(item, event, undefined),
    );
  const writer = (channelId: string) => {
    if (!canWrite(channelId))
      throw new Error("You don’t have write access to this conversation.");
    if (!outbox?.supports(PIN_KIND))
      throw new Error("This connection cannot publish that operation");
    return outbox;
  };
  return Object.freeze({
    snapshot,
    subscribe(channelId: string, listener: () => void) {
      let last = snapshot(channelId);
      return channels.subscribeWindow(channelId, () => {
        const next = snapshot(channelId);
        if (next === last) return;
        last = next;
        listener();
      });
    },
    read: (channelId: string, signal?: AbortSignal) =>
      readChannelPins(
        { read },
        channelId,
        signal ?? new AbortController().signal,
      ),
    canPin(message: ChannelMessage) {
      const channel = channels
        .list()
        .channels.find((item) => item.id === message.channelId);
      const original = find(message.id);
      return (
        !!viewer &&
        !!channel &&
        !channel.readOnly &&
        !channel.cached &&
        !channel.archived &&
        channel.channelType !== "dm" &&
        !message.huddle &&
        !!original &&
        PINNABLE_KINDS.includes(original.kind) &&
        !deleted(original) &&
        !!outbox?.supports(PIN_KIND) &&
        !ownPin(message)
      );
    },
    ownPin,
    pin(channelId: string, messageId: string) {
      const original = find(messageId);
      if (!original || !PINNABLE_KINDS.includes(original.kind))
        throw new Error("Load the message before pinning it");
      if (!original.tags.some(([name, id]) => name === "h" && id === channelId))
        throw new Error("Message is not in this channel");
      return writer(channelId).send(pinTemplate(channelId, messageId));
    },
    unpin(pinId: string) {
      if (find(pinId)?.kind !== PIN_KIND)
        throw new Error("Load the pin before unpinning it");
      return remove([pinId]);
    },
  });
}
