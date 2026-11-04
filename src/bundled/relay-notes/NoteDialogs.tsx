import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";
import type { MemberChange } from "../../features/channel-members/administration-protocol";
import { ChannelMembersDialog } from "../channels/ChannelMembersDialog";
import { noteUrl, type Note } from "../../features/notes/model";
import type { NotesWorkspace } from "../../features/notes/workspace";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { SurfaceButton } from "../../shared/design-system/ui/SurfaceButton";
import styles from "./WorkingNotes.module.css";

const message = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "The operation could not be completed.";

export function NoteSharing({
  note,
  workspace,
  onClose,
  trigger,
}: {
  note: Note;
  workspace: NotesWorkspace;
  onClose(): void;
  trigger: RefObject<HTMLElement | null>;
}) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const lifetime = useRef<AbortController | undefined>(undefined);
  const session = workspace.session;
  const { id, channel } = note;
  const administration = useSyncExternalStore(
    session.memberAdministration.subscribe,
    () => session.memberAdministration.snapshot(note.channel),
  );
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    void (async () => {
      await workspace.resolve({ id, channel }, controller.signal);
      await workspace.sharing(channel, controller.signal);
      controller.signal.throwIfAborted();
    })().catch((error: unknown) => {
      if (!controller.signal.aborted) setError(message(error));
    });
    return () => controller.abort();
  }, [workspace, id, channel]);
  const run = async (
    work?: (signal: AbortSignal) => Promise<unknown>,
    caller?: AbortSignal,
  ) => {
    if (pending.current)
      throw new Error("Wait for the current sharing change to finish.");
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted) throw new Error("Reopen sharing to retry.");
    const active = caller ? AbortSignal.any([signal, caller]) : signal;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      await work?.(active);
      await workspace.sharing(note.channel, active);
      active.throwIfAborted();
      await session.memberAdministration.refresh(note.channel);
    } finally {
      pending.current = false;
      if (!signal.aborted) setBusy(false);
    }
  };
  const roles =
    administration.status === "ready" ? administration.authority : undefined;
  const change = (change: MemberChange, signal: AbortSignal) =>
    run(
      (active) =>
        workspace.setMember(
          note,
          change.pubkey,
          change.role === "guest"
            ? "read"
            : change.role === "member"
              ? "edit"
              : change.role,
          active,
          { expectedRole: change.expectedRole },
        ),
      signal,
    );
  return (
    <ChannelMembersDialog
      session={session}
      channelId={note.channel}
      trigger={trigger}
      close={onClose}
      title="Share access"
      description="Access includes the current note and all retained revisions."
      shareLink={noteUrl(note, session.scope.replace(/:[0-9a-f]{64}$/, ""))}
      memberActions={{ canAdd: !!roles?.canManage, pending: busy, change }}
      accessSettings={
        <div className={`${styles.stack} ${styles.sharingSettings}`}>
          {error && (
            <div>
              <p role="alert">{error}</p>
              <Button
                size="sm"
                disabled={busy}
                onClick={() => {
                  void run().catch((error: unknown) =>
                    setError(message(error)),
                  );
                }}
              >
                Retry note access
              </Button>
            </div>
          )}
          <p className="text-caption text-subtle">
            Private note. Owners and admins manage access; participants can
            edit, delete and restore it.
          </p>
        </div>
      }
    />
  );
}

export function NoteHistory({
  note,
  workspace,
  canEdit,
  onUse,
  onClose,
  selection,
  onSelection,
  onPage,
}: {
  note: Note;
  workspace: NotesWorkspace;
  canEdit: boolean;
  onUse(revision: Note): void;
  onClose(): void;
  selection?: { revision?: string; offset?: number } | undefined;
  onSelection?(revision: string): void;
  onPage?(offset: number): void;
}) {
  const [revisions, setRevisions] = useState<Note[]>([]);
  const [more, setMore] = useState(false);
  const [limited, setLimited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [localSelected, setSelected] = useState<Note>();
  const [localOffset, setOffset] = useState(0);
  const offset = selection ? (selection.offset ?? 0) : localOffset;
  const selected = selection
    ? revisions.find((revision) => revision.revision === selection.revision)
    : localSelected;
  const load = useCallback(
    async (offset: number, signal?: AbortSignal) => {
      setBusy(true);
      setError("");
      try {
        const page = await workspace.history(note, offset, signal);
        signal?.throwIfAborted();
        setRevisions(page.revisions);
        setMore(page.more);
        setLimited(page.limited);
      } catch (error) {
        if (!signal?.aborted) setError(message(error));
      } finally {
        if (!signal?.aborted) setBusy(false);
      }
    },
    [workspace, note],
  );
  useEffect(() => {
    const controller = new AbortController();
    void load(offset, controller.signal);
    return () => controller.abort();
  }, [load, offset]);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Revision history"
      size="wide"
      height="stable"
    >
      <div className={styles.stack}>
        {error && <p role="alert">{error}</p>}
        {busy && <p role="status">Reading revisions…</p>}
        <ul className={styles.history}>
          {revisions.map((revision) => (
            <li key={revision.revision}>
              <SurfaceButton
                className={styles.revision}
                onClick={() => {
                  setSelected(revision);
                  onSelection?.(revision.revision);
                }}
              >
                <span>{revision.deleted ? "Deleted" : revision.title}</span>
                <span className="text-caption text-subtle">
                  {new Date(revision.event.created_at * 1000).toLocaleString()}{" "}
                  · {revision.revision.slice(0, 8)}
                </span>
              </SurfaceButton>
            </li>
          ))}
        </ul>
        {more && (
          <Button
            disabled={busy}
            onClick={() => {
              setOffset(offset + 100);
              onPage?.(offset + 100);
            }}
          >
            Load older revisions
          </Button>
        )}
        {limited && (
          <p role="status">
            More retained history exceeds this app’s page limit.
          </p>
        )}
        {offset > 0 && (
          <Button
            disabled={busy}
            onClick={() => {
              setOffset(Math.max(0, offset - 100));
              onPage?.(Math.max(0, offset - 100));
            }}
          >
            Newer revisions
          </Button>
        )}
        {selected && (
          <section aria-label="Selected revision" className={styles.stack}>
            <h2 className="text-label">{selected.title}</h2>
            <pre className={styles.source}>
              {selected.markdown || "Empty revision"}
            </pre>
            {canEdit && selected.editable && !selected.deleted && (
              <Button onClick={() => onUse(selected)}>
                Use this revision in editor
              </Button>
            )}
          </section>
        )}
      </div>
    </Dialog>
  );
}
