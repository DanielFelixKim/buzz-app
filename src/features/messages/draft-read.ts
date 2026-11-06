// Read snapshots from the composer owner, never a parallel draft store.
import { draftCoordinates, viewRevision } from "../../shared/view-state";
import { mentionDraft, type MentionDraft } from "./mention-draft";

export type OwnerDraft = Readonly<{
  text: string;
  recipients: MentionDraft["recipients"];
  source: "composer" | "saved";
}>;
type Reader = () => MentionDraft | undefined;
const composers = new Map<string, Set<Reader>>();
const coordinate = (scope: string, key: string) => JSON.stringify([scope, key]);

/** The mounted editor owns unsaved changes, including storage conflicts. */
export function registerComposerDraft(
  scope: string,
  key: string,
  read: Reader,
) {
  const id = coordinate(scope, key);
  const readers = composers.get(id) ?? new Set<Reader>();
  composers.set(id, readers);
  readers.add(read);
  return () => {
    readers.delete(read);
    if (!readers.size) composers.delete(id);
  };
}

/** Only an authenticated owner capability may supply the storage scope. */
export function readOwnerDraft(
  scope: string,
  channel: string,
  thread?: string,
): OwnerDraft | undefined {
  const key = `draft:${channel}${thread === undefined ? "" : `:thread:${thread}`}`;
  const target = draftCoordinates(key);
  if (!target || target.channelId !== channel || target.threadRootId !== thread)
    throw new Error("Invalid draft channel or thread.");
  const snapshot = (
    draft: MentionDraft,
    source: OwnerDraft["source"],
  ): OwnerDraft => ({
    text: draft.text,
    recipients: draft.recipients.map(({ pubkey, name, start, end }) => ({
      pubkey,
      name,
      start,
      end,
    })),
    source,
  });
  let live: OwnerDraft | undefined;
  for (const read of composers.get(coordinate(scope, key)) ?? []) {
    const draft = read();
    if (!draft) continue; // Sent-message edits are not unsent drafts.
    const next = snapshot(draft, "composer");
    if (live && JSON.stringify(live) !== JSON.stringify(next))
      throw new Error(
        "Multiple open composers have different drafts. Choose which draft to keep in Buzz first.",
      );
    live = next;
  }
  if (live) return live;
  const raw = viewRevision(scope, key);
  if (raw === undefined) throw new Error("Draft storage is unavailable.");
  if (raw === null) return undefined;
  if (raw.length > 8 * 1024 * 1024)
    throw new Error("The saved draft is too large to read.");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("The saved draft cannot be read.");
  }
  if (
    typeof value !== "string" &&
    (!value || typeof value !== "object" || Array.isArray(value))
  )
    throw new Error("The saved draft cannot be read.");
  return snapshot(mentionDraft(value), "saved");
}
