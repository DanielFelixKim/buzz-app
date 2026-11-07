/**
 * PROTOTYPE: Activity as the primary navigation. The sidebar lists
 * conversations, newest first, with their latest event as the preview, under
 * Solo / Team / DMs scopes. Team has a sub-view for Threads and Mentions.
 * Rows open in the Messages page, so a thread opens beside its channel with
 * its root revealed there: list | channel | thread.
 */
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { RelaySession } from "../../features/relay/session";
import type { ChannelSummary, Profile } from "../../features/relay/contracts";
import type { InboxItem } from "../../features/relay/inbox";
import type { ThreadActivityItem } from "../../features/relay/unread";
import type { Navigation } from "../../features/navigation/controller";
import type {
  NavigationScope,
  OpenTarget,
} from "../../features/navigation/targets";
import { useChannelList } from "../../features/relay/react";
import { useUnreadState } from "../../bundled/channels/UnreadBadge";
import { channelIcon, channelText } from "../../features/channels/channel-icon";
import { messagePreview } from "../../features/notifications/content";
import { MessageListRow } from "../../features/messages/MessageListRow";
import { relativeTimestamp } from "../../shared/relative-timestamp";
import { avatarMedia } from "../../shared/avatar-source";
import { formatPublicKey } from "../../shared/identity/public-key";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { Switch } from "../../shared/design-system/ui/Switch";
import { Tabs } from "../../shared/design-system/ui/Tabs";
import { readView, writeView } from "../../shared/view-state";
import styles from "./ActivitySidebar.module.css";

export type ActivityScope = "solo" | "team" | "dms";
type TeamView = "all" | "threads" | "mentions";
type View = { scope: ActivityScope; team: TeamView; unread: boolean };

const scopes = [
  { value: "solo", label: "Solo" },
  { value: "team", label: "Team" },
  { value: "dms", label: "DMs" },
] as const;
const teamViews = [
  { value: "all", label: "Channels" },
  { value: "threads", label: "Threads" },
  { value: "mentions", label: "Mentions" },
] as const;
const viewKey = "activity-sidebar:view";
/** Child thread rows shown under a channel before "+N more". */
const THREAD_ROWS = 3;

function readSavedView(scope: string): View {
  const saved = readView<Partial<View> | null>(scope, viewKey, null);
  return {
    scope:
      saved?.scope === "team" || saved?.scope === "dms" ? saved.scope : "solo",
    team:
      saved?.team === "threads" || saved?.team === "mentions"
        ? saved.team
        : "all",
    unread: saved?.unread === true,
  };
}

const scopeOf = (channel: ChannelSummary): ActivityScope | undefined =>
  channel.channelType === "solo"
    ? "solo"
    : channel.channelType === "dm"
      ? "dms"
      : channel.channelType === "stream" ||
          channel.channelType === "forum" ||
          channel.channelType === undefined
        ? "team"
        : undefined;

const listed = (channel: ChannelSummary) =>
  !channel.archived && !channel.huddle && !channel.metadataPending;

/** The scope a destination belongs to, so opening one shows its list. */
export function activityScopeOf(
  channels: readonly ChannelSummary[] | undefined,
  id: string,
): ActivityScope | undefined {
  const channel = channels?.find((entry) => entry.id === id);
  return channel ? scopeOf(channel) : undefined;
}

export function useActivityView(scope: string) {
  const [view, setView] = useState(() => readSavedView(scope));
  useEffect(() => {
    writeView(scope, viewKey, view);
  }, [scope, view]);
  return [view, setView] as const;
}

export function ActivityScopeTabs({
  view,
  onChange,
}: {
  view: View;
  onChange(view: View): void;
}) {
  return (
    <Tabs
      label="Activity scope"
      variant="segmented"
      size="sm"
      value={view.scope}
      items={scopes}
      onValueChange={(scope) => onChange({ ...view, scope })}
    />
  );
}

