// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { webcrypto } from "node:crypto";
import {
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
  const user = userEvent.setup();
  render(<WorkspaceControl session={session} channelId="chat" />);
  await user.click(screen.getByRole("button", { name: "Workspace: Buzz App" }));
  await user.click(
    await screen.findByRole("menuitemradio", { name: "No workspace" }),
  );
  expect(assign).toHaveBeenCalledWith("chat", undefined);
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

it.each(
  [
    { chat: "a new chat", trigger: "Add workspace", channelId: undefined },
    { chat: "a saved chat", trigger: "Workspace: Buzz App", channelId: "chat" },
  ].flatMap((chat) => [
    { ...chat, submit: "Create" },
    { ...chat, submit: "Enter" },
  ]),
)(
  "creates a workspace from the composer and picks it for $chat ($submit)",
  async ({ trigger, channelId, submit }) => {
    vi.stubGlobal("crypto", webcrypto);
    const { session, assign, createSection } = fixture();
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
    const open = async () => {
      await user.click(control);
      await user.click(
        await screen.findByRole("menuitem", { name: "New workspace" }),
      );
      return screen.findByRole("dialog", { name: "New workspace" });
    };
    await open();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(control).toHaveFocus());
    const dialog = await open();
    const name = within(dialog).getByRole("textbox", { name: "Name" });
    await user.type(name, "Planning");
    // A browser's Enter submits through the form-associated Create button;
    // jsdom has no implicit submission for it, so send that submit directly.
    if (submit === "Enter") fireEvent.submit(name.closest("form") as Element);
    else
      await user.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    expect(composerSubmit).not.toHaveBeenCalled();
    expect(createSection).toHaveBeenCalledWith({
      id: expect.any(String),
      name: "Planning",
    });
    const id = createSection.mock.calls[0]?.[0].id;
    if (channelId) {
      expect(assign).toHaveBeenCalledWith(channelId, id);
      expect(change).not.toHaveBeenCalled();
    } else {
      expect(change).toHaveBeenCalledWith(id);
      expect(assign).not.toHaveBeenCalled();
    }
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
