import { replaceView, viewRevision } from "../../shared/view-state";

/** Device-local seen watermarks for reaction rows, per account and community. */
export const reactionSeenKey = "inbox:reaction-seen";
type Seen = Readonly<{ messageId: string; seenThrough: number }>;
const maxEntries = 1000;

function entries(revision: string | null | undefined): Seen[] {
  if (!revision) return [];
  try {
    const value: unknown = JSON.parse(revision);
    if (!Array.isArray(value)) return [];
    return value.filter(
      (entry): entry is Seen =>
        !!entry &&
        typeof entry.messageId === "string" &&
        Number.isSafeInteger(entry.seenThrough) &&
        entry.seenThrough >= 0,
    );
  } catch {
    return [];
  }
}

/** Each reacted-to message's seen watermark; absent means never seen. */
export function readReactionSeen(
  revision: string | null | undefined,
): ReadonlyMap<string, number> {
  return new Map(
    entries(revision).map((entry) => [entry.messageId, entry.seenThrough]),
  );
}

/** Records reactions to `messageId` as seen through `seenThrough`, or, without
 * it, forgets them so the row is unread. Keeps the 1,000 latest writes. */
export function updateReactionSeen(
  scope: string,
  messageId: string,
  seenThrough?: number,
) {
  const revision = viewRevision(scope, reactionSeenKey);
  const next = [
    ...entries(revision).filter((entry) => entry.messageId !== messageId),
    ...(seenThrough === undefined ? [] : [{ messageId, seenThrough }]),
  ].slice(-maxEntries);
  const result = replaceView(scope, reactionSeenKey, revision, next);
  if (result !== "saved")
    throw new Error(
      result === "changed"
        ? "Inbox reactions changed in another window. Try again."
        : "Could not save Inbox reactions on this device. Try again.",
    );
}
