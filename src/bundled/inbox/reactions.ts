import type { ReactionNotice } from "../../features/relay/reaction-feed";

/** Every reaction to one of the viewer's messages, as one Inbox row. */
export type ReactionRow = Readonly<{
  /** `reaction:<messageId>`, distinct from conversation row ids. */
  id: string;
  channelId: string;
  messageId: string;
  rootId?: string | undefined;
  targetContent: string;
  /** The newest reaction's time. */
  createdAt: number;
  /** Every reaction at `createdAt`; seen state tells same-second arrivals apart. */
  newestIds: readonly string[];
  /** Distinct reactors, newest first. */
  reactorIds: readonly string[];
  /** Distinct reaction contents, in the order first reacted. */
  contents: readonly string[];
}>;

/** Groups newest-first notices into rows, newest row first. */
export function reactionRows(
  notices: readonly ReactionNotice[],
): ReactionRow[] {
  const groups = new Map<string, ReactionNotice[]>();
  for (const notice of notices) {
    const group = groups.get(notice.messageId);
    if (group) group.push(notice);
    else groups.set(notice.messageId, [notice]);
  }
  return [...groups.values()].flatMap((group) => {
    const newest = group[0];
    if (!newest) return [];
    return [
      {
        id: `reaction:${newest.messageId}`,
        channelId: newest.channelId,
        messageId: newest.messageId,
        rootId: newest.rootId,
        targetContent: newest.targetContent,
        createdAt: newest.createdAt,
        newestIds: group
          .filter((notice) => notice.createdAt === newest.createdAt)
          .map((notice) => notice.id),
        reactorIds: [...new Set(group.map((notice) => notice.reactorId))],
        contents: [
          ...new Set([...group].reverse().map((notice) => notice.content)),
        ],
      },
    ];
  });
}

/** "Alice reacted 👍", or "Alice and 2 others reacted 👍 🎉". */
export function reactionTitle(row: ReactionRow, newestReactor: string) {
  const others = row.reactorIds.length - 1;
  const who =
    others > 0
      ? `${newestReactor} and ${others} ${others === 1 ? "other" : "others"}`
      : newestReactor;
  return `${who} reacted ${row.contents.join(" ")}`;
}
