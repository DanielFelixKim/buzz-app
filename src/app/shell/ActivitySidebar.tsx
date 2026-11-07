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
import { Tabs } from "../../shared/design-system/ui/Tabs";
import { readView, writeView } from "../../shared/view-state";
import styles from "./ActivitySidebar.module.css";
import { useLatestMessages, type LatestMessage } from "./activity-previews";

export type ActivityScope = "solo" | "team" | "dms";
/** The second level of the one selector: what the chosen scope lists. */
type Filter = "all" | "unread" | "threads" | "mentions";
export type ActivityView = {
  scope: ActivityScope;
  filters: Record<ActivityScope, Filter>;
};
type View = ActivityView;

const scopes = [
  { value: "solo", label: "Solo" },
  { value: "team", label: "Team" },
  { value: "dms", label: "DMs" },
] as const;
const filtersFor = {
  solo: [
    { value: "all", label: "All" },
    { value: "unread", label: "Unread" },
  ],
  dms: [
    { value: "all", label: "All" },
    { value: "unread", label: "Unread" },
  ],
  team: [
    { value: "all", label: "All" },
    { value: "unread", label: "Unread" },
    { value: "threads", label: "Threads" },
    { value: "mentions", label: "Mentions" },
  ],
} as const satisfies Record<
  ActivityScope,
  readonly { value: Filter; label: string }[]
>;
const viewKey = "activity-sidebar:view:v2";

function readSavedView(scope: string): View {
  const saved = readView<Partial<View> | null>(scope, viewKey, null);
  const filter = (scope: ActivityScope): Filter => {
    const value = saved?.filters?.[scope];
    return filtersFor[scope].some((item) => item.value === value)
      ? (value as Filter)
      : "all";
  };
  return {
    scope:
      saved?.scope === "team" || saved?.scope === "dms" ? saved.scope : "solo",
    filters: { solo: filter("solo"), team: filter("team"), dms: filter("dms") },
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

/**
 * One selector, two levels: the scope, then what it lists, unread included.
 * Both sit in one tray so the second row reads as part of the first.
 */
export function ActivityScopeTabs({
  view,
  onChange,
}: {
  view: View;
  onChange(view: View): void;
}) {
  return (
    <div className={styles.selector}>
      <Tabs
        label="Activity scope"
        variant="segmented"
        size="sm"
        value={view.scope}
        items={scopes}
        onValueChange={(scope) => onChange({ ...view, scope })}
      />
      <div className={styles.subSelector}>
        <Tabs
          key={view.scope}
          label="Show"
          variant="segmented"
          size="sm"
          value={view.filters[view.scope]}
          items={filtersFor[view.scope]}
          onValueChange={(filter: Filter) =>
            onChange({
              ...view,
              filters: { ...view.filters, [view.scope]: filter },
            })
          }
        />
      </div>
    </div>
  );
}

export function ActivitySidebar({
  session,
  navigator,
  scope,
  target,
  view,
}: {
  session: RelaySession;
  navigator: Navigation;
  /** Navigation scope of this community. */
  scope: NavigationScope;
  target: OpenTarget;
  view: View;
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

  const filter = view.filters[view.scope];
  const unreadOnly = filter === "unread";
  const flat =
    view.scope === "team" && (filter === "threads" || filter === "mentions");
  const channels = list.channels.filter(
    (channel) => listed(channel) && scopeOf(channel) === view.scope,
  );
  const fetched = useLatestMessages(
    session,
    channels.map((channel) => channel.id),
  );
  // inbox changes re-render this list, which reads unread evidence directly.
  void inbox;
  const inboxAt = new Map<string, number>();
  for (const item of inbox.items)
    inboxAt.set(
      item.channelId,
      Math.max(inboxAt.get(item.channelId) ?? 0, item.createdAt),
    );
  /** Newest top-level message, from live evidence or the per-channel read. */
  const latestOf = (channel: ChannelSummary): LatestMessage | undefined => {
    const live = session.unread.snapshot({
      kind: "channel",
      channelId: channel.id,
    }).latestTopLevel;
    const read = fetched.get(channel.id) ?? undefined;
    return !live
      ? read
      : !read || live.createdAt >= read.createdAt
        ? live
        : read;
  };
  // Team ranks by what is relevant to you: top-level messages, threads you
  // are in, and your Activity (mentions, replies). Other people's thread
  // chatter does not move a channel. Solo chats and DMs rank by any message.
  const recency = (channel: ChannelSummary) => {
    const latest = latestOf(channel)?.createdAt ?? 0;
    if (view.scope !== "team")
      return Math.max(
        latest,
        channel.lastActivityAt ?? 0,
        session.unread.snapshot({ kind: "channel", channelId: channel.id })
          .latestMessage?.createdAt ?? 0,
      );
    const threads = session.unread.activity(channel.id).items ?? [];
    return Math.max(
      latest,
      inboxAt.get(channel.id) ?? 0,
      ...threads.map((item) => item.createdAt),
    );
  };
  const sorted = channels
    .map((channel) => ({ channel, at: recency(channel) }))
    .sort(
      (a, b) => b.at - a.at || a.channel.name.localeCompare(b.channel.name),
    );
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
  const shownEvents = !flat
    ? []
    : filter === "threads"
      ? threadEvents(inbox.items, [...teamIds], session, teamIds)
      : mentionEvents(inbox.items, teamIds);

  const ids = [
    ...shownEvents.slice(0, 100).map((event) => event.authorId),
    ...channels.flatMap((channel) => [
      ...(channel.channelType === "dm"
        ? (channel.participants?.slice(0, 1) ?? [])
        : []),
      latestOf(channel)?.authorId ?? "",
    ]),
  ].filter(Boolean);
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
                  latest={latestOf(entry.channel)}
                  team={view.scope === "team"}
                  profiles={profiles}
                  nameOf={nameOf}
                  unreadOnly={unreadOnly}
                  selected={selectedChannel === id && !selectedThread}
                  onOpen={() => open(id)}
                />
              );
            })}
      </ul>
      {list.status === "ready" &&
        (flat ? !shownEvents.length : !channels.length) && (
          <p className={`text-body-sm text-subtle ${styles.empty}`}>
            {filter === "threads"
              ? "No thread activity yet."
              : filter === "mentions"
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
  latest,
  team,
  profiles,
  nameOf,
  unreadOnly,
  selected,
  onOpen,
}: {
  session: RelaySession;
  channel: ChannelSummary;
  at: number;
  latest: LatestMessage | undefined;
  team: boolean;
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
  // The latest event: an unread thread reply you're in, when it is newer.
  const thread = team
    ? [...(state.activity.items ?? [])].sort(
        (a, b) => b.createdAt - a.createdAt,
      )[0]
    : undefined;
  const author = (id: string) => (dm || !team ? "" : `${nameOf(id)}: `);
  const preview =
    thread && thread.createdAt > (latest?.createdAt ?? 0)
      ? `${nameOf(thread.authorId)} in a thread: ${messagePreview(thread.preview)}`
      : latest
        ? `${author(latest.authorId)}${messagePreview(latest.content)}`
        : channel.preview
          ? messagePreview(channel.preview)
          : "";
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
