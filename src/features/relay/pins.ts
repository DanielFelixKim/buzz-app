import type { EventTemplate } from "nostr-tools";
import type { PinRecord } from "./contracts";
import type { EventData } from "./events";

/** A channel member's pin of one channel message (relay `KIND_STREAM_MESSAGE_PINNED`). */
export const PIN_KIND = 40004;
/** Message kinds a pin may target; the relay validator accepts the same set. */
export const PINNABLE_KINDS: readonly number[] = [9, 40002];
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
