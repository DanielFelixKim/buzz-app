import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  NoteConflict,
  noteKey,
  noteTag,
  noteUrl,
  parseNoteUrl,
  type Note,
  type NoteAddress,
} from "../../features/notes/model";
import type { NotesWorkspace } from "../../features/notes/workspace";
import { useIdentityNames } from "../../features/identity-names/react";
import { avatarMedia } from "../../shared/avatar-source";
import { writeClipboardText } from "../../shared/clipboard";
import { formatPublicKey } from "../../shared/identity/public-key";
import {
  MAX_MARKDOWN_LENGTH,
  safeLinkUrl,
  scanMarkdown,
} from "../../features/relay/message-content";
import {
  ArrowsClockwiseIcon,
  DotsThreeIcon,
  ShareIcon,
} from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Field } from "../../shared/design-system/ui/Field";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Input } from "../../shared/design-system/ui/Input";
import {
  MenuItem,
  MenuNote,
  MenuPopup,
  MenuRoot,
  MenuSubmenu,
  MenuSubmenuPopup,
  MenuSubmenuTrigger,
  MenuTrigger,
} from "../../shared/design-system/ui/Menu";
import { Select } from "../../shared/design-system/ui/Select";
import { NoteHistory, NoteSharing } from "./NoteDialogs";
import { NoteEditor, type NoteEditorHandle } from "./NoteEditor";
import { NoteByline } from "./NoteMetadata";
import readerStyles from "./NotesPage.module.css";
import styles from "./WorkingNotes.module.css";
import type { DocumentView } from "./working-route";

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "The note could not be read.";
const nothing = () => {};

