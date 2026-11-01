import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type Ref,
  type RefObject,
  type ComponentProps,
} from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useAgentChoices } from "../../features/agents/use-choices";
import { useIdentityNames } from "../../features/identity-names/react";
import {
  MAX_MARKDOWN_LENGTH,
  safeLinkUrl,
  scanMarkdown,
} from "../../features/relay/message-content";
import { PanelWorkspace } from "../../features/panels/PanelWorkspace";
import { PanelDock } from "../../features/panels/PanelDock";
import panelStyles from "../../features/panels/Panels.module.css";
import { noteUrl, type Note } from "../../features/notes/model";
import { SearchField } from "../../shared/design-system/ui/SearchField";
import { Checkbox } from "../../shared/design-system/ui/Checkbox";
import { PlusIcon } from "../../shared/design-system/icons";
import { workingRoute } from "./working-route";
import { usePanelSplit } from "../../features/panels/usePanelSplit";
import type { Profile } from "../../features/relay/contracts";
import type { EventData } from "../../features/relay/events";
import { useRelayConnection } from "../../features/relay/react";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import {
  ArrowLeftIcon,
  ArrowsClockwiseIcon,
  NoteIcon,
  InfoIcon,
} from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  PopoverRoot,
  PopoverTrigger,
  PopoverPopup,
  PopoverTitle,
  PopoverDescription,
} from "../../shared/design-system/ui/Popover";
import { SurfaceButton } from "../../shared/design-system/ui/SurfaceButton";
import { Panel } from "../../shared/design-system/ui/Panel";
import {
  PanelHeader,
  PanelHeaderLabel,
} from "../../shared/design-system/ui/PanelHeader";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { avatarMedia } from "../../shared/avatar-source";
import {
  NoteAuthor,
  NoteByline,
  NoteIdentifier,
  NoteTime,
} from "./NoteMetadata";
import {
  NOTE_LIMIT,
  emptyNotePage,
  readNotePage,
  noteHeads,
  noteKey,
  noteTag,
  noteTitle,
  workingNotePreview,
} from "./collection";
import styles from "./NotesPage.module.css";
import layoutStyles from "./WorkingNotes.module.css";
import { formatPublicKey } from "../../shared/identity/public-key";
import type { PageProps } from "../../features/pages/service";
import type { Navigation } from "../../features/navigation/controller";
import { notesRoute, notesTarget, type NotesRoute } from "./routes";
import type { Panels, RegisteredPanel } from "../../features/panels/service";
import { profileTarget } from "../../features/profiles/target";
const noSubscribe = () => () => {};
const noPanels: readonly RegisteredPanel[] = [];
const emptyPanels = () => noPanels;
/** Editable documents and published notes share one list and full-page viewer. */
export type WorkingNotesExtension = {
  entries: readonly Note[];
  open(note: Note): void;
  items: ComponentProps<typeof PanelWorkspace>["items"];
  selected: string;
  query: string;
  trash: boolean;
  searchRef: RefObject<HTMLElement | null>;
  loading: boolean;
  more: boolean;
  error: string;
  sharingError: string;
  search(query: string, commit?: boolean): void;
  showDeleted(value: boolean): void;
  create(): void;
  refresh(): void;
  loadMore(): void;
  select(key: string): void;
  close(key: string, fallback: string): void;
  dismiss(key: string, fallback: string): void;
  visit(route: NotesRoute): void;
};
type NotesNavigation = Pick<PageProps, "navigation"> & {
  working?: WorkingNotesExtension | undefined;
  navigator?: Navigation | undefined;
  panels?: Panels | undefined;
  onConvert?: ((note: EventData) => void) | undefined;
};

