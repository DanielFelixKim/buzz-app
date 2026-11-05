import { useSyncExternalStore } from "react";
import type { RelaySession } from "../../features/relay/session";

// Inbox owns this view; its sidebar shortcuts observe the same state. Like
// Inbox's retained selection, it lasts for the session without new storage.
const views = new WeakMap<RelaySession, ReturnType<typeof createView>>();
function createView() {
  let drafts = false;
  const listeners = new Set<() => void>();
  return {
    snapshot: () => drafts,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set(value: boolean) {
      if (value === drafts) return;
      drafts = value;
      for (const listener of listeners) listener();
    },
  };
}
export function useInboxDrafts(session: RelaySession) {
  let view = views.get(session);
  if (!view) {
    view = createView();
    views.set(session, view);
  }
  return [
    useSyncExternalStore(view.subscribe, view.snapshot),
    view.set,
  ] as const;
}
