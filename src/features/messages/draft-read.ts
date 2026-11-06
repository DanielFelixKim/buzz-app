// Read snapshots from the composer owner, never a parallel draft store.
import { draftCoordinates, viewRevision } from "../../shared/view-state";
import { composerMarkdown } from "./composer-markdown";
import { acceptedComposerSend } from "./composer-accepted";
import {
  hasDraftContent,
  mentionDraft,
  type MentionDraft,
} from "./mention-draft";

export type OwnerDraft = Readonly<{
  text: string;
  markdown: string;
  /** Recipient offsets refer to displayed text, not serialized Markdown. */
  recipients: MentionDraft["recipients"];
  source: "composer" | "saved";
}>;
type Reader = () => MentionDraft | undefined;
const composers = new Map<string, Set<Reader>>();
const coordinate = (scope: string, key: string) => JSON.stringify([scope, key]);
const submitted = new WeakMap<MentionDraft, Set<string>>();
const snapshot = (
  draft: MentionDraft,
  source: OwnerDraft["source"],
): OwnerDraft => ({
  text: draft.text,
  markdown: composerMarkdown(draft),
  recipients: draft.recipients.map(({ pubkey, name, start, end }) => ({
    pubkey,
    name,
    start,
    end,
  })),
  source,
});

/** Capture before awaiting admission, so identical edits made later survive. */
export function captureSubmittedDrafts(
  scope: string,
  key: string,
  draft: MentionDraft,
) {
  const id = coordinate(scope, key);
  const content = JSON.stringify(snapshot(draft, "composer"));
  const captured: MentionDraft[] = [];
  for (const read of composers.get(id) ?? []) {
    try {
      const current = read();
      if (current && JSON.stringify(snapshot(current, "composer")) === content)
        captured.push(current);
    } catch {
      // A detached or conflicted reader cannot supply a live snapshot.
    }
  }
  return () => {
    for (const current of captured) {
      const coordinates = submitted.get(current) ?? new Set<string>();
      coordinates.add(id);
      submitted.set(current, coordinates);
    }
  };
}

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
  session?: object,
): OwnerDraft | undefined {
  const key = `draft:${channel}${thread === undefined ? "" : `:thread:${thread}`}`;
  const target = draftCoordinates(key);
  if (!target || target.channelId !== channel || target.threadRootId !== thread)
    throw new Error("Invalid draft channel or thread.");
  const accepted = session && acceptedComposerSend(session, `${scope}:${key}`);
  const id = coordinate(scope, key);
  let live: OwnerDraft | undefined;
  let empty = false;
  for (const read of composers.get(coordinate(scope, key)) ?? []) {
    const draft = read();
    if (!draft || submitted.get(draft)?.has(id)) continue;
    const next = snapshot(draft, "composer");
    if (live && JSON.stringify(live) !== JSON.stringify(next))
      throw new Error(
        "Multiple open composers have different drafts. Choose which draft to keep in Buzz first.",
      );
    live = next;
    empty = !hasDraftContent(draft);
  }
  if (live) return empty ? undefined : live;
  const raw = viewRevision(scope, key);
  if (raw === undefined) throw new Error("Draft storage is unavailable.");
  if (raw === null || (accepted && raw === accepted.revision)) return undefined;
  if (accepted && accepted.revision === undefined)
    throw new Error(
      "Accepted-message cleanup could not verify this draft. Open its composer before reading it.",
    );
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
  const draft = mentionDraft(value);
  return hasDraftContent(draft) ? snapshot(draft, "saved") : undefined;
}
