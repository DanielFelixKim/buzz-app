import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ChatNotStarted } from "../../features/relay/channel-writes";
import type { RelayData } from "../../features/relay/service";
import {
  useChannelWindow,
  useRelayConnection,
} from "../../features/relay/react";
import { messageCopyLink } from "../../features/messages/message-copy";
import { useToastNotification } from "../../shared/design-system/ui/Toast";
import type { CatchUpSource } from "./catch-up-context";

export type BestieAsk = {
  id: string;
  source: CatchUpSource;
  question: string;
  agent: { pubkey: string; name: string };
  channelId: string;
  create?: string | undefined;
  messageId?: string;
  error?: string | undefined;
  busy: boolean;
};
type Asks = {
  asks: readonly BestieAsk[];
  submit(
    source: CatchUpSource,
    question: string,
    agent: BestieAsk["agent"],
  ): string;
  retry(id: string): void;
  selected: string | undefined;
  show(id?: string): void;
  open: boolean;
  close(): void;
};
const Context = createContext<Asks | undefined>(undefined);
export const useBestieAsks = () => useContext(Context);

/** Session-only index; channels, drafts, delivery and reads stay session-owned.
 * Submission lives here, not in a portaled or virtualized presentation. */
export function BestieAsksProvider({
  relay,
  enabled,
  children,
}: {
  relay: RelayData;
  enabled: boolean;
  children: ReactNode;
}) {
  const connection = useRelayConnection(relay);
  const [asks, setAsks] = useState<readonly BestieAsk[]>([]);
  const requests = useRef<readonly BestieAsk[]>([]);
  const [open, setOpen] = useState(false);
  const [selected, select] = useState<string>();
  const mounted = useRef(false);
  const scope = useRef(connection.scope);
  const latest = useRef({ connection, enabled });
  const notify = useToastNotification();
  useLayoutEffect(() => {
    latest.current = { connection, enabled };
    if (
      !enabled ||
      (connection.scope && scope.current !== connection.scope) ||
      (connection.viewer &&
        requests.current.some(
          (ask) => ask.source.session.viewer !== connection.viewer,
        ))
    ) {
      requests.current = [];
      setAsks([]);
      setOpen(false);
      select(undefined);
    }
    if (!connection.scope) {
      setOpen(false);
      select(undefined);
    }
    if (connection.scope) scope.current = connection.scope;
  }, [connection, enabled]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const patch = (id: string, change: Partial<BestieAsk>) => {
    if (!mounted.current) return;
    requests.current = requests.current.map((ask) =>
      ask.id === id ? { ...ask, ...change } : ask,
    );
    setAsks(requests.current);
  };
  const run = async (id: string) => {
    const ask = requests.current.find((item) => item.id === id);
    if (!ask || ask.busy || ask.messageId) return;
    const { connection, enabled } = latest.current;
    const session = connection.session;
    const active = () => {
      const current = relay.snapshot();
      return (
        mounted.current &&
        latest.current.enabled &&
        requests.current.some((item) => item.id === id) &&
        current.status === "ready" &&
        current.session === session &&
        current.scope === ask.source.session.scope
      );
    };
    patch(id, { busy: true, error: undefined });
    try {
      if (!enabled || !active())
        throw new Error("Reconnect to this community and try again.");
      if (
        !session.agentChoices
          .snapshot()
          .selectable.some((choice) => choice.pubkey === ask.agent.pubkey)
      )
        throw new Error(
          "This Bestie is no longer available in this community.",
        );
      const link = messageCopyLink(
        ask.source.message,
        ask.source.session.scope,
      );
      if (!link) throw new Error("This message has no link to send.");
      let create = ask.create;
      if (!create) {
        const start = session.channelWrites.start(
          ask.channelId,
          ask.question.slice(0, 80),
          [ask.agent.pubkey],
          undefined,
          false,
          undefined,
          { active },
        );
        create = start.create;
        patch(id, { create });
        await start.ready;
      } else await session.channelWrites.delivered(create, active);
      if (!active())
        throw new Error("The connection changed. Reconnect and try again.");
      // The existing outbox owns all send retries. Never create a second message
      // because this surface closed, switched variant, or lost a receipt.
      const messageId = session.messages.send(
        ask.channelId,
        `${ask.question}\n\nSource: ${link}`,
        [ask.agent.pubkey],
        [],
      );
      patch(id, { messageId, busy: false });
      notify(`Ask queued for ${ask.agent.name}`, "info", {
        label: "View ask",
        onClick: () => {
          if (requests.current.some((item) => item.id === id)) {
            select(id);
            setOpen(true);
          }
        },
      });
    } catch (reason) {
      patch(id, {
        busy: false,
        error:
          reason instanceof Error
            ? reason.message
            : "Bestie couldn’t start this ask.",
        ...(reason instanceof ChatNotStarted
          ? { create: undefined, channelId: crypto.randomUUID() }
          : {}),
      });
    }
  };
  const visible =
    enabled && connection.scope
      ? asks.filter((ask) => ask.source.session.scope === connection.scope)
      : [];
  return (
    <Context
      value={{
        asks: visible,
        selected,
        open: enabled && !!connection.scope && open,
        show: (id) => {
          if (!connection.scope) return;
          select(id);
          setOpen(true);
        },
        close: () => setOpen(false),
        submit: (source, question, agent) => {
          const current = relay.snapshot();
          if (
            !mounted.current ||
            !latest.current.enabled ||
            current.status !== "ready" ||
            current.session !== source.session
          )
            throw new Error(
              "The connection changed. Reopen this message and try again.",
            );
          const text = question.trim();
          if (!text || text.length > 4000)
            throw new Error("Write a question of up to 4,000 characters.");
          if (requests.current.length >= 20)
            throw new Error(
              "This prototype keeps 20 asks per app session. Your chats remain in Solo chats.",
            );
          const id = crypto.randomUUID();
          requests.current = [
            {
              id,
              source,
              question: text,
              agent,
              channelId: crypto.randomUUID(),
              busy: false,
            },
            ...requests.current,
          ];
          setAsks(requests.current);
          void run(id);
          return id;
        },
        retry: (id) => {
          void run(id);
        },
      }}
    >
      {visible
        .filter((ask) => ask.messageId)
        .map((ask) => (
          <AskHead
            key={ask.id}
            session={connection.session}
            channelId={ask.channelId}
          />
        ))}
      {children}
    </Context>
  );
}

function AskHead({
  session,
  channelId,
}: {
  session: CatchUpSource["session"];
  channelId: string;
}) {
  useChannelWindow(session.channels, channelId);
  return null;
}
