// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { notesFixture } from "../../features/notes/testing";
import { createNotesWorkspace } from "../../features/notes/workspace";
import { NoteHistory, NoteSharing } from "./NoteDialogs";

beforeEach(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});
it("restores the first history page when Back removes an explicit offset", async () => {
  const fixture = await notesFixture();
  const workspace = createNotesWorkspace(fixture.session);
  const note = fixture.seed("Plan", "Original");
  const history = vi
    .spyOn(workspace, "history")
    .mockImplementation(async (_note, offset) => ({
      revisions: [{ ...note, title: offset ? "Older plan" : "Current plan" }],
      more: !offset,
      limited: false,
    }));
  const onPage = vi.fn();
  const props = {
    note,
    workspace,
    canEdit: false,
    onUse: vi.fn(),
    onClose: vi.fn(),
    onPage,
  };
  try {
    const view = render(<NoteHistory {...props} selection={{}} />);
    await screen.findByRole("button", { name: /Current plan/ });
    fireEvent.click(
      screen.getByRole("button", { name: "Load older revisions" }),
    );
    expect(onPage).toHaveBeenCalledWith(100);
    view.rerender(<NoteHistory {...props} selection={{ offset: 100 }} />);
    await screen.findByRole("button", { name: /Older plan/ });
    view.rerender(<NoteHistory {...props} selection={{}} />);
    await screen.findByRole("button", { name: /Current plan/ });
    await waitFor(() => expect(history.mock.calls.at(-1)?.[1]).toBe(0));
    view.unmount();
  } finally {
    workspace.dispose();
    fixture.dispose();
  }
});

it("uses the channel member picker while guarding a pending automatic-agent policy change", async () => {
  const fixture = await notesFixture();
  const workspace = createNotesWorkspace(fixture.session);
  const note = fixture.seed("Plan", "Original");
  const onClose = vi.fn();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = workspace.setAudience;
  const audience = vi
    .spyOn(workspace, "setAudience")
    .mockImplementation(async (...args) => {
      await gate;
      return original(...args);
    });
  const props = { note, workspace, onClose, trigger: { current: null } };
  try {
    const view = render(<NoteSharing {...props} />);
    await screen.findByRole("searchbox", { name: "Search people and agents" });
    const toggle = await screen.findByRole("checkbox", {
      name: "Share with my agents automatically",
    });
    expect(toggle).toBeChecked();
    expect(
      screen.queryByRole("combobox", { name: "General access" }),
    ).not.toBeInTheDocument();
    fireEvent.click(toggle);
    await waitFor(() => expect(audience).toHaveBeenCalledOnce());
    // The document refreshes its Note object after membership updates.
    view.rerender(<NoteSharing {...props} note={{ ...note }} />);
    try {
      expect(toggle).toHaveAttribute("aria-disabled", "true");
      expect(screen.getByRole("button", { name: "Done" })).toBeDisabled();
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
      expect(onClose).not.toHaveBeenCalled();
    } finally {
      release();
    }
    await waitFor(() =>
      expect(
        screen.getByRole("checkbox", {
          name: "Share with my agents automatically",
        }),
      ).not.toBeChecked(),
    );
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