function NotesPanel({
  children,
  refresh,
  refreshRef,
  loading = false,
  working,
}: {
  working?: WorkingNotesExtension | undefined;
  children: ReactNode;
  refresh?: (() => void) | undefined;
  refreshRef?: Ref<HTMLButtonElement>;
  loading?: boolean;
}) {
  return (
    <Panel aria-label={working ? "Notes" : "Shared notes"}>
      <div className={styles.page}>
        <PanelHeader
          title={
            <PanelHeaderLabel
              title={working ? "Notes" : "Shared notes"}
              icon={<NoteIcon size="1rem" />}
            >
              <PopoverRoot>
                <PopoverTrigger
                  render={
                    <IconButton
                      size="sm"
                      variant="ghost"
                      icon={<InfoIcon size="1rem" aria-hidden="true" />}
                      aria-label={
                        working ? "About notes" : "About shared notes"
                      }
                      title={working ? "About notes" : "About shared notes"}
                    />
                  }
                />
                <PopoverPopup>
                  <PopoverTitle>
                    {working ? "About notes" : "About shared notes"}
                  </PopoverTitle>
                  <PopoverDescription
                    render={<div className={styles.description} />}
                  >
                    {working ? (
                      <p>
                        Notes from you and agents live together here. Open a
                        title to read the note, then use Back to notes to return
                        to the list. Edit when you have access, or make an
                        editable copy of a published agent note.
                      </p>
                    ) : (
                      <p>
                        Shared notes are reusable documents saved by your agents
                        and other agents in this community—recipes, prompts,
                        research and guides you can return to across
                        conversations. Ask the agent who saved a note to update
                        it, or ask your agent to save its own copy.
                      </p>
                    )}
                    {working ? (
                      <p>
                        Each document has its own sharing settings. Published
                        agent notes are readable by people with access to this
                        community’s relay. The relay operator can read note
                        contents. Don’t include secrets.
                      </p>
                    ) : (
                      <p>
                        Anyone with access to this community’s relay can read
                        shared notes. Don’t include secrets or private
                        information.
                      </p>
                    )}
                  </PopoverDescription>
                </PopoverPopup>
              </PopoverRoot>
            </PanelHeaderLabel>
          }
          actions={
            refresh && (
              <>
                {working && (
                  <IconButton
                    aria-label="New note"
                    title="New note"
                    icon={<PlusIcon size={16} />}
                    onClick={working.create}
                  />
                )}
                {loading && (
                  <span role="status" className="text-caption text-subtle">
                    Reading notes…
                  </span>
                )}
                <IconButton
                  hint="familiar"
                  ref={refreshRef}
                  size="sm"
                  variant="ghost"
                  aria-label="Refresh notes"
                  title="Refresh notes"
                  icon={<ArrowsClockwiseIcon size="1rem" />}
                  onClick={refresh}
                />
              </>
            )
          }
        />
        <div className={styles.body}>{children}</div>
      </div>
    </Panel>
  );
}

