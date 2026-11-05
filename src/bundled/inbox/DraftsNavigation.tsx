import { useId } from "react";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import type { Navigation } from "../../features/navigation/controller";
import { useRelayConnection } from "../../features/relay/react";
import { useDraftCount } from "../../features/messages/draft-presence";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { PencilSimpleIcon } from "../../shared/design-system/icons";
import { inboxRouteTarget } from "./route";

/** A second entry to Inbox, not a second page or draft editor. */
export function DraftsNavigation({
  relay,
  navigation,
  selected,
}: {
  relay: RelayData;
  navigation: Navigation;
  selected: boolean;
}) {
  const connection = useRelayConnection(relay);
  const countId = useId();
  return (
    <NavigationItem
      label="Drafts"
      aria-label="Drafts"
      aria-describedby={connection.status === "ready" ? countId : undefined}
      selected={selected}
      icon={
        <span className="shell-page-icon">
          <PencilSimpleIcon size={16} strokeWidth={2.5} />
        </span>
      }
      trailing={
        connection.status === "ready" ? (
          <DraftCount session={connection.session} id={countId} />
        ) : undefined
      }
      onClick={() => {
        void navigation.open(inboxRouteTarget({ drafts: true }));
        document.getElementById("main-content")?.focus({ preventScroll: true });
      }}
    />
  );
}

function DraftCount({ session, id }: { session: RelaySession; id: string }) {
  const count = useDraftCount(session);
  return (
    <>
      {count > 0 && (
        <span
          aria-hidden="true"
          data-draft-count=""
          className="text-caption text-subtle"
        >
          {count}
        </span>
      )}
      <span id={id} className="sr-only">
        {count ? `${count} ${count === 1 ? "draft" : "drafts"}` : ""}
      </span>
    </>
  );
}
