import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { noteKey, noteUrl, type Note } from "../../features/notes/model";
import {
  ArrowLeftIcon,
  ArrowsClockwiseIcon,
  Filter2Icon,
  InfoIcon,
  NoteIcon,
  PlusIcon,
} from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Panel } from "../../shared/design-system/ui/Panel";
import {
  PanelHeader,
  PanelHeaderLabel,
} from "../../shared/design-system/ui/PanelHeader";
import {
  PopoverRoot,
  PopoverTrigger,
  PopoverPopup,
  PopoverTitle,
  PopoverDescription,
} from "../../shared/design-system/ui/Popover";
import { SearchField } from "../../shared/design-system/ui/SearchField";
import {
  MenuRoot,
  MenuTrigger,
  MenuPopup,
  MenuCheckboxItem,
} from "../../shared/design-system/ui/Menu";
import styles from "./NotesPage.module.css";

export type NotesPageProps = {
  community: string;
  entries: readonly Note[];
  items: readonly { id: string; label: string; content: ReactNode }[];
  selected: string;
  query: string;
  trash: boolean;
  searchRef: RefObject<HTMLElement | null>;
  loading: boolean;
  more: boolean;
  error: string;
  search(query: string, commit?: boolean): void;
  showDeleted(value: boolean): void;
  create(): void;
  refresh(): void;
  loadMore(): void;
  open(note: Note): void;
  browse(): void;
};

/** The workspace owns discovery, access, drafts and navigation. This page renders its documents. */
export function NotesPage({
  community,
  entries,
  items,
  selected,
  query,
  trash,
  searchRef,
  loading,
  more,
  error,
  search,
  showDeleted,
  create,
  refresh,
  loadMore,
  open,
  browse,
}: NotesPageProps) {
  const backRef = useRef<HTMLButtonElement>(null);
  const reading = selected !== "browse";
  useEffect(() => {
    if (selected !== "browse" && !selected.startsWith("new:"))
      backRef.current?.focus();
  }, [selected]);
  const match = query.toLowerCase();
  const visible = entries
    .filter((note) =>
      `${note.title}\n${note.markdown}\n${note.event.pubkey}`
        .toLowerCase()
        .includes(match),
    )
    .sort(
      (a, b) =>
        b.event.created_at - a.event.created_at ||
        a.event.id.localeCompare(b.event.id),
    );
  const active = items.find((item) => item.id === selected);
  const titleLink = (note: Note) => (
    <li key={noteKey(note)}>
      <a
        className="text-body"
        href={noteUrl(note, community)}
        onClick={(event) => {
          if (
            event.button !== 0 ||
            event.metaKey ||
            event.ctrlKey ||
            event.shiftKey ||
            event.altKey
          )
            return;
          event.preventDefault();
          open(note);
        }}
      >
        {note.title}
      </a>
    </li>
  );
  return (
    <div className={styles.page}>
      <div className={styles.collection} hidden={reading}>
        <Panel aria-label="Notes">
          <div className={styles.page}>
            <PanelHeader
              title={
                <PanelHeaderLabel title="Notes" icon={<NoteIcon size={16} />}>
                  <PopoverRoot>
                    <PopoverTrigger
                      render={
                        <IconButton
                          aria-label="About notes"
                          title="About notes"
                          icon={<InfoIcon size={16} />}
                        />
                      }
                    />
                    <PopoverPopup>
                      <PopoverTitle>About notes</PopoverTitle>
                      <PopoverDescription
                        render={<div className={styles.description} />}
                      >
                        <p>
                          Create documents with people and agents. Open a title
                          to read or edit the note, then use Back to notes to
                          return to the list.
                        </p>
                        <p>
                          Each note has its own sharing settings. Access
                          includes retained revisions. The relay operator can
                          read note contents. Don’t include secrets.
                        </p>
                      </PopoverDescription>
                    </PopoverPopup>
                  </PopoverRoot>
                </PanelHeaderLabel>
              }
              actions={
                <IconButton
                  aria-label="Refresh notes"
                  title="Refresh notes"
                  icon={
                    <ArrowsClockwiseIcon
                      size={16}
                      className={
                        loading ? "motion-safe:animate-spin" : undefined
                      }
                    />
                  }
                  aria-busy={loading}
                  disabled={loading}
                  onClick={refresh}
                />
              }
            />
            <div className={styles.body}>
              <SearchField
                inputRef={searchRef}
                label="Search notes"
                placeholder="Search loaded notes…"
                value={query}
                onValueChange={(value) => search(value)}
                onBlur={() => search(query, true)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") search(query, true);
                }}
                trailing={
                  <MenuRoot>
                    <MenuTrigger
                      render={
                        <IconButton
                          aria-label="Filter notes"
                          title="Filter notes"
                          variant={trash ? "prominent" : "ghost"}
                          icon={<Filter2Icon size={16} aria-hidden="true" />}
                        />
                      }
                    />
                    <MenuPopup align="end">
                      <MenuCheckboxItem
                        checked={trash}
                        onCheckedChange={showDeleted}
                        closeOnClick
                      >
                        Show deleted notes
                      </MenuCheckboxItem>
                    </MenuPopup>
                  </MenuRoot>
                }
              />
              {loading && (
                <span role="status" className="sr-only">
                  Reading notes…
                </span>
              )}
              {error && <p role="alert">{error}</p>}
              {!loading && !error && !entries.length && !query && (
                <EmptyState
                  icon={<NoteIcon size={24} />}
                  title="No notes yet"
                  description="Create a note or ask an agent to save one."
                />
              )}
              <ul className={styles.titleList} aria-label="Notes">
                <li key="new-note">
                  <Button variant="subtle" size="sm" onClick={create}>
                    <PlusIcon size={16} aria-hidden="true" /> New note
                  </Button>
                </li>
                {visible.map(titleLink)}
              </ul>
              {!loading && !error && query && !visible.length && (
                <p role="status">No matching notes.</p>
              )}
              {more && (
                <div>
                  <Button size="sm" loading={loading} onClick={loadMore}>
                    Load more notes
                  </Button>
                </div>
              )}
            </div>
          </div>
        </Panel>
      </div>
      <div className={styles.fullView} hidden={!reading}>
        <Panel aria-label="Note details">
          <PanelHeader
            title={
              <PanelHeaderLabel
                title={active?.label ?? "Note"}
                icon={<NoteIcon size={16} />}
              />
            }
            navigation={
              <IconButton
                ref={backRef}
                aria-label="Back to notes"
                title="Back to notes"
                icon={<ArrowLeftIcon size={16} />}
                onClick={browse}
              />
            }
          />
          {items.map((item) => (
            <div
              key={item.id}
              className={styles.noteView}
              hidden={item.id !== selected}
            >
              {item.content}
            </div>
          ))}
        </Panel>
      </div>
    </div>
  );
}
