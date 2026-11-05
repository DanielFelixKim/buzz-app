import { replaceView, viewRevision } from "../../shared/view-state";

/** Device-local seen watermarks for reaction rows, per account and community. */
export const reactionSeenKey = "inbox:reaction-seen";
/** Reactions to a message seen through `through`: every one before that
 * second, and at it only `ids`, since reactions share one-second times. */
export type ReactionSeen = Readonly<{
  through: number;
  ids: ReadonlySet<string>;
}>;
type Entry = Readonly<{
  messageId: string;
  seenThrough: number;
  seenIds: readonly string[];
}>;
const maxEntries = 1000;

function entries(revision: string | null | undefined): Entry[] {
  if (!revision) return [];
  try {
    const value: unknown = JSON.parse(revision);
    if (!Array.isArray(value)) return [];
    return value.filter(
      (entry): entry is Entry =>
        !!entry &&
        typeof entry.messageId === "string" &&
        Number.isSafeInteger(entry.seenThrough) &&
        entry.seenThrough >= 0 &&
        Array.isArray(entry.seenIds) &&
        entry.seenIds.every((id: unknown) => typeof id === "string"),
    );
  } catch {
    return [];
  }
}

/** Each reacted-to message's seen state; absent means never seen. */
export function readReactionSeen(
  revision: string | null | undefined,
): ReadonlyMap<string, ReactionSeen> {
  return new Map(
    entries(revision).map((entry) => [
      entry.messageId,
      { through: entry.seenThrough, ids: new Set(entry.seenIds) },
    ]),
  );
}

/** Whether a row whose newest reactions are `newestIds` at `createdAt` has
 * any reaction `seen` does not cover. */
export function reactionsUnseen(
  seen: ReactionSeen | undefined,
  createdAt: number,
  newestIds: readonly string[],
) {
  if (!seen || createdAt > seen.through) return true;
  return (
    createdAt === seen.through && newestIds.some((id) => !seen.ids.has(id))
  );
}

/** Records reactions to `messageId` as seen through `seen`, or, without it,
 * forgets them so the row is unread. Keeps the 1,000 latest writes. */
export function updateReactionSeen(
  scope: string,
  messageId: string,
  seen?: Readonly<{ through: number; ids: readonly string[] }>,
) {
  const revision = viewRevision(scope, reactionSeenKey);
  const next: Entry[] = [
    ...entries(revision).filter((entry) => entry.messageId !== messageId),
    ...(seen === undefined
      ? []
      : [{ messageId, seenThrough: seen.through, seenIds: [...seen.ids] }]),
  ].slice(-maxEntries);
  const result = replaceView(scope, reactionSeenKey, revision, next);
  if (result !== "saved")
    throw new Error(
      result === "changed"
        ? "Inbox reactions changed in another window. Try again."
        : "Could not save Inbox reactions on this device. Try again.",
    );
}
