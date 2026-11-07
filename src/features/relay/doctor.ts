import type { RelayData, RelaySnapshot } from "./service";
import type { RelaySession } from "./session";
import { isTransientLiveError } from "./live-recovery";

export type DoctorIssueId =
  | "connection"
  | "live"
  | "catalog"
  | "workspaces"
  | "sidebar"
  | "visibility"
  | "agents";
export type DoctorIssue = Readonly<{
  id: DoctorIssueId;
  title: string;
  details: readonly string[];
  busy: boolean;
  quiet: boolean;
  failure?: number;
}>;
type Source = Omit<DoctorIssue, "quiet"> & {
  failed: boolean;
  transient?: boolean | undefined;
  retry(): unknown;
};

function sources(connection: RelaySnapshot, relay: RelayData): Source[] {
  const session = connection.session;
  const state = session.live.snapshot();
  const choices = session.agentChoices.snapshot();
  const library = session.agentLibrary.snapshot();
  const liveErrors = [
    state.error,
    state.roster.error,
    ...state.routes
      .filter((route) => route.status === "error")
      .map((route) => route.error ?? "Conversation updates could not connect."),
    ...state.heads
      .filter((head) => head.state === "error")
      .map((head) => head.error ?? "Messages could not refresh."),
  ].filter((error): error is string => !!error);
  const liveFailed =
    liveErrors.length > 0 ||
    ["retrying", "error", "unavailable"].includes(state.status) ||
    ["error", "deferred"].includes(state.roster.state);
  const liveRefused =
    (state.status === "error" && !isTransientLiveError(state.error)) ||
    (state.roster.state === "error" && !state.roster.transient) ||
    state.heads.some((head) => head.state === "error" && !head.transient) ||
    state.routes.some(
      (route) => route.status === "error" && !isTransientLiveError(route.error),
    );
  const read = (
    id: DoctorIssueId,
    title: string,
    snapshot: {
      status: string;
      error?: string | undefined;
      transient?: true | undefined;
    },
    retry: Source["retry"],
  ): Source => ({
    id,
    title,
    details: snapshot.error
      ? [snapshot.error]
      : [`${title} could not refresh.`],
    failed: snapshot.status === "error" || !!snapshot.error,
    busy: snapshot.status === "loading",
    transient: snapshot.transient,
    retry,
  });
  return [
    {
      id: "connection",
      title: "Community connection",
      details: [connection.error ?? "Your community could not connect."],
      failed: connection.status === "error",
      busy: connection.status === "connecting",
      transient: connection.retrying,
      retry: relay.retry,
    },
    // A cached/offline session has no live transport. Connection recovery owns it.
    ...(connection.cached || !session.recovery
      ? []
      : [
          {
            id: "live" as const,
            title: "Conversations and live updates",
            details: [
              ...new Set(
                liveErrors.length
                  ? liveErrors
                  : ["Conversation updates could not connect."],
              ),
            ],
            failed: liveFailed,
            busy:
              !liveFailed &&
              (state.status === "connecting" ||
                state.roster.state === "pending" ||
                state.heads.some((head) => head.state === "pending") ||
                state.routes.some((route) => route.status === "pending")),
            // A refusal must remain visible even if another route is recovering.
            transient: !liveRefused,
            retry: session.live.retry,
          },
          read(
            "catalog",
            "Channel templates",
            session.channelKit.snapshot(),
            () => session.channelKit.refresh(),
          ),
          read(
            "workspaces",
            "Workspaces",
            session.soloPreferences.snapshot(),
            () => session.soloPreferences.refresh(),
          ),
          read(
            "sidebar",
            "Saved sidebar preferences",
            session.sidebarPreferences.snapshot(),
            () => session.sidebarPreferences.refresh(),
          ),
          read(
            "visibility",
            "Hidden conversations",
            session.channelLifecycle.snapshot(),
            () => session.channelLifecycle.refreshVisibility(),
          ),
          {
            ...read("agents", "Agent inventory", choices, () =>
              session.agentChoices.refresh(),
            ),
            // Choice inference also calls idle legacy evidence `pending`.
            // Only join reads that have actually started.
            busy:
              choices.status === "loading" ||
              library.status === "loading" ||
              (library.status === "ready" && choices.pending),
          },
        ]),
  ];
}

const subscriptions = (session: RelaySession) => [
  session.live,
  session.channelKit,
  session.soloPreferences,
  session.sidebarPreferences,
  session.channelLifecycle,
  session.agentChoices,
  ...(session.recovery ? [session.recovery] : []),
];

/** Presentation and explicit read retries only. Sources keep their automatic
 * recovery, coalescing, cancellation and partial data. No writes are replayed. */
