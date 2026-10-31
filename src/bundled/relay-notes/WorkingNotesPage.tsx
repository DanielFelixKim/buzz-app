import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useAgentChoices } from "../../features/agents/use-choices";
import type { Navigation } from "../../features/navigation/controller";
import { targetKey } from "../../features/navigation/targets";
import {
  noteKey,
  noteAddress,
  noteUrl,
  parseNoteUrl,
  type Note,
  type NoteAddress,
} from "../../features/notes/model";
import type {
  NotesPage as CollectionPage,
  NotesWorkspace,
} from "../../features/notes/workspace";
import type { PageProps } from "../../features/pages/service";
import {
  PanelWorkspace,
  usePanelTabTitle,
} from "../../features/panels/PanelWorkspace";
import { usePanelSplit } from "../../features/panels/usePanelSplit";
import { PanelDock } from "../../features/panels/PanelDock";
import panelStyles from "../../features/panels/Panels.module.css";
import type { PanelProps, Panels } from "../../features/panels/service";
import { useRelayConnection } from "../../features/relay/react";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import {
  ArrowLeftIcon,
  ArrowsClockwiseIcon,
  NoteIcon,
  PlusIcon,
} from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { Checkbox } from "../../shared/design-system/ui/Checkbox";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import { Field } from "../../shared/design-system/ui/Field";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Input } from "../../shared/design-system/ui/Input";
import { Panel } from "../../shared/design-system/ui/Panel";
import {
  PanelHeader,
  PanelHeaderLabel,
} from "../../shared/design-system/ui/PanelHeader";
import { SearchField } from "../../shared/design-system/ui/SearchField";
import { SurfaceButton } from "../../shared/design-system/ui/SurfaceButton";
import { Textarea } from "../../shared/design-system/ui/Textarea";
import { NoteDocument } from "./NoteDocument";
import { NotesPage } from "./NotesPage";
import { notesRoute } from "./routes";
import { workingNotePreview, noteTitle as legacyTitle } from "./collection";
import styles from "./WorkingNotes.module.css";
import {
  workingRoute,
  workingTarget,
  type WorkingRoute,
} from "./working-route";

export type NotesOwner = (session: RelaySession) => NotesWorkspace;
type NewDraft = {
  id: string;
  title: string;
  markdown: string;
  copy?: boolean;
  agents?: boolean;
};
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "Notes could not be read.";

export function WorkingNotesPage({
  relay,
  getWorkspace,
  navigator,
  panels,
  ...props
}: PageProps & {
  relay: RelayData;
  getWorkspace: NotesOwner;
  navigator: Navigation;
  panels: Panels;
}) {
  const connection = useRelayConnection(relay);
  if (connection.status !== "ready")
    return (
      <Panel>
        <PanelHeader
          title={
            <PanelHeaderLabel title="Notes" icon={<NoteIcon size={16} />} />
          }
        />
        <div className={styles.browser}>
          <p role="status">
            {connection.status === "connecting"
              ? "Connecting to working notes…"
              : "Connect to your community to open notes."}
          </p>
          {connection.status === "error" && (
            <>
              <p role="alert">{connection.error}</p>
              <Button onClick={() => relay.retry()}>Retry connection</Button>
            </>
          )}
        </div>
      </Panel>
    );
  return (
    <WorkingNotesCommunity
      key={`${connection.scope}:${connection.generation}`}
      workspace={getWorkspace(connection.session)}
      relay={relay}
      navigator={navigator}
      panels={panels}
      {...props}
    />
  );
}

