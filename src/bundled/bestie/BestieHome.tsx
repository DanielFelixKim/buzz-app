import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import {
  useRelayConnection,
  useChannelList,
  useChannelWindow,
} from "../../features/relay/react";
import { useSavedAgentState } from "../../features/solo/default-agent";
import { useAgentChoices } from "../../features/agents/use-choices";
import { splitPartition } from "../../features/relay/partition";
import { messagePreviewText } from "../../features/conversation/message-preview-text";
import {
  ConversationChannel,
  ConversationComposer,
} from "../../features/conversation/Conversation";
import { SoloColumn } from "../../features/solo/SoloPresentation";
import { ChannelBody } from "../channels/ChannelBody";
import { ordinaryUnread, useUnreadState } from "../channels/UnreadBadge";
import { Button } from "../../shared/design-system/ui/Button";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { SurfaceButton } from "../../shared/design-system/ui/SurfaceButton";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { NavigationSection } from "../../shared/design-system/ui/NavigationSection";
import {
  PopoverRoot,
  PopoverTrigger,
  PopoverPopup,
  PopoverTitle,
  PopoverClose,
} from "../../shared/design-system/ui/Popover";
import {
  ArrowLeftIcon,
  ArrowUpRightIcon,
  ChatCircleIcon,
  XIcon,
} from "../../shared/design-system/icons";
import { useBestieAsks, type BestieAsk } from "./BestieAsks";
import { useBestieTake } from "./BestieExperiment";
import { CatchUpAvatar } from "./CatchUpAvatar";
import { bestieChat } from "./chat";
import styles from "./BestieHome.module.css";
import soloStyles from "./PinnedBestie.module.css";