export function createDoctor(
  relay: RelayData,
  viewer?: string,
  origin?: string,
) {
  const listeners = new Set<() => void>();
  type Operation = {
    session: RelaySession;
    all: boolean;
    active?: DoctorIssueId;
  };
  const pending = new Map<DoctorIssueId, Operation>();
  const failures = new Map<
    DoctorIssueId,
    { session: RelaySession; count: number }
  >();
  let revision = 0;
  let inputs: readonly unknown[] = [];
  let snapshot = {
    session: relay.snapshot().session,
    issues: [] as readonly DoctorIssue[],
    busy: false,
    retryingAll: false,
    checking: relay.snapshot().status === "connecting",
  };
  const emit = () => {
    revision++;
    for (const listener of listeners) listener();
  };
  const getSnapshot = () => {
    const connection = relay.snapshot(),
      session = connection.session;
    const recovery = session.recovery?.snapshot();
    const nextInputs = [
      connection,
      revision,
      ...subscriptions(session).map((source) => source.snapshot()),
    ];
    if (
      nextInputs.length === inputs.length &&
      nextInputs.every((value, index) => value === inputs[index])
    )
      return snapshot;
    inputs = nextInputs;
    if (
      (viewer && connection.viewer && viewer !== connection.viewer) ||
      (origin && connection.origin && origin !== connection.origin)
    ) {
      snapshot = {
        session,
        issues: [],
        busy: false,
        retryingAll: false,
        checking: false,
      };
      return snapshot;
    }
    // The host recreates this model when the visible account/community changes.
    // A same-scope reconnect can replace the session before it knows its origin.
    const previous: readonly DoctorIssue[] =
      snapshot.session === session
        ? snapshot.issues
        : connection.status === "connecting" && snapshot.issues.length
          ? [
              {
                id: "connection",
                title: "Community connection",
                details: ["Reconnecting to your community…"],
                busy: true,
                quiet: false,
              },
            ]
          : [];
    const issues = sources(connection, relay).flatMap(
      (source): DoctorIssue[] => {
        const old = previous.find((issue) => issue.id === source.id);
        const operation = pending.get(source.id);
        const busy =
          operation?.session === session
            ? operation.active === source.id
            : source.busy;
        if (!source.failed)
          return busy && old
            ? [{ ...old, busy, quiet: old.quiet && !recovery?.shown }]
            : [];
        return [
          {
            id: source.id,
            title: source.title,
            details: source.details,
            busy,
            failure:
              failures.get(source.id)?.session === session
                ? (failures.get(source.id)?.count ?? 0)
                : 0,
            quiet:
              !!source.transient &&
              !!recovery?.recovering &&
              !recovery.shown &&
              (!old || old.quiet),
          },
        ];
      },
    );
    // A retry may have started before this host mounted, leaving only busy
    // source snapshots. Keep the existing delayed recovery entry point.
    if (recovery?.shown && !issues.length)
      issues.push({
        id: "live",
        title: "Conversations and live updates",
        details: ["Reconnecting to your community…"],
        busy: true,
        quiet: false,
      });
    snapshot = {
      session,
      issues,
      busy: [...pending.values()].some(
        (operation) => operation.session === session,
      ),
      retryingAll: [...pending.values()].some(
        (operation) => operation.session === session && operation.all,
      ),
      checking: connection.status === "connecting",
    };
    return snapshot;
  };
  return {
    snapshot: getSnapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      let session = relay.snapshot().session;
      let stops = subscriptions(session).map((source) =>
        source.subscribe(listener),
      );
      const stop = relay.subscribe(() => {
        const current = relay.snapshot().session;
        if (current !== session) {
          for (const stop of stops) stop();
          session = current;
          stops = subscriptions(session).map((source) =>
            source.subscribe(listener),
          );
        }
        listener();
      });
      return () => {
        stop();
        for (const stop of stops) stop();
        listeners.delete(listener);
      };
    },
    async retry(id?: DoctorIssueId) {
      const connection = relay.snapshot();
      const session = connection.session;
      // All Doctor entry points share one manual batch. Repeated clicks and
      // individual actions cannot start another batch while this one is active.
      if (
        [...pending.values()].some((operation) => operation.session === session)
      )
        return;
      const issues = getSnapshot().issues;
      if (!issues.length) return;
      const selected = sources(connection, relay).filter(
        (source) =>
          (!id ||
            source.id === id ||
            (id === "catalog" && source.id === "workspaces")) &&
          (issues.some((issue) => issue.id === source.id) ||
            (!id &&
              source.busy &&
              source.id !== "connection" &&
              source.id !== "live")) &&
          !(
            source.busy &&
            (source.id === "connection" || source.id === "live")
          ),
      );
      if (!selected.length) return;
      const operation: Operation = { session, all: !id };
      for (const source of selected) pending.set(source.id, operation);
      emit();
      const retry = async (source: Source) => {
        await source.retry();
        // Join work already in flight. If that pre-click read then fails,
        // make one fresh attempt rather than returning its stale failure.
        if (source.busy && relay.snapshot().session === session) {
          const current = sources(relay.snapshot(), relay).find(
            (item) => item.id === source.id,
          );
          if (current?.failed) await current.retry();
        }
      };
      try {
        // Sources are dependency ordered: connection/live, catalog, workspaces,
        // then independent finite reads. Keep one finite source retry at a time.
        // A catalog need not change its Solo head, so still refresh the failed
        // workspace projection after it, even when that head is unchanged.
        for (const source of selected) {
          if (relay.snapshot().session !== session) break;
          const current = sources(relay.snapshot(), relay).find(
            (item) => item.id === source.id,
          );
          // Earlier recovery may already have repaired this queued source.
          if (!current || (!current.failed && !current.busy)) continue;
          operation.active = source.id;
          emit();
          try {
            await retry(current);
          } catch {
            // Source snapshots retain their own failure; later issues can still recover.
          } finally {
            if (
              relay.snapshot().session === session &&
              sources(relay.snapshot(), relay).find(
                (item) => item.id === source.id,
              )?.failed
            ) {
              const previous = failures.get(source.id);
              failures.set(source.id, {
                session,
                count: (previous?.session === session ? previous.count : 0) + 1,
              });
            }
            delete operation.active;
            emit();
          }
        }
      } finally {
        for (const source of selected)
          if (pending.get(source.id) === operation) pending.delete(source.id);
        emit();
      }
    },
  };
}
