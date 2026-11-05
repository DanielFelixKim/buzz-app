import { useEffect, type ComponentProps } from "react";
import { useBestieTake } from "./BestieExperiment";
import { AskBestiePopover } from "./AskBestiePopover";
import type { ConversationHostServices } from "../../features/conversation/ConversationHost";
import type { ConversationExtensions } from "../../features/conversation/contracts";
import type { MessageAction } from "../../features/conversation/contracts";
import { useAgentChoices } from "../../features/agents/use-choices";
import { useSavedAgentState } from "../../features/solo/default-agent";
import {
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuSeparator,
} from "../../shared/design-system/ui/Menu";
import { AgentPortrait } from "../agents/AgentCard";
import { splitPartition } from "../../features/relay/partition";
import { useCatchUp } from "./catch-up-context";
import { useAfterMessageMenuClose } from "../../features/messages/MessageActionBar";

export function AskBestieMenu({
  session,
  open,
}: ComponentProps<NonNullable<MessageAction["menu"]>>) {
  const take = useBestieTake();
  const saved = useSavedAgentState(session, session.scope);
  const choices = useAgentChoices(session, true, true);
  const bestie = choices.selectable.find(
    (agent) => agent.pubkey === saved.agent,
  );
  const name = bestie?.managedName ?? bestie?.name ?? "your Bestie";
  const afterMenuClose = useAfterMessageMenuClose();
  return (
    <>
      <MenuSeparator />
      <MenuGroup>
        <MenuGroupLabel>
          <span className="flex items-center gap-2">
            <span className="h-5 w-5 overflow-hidden rounded-full">
              <AgentPortrait
                agent={{ name, picture: bestie?.avatar }}
                community={splitPartition(session.scope)?.communityOrigin}
              />
            </span>
            {name}
          </span>
        </MenuGroupLabel>
        <MenuItem
          onClick={() => (afterMenuClose ? afterMenuClose(open) : open())}
        >
          {take === "current" ? "Catch me up" : "Ask Bestie…"}
        </MenuItem>
      </MenuGroup>
    </>
  );
}

/** Hand intent to the shell before the source row or channel can unmount. */
export function AskBestie(
  props: ComponentProps<MessageAction["component"]> & {
    host: ConversationHostServices;
    extensions: ConversationExtensions;
  },
) {
  const take = useBestieTake();
  return take === "current" ? (
    <CurrentAsk {...props} />
  ) : (
    <AskBestiePopover
      source={{
        message: props.message,
        session: props.session,
        host: props.host,
        extensions: props.extensions,
      }}
      anchor={props.anchor}
      close={props.close}
    />
  );
}
function CurrentAsk({
  message,
  session,
  close,
  host,
  extensions,
}: ComponentProps<typeof AskBestie>) {
  const catchUp = useCatchUp();
  useEffect(() => {
    catchUp?.open({ message, session, host, extensions });
    close();
  }, [catchUp?.open, message, session, host, extensions, close]);
  return null;
}
