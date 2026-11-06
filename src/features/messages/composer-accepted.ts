import type { MentionDraft } from "./mention-draft";
import type { ComposerSession } from "./composer-session";

export type AcceptedDraft = {
  next: MentionDraft;
  revision: string | null | undefined;
  /** Companion-captured revision, used only to verify a later cleanup event. */
  cleanupRevision?: string;
};
// Failed post-acceptance cleanup survives composer remounts within this session.
// This is recovery evidence only, not another persistent draft inventory.
const acceptedDrafts = new WeakMap<
  ComposerSession,
  Map<string, AcceptedDraft>
>();

export function recoveryFor(session: ComposerSession) {
  let recovery = acceptedDrafts.get(session);
  if (!recovery) {
    recovery = new Map();
    acceptedDrafts.set(session, recovery);
  }
  return recovery;
}

/** Read recovery evidence without creating or changing it. */
export function acceptedComposerSend(session: object, key: string) {
  return acceptedDrafts.get(session as ComposerSession)?.get(key);
}
