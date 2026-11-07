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
} from "react";
import type { RelaySession } from "../../features/relay/session";
import type { ChannelSummary, Profile } from "../../features/relay/contracts";
import type { InboxItem } from "../../features/relay/inbox";
import type { Navigation } from "../../features/navigation/controller";
import type {
  NavigationScope,
  OpenTarget,
} from "../../features/navigation/targets";
import { useChannelList } from "../../features/relay/react";
import { useUnreadState } from "../../bundled/channels/UnreadBadge";
import { channelIcon, channelText } from "../../features/channels/channel-icon";
import { messagePreview } from "../../features/notifications/content";
import { avatarMedia } from "../../shared/avatar-source";
import { formatPublicKey } from "../../shared/identity/public-key";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { MessageListRow } from "../../features/messages/MessageListRow";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Tabs } from "../../shared/design-system/ui/Tabs";
import { ChatUnreadIcon } from "../../shared/design-system/icons";
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
  const team = view.scope === "team" ? view.team : undefined;
  const flat = team === "threads" || team === "mentions";
  const order = useFrozenOrder(
    flat ? "" : sorted.map((entry) => entry.channel.id).join("\n"),
  );
  const byId = new Map(sorted.map((entry) => [entry.channel.id, entry]));
  const teamIds = new Set(
    list.channels
      .filter((channel) => listed(channel) && scopeOf(channel) === "team")
      .map((channel) => channel.id),
  );
  const channelsById = new Map(list.channels.map((c) => [c.id, c]));
  const events =
    team === "threads"
      ? threadEvents(inbox.items, [...teamIds], session, teamIds)
      : team === "mentions"
        ? mentionEvents(inbox.items, teamIds)
        : [];
  const shownEvents = view.unread
    ? events.filter((event) => event.unread)
    : events;

  const ids = [
    ...shownEvents.slice(0, 100).map((event) => event.authorId),
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
        {team ? (
          <div className={styles.teamTabs}>
            <Tabs
              label="Team view"
              variant="panel"
              size="sm"
              value={team}
              items={teamViews}
              onValueChange={(team) => onViewChange({ ...view, team })}
            />
          </div>
        ) : (
          <span className={styles.spacer} />
        )}
        <IconButton
          variant={view.unread ? "subtle" : "ghost"}
          size="sm"
          aria-label="Unread only"
          title="Unread only"
          aria-pressed={view.unread}
          onClick={() => onViewChange({ ...view, unread: !view.unread })}
          icon={<ChatUnreadIcon aria-hidden="true" size={16} />}
        />
      </div>
      <ul className={styles.rows} aria-label="Conversations">
        {flat
          ? shownEvents.map((event) => {
              const channel = channelsById.get(event.channelId);
              const name = nameOf(event.authorId);
              return (
                <li key={event.key}>
                  <MessageListRow
                    selected={
                      selectedChannel === event.channelId &&
                      !!event.rootId &&
                      selectedThread === event.rootId
                    }
                    onClick={() =>
                      open(event.channelId, {
                        messageId: event.messageId,
                        ...(event.rootId ? { threadRootId: event.rootId } : {}),
                      })
                    }
                    avatar={
                      <PersonAvatar
                        session={session}
                        profile={profiles.get(event.authorId)}
                        name={name}
                      />
                    }
                    sender={name}
                    source={channel ? channelText(channel) : ""}
                    time={shortTime(event.createdAt)}
                    preview={messagePreview(event.preview)}
                    unread={event.unread}
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
                  selected={selectedChannel === id && !selectedThread}
                  onOpen={() => open(id)}
                />
              );
            })}
      </ul>
      {list.status === "ready" &&
        (flat ? !shownEvents.length : !channels.length) && (
          <p className={`text-body-sm text-subtle ${styles.empty}`}>
            {view.unread
              ? "You're all caught up."
              : team === "threads"
                ? "No thread activity yet."
                : team === "mentions"
                  ? "No one has mentioned you yet."
                  : "Nothing here yet."}
          </p>
        )}
    </div>
  );
}