export function NoteDocument({
  address,
  workspace,
  catalogue = [],
  partial = false,
  onOpen,
  onChange = nothing,
  onDirty = nothing,
  onUnavailable = nothing,
  view,
  onViewChange,
  active = true,
}: {
  address: NoteAddress;
  workspace: NotesWorkspace;
  catalogue?: readonly Note[];
  partial?: boolean;
  onOpen(address: NoteAddress): void;
  onChange?(note: Note): void;
  onDirty?(dirty: boolean): void;
  onUnavailable?(address: NoteAddress): void;
  view?: DocumentView | undefined;
  onViewChange?: ((view: DocumentView) => void) | undefined;
  active?: boolean;
}) {
  const cachedDraft = useRef(workspace.drafts.get(noteKey(address))).current;
  const [note, setNote] = useState<Note | undefined>(cachedDraft?.base);
  const [title, setTitle] = useState(cachedDraft?.title ?? "");
  const [markdown, setMarkdown] = useState(cachedDraft?.markdown ?? "");
  const [localEditing, setLocalEditing] = useState(true);
  const [source, setSource] = useState(false);
  const [canEdit, setCanEdit] = useState(false);
  const [busy, setBusy] = useState(false);
  const shareTrigger = useRef<HTMLButtonElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const editor = useRef<NoteEditorHandle>(null);
  const blankPress = useRef(false);
  const [toolbarTarget, setToolbarTarget] = useState<HTMLDivElement | null>(
    null,
  );
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [unavailable, setUnavailable] = useState(!!cachedDraft);
  const [conflict, setConflict] = useState<Note>();
  const [restoreFrom, setRestoreFrom] = useState<Note | undefined>(
    cachedDraft?.restoreFrom,
  );
  const dirty = !!note && (title !== note.title || markdown !== note.markdown);
  const editing =
    (view ? (view.edit ?? true) : localEditing) &&
    ((canEdit && !note?.deleted) || dirty || !!restoreFrom);
  const [localDialog, setLocalDialog] = useState<
    "share" | "history" | "link" | "delete" | undefined
  >();
  const dialog = active ? (view ? view.dialog : localDialog) : undefined;
  const presentation = useRef({ view, onViewChange, editing });
  presentation.current = { view, onViewChange, editing };
  const setEditing = useCallback((edit: boolean) => {
    setLocalEditing(edit);
    const current = presentation.current;
    if (current.editing !== edit)
      current.onViewChange?.({ ...current.view, edit });
  }, []);
  const setDialog = useCallback((next: DocumentView["dialog"]) => {
    setLocalDialog(next);
    const current = presentation.current;
    if (current.view?.dialog !== next)
      current.onViewChange?.({
        edit: current.editing,
        ...(next ? { dialog: next } : {}),
      });
  }, []);
  const latest = useRef({ note, editing, title, markdown });
  latest.current = { note, editing, title, markdown };
  const callbacks = useRef({ onChange, onDirty, onUnavailable });
  callbacks.current = { onChange, onDirty, onUnavailable };
  const community = workspace.session.scope.replace(/:[0-9a-f]{64}$/, "");
  useEffect(() => {
    const key = noteKey(address);
    if (note && dirty)
      workspace.drafts.set(key, {
        base: note,
        title,
        markdown,
        ...(restoreFrom ? { restoreFrom } : {}),
      });
    else workspace.drafts.delete(key);
  }, [workspace, address, note, dirty, title, markdown, restoreFrom]);
  useEffect(() => {
    callbacks.current.onDirty(dirty);
  }, [dirty]);
  useEffect(() => {
    if (!dirty) return;
    const prevent = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [dirty]);
  const adopt = useCallback((next: Note) => {
    setNote(next);
    setTitle(next.title);
    setMarkdown(next.markdown);
    setConflict(undefined);
    setRestoreFrom(undefined);
    callbacks.current.onChange(next);
  }, []);
  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      setBusy(true);
      setError("");
      try {
        const current = await workspace.open(address, signal);
        const roles = await workspace.authority(current.channel, signal);
        signal?.throwIfAborted();
        setUnavailable(false);
        setCanEdit(
          ["owner", "admin", "member", "bot"].includes(
            roles.roles[workspace.session.viewer ?? ""] ?? "",
          ) && current.editable,
        );
        const previous = latest.current;
        if (
          (previous.editing || workspace.drafts.has(noteKey(address))) &&
          previous.note &&
          previous.note.revision !== current.revision
        )
          setConflict(current);
        else if (!previous.editing && !workspace.drafts.has(noteKey(address)))
          adopt(current);
        callbacks.current.onChange(current);
      } catch (error) {
        if (!signal?.aborted) {
          setError(errorText(error));
          setCanEdit(false);
          setUnavailable(true);
          setDialog(undefined);
          setConflict(undefined);
          callbacks.current.onUnavailable(address);
        }
      } finally {
        if (!signal?.aborted) setBusy(false);
      }
    },
    [workspace, address, adopt, setDialog],
  );
  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);
  useEffect(() => {
    const roster = () =>
      workspace.session.channels.get?.(address.channel)?.members?.join(":");
    let prior = roster();
    return workspace.session.channels.subscribeList(() => {
      const next = roster();
      if (next === prior) return;
      const known = prior !== undefined;
      prior = next;
      if (known) void refresh();
    });
  }, [workspace, address, refresh]);
  const currentRevision = note?.revision;
  const profiles = useSyncExternalStore(
    workspace.session.profiles.subscribe,
    workspace.session.profiles.snapshot,
  );
  const resolveName = useIdentityNames(workspace.session.names);
  const author = note?.event.pubkey ?? "";
  const profile = profiles.get(author);
  const authorName =
    author === workspace.session.viewer
      ? "You"
      : resolveName(author, profile?.name ?? formatPublicKey(author) ?? author);
  useEffect(
    () =>
      workspace.session.subscribeLive(({ events }) => {
        if (
          events.some(
            (event) =>
              event.kind === 45010 &&
              event.id !== currentRevision &&
              noteTag(event, "d") === address.id &&
              noteTag(event, "h") === address.channel,
          )
        )
          void refresh();
      }),
    [workspace, address, currentRevision, refresh],
  );
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setStatus("");
    try {
      await action();
    } catch (error) {
      if (error instanceof NoteConflict) setConflict(error.current);
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  };
  const save = () => {
    if (note)
      void run(async () => {
        const next = await workspace.save(
          note,
          { title, markdown, ...(restoreFrom ? { restoreFrom } : {}) },
          note.deleted ? "restore" : "update",
        );
        adopt(next);
        setEditing(false);
        setStatus("Saved");
      });
  };
  const backlinks = useMemo(
    () =>
      catalogue.filter(
        (source) =>
          !source.deleted &&
          source.markdown.length <= MAX_MARKDOWN_LENGTH &&
          noteKey(source) !== noteKey(address) &&
          scanMarkdown(source.markdown).links.some((link) => {
            const target =
              typeof link.url === "string" ? parseNoteUrl(link.url) : undefined;
            return (
              target?.community === community &&
              noteKey(target) === noteKey(address)
            );
          }),
      ),
    [catalogue, address, community],
  );
  const exportMarkdown = () => {
    if (!note) return;
    const url = URL.createObjectURL(
      new Blob([editing || dirty ? markdown : note.markdown], {
        type: "text/markdown;charset=utf-8",
      }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `${(editing ? title : note.title).replace(/[^\p{L}\p{N}._ -]/gu, "_").slice(0, 80) || "note"}.md`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const copyLink = () => {
    void run(async () => {
      await writeClipboardText(noteUrl(address, community));
      setStatus("Note link copied");
    });
  };
  return (
    <article
      className={styles.documentPane}
      aria-label={!unavailable && note ? note.title : "Working note"}
    >
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: blank-space clicks extend the existing textbox hit area; keyboard users reach that textbox with Tab. */}
      <section
        className={readerStyles.document}
        aria-label="Note contents"
        onPointerDown={(event) => {
          blankPress.current = event.target === event.currentTarget;
        }}
        onClick={(event) => {
          const startedOnBlank = blankPress.current;
          blankPress.current = false;
          if (
            !startedOnBlank ||
            !editing ||
            !canEdit ||
            busy ||
            event.button !== 0 ||
            event.metaKey ||
            event.ctrlKey ||
            event.altKey ||
            event.shiftKey ||
            event.target !== event.currentTarget ||
            !body.current ||
            event.clientY < body.current.getBoundingClientRect().bottom
          )
            return;
          editor.current?.focusEnd();
        }}
      >
        {note && canEdit && !unavailable && !note.deleted ? (
          <Field label="Title" labelVisibility="hidden">
            <Input
              appearance="heading"
              value={title}
              onValueChange={setTitle}
              disabled={busy}
              readOnly={!editing}
              tabIndex={editing ? undefined : -1}
            />
          </Field>
        ) : (
          <h2 className="text-heading">
            {!unavailable && note ? note.title : "Working note"}
          </h2>
        )}
        {note && !unavailable && (
          <NoteByline
            note={note.event}
            author={authorName}
            picture={avatarMedia(profile?.picture, workspace.session.media)}
          />
        )}
        <div className={styles.actions}>
          {note && canEdit && !note.deleted && (
            <Select
              label="Document mode"
              variant="compact"
              size="sm"
              value={editing ? "editing" : "viewing"}
              disabled={busy}
              groups={[
                {
                  label: "Document mode",
                  options: [
                    { value: "viewing", label: "Viewing" },
                    { value: "editing", label: "Editing" },
                  ],
                },
              ]}
              onValueChange={(mode) => {
                setStatus("");
                setEditing(mode === "editing");
              }}
            />
          )}
          <IconButton
            aria-label="Refresh note"
            title="Refresh note"
            icon={
              <ArrowsClockwiseIcon
                size={16}
                aria-hidden="true"
                className={busy ? "motion-safe:animate-spin" : undefined}
              />
            }
            aria-busy={busy}
            disabled={busy}
            onClick={() => {
              void refresh();
            }}
          />
          {note && !unavailable && (
            <>
              <IconButton
                ref={shareTrigger}
                aria-label="Share note"
                title="Share note"
                icon={<ShareIcon size={16} />}
                onClick={() => setDialog("share")}
              />
              <MenuRoot>
                <MenuTrigger
                  render={
                    <IconButton
                      aria-label="Note actions"
                      title="Note actions"
                      icon={<DotsThreeIcon size={16} />}
                    />
                  }
                />
                <MenuPopup>
                  <MenuItem onClick={copyLink}>Copy note link</MenuItem>
                  {canEdit && !note.deleted && (
                    <MenuItem
                      disabled={busy}
                      onClick={() => {
                        setSource(editing ? !source : true);
                        setEditing(true);
                      }}
                    >
                      {editing && source ? "Formatted text" : "Markdown source"}
                    </MenuItem>
                  )}
                  {!note.deleted && (
                    <MenuSubmenu>
                      <MenuSubmenuTrigger>Linked notes</MenuSubmenuTrigger>
                      <MenuSubmenuPopup aria-label="Linked notes">
                        {backlinks.map((source) => (
                          <MenuItem
                            key={noteKey(source)}
                            onClick={() => onOpen(source)}
                          >
                            {source.title}
                          </MenuItem>
                        ))}
                        {!backlinks.length && (
                          <MenuNote>No links from the loaded notes.</MenuNote>
                        )}
                        {partial && (
                          <MenuNote>
                            More notes are available in the browser. Linked
                            notes cover the loaded notes.
                          </MenuNote>
                        )}
                      </MenuSubmenuPopup>
                    </MenuSubmenu>
                  )}
                  <MenuItem onClick={() => setDialog("history")}>
                    Revision history
                  </MenuItem>
                  <MenuItem onClick={exportMarkdown}>Export Markdown</MenuItem>
                  {canEdit && !note.deleted && (
                    <MenuItem
                      disabled={busy || dirty}
                      onClick={() => setDialog("delete")}
                    >
                      Delete note
                    </MenuItem>
                  )}
                </MenuPopup>
              </MenuRoot>
            </>
          )}
        </div>
        {error && <p role="alert">{error}</p>}
        {status && (
          <p role="status" className="text-caption text-subtle">
            {status}
          </p>
        )}
        {note && !unavailable && !canEdit && !note.deleted && (
          <p className="text-caption text-subtle">
            {note.editable
              ? "You have read access."
              : "This document format is read-only in this version of Buzz."}
          </p>
        )}
        {note?.deleted && !unavailable && !editing && (
          <div className={styles.stack}>
            <p>
              This note was deleted. Its retained history and sharing remain
              available.
            </p>
            {canEdit && (
              <Button onClick={() => setDialog("history")}>
                Choose a revision to restore
              </Button>
            )}
          </div>
        )}
        {note && (editing || (!unavailable && !note.deleted)) && (
          <div ref={body} className={styles.stack}>
            <NoteEditor
              ref={editor}
              source={source}
              onSourceChange={setSource}
              toolbarTarget={toolbarTarget}
              value={markdown}
              editing={editing}
              onChange={setMarkdown}
              disabled={busy}
              notes={catalogue}
              community={community}
              linkOpen={dialog === "link"}
              onLinkOpenChange={(open) => setDialog(open ? "link" : undefined)}
              onSave={save}
            >
              <NoteMarkdown
                text={markdown}
                community={community}
                onOpen={onOpen}
              />
            </NoteEditor>
          </div>
        )}
        {note && (dirty || restoreFrom) && (
          <div className={styles.saveBar}>
            <Button
              variant="prominent"
              size="lg"
              loading={busy}
              disabled={busy || !!conflict || !canEdit}
              onClick={save}
            >
              {note.deleted ? "Restore note" : "Save"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => {
                adopt(note);
                setEditing(false);
              }}
            >
              Discard changes
            </Button>
          </div>
        )}
        {note && dialog === "share" && (
          <NoteSharing
            note={note}
            workspace={workspace}
            trigger={shareTrigger}
            onClose={() => setDialog(undefined)}
          />
        )}
        {note && dialog === "history" && (
          <NoteHistory
            note={note}
            workspace={workspace}
            canEdit={canEdit}
            selection={view}
            onSelection={(revision) =>
              presentation.current.onViewChange?.({
                ...presentation.current.view,
                revision,
              })
            }
            onPage={(offset) => {
              const { revision: _revision, ...rest } =
                presentation.current.view ?? {};
              presentation.current.onViewChange?.({ ...rest, offset });
            }}
            onClose={() => setDialog(undefined)}
            onUse={(revision) => {
              setRestoreFrom(note.deleted ? revision : undefined);
              setTitle(revision.title);
              setMarkdown(revision.markdown);
              setLocalEditing(true);
              setLocalDialog(undefined);
              presentation.current.onViewChange?.({ edit: true });
            }}
          />
        )}
        {note && dialog === "delete" && (
          <Dialog
            open
            onOpenChange={(open) => {
              if (!open) setDialog(undefined);
            }}
            title="Delete this note?"
            description="You can restore it from retained history."
            preventClose={busy}
            actions={
              <>
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => setDialog(undefined)}
                >
                  Cancel
                </Button>
                <Button
                  disabled={busy}
                  onClick={() => {
                    void run(async () => {
                      adopt(
                        await workspace.save(
                          note,
                          { title: note.title, markdown: "" },
                          "delete",
                        ),
                      );
                      setDialog(undefined);
                    });
                  }}
                >
                  Delete note
                </Button>
              </>
            }
          />
        )}
        {conflict && active && (
          <Dialog
            open
            onOpenChange={() => {}}
            title="This note has a newer revision"
            description="Compare the latest contents with your unsaved draft before choosing what to keep."
            size="wide"
            preventClose
            actions={
              <>
                <Button
                  onClick={() => {
                    adopt(conflict);
                    setEditing(false);
                    setError("");
                  }}
                >
                  Use latest version
                </Button>
                <Button
                  disabled={conflict.deleted || !conflict.editable}
                  onClick={() => {
                    setNote(conflict);
                    setConflict(undefined);
                    setError("");
                  }}
                >
                  I’ve compared; keep my draft
                </Button>
              </>
            }
          >
            <h2 className="text-label">{conflict.title}</h2>
            <pre className={styles.source}>
              {conflict.markdown ||
                (conflict.deleted ? "The note was deleted." : "Empty note")}
            </pre>
          </Dialog>
        )}
      </section>
      <div
        ref={setToolbarTarget}
        className={styles.editorDock}
        hidden={!editing || source}
      />
    </article>
  );
}