export function ActivitySidebar({
  session,
  navigator,
  scope,
  target,
  view,
  onViewChange,
}: {
  session: RelaySession;
  navigator: Navigation;
  /** Navigation scope of this community. */
  scope: NavigationScope;
  target: OpenTarget;
  view: View;
  onViewChange(view: View): void;
}) {
  const list = useChannelList(session.channels);
  const inbox = useSyncExternalStore(
    session.unread.subscribeInbox,
    session.unread.inbox,
    session.unread.inbox,
  );
  useEffect(() => {
    if (list.status !== "ready") return;
    void session.unread.ensure();
    void session.inboxFeed.ensure();
  }, [session, list.status]);
  const profiles = useSyncExternalStore(
    session.profiles.subscribe,
    session.profiles.snapshot,
    session.profiles.snapshot,
  );
  const selectedChannel =
    target.kind === "conversation" ? target.channelId : undefined;
  const selectedThread =
    target.kind === "conversation" ? target.threadRootId : undefined;

  const open = (
    channelId: string,
    options: { messageId?: string; threadRootId?: string } = {},
  ) =>
    void navigator.open({
      version: 1,
      kind: "conversation",
      scope,
      channelId,
      ...(options.messageId ? { messageId: options.messageId } : {}),
      // A thread opens beside its channel, its root revealed there.
      ...(options.threadRootId
        ? { threadRootId: options.threadRootId, context: "channel" as const }
        : {}),
    });

  const channels = list.channels.filter(
    (channel) => listed(channel) && scopeOf(channel) === view.scope,
  );
  const channelsById = new Map(list.channels.map((c) => [c.id, c]));
  // Recency includes thread replies and the latest evidence the unread
  // service has; inbox changes re-render this list.
  void inbox;
  const recency = (channel: ChannelSummary) => {
    const threads = session.unread.activity(channel.id).items ?? [];
    const latest = session.unread.snapshot({
      kind: "channel",
      channelId: channel.id,
    }).latestMessage?.createdAt;
    return Math.max(
      channel.lastActivityAt ?? 0,
      latest ?? 0,
      ...threads.map((item) => item.createdAt),
    );
  };
  const sorted = channels
    .map((channel) => ({ channel, at: recency(channel) }))
    .sort(
      (a, b) => b.at - a.at || a.channel.name.localeCompare(b.channel.name),
    );
  const order = useFrozenOrder(
    sorted.map((entry) => entry.channel.id).join("\n"),
  );
  const byId = new Map(sorted.map((entry) => [entry.channel.id, entry]));

  const teamItems =
    view.scope === "team" && view.team !== "all"
      ? inbox.items
          .map((item) => (view.team === "mentions" ? item.mention : item))
          .filter((item): item is InboxItem => {
            if (!item) return false;
            const channel = channelsById.get(item.channelId);
            if (!channel || scopeOf(channel) !== "team") return false;
            if (view.team === "threads" && !item.thread) return false;
            return !view.unread || item.unreadCount > 0 || item.manual;
          })
          .sort((a, b) => b.createdAt - a.createdAt)
      : [];

  const ids = [
    ...teamItems.slice(0, 50).map((item) => item.authorId),
    ...channels
      .filter((channel) => channel.channelType === "dm")
      .flatMap((channel) => channel.participants?.slice(0, 1) ?? []),
  ];
  const profileKey = [...new Set(ids)].sort().join(":");
  useEffect(() => {
    if (profileKey && list.status === "ready")
      void session.profiles
        .ensure(profileKey.split(":"), "background")
        .catch(() => {});
  }, [session, profileKey, list.status]);
  const nameOf = (id: string) =>
    profiles.get(id)?.name ?? formatPublicKey(id) ?? "Someone";

  return (
    <div className={styles.activity} data-activity-sidebar="">
      <div className={styles.controls}>
        {view.scope === "team" ? (
          <div className={styles.teamTabs}>
            <Tabs
              label="Team view"
              variant="panel"
              size="sm"
              value={view.team}
              items={teamViews}
              onValueChange={(team) => onViewChange({ ...view, team })}
            />
          </div>
        ) : (
          <span className={styles.spacer} />
        )}
        <Switch
          label="Unread"
          checked={view.unread}
          onCheckedChange={(unread) => onViewChange({ ...view, unread })}
        />
      </div>
      <ul className={styles.rows} aria-label="Conversations">
        {view.scope === "team" && view.team !== "all"
          ? teamItems.map((item) => {
              const channel = channelsById.get(item.channelId);
              const rootId =
                item.rootId ?? (item.thread ? item.messageId : undefined);
              return (
                <li key={item.id}>
                  <MessageListRow
                    selected={
                      selectedChannel === item.channelId &&
                      (!rootId || selectedThread === rootId)
                    }
                    onClick={() =>
                      open(item.channelId, {
                        messageId: item.messageId,
                        ...(rootId ? { threadRootId: rootId } : {}),
                      })
                    }
                    avatar={
                      <PersonAvatar
                        session={session}
                        profile={profiles.get(item.authorId)}
                        name={nameOf(item.authorId)}
                      />
                    }
                    sender={nameOf(item.authorId)}
                    source={channel ? `in ${channelText(channel)}` : ""}
                    time={relativeTimestamp(item.createdAt)}
                    preview={messagePreview(item.preview)}
                    unread={item.unreadCount > 0 || item.manual}
                  />
                </li>
              );
            })
          : order.map((id) => {
              const entry = byId.get(id);
              if (!entry) return null;
              return (
                <ConversationRow
                  key={id}
                  session={session}
                  channel={entry.channel}
                  at={entry.at}
                  profiles={profiles}
                  nameOf={nameOf}
                  unreadOnly={view.unread}
                  threads={view.scope === "team"}
                  selected={selectedChannel === id}
                  selectedThread={
                    selectedChannel === id ? selectedThread : undefined
                  }
                  onOpen={() => open(id)}
                  onOpenThread={(item) =>
                    open(id, {
                      messageId: item.latestMessageId,
                      threadRootId: item.rootId,
                    })
                  }
                />
              );
            })}
      </ul>
      {list.status === "ready" &&
        (view.scope === "team" && view.team !== "all"
          ? !teamItems.length
          : !channels.length) && (
          <p className={`text-body-sm text-subtle ${styles.empty}`}>
            {view.unread ? "You're all caught up." : "Nothing here yet."}
          </p>
        )}
    </div>
  );
}

