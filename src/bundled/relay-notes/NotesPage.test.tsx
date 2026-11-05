// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { useRef, useState } from "react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { noteKey, noteUrl } from "../../features/notes/model";
import { notesFixture } from "../../features/notes/testing";
import { NotesPage, type NotesPageProps } from "./NotesPage";

const dispose: (() => void)[] = [];
afterEach(() => {
  cleanup();
  for (const stop of dispose.splice(0)) stop();
});
async function fixture() {
  const f = await notesFixture();
  dispose.push(f.dispose);
  const first = f.seed("First note", "Earlier findings");
  const latest = f.seed("Latest note", "Searchable body");
  const props: NotesPageProps = {
    community: f.origin,
    entries: [first, latest],
    items: [],
    selected: "browse",
    query: "",
    trash: false,
    searchRef: { current: null },
    loading: false,
    more: false,
    error: "",
    search: vi.fn(),
    showDeleted: vi.fn(),
    create: vi.fn(),
    refresh: vi.fn(),
    loadMore: vi.fn(),
    open: vi.fn(),
    browse: vi.fn(),
  };
  return { f, first, latest, props };
}

it("shows only title links in revision order and opens the selected channel-backed document", async () => {
  const { first, latest, props } = await fixture();
  const user = userEvent.setup();
  const view = render(<NotesPage {...props} />);
  const list = screen.getByRole("list", { name: "Notes" });
  expect(
    within(list)
      .getAllByRole("link")
      .map((link) => link.textContent),
  ).toEqual(["Latest note", "First note"]);
  expect(list).not.toHaveTextContent("Searchable body");
  expect(
    within(list)
      .getAllByRole("listitem")
      .map((row) => row.textContent?.trim()),
  ).toEqual(["Latest note", "First note", "New note"]);
  expect(
    within(list).getByRole("button", { name: "New note" }),
  ).toHaveAttribute("data-variant", "text");
  expect(screen.getByRole("link", { name: "Latest note" })).toHaveAttribute(
    "href",
    noteUrl(latest, props.community),
  );
  await user.click(screen.getByRole("link", { name: "Latest note" }));
  expect(props.open).toHaveBeenCalledWith(latest);
  const updated = {
    ...first,
    event: { ...first.event, created_at: latest.event.created_at + 1 },
  };
  view.rerender(<NotesPage {...props} entries={[updated, latest]} />);
  expect(
    within(list)
      .getAllByRole("link")
      .map((link) => link.textContent),
  ).toEqual(["First note", "Latest note"]);
  expect(
    within(list)
      .getAllByRole("listitem")
      .map((row) => row.textContent?.trim()),
  ).toEqual(["First note", "Latest note", "New note"]);
});

it("retains mounted editor state across Back and focuses the full-view Back button", async () => {
  const { first, latest, props } = await fixture();
  const user = userEvent.setup();
  function Host() {
    const [selected, select] = useState("browse");
    const searchRef = useRef<HTMLElement>(null);
    return (
      <NotesPage
        {...props}
        selected={selected}
        searchRef={searchRef}
        open={(note) => select(noteKey(note))}
        browse={() => select("browse")}
        items={[first, latest].map((note) => ({
          id: noteKey(note),
          label: note.title,
          content: (
            <label>
              {note.title} draft
              <input defaultValue="" />
            </label>
          ),
        }))}
      />
    );
  }
  render(<Host />);
  await user.click(screen.getByRole("link", { name: "First note" }));
  expect(screen.getByRole("button", { name: "Back to notes" })).toHaveFocus();
  await user.type(
    screen.getByRole("textbox", { name: "First note draft" }),
    "Unsaved work",
  );
  await user.click(screen.getByRole("button", { name: "Back to notes" }));
  await user.click(screen.getByRole("link", { name: "Latest note" }));
  expect(
    screen.queryByRole("textbox", { name: "First note draft" }),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Back to notes" }));
  await user.click(screen.getByRole("link", { name: "First note" }));
  expect(screen.getByRole("textbox", { name: "First note draft" })).toHaveValue(
    "Unsaved work",
  );
});

it("keeps loading and failed reads distinct from empty and retains useful content for refresh recovery", async () => {
  const { props } = await fixture();
  const user = userEvent.setup();
  const view = render(<NotesPage {...props} entries={[]} loading />);
  expect(screen.getByRole("button", { name: "Refresh notes" })).toHaveAttribute(
    "aria-busy",
    "true",
  );
  expect(screen.queryByText("No notes yet")).not.toBeInTheDocument();
  view.rerender(<NotesPage {...props} error="Cannot read notes" />);
  expect(screen.getByRole("alert")).toHaveTextContent("Cannot read notes");
  expect(screen.getByRole("link", { name: "Latest note" })).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Refresh notes" }));
  expect(props.refresh).toHaveBeenCalledOnce();
  view.rerender(<NotesPage {...props} entries={[]} />);
  expect(screen.getByText("No notes yet")).toBeVisible();
  expect(screen.getByRole("button", { name: "New note" })).toBeVisible();
});

it("searches loaded documents and delegates filters, creation and pagination to the workspace", async () => {
  const { props } = await fixture();
  const user = userEvent.setup();
  const view = render(<NotesPage {...props} query="searchable" more />);
  expect(screen.getAllByRole("link").map((link) => link.textContent)).toEqual([
    "Latest note",
  ]);
  const filter = screen.getByRole("button", { name: "Filter notes" });
  expect(
    screen.queryByRole("checkbox", { name: "Show deleted notes" }),
  ).not.toBeInTheDocument();
  await user.click(filter);
  const deleted = await screen.findByRole("menuitemcheckbox", {
    name: "Show deleted notes",
  });
  expect(deleted).not.toBeChecked();
  await user.click(deleted);
  expect(vi.mocked(props.showDeleted).mock.calls[0]?.[0]).toBe(true);
  view.rerender(<NotesPage {...props} query="searchable" more trash />);
  await user.click(filter);
  expect(
    await screen.findByRole("menuitemcheckbox", { name: "Show deleted notes" }),
  ).toBeChecked();
  await user.keyboard("{Escape}");
  expect(filter).toHaveFocus();
  await user.click(screen.getByRole("button", { name: "New note" }));
  expect(props.create).toHaveBeenCalledOnce();
  await user.click(screen.getByRole("button", { name: "Load more notes" }));
  expect(props.loadMore).toHaveBeenCalledOnce();
  await user.click(screen.getByRole("searchbox", { name: "Search notes" }));
  await user.keyboard("{Enter}");
  expect(props.search).toHaveBeenCalledWith("searchable", true);
  view.rerender(<NotesPage {...props} query="no results" />);
  expect(screen.getByText("No matching notes.")).toBeVisible();
  expect(screen.queryAllByRole("link")).toHaveLength(0);
});

it("explains sharing and retained history with standard popup focus return", async () => {
  const { props } = await fixture();
  const user = userEvent.setup();
  render(<NotesPage {...props} />);
  const about = screen.getByRole("button", { name: "About notes" });
  await user.click(about);
  expect(
    await screen.findByText(/Access includes retained revisions/),
  ).toBeVisible();
  expect(screen.getByText(/relay operator can read/)).toBeVisible();
  await user.keyboard("{Escape}");
  expect(about).toHaveFocus();
});