type Props = {
  relay: RelayData;
  onOpenConversation(channelId: string): void;
  onSetup(): void;
};
export function BestieHome({
  place,
  ...props
}: Props & { place: "top-nav" | "floating" }) {
  const take = useBestieTake();
  if (take !== place) return null;
  return (
    <div className={place === "floating" ? styles.floating : undefined}>
      <Home {...props} floating={place === "floating"} />
    </div>
  );
}
function Home({
  relay,
  onOpenConversation,
  onSetup,
  floating,
}: Props & { floating: boolean }) {
  const workspace = useBestieAsks();
  const { session, status, scope } = useRelayConnection(relay);
  const saved = useSavedAgentState(session, session.scope);
  const choices = useAgentChoices(session, true, true);
  const agent = choices.selectable.find((item) => item.pubkey === saved.agent);
  const name = agent?.managedName ?? agent?.name ?? "Bestie";
  const list = useChannelList(session.channels);
  const dm = bestieChat(list.channels, session.viewer, saved.agent);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string>();
  const trigger = useRef<HTMLButtonElement>(null);
  const life = useRef<AbortController | undefined>(undefined);
  // biome-ignore lint/correctness/useExhaustiveDependencies: A replaced session/account cancels its in-flight DM opening.
  useEffect(() => {
    setOpening(false);
    setError(undefined);
    return () => life.current?.abort();
  }, [session, scope]);
  const selected = workspace?.asks.find((ask) => ask.id === workspace.selected);
  const openChat = async () => {
    if ((!agent && !dm) || opening) return;
    setOpening(true);
    setError(undefined);
    life.current?.abort();
    const controller = new AbortController();
    life.current = controller;
    try {
      const id =
        dm?.id ??
        (await session.directMessages.open(
          agent ? [agent.pubkey] : [],
          controller.signal,
        ));
      const current = relay.snapshot();
      if (
        controller.signal.aborted ||
        current.session !== session ||
        current.scope !== scope ||
        current.status !== "ready"
      )
        return;
      workspace?.close();
      onOpenConversation(id);
    } catch (reason) {
      if (!controller.signal.aborted)
        setError(
          reason instanceof Error
            ? reason.message
            : "Couldn’t open your Bestie DM.",
        );
    } finally {
      if (!controller.signal.aborted) setOpening(false);
    }
  };
  const unread = useSyncExternalStore(
    session.unread.subscribeInbox,
    () =>
      workspace?.asks.some((ask) =>
        ordinaryUnread(
          session.unread.snapshot({
            kind: "channel",
            channelId: ask.channelId,
          }),
          true,
        ),
      ) ||
      (!!dm &&
        ordinaryUnread(
          session.unread.snapshot({ kind: "channel", channelId: dm.id }),
          true,
        )) ||
      false,
  );
  if (!workspace) return null;
  const label = `Open ${name} — Bestie${unread ? " — unread replies" : ""}`;
  const handoff = (id: string) => {
    workspace.close();
    onOpenConversation(id);
  };
  return (
    <PopoverRoot
      open={workspace.open}
      onOpenChange={(open) => (open ? workspace.show() : workspace.close())}
    >
      <PopoverTrigger
        render={
          floating ? (
            <SurfaceButton
              ref={trigger}
              aria-label={label}
              title={label}
              data-bestie-home-trigger=""
              className={styles.floatingTrigger}
            >
              {/* User-requested prototype exception: circular, prominent artwork. */}
              <CatchUpAvatar session={session} size="fill" shape="circle" />
              {unread && <span className={styles.unread} />}
            </SurfaceButton>
          ) : (
            <IconButton
              ref={trigger}
              aria-label={label}
              title={label}
              data-bestie-home-trigger=""
              variant="inverted"
              size="md"
              shape="round"
              icon={
                <span className="relative inline-flex">
                  <CatchUpAvatar
                    session={session}
                    size="small"
                    shape="circle"
                  />
                  {unread && <span className={styles.unread} />}
                </span>
              }
            />
          )
        }
      />
      <PopoverPopup
        side={floating ? "top" : "bottom"}
        align="end"
        size={selected ? "expanded" : "wide"}
        padding="none"
        finalFocus={trigger}
        aria-label={selected ? "Bestie ask" : "Bestie home"}
      >
        {selected ? (
          <AskConversation
            key={selected.id}
            ask={selected}
            session={session}
            connected={
              status === "ready" && scope === selected.source.session.scope
            }
            back={() => workspace.show()}
            retry={() => workspace.retry(selected.id)}
            openConversation={handoff}
            close={workspace.close}
          />
        ) : (
          <div className={styles.home}>
            <div className={styles.heading}>
              <div className="flex min-w-0 items-center gap-2">
                <CatchUpAvatar session={session} />
                <PopoverTitle>{name}</PopoverTitle>
              </div>
              <PopoverClose
                render={
                  <IconButton
                    aria-label="Close Bestie"
                    size="toolbar"
                    icon={<XIcon />}
                  />
                }
              />
            </div>
            <div className={styles.homeBody}>
              <div className={styles.list}>
                <NavigationItem
                  multiline
                  label={
                    <span className={styles.rowCopy}>
                      <span className="text-label">Chat with {name}</span>
                      <span className="text-body-sm text-secondary">
                        Your everyday conversation
                      </span>
                    </span>
                  }
                  icon={<ChatCircleIcon />}
                  trailing={<ArrowUpRightIcon />}
                  disabled={
                    status !== "ready" ||
                    opening ||
                    !saved.read ||
                    choices.pending
                  }
                  onClick={() => {
                    if (!agent && !dm) {
                      workspace.close();
                      onSetup();
                    } else void openChat();
                  }}
                />
              </div>
              {opening && (
                <p role="status" className="text-body-sm text-secondary">
                  Opening your conversation…
                </p>
              )}
              {(error || saved.error) && (
                <p role="alert" className="text-body-sm text-danger">
                  {error ?? saved.error}
                </p>
              )}
              <NavigationSection label="Recent asks">
                <p className="m-0 px-2 pb-2 text-caption text-secondary">
                  From this app session. Chats also appear in Solo chats.
                </p>
                <div className={styles.list}>
                  {workspace.asks.map((ask) => (
                    <AskRow
                      key={ask.id}
                      ask={ask}
                      session={session}
                      onOpen={() => workspace.show(ask.id)}
                    />
                  ))}
                </div>
                {!workspace.asks.length && (
                  <p className="m-0 px-2 py-4 text-body-sm text-secondary">
                    Ask about a message from its actions menu. Your asks will
                    stay here while you browse.
                  </p>
                )}
              </NavigationSection>
            </div>
          </div>
        )}
      </PopoverPopup>
    </PopoverRoot>
  );
}
function AskRow({
  ask,
  session,
  onOpen,
}: {
  ask: BestieAsk;
  session: RelaySession;
  onOpen(): void;
}) {
  const unread = useUnreadState(session, ask.channelId, true);
  // A retained head uses the existing live route. Reading never marks it read.
  const window = useChannelWindow(session.channels, ask.channelId);
  const outgoing = window.rows.find((row) => row.id === ask.messageId);
  const answer = [...window.rows]
    .reverse()
    .find((row) => row.authorId === ask.agent.pubkey);
  const failed =
    outgoing?.delivery === "failed" || outgoing?.delivery === "unknown";
  const status = ask.error
    ? "Couldn’t start — open to retry"
    : failed
      ? "Check delivery"
      : answer
        ? unread.ordinary
          ? "Unread reply"
          : "Reply received"
        : ask.busy
          ? "Starting…"
          : outgoing?.delivery === "accepted" || outgoing?.delivery === "seen"
            ? "Sent"
            : "Queued";
  const channel = session.channels.get?.(ask.source.message.channelId);
  return (
    <NavigationItem
      multiline
      aria-label={`${ask.question} — ${status}`}
      onClick={onOpen}
      icon={<CatchUpAvatar session={session} pubkey={ask.agent.pubkey} />}
      label={
        <span className={styles.rowCopy}>
          <span className={`text-label-sm ${styles.question}`}>
            {ask.question}
          </span>
          <span className={`text-body-sm text-secondary ${styles.excerpt}`}>
            {channel?.name ?? "Original conversation"} ·{" "}
            {messagePreviewText(ask.source.message.content)}
          </span>
          <span className="text-caption text-secondary">{status}</span>
        </span>
      }
      trailing={<ArrowUpRightIcon />}
    />
  );
}
function AskConversation({
  ask,
  session,
  connected,
  back,
  retry,
  close,
  openConversation,
}: {
  ask: BestieAsk;
  session: RelaySession;
  connected: boolean;
  back(): void;
  retry(): void;
  close(): void;
  openConversation(id: string): void;
}) {
  const roster = useChannelList(session.channels);
  const channel = roster.channels.find((item) => item.id === ask.channelId);
  const sourceName = roster.channels.find(
    (item) => item.id === ask.source.message.channelId,
  )?.name;
  const [sent, setSent] = useState<string>();
  const scope = splitPartition(ask.source.session.scope);
  const host = useMemo(
    () => ({
      // Plugin hosts resolve services through Cordis; spreading a context drops them.
      panels: ask.source.host.panels,
      relay: ask.source.host.relay,
      navigation: {
        ...ask.source.host.navigation,
        open: (...args: Parameters<typeof ask.source.host.navigation.open>) => {
          close();
          return ask.source.host.navigation.open(...args);
        },
      },
    }),
    [ask.source.host, close],
  );
  const source = () => {
    if (!scope || !connected) return;
    close();
    void ask.source.host.navigation.open({
      version: 1,
      kind: "conversation",
      scope,
      channelId: ask.source.message.channelId,
      messageId: ask.source.message.id,
      ...(ask.source.message.threadRootId || ask.source.message.replyCount > 0
        ? {
            threadRootId:
              ask.source.message.threadRootId ?? ask.source.message.id,
          }
        : {}),
    });
  };
  const content: ReactNode = !connected ? (
    <p role="status" className="p-4 text-body-sm text-secondary">
      Reconnect to continue this ask.
    </p>
  ) : ask.error ? (
    <div className="flex flex-col gap-3 p-4">
      <p role="alert" className="m-0 text-body-sm text-danger">
        {ask.error}
      </p>
      <Button size="sm" onClick={retry}>
        Try again
      </Button>
    </div>
  ) : !channel || !ask.messageId ? (
    <p role="status" className="p-4 text-body-sm text-secondary">
      Preparing your conversation…
    </p>
  ) : (
    <ConversationChannel
      session={session}
      scope={ask.source.session.scope}
      channel={channel}
      extensions={ask.source.extensions}
      host={host}
    >
      <div className={`${soloStyles.work} flex min-h-0 flex-1 flex-col`}>
        <SoloColumn>
          <ChannelBody
            cached={!!channel.cached}
            viewer={session.viewer}
            revealMessageId={sent}
          />
          <ConversationComposer
            autoFocus={false}
            defaultMention={ask.agent}
            label={`Message ${ask.agent.name}`}
            onSend={setSent}
          />
        </SoloColumn>
      </div>
    </ConversationChannel>
  );
  return (
    <div className={styles.conversation}>
      <div className={styles.heading}>
        <IconButton
          aria-label="Back to Bestie"
          size="toolbar"
          onClick={back}
          icon={<ArrowLeftIcon />}
        />
        <PopoverTitle>{ask.agent.name}</PopoverTitle>
        <div className="flex items-center gap-1">
          <IconButton
            aria-label="Open conversation"
            title="Open conversation"
            size="toolbar"
            disabled={!connected || !ask.messageId}
            onClick={() => openConversation(ask.channelId)}
            icon={<ArrowUpRightIcon />}
          />
          <PopoverClose
            render={
              <IconButton
                aria-label="Close Bestie"
                size="toolbar"
                icon={<XIcon />}
              />
            }
          />
        </div>
      </div>
      <div className={styles.source}>
        <Button
          variant="link"
          size="inline"
          disabled={!connected}
          onClick={source}
        >
          View source in {sourceName ?? "original conversation"}
        </Button>
        <p className={`text-body-sm ${styles.excerpt}`}>
          {messagePreviewText(ask.source.message.content)}
        </p>
      </div>
      {content}
    </div>
  );
}
