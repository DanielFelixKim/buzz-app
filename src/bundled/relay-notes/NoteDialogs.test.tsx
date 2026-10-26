// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { notesFixture } from "../../features/notes/testing";
import { createNotesWorkspace } from "../../features/notes/workspace";
import { NoteHistory } from "./NoteDialogs";

afterEach(cleanup);
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
