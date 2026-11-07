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
import type { ThreadActivityItem } from "../../features/relay/unread";
import type { Navigation } from "../../features/navigation/controller";
import type {
  NavigationScope,
  OpenTarget,
} from "../../features/navigation/targets";
import { useChannelList } from "../../features/relay/react";
import { useUnreadState } from "../../bundled/channels/UnreadBadge";
import { channelIcon } from "../../features/channels/channel-icon";
import { messagePreview } from "../../features/notifications/content";
import { avatarMedia } from "../../shared/avatar-source";
import { formatPublicKey } from "../../shared/identity/public-key";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Tabs } from "../../shared/design-system/ui/Tabs";
import { AtIcon, ChatUnreadIcon } from "../../shared/design-system/icons";
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
  { value: "all", label: "All" },
  { value: "threads", label: "Threads" },
  { value: "mentions", label: "Mentions" },
] as const;
const viewKey = "activity-sidebar:view";
/** Rows shown under a channel in All before "+N more". */
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
  const inboxByChannel = new Map<string, InboxItem[]>();
  if (team)
    for (const item of inbox.items) {
      const items = inboxByChannel.get(item.channelId);
      if (items) items.push(item);
      else inboxByChannel.set(item.channelId, [item]);
    }
  const noItems: readonly InboxItem[] = [];
  // Threads and Mentions list only channels that have some, by their newest.
  const visible = sorted.flatMap((entry) => {
    if (!team || team === "all") return [entry];
    const children = childrenFor(
      team,
      session.unread.activity(entry.channel.id).items ?? [],
      inboxByChannel.get(entry.channel.id) ?? noItems,
      view.unread,
    );
    const newest = children[0]?.createdAt;
    return newest === undefined ? [] : [{ ...entry, at: newest }];
  });
  if (team && team !== "all") visible.sort((a, b) => b.at - a.at);
  const order = useFrozenOrder(
    visible.map((entry) => entry.channel.id).join("\n"),
  );
  const byId = new Map(visible.map((entry) => [entry.channel.id, entry]));

  const ids = [
    ...[...inboxByChannel.values()]
      .flat()
      .slice(0, 100)
      .flatMap((item) => [item.authorId, item.mention?.authorId ?? ""]),
    ...channels.flatMap((channel) => [
      ...(channel.channelType === "dm"
        ? (channel.participants?.slice(0, 1) ?? [])
        : []),
      ...(team
        ? (session.unread.activity(channel.id).items ?? []).map(
            (item) => item.authorId,
          )
        : []),
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
        {order.map((id) => {
          const entry = byId.get(id);
          if (!entry) return null;
          return (
            <ConversationRow
              key={id}
              session={session}
              channel={entry.channel}
              at={entry.at}
              team={team}
              inboxItems={inboxByChannel.get(id) ?? noItems}
              profiles={profiles}
              nameOf={nameOf}
              unreadOnly={view.unread}
              selected={selectedChannel === id}
              selectedThread={
                selectedChannel === id ? selectedThread : undefined
              }
              onOpen={() => open(id)}
              onOpenChild={(child) =>
                open(id, {
                  messageId: child.messageId,
                  ...(child.rootId ? { threadRootId: child.rootId } : {}),
                })
              }
              onMore={() => onViewChange({ ...view, team: "threads" })}
            />
          );
        })}
      </ul>
      {list.status === "ready" && !visible.length && (
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

/** Sidebar-width recency: now, 8m, 2h, 3d, then the date. */
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

/** A thread or mention shown under its channel. */
type Child = Readonly<{
  key: string;
  rootId?: string | undefined;
  messageId: string;
  authorId: string;
  preview: string;
  createdAt: number;
  unread: boolean;
  mention: boolean;
}>;

const rootOf = (item: InboxItem) =>
  item.rootId ?? (item.thread ? item.messageId : undefined);
const itemUnread = (item: InboxItem) => item.unreadCount > 0 || item.manual;

/**
 * The rows under a channel, newest first. All shows what needs you: unread
 * threads and unread mentions. Threads shows every active thread, Mentions
 * every mention, in a thread or not.
 */
export function childrenFor(
  team: TeamView,
  threads: readonly ThreadActivityItem[],
  items: readonly InboxItem[],
  unreadOnly: boolean,
): Child[] {
  const mentions = items.flatMap((item) =>
    item.mention ? [item.mention] : [],
  );
  const children: Child[] = [];
  if (team === "mentions") {
    for (const item of mentions)
      children.push({
        key: item.id,
        rootId: rootOf(item),
        messageId: item.messageId,
        authorId: item.authorId,
        preview: item.preview,
        createdAt: item.createdAt,
        unread: itemUnread(item),
        mention: true,
      });
  } else {
    const mentionRoots = new Set(mentions.map(rootOf));
    const seen = new Set<string>();
    for (const thread of threads) {
      seen.add(thread.rootId);
      children.push({
        key: thread.rootId,
        rootId: thread.rootId,
        messageId: thread.latestMessageId,
        authorId: thread.authorId,
        preview: thread.preview,
        createdAt: thread.createdAt,
        unread: thread.unreadCount > 0,
        mention: mentionRoots.has(thread.rootId),
      });
    }
    for (const item of items) {
      const root = rootOf(item);
      if (root) {
        if (seen.has(root)) continue;
        seen.add(root);
        children.push({
          key: root,
          rootId: root,
          messageId: item.messageId,
          authorId: item.authorId,
          preview: item.preview,
          createdAt: item.createdAt,
          unread: itemUnread(item),
          mention: !!item.mention,
        });
      } else if (team === "all" && item.mention) {
        children.push({
          key: item.id,
          messageId: item.mention.messageId,
          authorId: item.mention.authorId,
          preview: item.mention.preview,
          createdAt: item.mention.createdAt,
          unread: itemUnread(item.mention),
          mention: true,
        });
      }
    }
  }
  return children
    .filter((child) => child.unread || (!unreadOnly && team !== "all"))
    .sort((a, b) => b.createdAt - a.createdAt);
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
  team,
  inboxItems,
  profiles,
  nameOf,
  unreadOnly,
  selected,
  selectedThread,
  onOpen,
  onOpenChild,
  onMore,
}: {
  session: RelaySession;
  channel: ChannelSummary;
  at: number;
  /** Set in Team, which shows threads and mentions under each channel. */
  team: TeamView | undefined;
  inboxItems: readonly InboxItem[];
  profiles: ReadonlyMap<string, Profile>;
  nameOf(id: string): string;
  unreadOnly: boolean;
  selected: boolean;
  selectedThread: string | undefined;
  onOpen(): void;
  onOpenChild(child: Child): void;
  onMore(): void;
}) {
  const dm = channel.channelType === "dm";
  const state = useUnreadState(session, channel.id, dm);
  const children = team
    ? childrenFor(team, state.activity.items ?? [], inboxItems, unreadOnly)
    : [];
  if (team && team !== "all" && !children.length) return null;
  if (unreadOnly && !state.unread && !children.length && !selected) return null;
  const shown = team === "all" ? children.slice(0, THREAD_ROWS) : children;
  const hidden = children.length - shown.length;
  const mentions = state.snapshot.attentionCount ?? 0;
  const Icon = channelIcon(channel);
  const peer = dm ? channel.participants?.[0] : undefined;
  const name = dm ? channel.name || (peer ? nameOf(peer) : "") : channel.name;
  // In Threads and Mentions the channel row is a header for what's under it.
  const preview =
    channel.preview && (!team || team === "all")
      ? messagePreview(channel.preview)
      : "";
  return (
    <li data-activity-row={channel.id} className={styles.group}>
      <NavigationItem
        multiline
        aria-current={selected && !selectedThread ? "page" : undefined}
        selected={selected && !selectedThread}
        onClick={onOpen}
        icon={
          <span className={styles.icon}>
            {peer ? (
              <PersonAvatar
                session={session}
                profile={profiles.get(peer)}
                name={name}
              />
            ) : (
              <Icon size={16} aria-hidden="true" />
            )}
          </span>
        }
        label={
          <span className={styles.content}>
            <span className={styles.heading}>
              <span
                className={`${state.unread ? "text-label-sm text-standard" : "text-body-sm"} ${styles.name}`}
              >
                {name}
              </span>
              <span className={`text-caption text-subtle ${styles.time}`}>
                {at ? shortTime(at) : ""}
              </span>
            </span>
            {preview && (
              <span className={`text-body-sm text-subtle ${styles.preview}`}>
                {preview}
              </span>
            )}
          </span>
        }
        trailing={<Marker mentions={mentions} unread={state.unread} />}
      />
      {shown.length > 0 && (
        <ul className={styles.children} aria-label={`In ${channel.name}`}>
          {shown.map((child) => (
            <li key={child.key}>
              <NavigationItem
                multiline
                selected={!!child.rootId && selectedThread === child.rootId}
                onClick={() => onOpenChild(child)}
                icon={
                  <span className={styles.childAvatar}>
                    <PersonAvatar
                      session={session}
                      profile={profiles.get(child.authorId)}
                      name={nameOf(child.authorId)}
                    />
                  </span>
                }
                label={
                  <span className={styles.child}>
                    <span className={styles.childText}>
                      <span className="text-label-sm text-standard">
                        {nameOf(child.authorId)}
                      </span>{" "}
                      <span
                        className={`text-body-sm ${child.unread ? "text-standard" : "text-subtle"}`}
                      >
                        {messagePreview(child.preview)}
                      </span>
                    </span>
                    <span className={`text-caption text-subtle ${styles.time}`}>
                      {shortTime(child.createdAt)}
                    </span>
                  </span>
                }
                trailing={
                  <Marker
                    mentions={child.mention ? 1 : 0}
                    unread={child.unread}
                    compact
                  />
                }
              />
            </li>
          ))}
          {hidden > 0 && (
            <li>
              <button
                type="button"
                className={`text-caption text-subtle ${styles.more}`}
                onClick={onMore}
              >
                +{hidden} more
              </button>
            </li>
          )}
        </ul>
      )}
    </li>
  );
}

/** @ for a mention of you (with a count on channels), a dot for unread. */
function Marker({
  mentions,
  unread,
  compact = false,
}: {
  mentions: number;
  unread: boolean;
  compact?: boolean;
}) {
  if (mentions > 0)
    return (
      <span
        className={`text-caption ${styles.mention}`}
        role="img"
        aria-label={
          compact
            ? "Mentions you"
            : `${mentions} mention${mentions === 1 ? "" : "s"}`
        }
      >
        <AtIcon size={12} aria-hidden="true" />
        {!compact && mentions > 1 ? mentions : null}
      </span>
    );
  return (
    <span className={styles.markerSlot}>
      {unread && <span className={styles.dot} role="img" aria-label="Unread" />}
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