export function NotesPage({
  relay,
  navigation,
  navigator,
  panels,
  onConvert,
  working,
}: { relay: RelayData } & NotesNavigation) {
  const connection = useRelayConnection(relay);
  const request = useMemo(
    () => navigation?.forSession(relay, connection),
    [navigation, relay, connection],
  );
  useEffect(() => {
    if (
      request?.target.kind !== "page" ||
      request.target.scope !== undefined ||
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
  if (connection.status === "ready")
    return (
      <NotesCommunity
        key={`${connection.scope}:${connection.generation}`}
        session={connection.session}
        navigation={request}
        navigator={navigator}
        panels={panels}
        onConvert={onConvert}
        working={working}
      />
    );
  return (
    <NotesPanel>
      <p role="status">
        {connection.status === "connecting"
          ? "Connecting to your community…"
          : "Connect to a community to read notes."}
      </p>
      {connection.status === "error" && (
        <>
          <p role="alert">{connection.error}</p>
          <Button onClick={() => relay.retry()}>Retry connection</Button>
        </>
      )}
    </NotesPanel>
  );
}

export function NotesCommunity({
  session,
  navigation,
  navigator,
  panels,
  onConvert,
  working,
}: { session: RelaySession } & NotesNavigation) {
  const choices = useAgentChoices(session);
  const resolveName = useIdentityNames(session.names);
  const candidates = choices.identities.map((agent) => agent.pubkey);
  const agents = choices.identities.map((agent) => ({
    pubkey: agent.pubkey,
    picture: agent.avatar,
    name: resolveName(
      agent.pubkey,
      agent.managedName ?? agent.name,
      candidates,
      choices.identities,
    ),
  }));
  // Existing content includes archived identities; selecting a new recipient does not.
  const authors = choices.identities
    .map((agent) => agent.pubkey)
    .sort()
    .join(":");
  return (
    <NoteCollection
      key={authors}
      session={session}
      navigation={navigation}
      navigator={navigator}
      panels={panels}
      onConvert={onConvert}
      working={working}
      authors={authors}
      agents={agents}
      pending={choices.pending}
      complete={choices.complete}
      inventoryError={choices.error}
      refreshAgents={() => {
        void session.agentChoices.refresh().catch(() => {});
      }}
    />
  );
}

function NoteCollection({
  session,
  authors,
  agents: ownedAgents,
  pending,
  complete,
  inventoryError,
  refreshAgents,
  navigation,
  navigator,
  panels,
  onConvert,
  working,
}: NotesNavigation & {
  session: RelaySession;
  authors: string;
  agents: readonly {
    pubkey: string;
    name: string;
    picture?: string | undefined;
  }[];
  pending: boolean;
  complete: boolean;
  inventoryError: string | undefined;
  refreshAgents(): void;
}) {
  const combined = !!working;
  const workingRef = useRef(working);
  workingRef.current = working;
  const [request, setRequest] = useState({ version: 0, more: false });
  const pages = useRef({ owned: emptyNotePage(), shared: emptyNotePage() });
  const sharedAgents = useRef(new Map<string, Profile>());
  const [result, setResult] = useState<{
    notes: EventData[];
    loading: boolean;
    partial: boolean;
    error?: string | undefined;
    sharedError?: string | undefined;
  }>({ notes: [], loading: true, partial: false });
  const profiles = useSyncExternalStore(
    session.profiles.subscribe,
    session.profiles.snapshot,
  );
  const documentAuthors = [
    ...new Set(working?.entries.map((note) => note.event.pubkey) ?? []),
  ]
    .sort()
    .join(":");
  useEffect(() => {
    const authors = documentAuthors ? documentAuthors.split(":") : [];
    const controller = new AbortController();
    void (async () => {
      for (
        let offset = 0;
        offset < authors.length && !controller.signal.aborted;
        offset += NOTE_LIMIT
      )
        await session.profiles.ensure(
          authors.slice(offset, offset + NOTE_LIMIT),
          "background",
        );
    })().catch(() => {});
    return () => controller.abort();
  }, [session, documentAuthors]);
  const resolveName = useIdentityNames(session.names);
  const agents = useMemo(() => {
    const others = [
      ...new Set([
        ...result.notes.map((note) => note.pubkey),
        ...(documentAuthors ? documentAuthors.split(":") : []),
      ]),
    ].filter(
      (pubkey) =>
        pubkey !== (combined ? session.viewer : undefined) &&
        !ownedAgents.some((agent) => agent.pubkey === pubkey) &&
        (sharedAgents.current.has(pubkey) ||
          documentAuthors.split(":").includes(pubkey)),
    );
    const candidates = [...ownedAgents.map((agent) => agent.pubkey), ...others];
    return [
      ...(combined && session.viewer
        ? [
            {
              pubkey: session.viewer,
              name: "You",
              owned: true,
              picture: profiles.get(session.viewer)?.picture,
            },
          ]
        : []),
      ...ownedAgents.map((agent) => ({ ...agent, owned: true })),
      ...others.map((pubkey) => ({
        pubkey,
        picture: (profiles.get(pubkey) ?? sharedAgents.current.get(pubkey))
          ?.picture,
        name: resolveName(
          pubkey,
          (profiles.get(pubkey) ?? sharedAgents.current.get(pubkey))?.name ??
            formatPublicKey(pubkey) ??
            pubkey,
          candidates,
        ),
        owned: false,
      })),
    ].sort(
      (a, b) =>
        a.name.localeCompare(b.name, undefined, {
          sensitivity: "base",
          numeric: true,
        }) || a.pubkey.localeCompare(b.pubkey),
    );
  }, [
    ownedAgents,
    result.notes,
    profiles,
    resolveName,
    combined,
    session.viewer,
    documentAuthors,
  ]);
  const [author, setAuthor] = useState("");
  const [opened, setOpened] = useState<EventData[]>([]);
  const [selected, setSelected] = useState("");
  const split = usePanelSplit(448, 320);
  const origin = useRef<HTMLElement | null>(null);
  const refreshRef = useRef<HTMLButtonElement>(null);
  const preserveControlFocus = useCallback((node: HTMLButtonElement | null) => {
    if (!node) return;
    return () => {
      if (document.activeElement === node) refreshRef.current?.focus();
    };
  }, []);
  const folderGrid = useRef<HTMLElement>(null);
  const folderTitle = useRef<HTMLHeadingElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const [profile, setProfile] = useState("");
  useSyncExternalStore(
    panels?.subscribe ?? noSubscribe,
    panels?.snapshot ?? emptyPanels,
  );
  const isAgent = (pubkey: string) =>
    ownedAgents.some((agent) => agent.pubkey === pubkey) ||
    profiles.get(pubkey)?.isAgent === true ||
    sharedAgents.current.has(pubkey);
  const profileAddress = profileTarget(profile, { agent: isAgent(profile) });
  const profilePanel = profileAddress
    ? panels?.resolve(profileAddress)
    : undefined;
  const profileKey = `profile:${profile}`;
  const noteActive = opened.some((note) => noteKey(note) === selected)
    ? selected
    : noteKeyOrEmpty(opened[0]);
  const active =
    working?.selected ??
    (profilePanel && (selected === profileKey || !noteActive)
      ? profileKey
      : noteActive);
  useEffect(() => {
    if (combined && active !== "browse") backRef.current?.focus();
  }, [combined, active]);
  useEffect(() => {
    if (working?.selected === profileKey && profile && !profilePanel) {
      setProfile("");
      workingRef.current?.dismiss(
        profileKey,
        noteActive || workingRef.current.items[0]?.id || "browse",
      );
    }
  }, [working?.selected, profileKey, profile, profilePanel, noteActive]);

  useEffect(() => {
    const controller = new AbortController();
    setResult((old) => ({
      ...old,
      loading: true,
      sharedError: undefined,
    }));
    const options = { signal: controller.signal, fresh: request.version > 0 };
    const previous = request.more
      ? pages.current
      : { owned: emptyNotePage(), shared: emptyNotePage() };
    const owned = authors
      ? readNotePage(
          session,
          { kinds: [30023], authors: authors.split(":"), limit: NOTE_LIMIT },
          previous.owned,
          options,
        )
      : Promise.resolve({ ...emptyNotePage(), done: true });
    const shared = readNotePage(
      session,
      { kinds: [30023], limit: NOTE_LIMIT },
      previous.shared,
      options,
    ).then(async (page) => {
      controller.signal.throwIfAborted();
      const known = request.more
        ? new Map(sharedAgents.current)
        : new Map<string, Profile>();
      const previousIds = new Set(previous.shared.notes.map((note) => note.id));
      const newAuthors = [
        ...new Set(
          page.notes
            .filter((note) => !previousIds.has(note.id))
            .map((note) => note.pubkey),
        ),
      ];
      // Enrich only this page, and retain accepted classification across directory eviction.
      for (let offset = 0; offset < newAuthors.length; offset += NOTE_LIMIT) {
        const batch = newAuthors.slice(offset, offset + NOTE_LIMIT);
        await session.profiles.ensure(batch, "background");
        controller.signal.throwIfAborted();
        for (const pubkey of batch) {
          const profile = session.profiles.snapshot().get(pubkey);
          if (profile?.isAgent) known.set(pubkey, profile);
          else known.delete(pubkey);
        }
      }
      return { page, agents: known };
    });
    void Promise.allSettled([owned, shared]).then(
      ([ownResult, sharedResult]) => {
        if (controller.signal.aborted) return;
        if (ownResult.status === "fulfilled")
          pages.current.owned = ownResult.value;
        if (sharedResult.status === "fulfilled") {
          pages.current.shared = sharedResult.value.page;
          sharedAgents.current = sharedResult.value.agents;
        }
        const ownAuthors = authors ? authors.split(":") : [];
        const sharedNotes = pages.current.shared.notes.filter(
          (note) =>
            !ownAuthors.includes(note.pubkey) &&
            sharedAgents.current.has(note.pubkey),
        );
        const notes = noteHeads(
          [...pages.current.owned.notes, ...sharedNotes],
          [...ownAuthors, ...sharedNotes.map((note) => note.pubkey)],
        );
        setResult({
          notes,
          loading: false,
          partial: !pages.current.owned.done || !pages.current.shared.done,
          error:
            ownResult.status === "rejected"
              ? "Couldn’t read notes. Try again."
              : undefined,
          sharedError:
            sharedResult.status === "rejected"
              ? "Other agents’ notes could not be checked. Refresh to try again."
              : undefined,
        });
        setAuthor((current) =>
          notes.some((note) => note.pubkey === current) ||
          workingRef.current?.entries.some(
            (note) => note.event.pubkey === current,
          )
            ? current
            : "",
        );
        setOpened((old) =>
          old.map(
            (note) =>
              notes.find((next) => noteKey(next) === noteKey(note)) ?? note,
          ),
        );
      },
    );
    return () => controller.abort();
  }, [session, authors, request]);

  const restored = useRef<string | undefined>(undefined);
  const [routeError, setRouteError] = useState("");
  const visit = (route: NotesRoute, replace = false) => {
    if (working) {
      working.visit(route);
      return;
    }
    if (
      !navigation ||
      !navigator ||
      navigation.signal.aborted ||
      navigation.target.kind !== "page" ||
      navigation.target.pluginId !== "buzz.relay-notes" ||
      navigation.target.pageId !== "notes" ||
      navigator.snapshot().entry.id !== navigation.entryId
    )
      return;
    void navigator.open(notesTarget(navigation.target, route), {
      replace,
      focus: "preserve",
    });
  };
  useEffect(() => {
    if (
      !navigation ||
      navigation.signal.aborted ||
      restored.current === navigation.entryId ||
      result.loading ||
      result.error ||
      pending
    )
      return;
    const params =
      navigation.target.kind === "page"
        ? navigation.target.route?.params
        : undefined;
    const combined = workingRoute(params);
    const route =
      notesRoute(params) ??
      (combined
        ? {
            author: combined.author ?? "",
            ...(combined.view === "shared" ? { note: combined.shared } : {}),
            ...(combined.view === "profile"
              ? { profile: combined.profile }
              : {}),
          }
        : undefined);
    setRouteError("");
    if (
      route?.author &&
      !agents.some((agent) => agent.pubkey === route.author)
    ) {
      setRouteError("This agent folder is unavailable.");
      return;
    }
    setAuthor(route?.author ?? "");
    if (route?.profile) {
      if (!agents.some((agent) => agent.pubkey === route.profile)) {
        setRouteError("This agent profile is unavailable.");
        return;
      }
      setProfile(route.profile);
      setSelected(`profile:${route.profile}`);
    }
    if (route?.note === "") {
      setOpened([]);
      setSelected("");
    } else if (route?.note) {
      const note =
        result.notes.find((item) => noteKey(item) === route.note) ??
        opened.find((item) => noteKey(item) === route.note);
      if (note) {
        setOpened((old) =>
          old.some((item) => noteKey(item) === route.note)
            ? old
            : [...old, note],
        );
        setSelected(route.note);
      } else {
        setRouteError(
          "This note isn’t in the loaded collection. Refresh to check again.",
        );
        return;
      }
    }
    restored.current = navigation.entryId;
  }, [
    navigation,
    result.loading,
    result.error,
    result.notes,
    pending,
    agents,
    opened,
  ]);

  const openProfile = (pubkey: string) => {
    setProfile(pubkey);
    setSelected(`profile:${pubkey}`);
    visit({ author, profile: pubkey }, true);
  };
  const closeProfile = () => {
    setProfile("");
    setSelected(noteActive);
    if (working)
      working.dismiss(
        profileKey,
        noteActive || working.items[0]?.id || "browse",
      );
    else visit({ author, note: noteActive }, true);
  };
  const canProfile = (pubkey: string) =>
    !!panels?.resolve(profileTarget(pubkey, { agent: isAgent(pubkey) }) ?? "");
  const refresh = () => {
    working?.refresh();
    setRequest((old) => ({ version: old.version + 1, more: false }));
  };
  const close = (key: string) => {
    setOpened((old) => old.filter((note) => noteKey(note) !== key));
    const next =
      active === key
        ? opened.find((note) => noteKey(note) !== key)
        : opened.find((note) => noteKey(note) === active);
    if (working) {
      working.dismiss(
        key,
        active === key
          ? next
            ? noteKey(next)
            : (working.items[0]?.id ?? "browse")
          : active,
      );
    } else
      visit(
        active === profileKey && profilePanel
          ? { author, profile }
          : { author, note: noteKeyOrEmpty(next) },
        true,
      );
    if (opened.length === 1 && !profilePanel)
      requestAnimationFrame(() => {
        (origin.current?.isConnected
          ? origin.current
          : refreshRef.current
        )?.focus();
      });
  };
  const name = (note: EventData) =>
    agents.find((agent) => agent.pubkey === note.pubkey)?.name ?? note.pubkey;
  const query = working?.query.toLowerCase() ?? "";
  const matches = (note: EventData) =>
    `${noteTitle(note)}\n${note.content}\n${name(note)}`
      .toLowerCase()
      .includes(query);
  const visible = result.notes.filter(
    (note) => note.pubkey === author && matches(note),
  );
  const ownedNotes = result.notes.filter((note) =>
    ownedAgents.some((agent) => agent.pubkey === note.pubkey),
  );
  const folders = agents.flatMap((agent) => {
    const notes = result.notes.filter((note) => note.pubkey === agent.pubkey);
    const documents =
      working?.entries.filter((note) => note.event.pubkey === agent.pubkey) ??
      [];
    const count = notes.length + documents.length;
    return count
      ? [
          {
            ...agent,
            count,
            latest: Math.max(
              notes[0]?.created_at ?? 0,
              ...documents.map((note) => note.event.created_at),
            ),
          },
        ]
      : [];
  });
  const folder = folders.find((agent) => agent.pubkey === author);
  const openFolder = (pubkey: string) => {
    visit({
      author: pubkey,
      ...(active === profileKey && profilePanel
        ? { profile }
        : active
          ? active === "browse"
            ? {}
            : { note: active }
          : {}),
    });
    setAuthor(pubkey);
    requestAnimationFrame(() => {
      if (pubkey) folderTitle.current?.focus();
      else
        folderGrid.current
          ?.querySelector<HTMLElement>(`[data-agent="${author}"]`)
          ?.focus();
    });
  };
  const renderNoteGrid = (
    notes: readonly EventData[],
    group?: "you" | "agents" | "others",
  ) => {
    const rows = [
      ...(working?.entries ?? [])
        .filter(
          (note) =>
            (!author || !!working || note.event.pubkey === author) &&
            (!group ||
              (group === "you"
                ? note.event.pubkey === session.viewer
                : group === "agents"
                  ? ownedAgents.some(
                      (agent) => agent.pubkey === note.event.pubkey,
                    )
                  : note.event.pubkey !== session.viewer &&
                    !ownedAgents.some(
                      (agent) => agent.pubkey === note.event.pubkey,
                    ))),
        )
        .map((note) => ({
          key: `${note.channel}:${note.id}`,
          title: note.title,
          identifier: "",
          summary: note.deleted
            ? "Deleted · retained history available"
            : workingNotePreview(note.markdown) || "Empty note",
          author: note.event.pubkey,
          event: note.event,
          document: note,
        })),
      ...notes.map((note) => ({
        key: noteKey(note),
        title: noteTitle(note),
        identifier: noteTag(note, "d"),
        summary: noteTag(note, "summary") || workingNotePreview(note.content),
        author: note.pubkey,
        event: note,
        published: note,
      })),
    ];
    if (working) {
      const visible = rows
        .filter((row) =>
          `${row.title}\n${row.summary}\n${"document" in row ? row.document.markdown : row.published.content}\n${agents.find((agent) => agent.pubkey === row.author)?.name ?? ""}`
            .toLowerCase()
            .includes(query),
        )
        .sort(
          (a, b) =>
            b.event.created_at - a.event.created_at ||
            a.event.id.localeCompare(b.event.id),
        );
      return (
        <>
          <ul className={styles.titleList} aria-label="Notes">
            {visible.map((row) => {
              const href =
                "document" in row
                  ? noteUrl(
                      row.document,
                      session.scope.replace(/:[0-9a-f]{64}$/, ""),
                    )
                  : `buzz://plugin?${new URLSearchParams({
                      id: "buzz.relay-notes",
                      page: "notes",
                      "route.author": row.author,
                      "route.note": row.key,
                    })}`;
              return (
                <li key={row.key}>
                  <a
                    className="text-body"
                    href={href}
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
                      origin.current = event.currentTarget;
                      if ("document" in row) working.open(row.document);
                      else {
                        setOpened((old) =>
                          old.some((note) => noteKey(note) === row.key)
                            ? old
                            : [...old, row.published],
                        );
                        setSelected(row.key);
                        visit({ author: "", note: row.key });
                      }
                    }}
                  >
                    {row.title}
                  </a>
                </li>
              );
            })}
          </ul>
          {query &&
            !visible.length &&
            !result.loading &&
            !working.loading &&
            !result.error &&
            !working.error && <p role="status">No matching notes.</p>}
        </>
      );
    }
    return (
      <div className={styles.notes}>
        {rows
          .filter((row) =>
            `${row.title}\n${row.summary}\n${"document" in row ? row.document.markdown : row.published.content}\n${agents.find((agent) => agent.pubkey === row.author)?.name ?? ""}`
              .toLowerCase()
              .includes(query),
          )
          .sort(
            (a, b) =>
              b.event.created_at - a.event.created_at ||
              a.event.id.localeCompare(b.event.id),
          )
          .map((row) => {
            if ("document" in row) return null;
            const agent = agents.find((agent) => agent.pubkey === row.author);
            const caption = agent?.name ?? row.author;
            const picture = avatarMedia(agent?.picture, session.media);
            const isOpen = opened.some((note) => noteKey(note) === row.key);
            return (
              <article key={row.key} className={styles.noteItem}>
                <SurfaceButton
                  className={styles.noteCard}
                  aria-label={`Open ${row.title} by ${caption}`}
                  aria-current={active === row.key ? "true" : undefined}
                  aria-pressed={isOpen}
                  onClick={(event) => {
                    origin.current = event.currentTarget;
                    if (isOpen) close(row.key);
                    else {
                      setOpened((old) => [...old, row.published]);
                      setSelected(row.key);
                      visit({ author, note: row.key }, true);
                    }
                  }}
                >
                  <span className={styles.noteHeading}>
                    <span
                      className={`${styles.noteTitle} text-label`}
                      title={row.title}
                    >
                      {row.title}
                    </span>
                    {row.identifier && (
                      <span className="text-caption text-secondary">
                        <NoteIdentifier note={row.event} separator={false} />
                      </span>
                    )}
                  </span>
                  <span
                    className={`${styles.summary} text-body-sm text-subtle`}
                  >
                    {row.summary}
                  </span>
                </SurfaceButton>
                <span
                  className={`${styles.byline} text-caption text-secondary`}
                >
                  <NoteAuthor
                    name={caption}
                    picture={picture}
                    open={
                      canProfile(row.author)
                        ? () => openProfile(row.author)
                        : undefined
                    }
                  />{" "}
                  · <NoteTime note={row.event} />
                </span>
              </article>
            );
          })}
      </div>
    );
  };
  const readerOpen = working
    ? active !== "browse" &&
      !!(opened.length || working.items.length || profilePanel)
    : !!opened.length || !!profilePanel;
  const items: ComponentProps<typeof PanelWorkspace>["items"] = [
    ...(working?.items ?? []),
    ...opened.map((note) => ({
      id: noteKey(note),
      label: noteTitle(note),
      icon: (
        <Avatar
          src={avatarMedia(
            agents.find((agent) => agent.pubkey === note.pubkey)?.picture,
            session.media,
          )}
          alt=""
          fallback={name(note)}
          size="fill"
          shape="squircle"
        />
      ),
      close: () => close(noteKey(note)),
      content: (
        <NoteBody
          note={note}
          onConvert={onConvert ? () => onConvert(note) : undefined}
          openProfile={
            canProfile(note.pubkey) ? () => openProfile(note.pubkey) : undefined
          }
          author={name(note)}
          picture={avatarMedia(
            agents.find((agent) => agent.pubkey === note.pubkey)?.picture,
            session.media,
          )}
        />
      ),
    })),
    ...(profilePanel && profileAddress
      ? [
          {
            id: profileKey,
            label: `${agents.find((agent) => agent.pubkey === profile)?.name ?? "Agent"} · Profile`,
            close: closeProfile,
            content: (
              <profilePanel.component
                target={profileAddress}
                close={closeProfile}
              />
            ),
          },
        ]
      : []),
  ];
  const activeItem = items.find((item) => item.id === active);
  const fullView = working && (
    <div className={styles.fullView} hidden={!readerOpen}>
      <Panel aria-label="Note details">
        <PanelHeader
          title={
            <PanelHeaderLabel
              title={activeItem?.label ?? "Note"}
              icon={<NoteIcon size={16} />}
            />
          }
          navigation={
            <IconButton
              ref={backRef}
              aria-label="Back to notes"
              title="Back to notes"
              icon={<ArrowLeftIcon size={16} />}
              onClick={() => working.select("browse")}
            />
          }
        />
        {items.map((item) => (
          <div
            key={item.id}
            className={styles.noteView}
            hidden={item.id !== active}
          >
            {item.content}
          </div>
        ))}
      </Panel>
    </div>
  );
  return (
    <div
      className={
        working
          ? styles.page
          : `${layoutStyles.split} ${panelStyles.splitMotion}`
      }
      ref={working ? undefined : split.ref}
      data-side={readerOpen ? "" : undefined}
    >
      <div
        className={working ? styles.collection : layoutStyles.main}
        hidden={!!working && readerOpen}
      >
        <NotesPanel
          refresh={refresh}
          refreshRef={refreshRef}
          loading={result.loading || !!working?.loading}
          working={working}
        >
          {working && (
            <>
              <SearchField
                inputRef={working.searchRef}
                label="Search notes"
                placeholder="Search loaded notes…"
                value={working.query}
                onValueChange={(value) => working.search(value)}
                onBlur={() => working.search(working.query, true)}
                onKeyDown={(event) => {
                  if (event.key === "Enter")
                    working.search(working.query, true);
                }}
              />
              <Checkbox
                label="Show deleted notes"
                checked={working.trash}
                onCheckedChange={working.showDeleted}
              />
              {working.error && <p role="alert">{working.error}</p>}
              {working.sharingError && (
                <p role="alert">
                  Automatic agent access needs attention: {working.sharingError}
                </p>
              )}
            </>
          )}
          {!working && author && (
            <div className={styles.folderHeader}>
              <IconButton
                hint="familiar"
                variant="ghost"
                aria-label="Back to folders"
                title="Back to folders"
                icon={<ArrowLeftIcon size="1rem" aria-hidden="true" />}
                onClick={() => openFolder("")}
              />
              <h2 className="text-heading" ref={folderTitle} tabIndex={-1}>
                {folder?.name}
              </h2>
            </div>
          )}
          {routeError && <p role="alert">{routeError}</p>}
          {pending && <p role="status">Loading your agents…</p>}
          {!pending && !complete && !inventoryError && (
            <div role="status">
              <p>
                Some agents could not be checked. Showing notes from available
                agents.
              </p>
              <Button onClick={refreshAgents}>Retry agents</Button>
            </div>
          )}
          {inventoryError && (
            <div role="alert">
              <p>{inventoryError}</p>
              <Button onClick={refreshAgents}>Retry agents</Button>
            </div>
          )}
          {result.sharedError && (
            <p role="status" className="text-body-sm text-secondary">
              {result.sharedError}
            </p>
          )}
          {result.error && (
            <div role="alert">
              <p>{result.error}</p>
              <Button
                ref={preserveControlFocus}
                loading={result.loading}
                onClick={() =>
                  setRequest((old) => ({ ...old, version: old.version + 1 }))
                }
              >
                Retry notes
              </Button>
            </div>
          )}
          {!pending &&
            complete &&
            !inventoryError &&
            !result.loading &&
            !result.error &&
            !working?.loading &&
            !working?.error &&
            !working?.entries.length &&
            !(working
              ? result.notes.length
              : author
                ? visible.length
                : folders.length) && (
              <EmptyState
                icon={<NoteIcon size="1.5rem" />}
                title="No notes yet"
                description={
                  working
                    ? "Create a note or ask an agent to save one."
                    : author
                      ? "This folder has no notes in the loaded collection. Go back to folders to browse another agent."
                      : "Ask one of your agents to save a recipe or reference as a shared note, then refresh."
                }
              />
            )}
          {working ? (
            renderNoteGrid(result.notes)
          ) : !author && !query ? (
            <section
              className={styles.folderGroups}
              aria-label="Agent folders"
              ref={folderGrid}
            >
              {[
                ...(working ? [{ owned: true, label: "You" }] : []),
                { owned: true, label: "Your agents" },
                { owned: false, label: working ? "Others" : "Other agents" },
              ].map((group) => {
                const items = folders.filter(
                  (agent) =>
                    agent.owned === group.owned &&
                    (!working ||
                      (group.label === "You"
                        ? agent.pubkey === session.viewer
                        : agent.pubkey !== session.viewer)),
                );
                // Folders start in alphabetical order; retain that order for ties.
                if (!group.owned) items.sort((a, b) => b.latest - a.latest);
                return items.length || (group.owned && working) ? (
                  <Fragment key={group.label}>
                    {items.length > 0 && (
                      <section aria-label={group.label}>
                        <h2 className="text-label">{group.label}</h2>
                        <div className={styles.folders}>
                          {items.map((agent) => (
                            <SurfaceButton
                              key={agent.pubkey}
                              className={styles.folderCard}
                              aria-label={`Open ${agent.name} folder`}
                              data-agent={agent.pubkey}
                              onClick={() => openFolder(agent.pubkey)}
                            >
                              <span className={styles.folderAvatar}>
                                <Avatar
                                  src={avatarMedia(
                                    agent.picture,
                                    session.media,
                                  )}
                                  alt=""
                                  fallback={agent.name}
                                  size="fill"
                                  shape="squircle"
                                />
                              </span>
                              <span
                                className={`${styles.folderName} text-label`}
                              >
                                {agent.name}
                              </span>
                              <span className="text-caption text-subtle">
                                {agent.count}{" "}
                                {working
                                  ? agent.count === 1
                                    ? "note"
                                    : "notes"
                                  : agent.count === 1
                                    ? "shared note"
                                    : "shared notes"}
                              </span>
                            </SurfaceButton>
                          ))}
                        </div>
                      </section>
                    )}
                    {group.owned &&
                      renderNoteGrid(
                        working
                          ? ownedNotes.filter((note) =>
                              group.label === "You"
                                ? note.pubkey === session.viewer
                                : note.pubkey !== session.viewer,
                            )
                          : ownedNotes,
                        working
                          ? group.label === "You"
                            ? "you"
                            : "agents"
                          : undefined,
                      )}
                    {working &&
                      !group.owned &&
                      renderNoteGrid(
                        result.notes.filter(
                          (note) =>
                            !ownedAgents.some(
                              (agent) => agent.pubkey === note.pubkey,
                            ),
                        ),
                        "others",
                      )}
                  </Fragment>
                ) : null;
              })}
            </section>
          ) : (
            renderNoteGrid(author ? visible : result.notes)
          )}
          {(result.partial || working?.more) && (
            <div>
              <Button
                size="sm"
                ref={preserveControlFocus}
                loading={result.loading || !!working?.loading}
                onClick={() => {
                  if (working?.more) working.loadMore();
                  if (result.partial)
                    setRequest((old) => ({
                      version: old.version + 1,
                      more: true,
                    }));
                }}
              >
                {working ? "Load more notes" : "Load older notes"}
              </Button>
            </div>
          )}
        </NotesPanel>
      </div>
      {fullView}
      {!working && (
        <PanelDock
          open={readerOpen}
          keepMounted
          className={layoutStyles.side}
          resizeHandle={split.handle}
        >
          <aside aria-label="Note reader">
            <Panel aria-label="Note details">
              <PanelWorkspace
                label="Open notes"
                value={active}
                select={(key) => {
                  setSelected(key);
                  visit(
                    key === profileKey
                      ? { author, profile }
                      : { author, note: key },
                    true,
                  );
                }}
                items={items}
              />
            </Panel>
          </aside>
        </PanelDock>
      )}
    </div>
  );
}

const noteKeyOrEmpty = (note: EventData | undefined) =>
  note ? noteKey(note) : "";

function NoteBody({
  note,
  author,
  picture,
  openProfile,
  onConvert,
}: {
  openProfile?: (() => void) | undefined;
  onConvert?: (() => void) | undefined;
  note: EventData;
  author: string;
  picture?: string | undefined;
}) {
  const plain =
    note.content.length > MAX_MARKDOWN_LENGTH ||
    scanMarkdown(note.content).tooDeep;
  return (
    <article className={styles.document} aria-label={noteTitle(note)}>
      <h2 className="text-heading">{noteTitle(note)}</h2>
      <NoteByline
        note={note}
        author={author}
        picture={picture}
        openProfile={openProfile}
      />
      {onConvert && (
        <div>
          <Button onClick={onConvert}>Make editable copy</Button>
        </div>
      )}
      <div className={styles.markdown}>
        {plain ? (
          <pre>{note.content}</pre>
        ) : (
          <Markdown
            remarkPlugins={[remarkGfm]}
            urlTransform={(url) => safeLinkUrl(url) ?? null}
            components={{
              img: ({ alt }) => alt ?? null,
              a: ({ children, href, title }) =>
                href ? (
                  <a
                    href={href}
                    title={title}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {children}
                  </a>
                ) : (
                  children
                ),
            }}
          >
            {note.content}
          </Markdown>
        )}
      </div>
    </article>
  );
}
