// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { notesFixture } from "../../features/notes/testing";
import { createNotesWorkspace } from "../../features/notes/workspace";
import { NoteHistoryMenu, NoteSharing } from "./NoteDialogs";
import {
  MenuRoot,
  MenuTrigger,
  MenuPopup,
} from "../../shared/design-system/ui/Menu";

beforeEach(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});
it("pages history inside the submenu, keeps it open, and selects with the page offset", async () => {
  const fixture = await notesFixture();
  const workspace = createNotesWorkspace(fixture.session);
  const note = fixture.seed("Plan", "Original");
  const history = vi
    .spyOn(workspace, "history")
    .mockImplementation(async (_note, offset) => ({
      revisions: [{ ...note, title: offset ? "Older plan" : "Current plan" }],
      more: !offset,
      limited: !!offset,
    }));
  const onSelect = vi.fn();
  try {
    render(
      <MenuRoot>
        <MenuTrigger>Actions</MenuTrigger>
        <MenuPopup>
          <NoteHistoryMenu
            note={note}
            workspace={workspace}
            disabled={false}
            onSelect={onSelect}
          />
        </MenuPopup>
      </MenuRoot>,
    );
    expect(history).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Actions" }));
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Revision history" }),
    );
    await screen.findByRole("menuitem", { name: /Current plan/ });
    await userEvent.click(
      screen.getByRole("menuitem", { name: "Load older revisions" }),
    );
    await screen.findByRole("menuitem", { name: /Older plan/ });
    expect(
      screen.getByRole("menu", { name: "Revision history" }),
    ).toHaveTextContent("page limit");
    await userEvent.click(
      screen.getByRole("menuitem", { name: "Newer revisions" }),
    );
    await screen.findByRole("menuitem", { name: /Current plan/ });
    await userEvent.click(
      screen.getByRole("menuitem", { name: "Load older revisions" }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: /Older plan/ }),
    );
    expect(onSelect).toHaveBeenCalledWith(note.revision, 100);
    await waitFor(() =>
      expect(screen.queryByRole("menu")).not.toBeInTheDocument(),
    );
  } finally {
    cleanup();
    workspace.dispose();
    fixture.dispose();
  }
});

it("offers retry after a failed history read", async () => {
  const fixture = await notesFixture();
  const workspace = createNotesWorkspace(fixture.session);
  const note = fixture.seed("Plan", "Original");
  const history = vi
    .spyOn(workspace, "history")
    .mockRejectedValueOnce(new Error("Offline"));
  try {
    render(
      <MenuRoot>
        <MenuTrigger>Actions</MenuTrigger>
        <MenuPopup>
          <NoteHistoryMenu
            note={note}
            workspace={workspace}
            disabled={false}
            onSelect={vi.fn()}
          />
        </MenuPopup>
      </MenuRoot>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Actions" }));
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Revision history" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("Offline");
    await userEvent.click(
      screen.getByRole("menuitem", { name: "Retry history" }),
    );
    await screen.findByRole("menuitem", { name: /Plan/ });
    expect(history).toHaveBeenCalledTimes(2);
  } finally {
    cleanup();
    workspace.dispose();
    fixture.dispose();
  }
});

it("uses the channel member picker while guarding a pending explicit invitation", async () => {
  const fixture = await notesFixture();
  const workspace = createNotesWorkspace(fixture.session);
  const note = fixture.seed("Plan", "Original");
  const onClose = vi.fn();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = workspace.setMember;
  const member = vi
    .spyOn(workspace, "setMember")
    .mockImplementation(async (...args) => {
      await gate;
      return original(...args);
    });
  const props = { note, workspace, onClose, trigger: { current: null } };
  try {
    const view = render(<NoteSharing {...props} />);
    await screen.findByRole("searchbox", { name: "Search people and agents" });
    expect(
      screen.queryByRole("checkbox", {
        name: "Share with my agents automatically",
      }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("combobox", { name: "General access" }),
    ).not.toBeInTheDocument();
    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search people and agents" }),
      { target: { value: "Sam" } },
    );
    await userEvent.click(
      await screen.findByRole("button", { name: /^Add Sam \([^)]+\)$/ }),
    );
    await waitFor(() => expect(member).toHaveBeenCalledOnce());
    // The document refreshes its Note object after membership updates.
    view.rerender(<NoteSharing {...props} note={{ ...note }} />);
    try {
      expect(screen.getByRole("button", { name: "Done" })).toBeDisabled();
      await userEvent.click(screen.getByRole("button", { name: "Close" }));
      expect(onClose).not.toHaveBeenCalled();
    } finally {
      release();
    }
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Done" })).toBeEnabled(),
    );
  } finally {
    release();
    cleanup();
    workspace.dispose();
    fixture.dispose();
  }
});
