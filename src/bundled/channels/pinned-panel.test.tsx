// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "../../features/relay/session";
import type { ReadFilter, RelayEvent } from "../../features/relay/events";
import { keypair, message, signed } from "../../features/relay/testing";
import { Context } from "@deepseek-ai/cordis";
import { PanelsService } from "../../features/panels/service";
import type { ChannelSummary } from "../../features/relay/contracts";
import { PinnedMessages, registerPinned } from "./pinned-panel";

afterEach(cleanup);

const viewer = keypair(),
  other = keypair();
const channelId = "11111111-1111-4111-8111-111111111111";
const pinOf = (target: RelayEvent, time: number, author = viewer) =>
  signed(author, {
    kind: 40004,
    content: "",
    created_at: time,
    tags: [
      ["h", channelId],
      ["e", target.id],
    ],
  });

function setup(events: RelayEvent[], failures = 0) {
  const owner = createRelaySession(null);
  let failing = failures;
  const read = vi.fn(async (filters: readonly ReadFilter[]) => {
    if (failing-- > 0) throw new Error("offline");
    const [filter] = filters;
    return events.filter(
      (event) =>
        (!filter?.ids || filter.ids.includes(event.id)) &&
        (!filter?.kinds || filter.kinds.includes(event.kind)) &&
        (!filter?.["#h"] ||
          event.tags.some(([name, id]) => name === "h" && id === channelId)) &&
        (!filter?.["#e"] ||
          event.tags.some(
            ([name, id]) => name === "e" && filter["#e"]?.includes(id ?? ""),
          )),
    );
  });
  const remove = vi.fn(() => "deletion");
  const session = {
    ...owner.session,
    viewer: viewer.pubkey,
    read,
    outbox: { ...owner.session.outbox, supports: () => true },
    messages: { ...owner.session.messages, remove },
  } as unknown as typeof owner.session;
  const openLink = vi.fn(() => true);
  render(
    <PinnedMessages
      session={session}
      scope="pinned-test"
      channelId={channelId}
      links={undefined}
      openLink={openLink}
    />,
  );
  return { owner, read, remove, openLink };
}

it("lists pinned messages newest first, opens one and unpins only the viewer's", async () => {
  const older = message(other, channelId, "Older decision", 1);
  const newer = message(other, channelId, "Newer decision", 2);
  const deleted = message(other, channelId, "Deleted", 3);
  const mine = pinOf(older, 10),
    theirs = pinOf(newer, 20, other),
    orphan = pinOf(deleted, 30);
  const h = setup([
    older,
    newer,
    mine,
    theirs,
    orphan,
    signed(other, {
      kind: 5,
      content: "",
      tags: [
        ["h", channelId],
        ["e", deleted.id],
        ["k", "9"],
      ],
    }),
  ]);
  const list = await screen.findByRole("list", { name: "Pinned messages" });
  const rows = within(list).getAllByRole("listitem");
  expect(rows).toHaveLength(2);
  expect(rows[0]).toHaveTextContent(`Pinned by ${other.pubkey.slice(0, 10)}…`);
  expect(rows[1]).toHaveTextContent(`Pinned by ${viewer.pubkey.slice(0, 10)}…`);
  expect(
    within(rows[0] as HTMLElement).queryByRole("button", {
      name: "Unpin message",
    }),
  ).toBeNull();
  fireEvent.click(within(rows[1] as HTMLElement).getByRole("link"));
  expect(h.openLink).toHaveBeenCalledWith(
    `buzz://message?channel=${channelId}&id=${older.id}`,
  );
  fireEvent.click(
    within(rows[1] as HTMLElement).getByRole("button", {
      name: "Unpin message",
    }),
  );
  expect(h.remove).toHaveBeenCalledWith([mine.id]);
  await waitFor(() =>
    expect(within(list).getAllByRole("listitem")).toHaveLength(1),
  );
  h.owner.dispose();
});

it("shows an empty state, and a failed read with Retry", async () => {
  const empty = setup([]);
  expect(
    await screen.findByRole("heading", { name: "No pinned messages" }),
  ).toBeVisible();
  empty.owner.dispose();
  cleanup();
  const failed = setup([], 1);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Could not load pins.",
  );
  expect(
    screen.queryByRole("heading", { name: "No pinned messages" }),
  ).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(
    await screen.findByRole("heading", { name: "No pinned messages" }),
  ).toBeVisible();
  failed.owner.dispose();
});

it("offers View pinned in the channel menu to members of a non-DM channel", async () => {
  const root = new Context();
  root.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const owner = createRelaySession(null);
  const panels = new PanelsService(root);
  const session = { ...owner.session, viewer: viewer.pubkey };
  root.provide("relay", {
    snapshot: () => ({ status: "idle" }),
    subscribe: () => () => {},
  });
  const fiber = root
    .extend({ pluginOwner: { id: "channels", revision: "test" } })
    .plugin(registerPinned);
  try {
    await fiber.await();
    const panel = panels.snapshot().find((item) => item.id === "pinned");
    expect(panel?.channelMenu?.label).toBe("View pinned");
    const channel: ChannelSummary = {
      id: channelId,
      name: "Decisions",
      members: [viewer.pubkey],
    };
    expect(panel?.channelMenu?.eligible(channel, session)).toBe(true);
    const excludedChannels: ChannelSummary[] = [
      { ...channel, channelType: "dm" },
      { ...channel, cached: true },
      { ...channel, members: [] },
    ];
    for (const excluded of excludedChannels)
      expect(panel?.channelMenu?.eligible(excluded, session)).toBe(false);
  } finally {
    fiber.dispose();
    owner.dispose();
  }
});
