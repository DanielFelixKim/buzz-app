// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { webcrypto } from "node:crypto";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { FormEvent } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { RelaySession } from "../relay/session";
import { createSidebarPreferencesStore } from "../relay/sidebar-preferences-store";
import type {
  SidebarAssignmentIntent,
  SidebarPreferences,
} from "../relay/sidebar-preferences";
import { WorkspaceControl } from "./WorkspaceControl";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function fixture(sectionCreationWritable = true) {
  const assign = vi.fn(async (_channelId: string, _sectionId?: string) => {});
  const createSection = vi.fn(
    async (_section: { id: string; name: string }) => {},
  );
  const snapshot = {
    status: "ready" as const,
    data: {
      sections: [{ id: "buzz", name: "Buzz App", order: 0 }],
      assignments: { chat: "buzz" },
      starred: [],
      muted: [],
    },
  };
  const session = {
    soloPreferences: {
      snapshot: () => snapshot,
      subscribe: () => () => {},
      assign,
      refresh: vi.fn(async () => {}),
      sectionCreationWritable,
      createSection,
    },
  } as unknown as RelaySession;
  return { session, assign, createSection };
}

it("moves a saved chat without changing project defaults", async () => {
  const { session, assign } = fixture();
  // A move waits on the relay, and the control stays busy until it ends.
  let moved!: () => void;
  assign.mockReturnValue(new Promise<void>((resolve) => (moved = resolve)));
  const user = userEvent.setup();
  render(<WorkspaceControl session={session} channelId="chat" />);
  const control = screen.getByRole("button", { name: "Workspace: Buzz App" });
  await user.click(control);
  await user.click(
    await screen.findByRole("menuitemradio", { name: "No workspace" }),
  );
  expect(assign).toHaveBeenCalledWith("chat", undefined);
  // The menu hands focus back as the move starts. jsdom focuses a natively
  // disabled button; a browser can't.
  await waitFor(() => expect(control).toHaveFocus());
  expect(control).not.toHaveAttribute("disabled");
  expect(control).toHaveAttribute("aria-disabled", "true");
  await act(async () => moved());
  expect(control).not.toHaveAttribute("aria-disabled");
});

it("changes a new-chat project locally instead of moving a saved channel", async () => {
  const { session, assign } = fixture();
  const change = vi.fn();
  const user = userEvent.setup();
  render(<WorkspaceControl session={session} value="" onChange={change} />);
  await user.click(screen.getByRole("button", { name: "Add workspace" }));
  await user.click(
    await screen.findByRole("menuitemradio", { name: "Buzz App" }),
  );
  expect(change).toHaveBeenCalledWith("buzz");
  expect(assign).not.toHaveBeenCalled();
});

it("keeps project recovery reachable after preferences fail", async () => {
  const refresh = vi.fn(async () => {});
  const session = {
    soloPreferences: {
      snapshot: () => ({ status: "error", error: "Projects unavailable" }),
      subscribe: () => () => {},
      assign: vi.fn(async () => {}),
      refresh,
    },
  } as unknown as RelaySession;
  const user = userEvent.setup();
  render(<WorkspaceControl session={session} channelId="chat" />);
  await user.click(screen.getByRole("button", { name: "Add workspace" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "Retry workspaces" }),
  );
  expect(refresh).toHaveBeenCalledOnce();
});

/** A real Solo preferences store over one groups record, so a test can count
 * its writes. Reads wait while `hold` is pending. */
async function storeFixture() {
  let saved: SidebarPreferences = {
    sections: [{ id: "buzz", name: "Buzz App", order: 0 }],
    assignments: { chat: "buzz" },
    starred: [],
    muted: [],
  };
  const reads = { hold: Promise.resolve() };
  const write = vi.fn(async (intent: SidebarAssignmentIntent) => {
    const created = intent.createSection;
    if (created)
      saved = {
        ...saved,
        sections: [...saved.sections, { ...created, order: 1 }],
      };
    const target = created?.id ?? intent.sectionId;
    const assignments = { ...saved.assignments };
    if (intent.channelId !== undefined) {
      if (target) assignments[intent.channelId] = target;
      else delete assignments[intent.channelId];
    }
    saved = { ...saved, assignments };
    return saved;
  });
  const store = createSidebarPreferencesStore({
    read: async () => {
      await reads.hold;
      return saved;
    },
    available: true,
    groupsOnly: true,
    write,
  });
  await store.queries.ensure();
  const assign = vi.fn(store.queries.assign);
  const session = {
    soloPreferences: Object.create(store.queries, {
      assign: { value: assign },
    }),
  } as unknown as RelaySession;
  return { session, write, assign, reads };
}

it.each(
  [
    { chat: "a new chat", trigger: "Add workspace", channelId: undefined },
    { chat: "a saved chat", trigger: "Workspace: Buzz App", channelId: "chat" },
  ].flatMap((chat) => [
    { ...chat, submit: "Create" },
    { ...chat, submit: "Enter" },
  ]),
)(
  "creates a workspace from the composer and picks it for $chat in one write ($submit)",
  async ({ trigger, channelId, submit }) => {
    vi.stubGlobal("crypto", webcrypto);
    const { session, write, assign } = await storeFixture();
    const change = vi.fn();
    // The control sits in the composer's form; the dialog's submit is its own.
    const composerSubmit = vi.fn((event: FormEvent) => event.preventDefault());
    const user = userEvent.setup();
    render(
      <form onSubmit={composerSubmit}>
        {channelId ? (
          <WorkspaceControl session={session} channelId={channelId} />
        ) : (
          <WorkspaceControl session={session} value="" onChange={change} />
        )}
      </form>,
    );
    const control = screen.getByRole("button", { name: trigger });
    await user.click(control);
    await user.click(
      await screen.findByRole("menuitem", { name: "New workspace" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "New workspace" });
    const name = within(dialog).getByRole("textbox", { name: "Name" });
    await user.type(name, "Planning");
    // A browser's Enter submits through the form-associated Create button;
    // jsdom has no implicit submission for it, so send that submit directly.
    if (submit === "Enter") fireEvent.submit(name.closest("form") as Element);
    else
      await user.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    await waitFor(() => expect(control).toHaveFocus());
    expect(control).not.toHaveAttribute("disabled");
    expect(composerSubmit).not.toHaveBeenCalled();
    // A second write of the groups record within a second is refused, so the
    // workspace and a saved chat's move into it are one write.
    expect(write).toHaveBeenCalledOnce();
    const id = write.mock.calls[0]?.[0].createSection?.id;
    expect(write).toHaveBeenCalledWith(
      {
        ...(channelId ? { channelId } : {}),
        createSection: { id: expect.any(String), name: "Planning" },
      },
      expect.anything(),
    );
    expect(assign).not.toHaveBeenCalled();
    if (channelId) {
      expect(change).not.toHaveBeenCalled();
      expect(control).toHaveAccessibleName("Workspace: Planning");
    } else expect(change).toHaveBeenCalledWith(id);
  },
);

it("offers New workspace disabled while workspaces can't be created", async () => {
  const { session } = fixture(false);
  const user = userEvent.setup();
  render(<WorkspaceControl session={session} value="" onChange={vi.fn()} />);
  await user.click(screen.getByRole("button", { name: "Add workspace" }));
  expect(
    await screen.findByRole("menuitem", { name: "New workspace" }),
  ).toHaveAttribute("aria-disabled", "true");
});