/**
 * Keeps rows where they are while the pointer or keyboard is in the list, so a
 * new message doesn't move a row out from under a click. New rows go at the end.
 */
function useFrozenOrder(key: string) {
  const [frozen, setFrozen] = useState(false);
  const held = useRef<readonly string[]>([]);
  useEffect(() => {
    const thaw = () => setFrozen(false);
    const onPointer = (event: PointerEvent) =>
      setFrozen(
        event.target instanceof Element &&
          !!event.target.closest("[data-activity-sidebar]"),
      );
    const onFocus = () =>
      setFrozen(!!document.activeElement?.closest("[data-activity-sidebar]"));
    document.addEventListener("pointerover", onPointer);
    document.addEventListener("focusin", onFocus);
    window.addEventListener("blur", thaw);
    return () => {
      document.removeEventListener("pointerover", onPointer);
      document.removeEventListener("focusin", onFocus);
      window.removeEventListener("blur", thaw);
    };
  }, []);
  return useMemo(() => {
    const next = key ? key.split("\n") : [];
    if (!frozen) {
      held.current = next;
      return next;
    }
    const present = new Set(next);
    const kept = held.current.filter((id) => present.has(id));
    const keptSet = new Set(kept);
    held.current = [...kept, ...next.filter((id) => !keptSet.has(id))];
    return held.current;
  }, [frozen, key]);
}