/** Sidebar-width recency, as the Activity card abbreviates it. */
export function shortTime(unixSeconds: number, nowSeconds = Date.now() / 1000) {
  const age = Math.max(0, nowSeconds - unixSeconds);
  if (age < 60) return "now";
  if (age < 3600) return `${Math.floor(age / 60)}m`;
  if (age < 86400) return `${Math.floor(age / 3600)}h`;
  if (age < 604800) return `${Math.floor(age / 86400)}d`;
  return new Date(unixSeconds * 1000).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

/** One row in Threads or Mentions: a message, opened where it lives. */
type ActivityEvent = Readonly<{
  key: string;
  channelId: string;
  rootId?: string | undefined;
  messageId: string;
  authorId: string;
  preview: string;
  createdAt: number;
  unread: boolean;
}>;

const rootOf = (item: InboxItem) =>
  item.rootId ?? (item.thread ? item.messageId : undefined);
const itemUnread = (item: InboxItem) => item.unreadCount > 0 || item.manual;
const newestFirst = (a: ActivityEvent, b: ActivityEvent) =>
  b.createdAt - a.createdAt;

/** Every active thread in Team channels, one row each, at its latest reply. */
function threadEvents(
  items: readonly InboxItem[],
  channelIds: readonly string[],
  session: RelaySession,
  team: ReadonlySet<string>,
): ActivityEvent[] {
  const byRoot = new Map<string, ActivityEvent>();
  const add = (event: ActivityEvent) => {
    const key = `${event.channelId}:${event.rootId}`;
    const held = byRoot.get(key);
    if (!held || held.createdAt < event.createdAt)
      byRoot.set(key, {
        ...event,
        key,
        unread: event.unread || !!held?.unread,
      });
    else if (event.unread && !held.unread)
      byRoot.set(key, { ...held, unread: true });
  };
  for (const id of channelIds)
    for (const thread of session.unread.activity(id).items ?? [])
      add({
        key: "",
        channelId: id,
        rootId: thread.rootId,
        messageId: thread.latestMessageId,
        authorId: thread.authorId,
        preview: thread.preview,
        createdAt: thread.createdAt,
        unread: thread.unreadCount > 0,
      });
  for (const item of items) {
    const root = rootOf(item);
    if (!root || !team.has(item.channelId)) continue;
    add({
      key: "",
      channelId: item.channelId,
      rootId: root,
      messageId: item.messageId,
      authorId: item.authorId,
      preview: item.preview,
      createdAt: item.createdAt,
      unread: itemUnread(item),
    });
  }
  return [...byRoot.values()].sort(newestFirst);
}

/** Mentions of you in Team channels, in a thread or not. */
function mentionEvents(
  items: readonly InboxItem[],
  team: ReadonlySet<string>,
): ActivityEvent[] {
  return items
    .flatMap((item) => (item.mention ? [item.mention] : []))
    .filter((item) => team.has(item.channelId))
    .map((item) => ({
      key: item.id,
      channelId: item.channelId,
      rootId: rootOf(item),
      messageId: item.messageId,
      authorId: item.authorId,
      preview: item.preview,
      createdAt: item.createdAt,
      unread: itemUnread(item),
    }))
    .sort(newestFirst);
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
  selected,
  onOpen,
}: {
  session: RelaySession;
  channel: ChannelSummary;
  at: number;
  profiles: ReadonlyMap<string, Profile>;
  nameOf(id: string): string;
  unreadOnly: boolean;
  selected: boolean;
  onOpen(): void;
}) {
  const dm = channel.channelType === "dm";
  const state = useUnreadState(session, channel.id, dm);
  const threadUnread = (state.activity.items ?? []).some(
    (item) => item.unreadCount > 0,
  );
  const unread = state.unread || threadUnread;
  if (unreadOnly && !unread && !selected) return null;
  const Icon = channelIcon(channel);
  const peer = dm ? channel.participants?.[0] : undefined;
  // The latest event: a newer thread reply wins over the channel's own tail.
  const thread = [...(state.activity.items ?? [])].sort(
    (a, b) => b.createdAt - a.createdAt,
  )[0];
  const tail = (channel.lastActivityAt ?? 0) >= (thread?.createdAt ?? 0);
  const preview =
    !thread || tail
      ? channel.preview
        ? messagePreview(channel.preview)
        : "No recent messages"
      : `${nameOf(thread.authorId)} in a thread: ${messagePreview(thread.preview)}`;
  return (
    <li data-activity-row={channel.id}>
      <MessageListRow
        aria-current={selected ? "page" : undefined}
        selected={selected}
        onClick={onOpen}
        avatar={
          peer ? (
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
              fallbackContent={<Icon size={16} aria-hidden="true" />}
            />
          )
        }
        sender={dm ? channel.name || (peer ? nameOf(peer) : "") : channel.name}
        source=""
        time={at ? shortTime(at) : ""}
        preview={preview}
        unread={unread}
      />
    </li>
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
