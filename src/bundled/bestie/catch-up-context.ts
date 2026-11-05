import { createContext, useContext } from "react";
import type { ChannelMessage } from "../../features/relay/contracts";
import type { RelaySession } from "../../features/relay/session";
import type { ConversationHostServices } from "../../features/conversation/ConversationHost";
import type { ConversationExtensions } from "../../features/conversation/contracts";

export type CatchUpSource = {
  session: RelaySession;
  message: ChannelMessage;
  host: ConversationHostServices;
  extensions: ConversationExtensions;
};
export type CatchUpOpening = CatchUpSource & { id: string };
export const CatchUpContext = createContext<
  | {
      source: CatchUpOpening | undefined;
      visible: boolean;
      open(source: CatchUpSource): void;
      hide(restoreFocus?: boolean): void;
    }
  | undefined
>(undefined);

/** Presentation intent only. Membership, delivery and data stay session-owned. */
export const useCatchUp = () => useContext(CatchUpContext);