function ConversationRow({
  session,
  channel,
  at,
  profiles,
  nameOf,
  unreadOnly,
  threads,
  selected,
  selectedThread,
  onOpen,
  onOpenThread,
}: {
  session: RelaySession;
  channel: ChannelSummary;
  at: number;
  profiles: ReadonlyMap<string, Profile>;
  nameOf(id: string): string;
  unreadOnly: boolean;
  threads: boolean;
  selected: boolean;
  selectedThread: string | undefined;
  onOpen(): void;
  onOpenThread(item: ThreadActivityItem): void;
}) {
  const dm = channel.channelType === "dm";
  const state = useUnreadState(session, channel.id, dm);
  const threadItems = threads
    ? [...(state.activity.items ?? [])]
        .filter((item) => !unreadOnly || item.unreadCount > 0)
        .sort((a, b) => b.createdAt - a.createdAt)
    : [];
  if (unreadOnly && !state.unread && !threadItems.length && !selected)
    return null;
  const Icon = channelIcon(channel);
  const peer = dm ? channel.participants?.[0] : undefined;
  const avatar = peer ? (
    <PersonAvatar
      session={session}
      profile={profiles.get(peer)}
      name={channel.name || nameOf(peer)}
    />
  ) : (
    <Avatar
      size="fill"
      alt=""
      shape="squircle"
      fallback={channel.name}
      fallbackContent={<Icon size={18} aria-hidden="true" />}
    />
  );
  const preview = channel.preview
    ? messagePreview(channel.preview)
    : channel.description || "No recent messages";
  return (
    <li data-activity-row={channel.id}>
      <MessageListRow
        aria-current={selected && !selectedThread ? "page" : undefined}
        selected={selected && !selectedThread}
        onClick={onOpen}
        avatar={avatar}
        sender={dm ? channel.name : channelText(channel)}
        source=""
        time={at ? relativeTimestamp(at) : ""}
        preview={preview}
        unread={state.unread}
      />
      {threadItems.length > 0 && (
        <ul
          className={styles.threads}
          aria-label={`Threads in ${channel.name}`}
        >
          {threadItems.slice(0, THREAD_ROWS).map((item) => (
            <li key={item.rootId}>
              <NavigationItem
                inset
                selected={selectedThread === item.rootId}
                onClick={() => onOpenThread(item)}
                label={
                  <ThreadLabel
                    author={nameOf(item.authorId)}
                    preview={messagePreview(item.preview)}
                    time={relativeTimestamp(item.createdAt)}
                    unread={item.unreadCount > 0}
                  />
                }
              />
            </li>
          ))}
          {threadItems.length > THREAD_ROWS && (
            <li className={`text-caption text-subtle ${styles.more}`}>
              +{threadItems.length - THREAD_ROWS} more threads
            </li>
          )}
        </ul>
      )}
    </li>
  );
}

function ThreadLabel({
  author,
  preview,
  time,
  unread,
}: {
  author: string;
  preview: string;
  time: ReactNode;
  unread: boolean;
}) {
  return (
    <span className={styles.thread}>
      <span
        className={`text-body-sm ${unread ? "text-standard" : "text-subtle"} ${styles.threadText}`}
      >
        <strong className="text-label-sm">{author}</strong> {preview}
      </span>
      <span className={`text-caption text-subtle ${styles.threadTime}`}>
        {time}
      </span>
    </span>
  );
}

function PersonAvatar({
  session,
  profile,
  name,
}: {
  session: RelaySession;
  profile: Profile | undefined;
  name: string;
}) {
  return (
    <Avatar
      size="fill"
      alt=""
      fallback={name}
      src={avatarMedia(profile?.picture, session.media)}
      shape={profile?.isAgent ? "squircle" : "circle"}
    />
  );
}
