// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { createRelaySession } from "../../features/relay/session";
import type { RelaySession } from "../../features/relay/session";
import type { InboxItem } from "../../features/relay/inbox";
import type { Navigation } from "../../features/navigation/controller";
import {
  ActivitySidebar,
  ActivityScopeTabs,
  type ActivityView,
} from "./ActivitySidebar";

afterEach(cleanup);

const viewer = "c".repeat(64);
const alice = "a".repeat(64);
const root = "d".repeat(64);
const reply = "e".repeat(64);
const scope = { viewer, communityOrigin: "https://relay.test" };

function setup(
  inboxItems: InboxItem[] = [],
  topLevel: Record<string, { createdAt: number; content: string }> = {},
) {
  const base = createRelaySession(null).session;
  const channels = [
    {
      id: "old",
      name: "old-news",
      channelType: "stream" as const,
      lastActivityAt: 100,
      preview: "ancient",
    },
    {
      id: "new",
      name: "fresh",
      channelType: "stream" as const,
      lastActivityAt: 200,
      preview: "hello there",
    },
    {
      id: "solo",
      name: "My chat",
      channelType: "solo" as const,
      lastActivityAt: 300,
    },
  ];
  const list = { status: "ready" as const, channels };
  const quiet = (channelId: string) => ({
    target: { kind: "channel" as const, channelId },
    observedCount: channelId === "old" ? 2 : 0,
    attentionCount: 0,
    coverage: "observed" as const,
    freshness: "observed" as const,
    manual: "none" as const,
  });
  const snapshots = new Map(
    channels.map((c) => [
      c.id,
      {
        ...quiet(c.id),
        ...(topLevel[c.id]
          ? {
              latestTopLevel: {
                id: `${c.id}-top`,
                authorId: alice,
                ...topLevel[c.id],
              },
            }
          : {}),
      },
    ]),
  );
  const thread = {
    channelId: "old",
    rootId: root,
    latestMessageId: reply,
    authorId: alice,
    createdAt: 400,
    preview: "a reply in the old channel",
    unreadCount: 1,
  };
  const activities = new Map(
    channels.map((c) => [
      c.id,
      {
        channelId: c.id,
        items: c.id === "old" ? [thread] : [],
        coverage: "observed" as const,
        freshness: "observed" as const,
      },
    ]),
  );
  const inbox = {
    status: "ready" as const,
    items: inboxItems,
    freshness: "observed" as const,
  };
  const profiles = new Map([[alice, { name: "Alice" }]]);
  const session: RelaySession = {
    ...base,
    viewer,
    channels: {
      ...base.channels,
      list: () => list,
      subscribeList: () => () => {},
      ensureList() {},
    },
    sidebarPreferences: {
      ...base.sidebarPreferences,
      snapshot: () => ({
        status: "ready" as const,
        data: { sections: [], assignments: {}, starred: [], muted: [] },
      }),
    },
    profiles: {
      ...base.profiles,
      snapshot: () => profiles,
      ensure: async () => {},
    },
    inboxFeed: { ...base.inboxFeed, ensure: async () => {} },
    unread: {
      ...base.unread,
      ensure: async () => {},
      inbox: () => inbox as never,
      subscribeInbox: () => () => {},
      snapshot: (target) =>
        snapshots.get(target.kind === "channel" ? target.channelId : "") ??
        quiet("none"),
      subscribe: () => () => {},
      activity: (id) =>
        activities.get(id) ?? {
          channelId: id,
          items: [],
          coverage: "observed",
          freshness: "observed",
        },
      subscribeActivity: () => () => {},
    },
  };
  const open = vi.fn(async () => ({ status: "opened" as const }));
  const navigator = { open } as unknown as Navigation;
  function Harness() {
    const [view, setView] = useState<ActivityView>({
      scope: "team",
      filters: { solo: "all", team: "all", dms: "all" },
    });
    return (
      <>
        <ActivityScopeTabs view={view} onChange={setView} />
        <ActivitySidebar
          session={session}
          navigator={navigator}
          scope={scope}
          target={
            { version: 1, kind: "page", pluginId: "x", pageId: "y" } as never
          }
          view={view}
        />
      </>
    );
  }
  render(<Harness />);
  return { open };
}

const rowNames = () =>
  within(screen.getByRole("list", { name: "Conversations" }))
    .getAllByRole("listitem")
    .filter((li) => li.hasAttribute("data-activity-row"))
    .map((li) => li.getAttribute("data-activity-row"));

test("Team lists channels by their newest activity, threads included", () => {
  setup();
  // old-news has an older top-level message but a newer thread reply, which
  // becomes its preview.
  expect(rowNames()).toEqual(["old", "new"]);
  expect(
    screen.getByText("Alice in a thread: a reply in the old channel"),
  ).toBeInTheDocument();
});

test("a thread row opens the thread beside its channel", async () => {
  const { open } = setup();
  await userEvent.click(screen.getByRole("tab", { name: "Threads" }));
  await userEvent.click(screen.getByText("a reply in the old channel"));
  expect(open).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: "conversation",
      channelId: "old",
      messageId: reply,
      threadRootId: root,
      context: "channel",
    }),
  );
});

test("Unread is a level of the one selector, remembered per scope", async () => {
  setup();
  await userEvent.click(screen.getByRole("tab", { name: "Unread" }));
  expect(rowNames()).toEqual(["old"]);
  await userEvent.click(screen.getByRole("tab", { name: "Solo" }));
  expect(rowNames()).toEqual(["solo"]);
  // Solo lists only All and Unread.
  expect(
    screen.queryByRole("tab", { name: "Threads" }),
  ).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("tab", { name: "Team" }));
  expect(screen.getByRole("tab", { name: "Unread" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

test("Team's Mentions view lists mentions and opens them in their thread", async () => {
  const mention = {
    id: "m",
    channelId: "new",
    target: { kind: "thread", channelId: "new", rootId: root },
    messageId: reply,
    latestMessageId: reply,
    messageIds: [reply],
    rootId: root,
    authorId: alice,
    preview: "hey @you",
    createdAt: 500,
    mentioned: true,
    messages: [],
    thread: true,
    unreadCount: 1,
    manual: false,
    readThrough: [],
  } as unknown as InboxItem;
  const { open } = setup([{ ...mention, mention }]);
  await userEvent.click(screen.getByRole("tab", { name: "Mentions" }));
  await userEvent.click(screen.getByText("hey @you"));
  expect(open).toHaveBeenCalledWith(
    expect.objectContaining({
      channelId: "new",
      threadRootId: root,
      context: "channel",
    }),
  );
});

test("Team's Threads view is a flat list of threads, not channels", async () => {
  setup();
  await userEvent.click(screen.getByRole("tab", { name: "Threads" }));
  expect(rowNames()).toEqual([]);
  expect(screen.getByText("Alice")).toBeInTheDocument();
  expect(screen.getByText("#old-news")).toBeInTheDocument();
  expect(screen.queryByText("ancient")).not.toBeInTheDocument();
});

test("a Team row previews its latest top-level message and its author", () => {
  setup([], {
    old: { createdAt: 600, content: "a new post" },
    new: { createdAt: 150, content: "older post" },
  });
  expect(rowNames()).toEqual(["old", "new"]);
  expect(screen.getByText("Alice: a new post")).toBeInTheDocument();
});