export function WorkingNotesCommunity({
  workspace,
  relay,
  navigator,
  panels,
  navigation,
}: PageProps & {
  workspace: NotesWorkspace;
  relay?: RelayData;
  navigator?: Navigation;
  panels?: Panels;
}) {
  const request = relay
    ? navigation?.forSession(relay, relay.snapshot())
    : undefined;
  const route =
    request?.target.kind === "page" ? request.target.route?.params : undefined;
  const destination = useMemo(() => workingRoute(route), [route]);
  const initial = useMemo(
    () => (destination?.view === "note" ? noteAddress(destination) : undefined),
    [destination],
  );
  const split = usePanelSplit(448, 320);
  const searchRef = useRef<HTMLElement>(null);
  const [legacy, setLegacy] = useState(!!notesRoute(route));
  const [collection, setCollection] = useState<CollectionPage>({
    notes: [],
    more: false,
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [sharingError, setSharingError] = useState("");
  const [query, setQuery] = useState(destination?.query ?? "");
  const [trash, setTrash] = useState(destination?.trash ?? false);
  const [creating, setCreating] = useState<NewDraft>();
  const drafts = useRef(new Map<string, NewDraft>());
  const [opened, setOpened] = useState<NoteAddress[]>(() =>
    initial ? [initial] : [],
  );
  const [selected, setSelected] = useState(
    initial ? noteKey(initial) : "browse",
  );
  const [closing, setClosing] = useState<string>();
  const dirty = useRef(new Set<string>());
  const reconciled = useRef(new Map<string, string>());
  const choices = useAgentChoices(workspace.session, true, true);
  const agentKeys = choices.complete
    ? choices.selectable
        .map((row) => row.pubkey)
        .sort()
        .join(":")
    : undefined;
  const loadId = useRef(0);
  const cursor = useRef(collection.cursor);
  cursor.current = collection.cursor;
  const load = useCallback(
    async (more = false) => {
      const id = ++loadId.current;
      setLoading(true);
      setError("");
      try {
        const page = await workspace.list(more ? cursor.current : undefined);
        if (loadId.current !== id) return;
        setCollection((old) => ({
          ...page,
          notes: more
            ? [
                ...new Map(
                  [...old.notes, ...page.notes].map((note) => [
                    noteKey(note),
                    note,
                  ]),
                ).values(),
              ]
            : page.notes,
        }));
      } catch (error) {
        if (loadId.current === id) setError(errorText(error));
      } finally {
        if (loadId.current === id) setLoading(false);
      }
    },
    [workspace],
  );
  useEffect(() => {
    void load();
    return () => {
      loadId.current++;
    };
  }, [load]);
  const reveal = useCallback((address: NoteAddress) => {
    setOpened((old) =>
      old.some((item) => noteKey(item) === noteKey(address))
        ? old
        : [...old, { id: address.id, channel: address.channel }],
    );
    setSelected(noteKey(address));
  }, []);
  const visit = useCallback(
    (next: WorkingRoute) => {
      if (
        !navigator ||
        !request ||
        request.signal.aborted ||
        request.target.kind !== "page" ||
        navigator.snapshot().entry.id !== request.entryId
      )
        return;
      const target = workingTarget(request.target, next);
      if (targetKey(target) === targetKey(navigator.snapshot().entry.target))
        return;
      void navigator.open(target, {
        focus: "preserve",
      });
    },
    [navigator, request],
  );
  const open = (address: NoteAddress) => {
    reveal(address);
    visit({ view: "note", ...noteAddress(address), query, trash });
  };
  const browse = () => {
    setSelected("browse");
    setCreating(undefined);
    visit({ view: "browse", query, trash });
    requestAnimationFrame(() => searchRef.current?.focus());
  };
  const newNote = (draft: Omit<NewDraft, "id">) => {
    const next = { ...draft, id: crypto.randomUUID() };
    drafts.current.set(next.id, next);
    setCreating(next);
    visit({ view: "new", draft: next.id, query, trash });
  };
  useEffect(() => {
    if (initial) reveal(initial);
    else if (destination) setSelected("browse");
    if (destination) {
      setQuery(destination.query ?? "");
      setTrash(destination.trash ?? false);
      setCreating(
        destination.view === "new" && destination.draft
          ? (drafts.current.get(destination.draft) ?? {
              id: destination.draft,
              title: "",
              markdown: "",
            })
          : undefined,
      );
    }
    setLegacy(!!notesRoute(route));
  }, [initial, route, destination, reveal]);
  useEffect(() => {
    if (agentKeys === undefined || choices.pending) return;
    const controller = new AbortController();
    void (async () => {
      for (const note of collection.notes) {
        controller.signal.throwIfAborted();
        if (reconciled.current.get(note.channel) === agentKeys) continue;
        await workspace.reconcile(note, controller.signal);
        reconciled.current.set(note.channel, agentKeys);
      }
      if (!controller.signal.aborted) setSharingError("");
    })().catch((error: unknown) => {
      if (!controller.signal.aborted) setSharingError(errorText(error));
    });
    return () => controller.abort();
  }, [workspace, collection.notes, agentKeys, choices.pending]);
  const changed = useCallback((note: Note) => {
    setCollection((old) =>
      old.notes.some(
        (item) =>
          noteKey(item) === noteKey(note) && item.revision === note.revision,
      )
        ? old
        : {
            ...old,
            notes: [
              note,
              ...old.notes.filter((item) => noteKey(item) !== noteKey(note)),
            ],
          },
    );
  }, []);
  const close = (key: string) => {
    if (dirty.current.has(key)) {
      setClosing(key);
      return;
    }
    setOpened((old) => old.filter((item) => noteKey(item) !== key));
    if (selected === key) browse();
  };
  const previews = useMemo(
    () =>
      new Map(
        collection.notes.map((note) => [
          noteKey(note),
          workingNotePreview(note.markdown),
        ]),
      ),
    [collection.notes],
  );
  const visible = collection.notes.filter(
    (note) =>
      (trash || !note.deleted) &&
      `${note.title}\n${note.markdown}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const creation = creating && (
    <NewNoteDialog
      workspace={workspace}
      initial={creating}
      onDraftChange={(draft) => drafts.current.set(draft.id, draft)}
      onClose={browse}
      onCreated={(note) => {
        changed(note);
        open(note);
        setCreating(undefined);
        setLegacy(false);
      }}
    />
  );
  if (legacy && relay)
    return (
      <div className={styles.page}>
        <div className={styles.actions}>
          <Button
            variant="ghost"
            onClick={() => {
              setLegacy(false);
              if (request?.target.kind === "page" && navigator) {
                const { route: _route, ...target } = request.target;
                void navigator.open(target);
              }
            }}
          >
            Back to working notes
          </Button>
        </div>
        <NotesPage
          relay={relay}
          navigation={navigation}
          navigator={navigator}
          panels={panels}
          onConvert={(note) =>
            newNote({
              title: legacyTitle(note),
              markdown: note.content,
              copy: true,
            })
          }
        />
        {creation}
      </div>
    );
  const readerOpen = selected !== "browse" && opened.length > 0;
  return (
    <div
      className={`${styles.split} ${panelStyles.splitMotion}`}
      ref={split.ref}
      data-side={readerOpen || undefined}
    >
      <div className={styles.main}>
        <Panel>
          <PanelHeader
            title={
              <PanelHeaderLabel title="Notes" icon={<NoteIcon size={16} />} />
            }
          />
          <div className={styles.browser}>
            <div className={styles.tools}>
              <SearchField
                inputRef={searchRef}
                label="Search working notes"
                placeholder="Search loaded notes…"
                value={query}
                onValueChange={setQuery}
                onBlur={() =>
                  visit({
                    ...(destination ?? { view: "browse" }),
                    query,
                    trash,
                  })
                }
                onKeyDown={(event) => {
                  if (event.key === "Enter")
                    visit({
                      ...(destination ?? { view: "browse" }),
                      query,
                      trash,
                    });
                }}
              />
              <Button onClick={() => newNote({ title: "", markdown: "" })}>
                <PlusIcon size={16} /> New note
              </Button>
              <IconButton
                aria-label="Refresh notes"
                title="Refresh notes"
                icon={<ArrowsClockwiseIcon size={16} />}
                disabled={loading}
                onClick={() => {
                  void load();
                }}
              />
            </div>
            <div className={styles.actions}>
              <Checkbox
                label="Show deleted notes"
                checked={trash}
                onCheckedChange={(value) => {
                  setTrash(value);
                  visit({
                    ...(destination ?? { view: "browse" }),
                    query,
                    trash: value,
                  });
                }}
              />
              {relay && (
                <Button
                  variant="ghost"
                  onClick={() => {
                    setLegacy(true);
                    if (request?.target.kind === "page" && navigator)
                      void navigator.open({
                        ...request.target,
                        route: { version: 1, params: { author: "" } },
                      });
                  }}
                >
                  Existing shared notes
                </Button>
              )}
            </div>
            {loading && (
              <p role="status" className="text-caption text-subtle">
                Reading notes…
              </p>
            )}
            {error && <p role="alert">{error}</p>}
            {sharingError && (
              <p role="alert">
                Automatic agent access needs attention: {sharingError}
              </p>
            )}
            {!loading && !error && !visible.length && (
              <EmptyState
                icon={<NoteIcon size={24} />}
                title={query ? "No matching notes" : "Your working notes"}
                description={
                  query
                    ? "Search covers the notes loaded below."
                    : "Create a plan, research note or guide to work on with your agents."
                }
              />
            )}
            {parseNoteUrl(query)?.community ===
              workspace.session.scope.replace(/:[0-9a-f]{64}$/, "") && (
              <Button
                onClick={() => {
                  const target = parseNoteUrl(query);
                  if (target) open(target);
                }}
              >
                Open linked note
              </Button>
            )}
            <div className={styles.cards}>
              {visible.map((note) => (
                <SurfaceButton
                  key={noteKey(note)}
                  className={styles.card}
                  aria-current={selected === noteKey(note) ? "true" : undefined}
                  onClick={() => open(note)}
                >
                  <span
                    className={`${styles.cardTitle} text-label`}
                    title={note.title}
                  >
                    {note.title}
                  </span>
                  <span
                    className={`${styles.preview} text-body-sm text-subtle`}
                  >
                    {note.deleted
                      ? "Deleted · retained history available"
                      : previews.get(noteKey(note)) || "Empty note"}
                  </span>
                </SurfaceButton>
              ))}
            </div>
            {collection.more && (
              <Button
                disabled={loading}
                onClick={() => {
                  void load(true);
                }}
              >
                Load more notes
              </Button>
            )}
            <p className="text-caption text-subtle">
              Share each note with people and agents. Access includes retained
              history.
            </p>
          </div>
        </Panel>
      </div>
      <PanelDock
        open={readerOpen}
        keepMounted
        className={styles.side}
        resizeHandle={split.handle}
      >
        <aside aria-label="Note editor">
          <Panel>
            <PanelWorkspace
              label="Open working notes"
              value={selected}
              select={(key) => {
                const address = opened.find((item) => noteKey(item) === key);
                if (address) open(address);
              }}
              items={opened.map((address) => {
                const key = noteKey(address);
                return {
                  id: key,
                  label:
                    collection.notes.find((note) => noteKey(note) === key)
                      ?.title ?? "Note",
                  toolbar: (
                    <IconButton
                      aria-label="Back to notes"
                      title="Back to notes"
                      icon={<ArrowLeftIcon size={16} />}
                      onClick={browse}
                    />
                  ),
                  close: () => close(key),
                  content: (
                    <NoteDocument
                      address={address}
                      workspace={workspace}
                      catalogue={collection.notes}
                      partial={collection.more}
                      active={selected === key && !legacy}
                      view={
                        selected === key && destination?.view === "note"
                          ? destination
                          : undefined
                      }
                      onViewChange={
                        selected === key
                          ? (view) =>
                              visit({
                                view: "note",
                                ...noteAddress(address),
                                query,
                                trash,
                                ...view,
                              })
                          : undefined
                      }
                      onOpen={open}
                      onUnavailable={(missing) =>
                        setCollection((old) => ({
                          ...old,
                          notes: old.notes.filter(
                            (note) => noteKey(note) !== noteKey(missing),
                          ),
                        }))
                      }
                      onChange={changed}
                      onDirty={(value) => {
                        if (value) dirty.current.add(key);
                        else dirty.current.delete(key);
                      }}
                    />
                  ),
                };
              })}
            />
          </Panel>
        </aside>
      </PanelDock>
      {creation}
      {closing && (
        <Dialog
          open
          title="Discard unsaved changes?"
          description="This note has a draft that has not been saved."
          onOpenChange={(open) => {
            if (!open) setClosing(undefined);
          }}
          actions={
            <>
              <Button onClick={() => setClosing(undefined)}>
                Keep editing
              </Button>
              <Button
                onClick={() => {
                  dirty.current.delete(closing);
                  close(closing);
                  setClosing(undefined);
                }}
              >
                Discard draft
              </Button>
            </>
          }
        />
      )}
    </div>
  );
}

function NewNoteDialog({
  workspace,
  initial,
  onCreated,
  onClose,
  onDraftChange,
}: {
  workspace: NotesWorkspace;
  initial: NewDraft;
  onDraftChange(draft: NewDraft): void;
  onCreated(note: Note): void;
  onClose(): void;
}) {
  const [id] = useState(initial.id);
  const [title, setTitle] = useState(initial.title);
  const [markdown, setMarkdown] = useState(initial.markdown);
  const [agents, setAgents] = useState(initial.agents ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [unverified, setUnverified] = useState<string[]>([]);
  const draftCallback = useRef(onDraftChange);
  draftCallback.current = onDraftChange;
  useEffect(() => {
    draftCallback.current({
      id,
      title,
      markdown,
      agents,
      ...(initial.copy ? { copy: true } : {}),
    });
  }, [id, title, markdown, agents, initial.copy]);
  return (
    <Dialog
      open
      title="New working note"
      description={
        initial.copy
          ? "Create a separate working copy. The original shared note stays readable."
          : undefined
      }
      size="wide"
      preventClose={busy}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      actions={
        <Button
          form={`new-note-${id}`}
          type="submit"
          disabled={busy || !title.trim()}
        >
          {busy
            ? "Creating…"
            : unverified.length && agents
              ? "Create with verified agents"
              : "Create note"}
        </Button>
      }
    >
      <form
        id={`new-note-${id}`}
        className={styles.stack}
        onSubmit={(event) => {
          event.preventDefault();
          setBusy(true);
          setError("");
          void (async () => {
            if (agents && !unverified.length) {
              const access = await workspace.agentAccess();
              if (access.unverified.length) {
                setUnverified(access.unverified);
                return undefined;
              }
            }
            return workspace.create({ id, title, markdown, agents });
          })()
            .then((note) => {
              if (note) onCreated(note);
            })
            .catch((error: unknown) => setError(errorText(error)))
            .finally(() => setBusy(false));
        }}
      >
        <Field label="Title">
          <Input
            autoFocus
            value={title}
            onValueChange={setTitle}
            disabled={busy}
            placeholder="Research, plan or guide"
          />
        </Field>
        <Field label="Markdown">
          <Textarea
            value={markdown}
            onChange={(event) => setMarkdown(event.target.value)}
            disabled={busy}
            rows={10}
          />
        </Field>
        <Checkbox
          label="Share with my agents"
          checked={agents}
          onCheckedChange={setAgents}
          disabled={busy}
        />
        <p className="text-caption text-subtle">
          {agents
            ? "You and your verified agents can edit this note."
            : "Only you have access until you share it."}
        </p>
        {error && <p role="alert">{error}</p>}
        {agents && unverified.length > 0 && (
          <p role="status">
            These agents could not be verified and will not receive access:{" "}
            {unverified
              .map(
                (key) =>
                  workspace.session.agentChoices
                    .snapshot()
                    .selectable.find((agent) => agent.pubkey === key)?.name ??
                  key,
              )
              .join(", ")}
            . You can create with verified agents, or turn off agent sharing to
            create privately.
          </p>
        )}
      </form>
    </Dialog>
  );
}

/** The channel owns this tab; linked views retain drafts while moving back. */
export function WorkingNotePanel({
  target,
  relay,
  getWorkspace,
  navigator,
  context,
}: PanelProps & {
  relay: RelayData;
  getWorkspace: NotesOwner;
  navigator: Navigation;
}) {
  const connection = useRelayConnection(relay);
  const initial = useMemo(() => parseNoteUrl(target), [target]);
  if (
    !initial ||
    connection.status !== "ready" ||
    initial.community !== connection.origin
  )
    return (
      <div className={styles.browser}>
        <p role="status">Connect to this note’s community to open it.</p>
      </div>
    );
  return (
    <NotePanelContents
      key={`${connection.scope}:${connection.generation}`}
      initial={initial}
      workspace={getWorkspace(connection.session)}
      navigator={navigator}
      context={context}
    />
  );
}

function NotePanelContents({
  initial,
  workspace,
  navigator,
  context,
}: {
  initial: NoteAddress;
  workspace: NotesWorkspace;
  navigator: Navigation;
  context: PanelProps["context"];
}) {
  const navigation = useSyncExternalStore(
    navigator.subscribe,
    navigator.snapshot,
    navigator.snapshot,
  );
  const route = navigation.entry.target;
  const view =
    route.kind === "conversation" &&
    route.note &&
    noteKey(route.note) === noteKey(initial)
      ? route.note
      : undefined;
  const [catalogue, setCatalogue] = useState<CollectionPage>({
    notes: [],
    more: false,
  });
  const [error, setError] = useState("");
  const title =
    catalogue.notes.find((note) => noteKey(note) === noteKey(initial))?.title ??
    "Note";
  usePanelTabTitle(title);
  useEffect(() => {
    const controller = new AbortController();
    void workspace
      .list(undefined, controller.signal)
      .then(setCatalogue)
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setError(errorText(error));
      });
    return () => controller.abort();
  }, [workspace]);
  const changed = useCallback(
    (note: Note) =>
      setCatalogue((old) =>
        old.notes.some(
          (item) =>
            noteKey(item) === noteKey(note) && item.revision === note.revision,
        )
          ? old
          : {
              ...old,
              notes: [
                note,
                ...old.notes.filter((item) => noteKey(item) !== noteKey(note)),
              ],
            },
      ),
    [],
  );
  const open = (address: NoteAddress) => {
    const communityOrigin = workspace.session.scope.replace(
      /:[0-9a-f]{64}$/,
      "",
    );
    if (context?.open(noteUrl(address, communityOrigin))) return;
    void navigator.open({
      version: 1,
      kind: "page",
      pluginId: "buzz.relay-notes",
      pageId: "notes",
      scope: { viewer: workspace.session.viewer ?? "", communityOrigin },
      route: { version: 1, params: { view: "note", ...noteAddress(address) } },
    });
  };
  return (
    <div className={styles.page}>
      {navigation.canGoBack && (
        <div className={styles.actions}>
          <Button variant="ghost" onClick={() => navigator.back()}>
            <ArrowLeftIcon size={16} /> Back
          </Button>
        </div>
      )}
      {error && (
        <p role="status" className="text-caption text-subtle">
          Related notes could not be loaded. {error}
        </p>
      )}
      {[initial].map((address) => (
        <div className={styles.page} key={noteKey(address)}>
          <NoteDocument
            address={address}
            workspace={workspace}
            catalogue={catalogue.notes}
            partial={catalogue.more}
            active={route.kind !== "conversation" || !!view}
            view={view}
            onViewChange={(next) => {
              if (route.kind === "conversation" && view)
                void navigator.open(
                  { ...route, note: { ...noteAddress(address), ...next } },
                  { focus: "preserve" },
                );
            }}
            onChange={changed}
            onUnavailable={(missing) =>
              setCatalogue((old) => ({
                ...old,
                notes: old.notes.filter(
                  (note) => noteKey(note) !== noteKey(missing),
                ),
              }))
            }
            onOpen={open}
          />
        </div>
      ))}
    </div>
  );
}
