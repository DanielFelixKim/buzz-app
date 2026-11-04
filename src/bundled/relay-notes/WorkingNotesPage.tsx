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
import { usePanelTabTitle } from "../../features/panels/PanelWorkspace";
import type { PanelProps } from "../../features/panels/service";
import { useRelayConnection } from "../../features/relay/react";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import { ArrowLeftIcon, NoteIcon } from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { Panel } from "../../shared/design-system/ui/Panel";
import {
  PanelHeader,
  PanelHeaderLabel,
} from "../../shared/design-system/ui/PanelHeader";
import { NoteDocument, type NoteFocus } from "./NoteDocument";
import { NewNoteDocument, type NewDraft } from "./NewNoteDocument";
import { NotesPage } from "./NotesPage";
import styles from "./WorkingNotes.module.css";
import {
  workingRoute,
  workingTarget,
  type WorkingRoute,
} from "./working-route";

export type NotesOwner = (session: RelaySession) => NotesWorkspace;
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "Notes could not be read.";

export function WorkingNotesPage({
  relay,
  getWorkspace,
  navigator,
  navigation,
  ...props
}: PageProps & {
  relay: RelayData;
  getWorkspace: NotesOwner;
  navigator: Navigation;
}) {
  const connection = useRelayConnection(relay);
  const request = useMemo(
    () => navigation?.forSession(relay, connection),
    [navigation, relay, connection],
  );
  useEffect(() => {
    if (
      request?.target.kind !== "page" ||
      request.target.scope ||
      connection.status !== "ready" ||
      !connection.viewer ||
      !connection.scope
    )
      return;
    request.resolve({
      ...request.target,
      scope: {
        viewer: connection.viewer,
        communityOrigin: connection.scope.slice(
          0,
          -(connection.viewer.length + 1),
        ),
      },
    });
  }, [request, connection]);
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
      navigation={navigation}
      {...props}
    />
  );
}

export function WorkingNotesCommunity({
  workspace,
  relay,
  navigator,
  navigation,
}: PageProps & {
  workspace: NotesWorkspace;
  relay?: RelayData;
  navigator?: Navigation;
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
  const searchRef = useRef<HTMLElement>(null);
  const [collection, setCollection] = useState<CollectionPage>({
    notes: [],
    more: false,
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [sharingError, setSharingError] = useState("");
  const [query, setQuery] = useState(destination?.query ?? "");
  const [trash, setTrash] = useState(destination?.trash ?? false);
  const drafts = useRef(new Map<string, NewDraft>());
  const createdDrafts = useRef(new Map<string, NoteAddress>());
  const createdFocus = useRef(new Map<string, NoteFocus>());
  const createdAutoSave = useRef(new Map<string, boolean>());
  const [opened, setOpened] = useState<NoteAddress[]>(() =>
    initial ? [initial] : [],
  );
  const [selected, setSelected] = useState(
    initial ? noteKey(initial) : "browse",
  );
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
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
    (next: WorkingRoute, replace = false) => {
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
        replace,
      });
    },
    [navigator, request],
  );
  const open = (address: NoteAddress, replace = false) => {
    reveal(address);
    visit(
      {
        view: "note",
        ...noteAddress(address),
        query,
        trash,
      },
      replace,
    );
  };
  const browse = () => {
    setSelected("browse");
    visit({ view: "browse", query, trash });
    requestAnimationFrame(() => searchRef.current?.focus());
  };
  const newNote = (draft: Omit<NewDraft, "id">) => {
    const next = { ...draft, id: crypto.randomUUID() };
    drafts.current.set(next.id, next);
    setSelected(`new:${next.id}`);
    visit({ view: "new", draft: next.id, query, trash });
  };
  useEffect(() => {
    if (initial) reveal(initial);
    else if (destination) setSelected("browse");
    if (destination) {
      setQuery(destination.query ?? "");
      setTrash(destination.trash ?? false);
      if (destination.view === "new" && destination.draft) {
        const created = createdDrafts.current.get(destination.draft);
        if (created) {
          reveal(created);
          const { draft: _draft, ...rest } = destination;
          visit({ ...rest, view: "note", ...created }, true);
        } else {
          if (!drafts.current.has(destination.draft))
            drafts.current.set(destination.draft, {
              id: destination.draft,
              title: "",
              markdown: "",
            });
          setSelected(`new:${destination.draft}`);
        }
      }
    }
  }, [initial, destination, reveal, visit]);
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
  const visible = collection.notes.filter((note) => trash || !note.deleted);
  return (
    <NotesPage
      community={workspace.session.scope.replace(/:[0-9a-f]{64}$/, "")}
      {...{
        selected,
        query,
        trash,
        searchRef,
        loading,
        more: collection.more,
        error,
        sharingError,
        search: (value, commit) => {
          setQuery(value);
          if (commit)
            visit({
              ...(destination ?? { view: "browse" }),
              query: value,
              trash,
            });
        },
        showDeleted: (value) => {
          setTrash(value);
          visit({
            ...(destination ?? { view: "browse" }),
            query,
            trash: value,
          });
        },
        create: () => newNote({ title: "", markdown: "" }),
        refresh: () => {
          void load();
        },
        loadMore: () => {
          void load(true);
        },
        browse,
        entries: visible,
        open,
        items: [
          ...opened.map((address) => {
            const key = noteKey(address);
            return {
              id: key,
              label:
                collection.notes.find((note) => noteKey(note) === key)?.title ??
                "Note",
              content: (
                <NoteDocument
                  address={address}
                  initialFocus={createdFocus.current.get(key)}
                  initialAutoSave={createdAutoSave.current.get(key)}
                  workspace={workspace}
                  catalogue={collection.notes}
                  partial={collection.more}
                  active={selected === key}
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
                />
              ),
            };
          }),
          ...[...drafts.current.values()].map((draft) => ({
            id: `new:${draft.id}`,
            label: "New note",
            content: (
              <NewNoteDocument
                workspace={workspace}
                initial={draft}
                catalogue={collection.notes}
                active={selected === `new:${draft.id}`}
                onDraftChange={(next) => drafts.current.set(next.id, next)}
                onCreated={(note, autoSave, focus) => {
                  if (focus) createdFocus.current.set(noteKey(note), focus);
                  createdAutoSave.current.set(noteKey(note), autoSave);
                  createdDrafts.current.set(draft.id, noteAddress(note));
                  drafts.current.delete(draft.id);
                  changed(note);
                  if (selectedRef.current === `new:${draft.id}`)
                    open(note, true);
                }}
              />
            ),
          })),
        ],
      }}
    />
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