export function NoteMarkdown({
  text,
  community,
  onOpen,
}: {
  text: string;
  community: string;
  onOpen(address: NoteAddress): void;
}) {
  const scanned = useMemo(
    () => (text.length <= MAX_MARKDOWN_LENGTH ? scanMarkdown(text) : undefined),
    [text],
  );
  if (!scanned || scanned.tooDeep)
    return (
      <div className={readerStyles.markdown}>
        <pre>{text}</pre>
      </div>
    );
  return (
    <div className={readerStyles.markdown}>
      <Markdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        urlTransform={(url) => (parseNoteUrl(url) ? url : safeLinkUrl(url))}
        components={{
          a: ({ href, children }) => {
            const note = href ? parseNoteUrl(href) : undefined;
            if (note)
              return note.community === community ? (
                <a
                  href={href}
                  onClick={(event) => {
                    event.preventDefault();
                    onOpen(note);
                  }}
                >
                  {children}
                </a>
              ) : (
                <span>{children} (another community)</span>
              );
            return href ? (
              <a href={href} target="_blank" rel="noreferrer noopener">
                {children}
              </a>
            ) : (
              <span>{children}</span>
            );
          },
          img: ({ alt }) => (alt ? <span>{alt}</span> : null),
        }}
      >
        {text}
      </Markdown>
    </div>
  );
}
