import type { ComponentProps } from "react";
import type { RelaySession } from "../../features/relay/session";
import { useAgentChoices } from "../../features/agents/use-choices";
import { useSavedAgentState } from "../../features/solo/default-agent";
import { agentAvatars } from "../../features/agents/avatar-packs";
import { useAvatarPreview } from "../../features/profiles/use-avatar-preview";
import { Avatar } from "../../shared/design-system/ui/Avatar";

/** Exact agent artwork, not the generic Bestie destination mark. */
export function CatchUpAvatar({
  session,
  pubkey,
  size = "compact",
  shape = "squircle",
}: {
  session: RelaySession;
  pubkey?: string | undefined;
  size?: ComponentProps<typeof Avatar>["size"];
  shape?: ComponentProps<typeof Avatar>["shape"];
}) {
  const saved = useSavedAgentState(session, session.scope);
  const choices = useAgentChoices(session, false);
  const agent = choices.identities.find(
    (item) => item.pubkey === (pubkey ?? saved.agent),
  );
  const name = agent?.managedName ?? agent?.name ?? "Bestie";
  const pack = agentAvatars.find((item) => item.url === agent?.avatar);
  const preview = useAvatarPreview(
    pack ? "" : (agent?.avatar ?? ""),
    undefined,
    "small",
    session.media,
  );
  const src = pack?.preview ?? preview;
  return <Avatar src={src} alt="" fallback={name} size={size} shape={shape} />;
}
