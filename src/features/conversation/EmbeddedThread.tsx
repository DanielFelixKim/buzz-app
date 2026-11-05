import {
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { MessageRow } from "../messages/MessageRow";
import { rowProfileIds } from "../relay/membership";
import { useProfileGeneration, useRowProfiles } from "../relay/react";
import type { ThreadView } from "../relay/threads";
import { useKnownAgentPubkeys } from "../agents/use-known";
import { Button } from "../../shared/design-system/ui/Button";
import { LoadingRegion } from "../../shared/design-system/ui/LoadingRegion";
import { useChannelReference } from "./channel-reference";
import { linkedMessage } from "./linked-message";
import type { ThreadPanelProps } from "../messages/ThreadPanel";
import { messageViewKey } from "../messages/view-key";
import {
  ConversationChannel,
  ConversationThread,
  useConversation,
} from "./Conversation";
import type {
  ConversationHostServices,
  ConversationInteractions,
} from "./ConversationHost";

/** The host owns conversation behavior; the page owns its task and placement. */
export type EmbeddedThreadProps = Pick<
  ThreadPanelProps,
  "session" | "scope" | "channelId" | "channelName" | "messageId"
> & {
  /** The host reads this message in its source channel. Replies stay in the task thread. */
  sourceMessage?: { channelId: string; messageId: string } | undefined;
};
/** One channel's host behavior for a page's own rows and composer, without a visit. */
export type EmbeddedConversationProps = Pick<
  ThreadPanelProps,
  "session" | "scope" | "channelId"
> & {
  channelName?: string | undefined;
  /** The thread a card shows; panels opened from it stay in that thread. */
  threadId?: string | undefined;
  children(interactions: ConversationInteractions): ReactNode;
};
type Hosted = {
  host: ConversationHostServices;
  extensions: NonNullable<ThreadPanelProps["extensions"]>;
};

/** Channel visits and recovery span threads; overlays belong to one thread. */
export function EmbeddedThread({
  messageId,
  sourceMessage,
  ...props
}: EmbeddedThreadProps & Hosted) {
  return (
    <HostedChannel {...props} threadId={messageId}>
      <ConversationThread
        messageId={messageId}
        contextRoot={
          sourceMessage && (
            <SourceMessage
              key={messageViewKey(
                props.session,
                props.scope,
                sourceMessage.channelId,
                sourceMessage.messageId,
              )}
              {...props}
              channelId={sourceMessage.channelId}
              messageId={sourceMessage.messageId}
            />
          )
        }
      />
    </HostedChannel>
  );
}

/** Rows and composer act as in Channels; nothing marks the channel read or follows it. */
export function EmbeddedConversation({
  children,
  ...props
}: EmbeddedConversationProps & Hosted) {
  return (
    <HostedChannel {...props} active={false}>
      <Interactions>{children}</Interactions>
    </HostedChannel>
  );
}

function Interactions({
  children,
}: Pick<EmbeddedConversationProps, "children">) {
  const { onOpenLink, canOpenLink, onOpenMediaReview } = useConversation();
  return children({ onOpenLink, canOpenLink, onOpenMediaReview });
}

function HostedChannel({
  session,
  scope,
  channelId,
  channelName,
  threadId,
  active,
  host,
  extensions,
  children,
}: Omit<EmbeddedConversationProps, "children"> &
  Hosted & { active?: false; children: ReactNode }) {
  const { channels } = useSyncExternalStore(
    session.channels.subscribeList,
    session.channels.list,
  );
  const channel = channels.find((item) => item.id === channelId);
  return (
    <ConversationChannel
      key={messageViewKey(session, scope, channelId)}
      session={session}
      scope={scope}
      extensions={extensions}
      host={host}
      threadId={threadId}
      active={active}
      channel={{
        id: channelId,
        name: channelName ?? channel?.name ?? "",
        channelType: channel?.channelType,
        creator: channel?.creator,
      }}
    >
      {children}
    </ConversationChannel>
  );
}

function SourceMessage({
  messageId,
  ...props
}: Omit<EmbeddedThreadProps, "sourceMessage"> & Hosted) {
  const { session, channelId } = props;
  const reference = useChannelReference(session.channels, channelId);
  const readable = reference.state === "found" && reference.readable !== false;
  const withheld = reference.state === "withheld";
  const [read, setRead] = useState<{ view?: ThreadView; readable: boolean }>();
  const [attempt, retry] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt retries reader allocation.
  useEffect(() => {
    if (withheld) {
      setRead(undefined);
      return;
    }
    try {
      const view = session.thread(channelId, messageId, { exact: true });
      setRead({ view, readable });
      void view.refresh();
      return () => view.dispose();
    } catch {
      setRead({ readable });
    }
  }, [session, channelId, messageId, readable, withheld, attempt]);
  if (withheld) return <p role="status">This message isn’t available.</p>;
  if (!read || read.readable !== readable)
    return (
      <LoadingRegion pending label="Loading message…">
        {null}
      </LoadingRegion>
    );
  if (!read.view)
    return <Button onClick={() => retry(attempt + 1)}>Try again</Button>;
  return (
    <HostedChannel
      {...props}
      channelName={undefined}
      threadId={messageId}
      active={false}
    >
      <SourceMessageContent view={read.view} messageId={messageId} />
    </HostedChannel>
  );
}

function SourceMessageContent({
  view,
  messageId,
}: {
  view: ThreadView;
  messageId: string;
}) {
  const {
    session,
    scope,
    extensions,
    onOpenLink,
    canOpenLink,
    onOpenMediaReview,
  } = useConversation();
  const snapshot = useSyncExternalStore(
    view.subscribe,
    view.snapshot,
    view.snapshot,
  );
  const { message, ready, stopped } = linkedMessage(snapshot, messageId);
  const rows = ready && message ? [message] : [];
  const authors = [...new Set(rows.flatMap(rowProfileIds))].sort().join(":");
  const generation = useProfileGeneration(session.profiles);
  useEffect(() => {
    void generation;
    if (authors)
      void session.profiles
        .ensure(authors.split(":"), "background")
        .catch(() => {});
  }, [session.profiles, authors, generation]);
  const profiles = useRowProfiles(session.profiles, rows);
  const agentPubkeys = useKnownAgentPubkeys(session, profiles);
  return (
    <LoadingRegion
      pending={!ready && !stopped}
      label="Loading message…"
      statusVisibility={ready ? "screen-reader" : "visible"}
      feedback={
        stopped && !ready ? (
          <>
            <p role="status">This message isn’t available.</p>
            <Button onClick={() => void view.refresh()}>Try again</Button>
          </>
        ) : undefined
      }
    >
      {ready && message && (
        <MessageRow
          session={session}
          scope={scope}
          viewer={session.viewer}
          extensions={extensions}
          row={message}
          getThreadRoot={() => view.snapshot().root}
          profile={profiles.get(message.authorId)}
          participantProfiles={profiles}
          agentPubkeys={agentPubkeys}
          media={session.media}
          onOpenLink={onOpenLink}
          canOpenLink={canOpenLink}
          onOpenMediaReview={onOpenMediaReview}
          day={false}
          layout="thread"
          mediaMode="thread"
          retry={session.messages.retry}
        />
      )}
    </LoadingRegion>
  );
}
