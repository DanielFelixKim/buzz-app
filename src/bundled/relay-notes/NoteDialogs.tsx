import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { MemberAuthority } from "../../features/channel-members/administration-protocol";
import { AGENTS_LABEL, noteKey, type Note } from "../../features/notes/model";
import type { NotesWorkspace } from "../../features/notes/workspace";
import { Button } from "../../shared/design-system/ui/Button";
import { Checkbox } from "../../shared/design-system/ui/Checkbox";
import { Combobox } from "../../shared/design-system/ui/Combobox";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { Select } from "../../shared/design-system/ui/Select";
import { SurfaceButton } from "../../shared/design-system/ui/SurfaceButton";
import { formatPublicKey } from "../../shared/identity/public-key";
import styles from "./WorkingNotes.module.css";

const message = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "The operation could not be completed.";

export function NoteLinkPicker({
  notes,
  onSelect,
  onClose,
}: {
  notes: readonly Note[];
  onSelect(note: Note): void;
  onClose(): void;
}) {
  const available = notes.filter((note) => !note.deleted);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Link a note"
      size="compact"
    >
      <Combobox.Root
        items={available}
        itemToStringLabel={(note: Note) => note.title}
        itemToStringValue={noteKey}
        autoHighlight
        defaultOpen
        onValueChange={(note) => {
          if (note) onSelect(note);
        }}
      >
        <Combobox.Control
          label="Note"
          triggerLabel="Browse notes"
          placeholder="Search loaded notes…"
          autoFocus
        />
        <Combobox.Popup empty="No accessible notes match.">
          <Combobox.List>
            {(note: Note) => (
              <Combobox.Item key={noteKey(note)} value={note}>
                {note.title}
              </Combobox.Item>
            )}
          </Combobox.List>
        </Combobox.Popup>
      </Combobox.Root>
      <p className="text-caption text-subtle">
        This link uses the note’s stable identity. It does not change access.
      </p>
    </Dialog>
  );
}

export function NoteSharing({
  note,
  workspace,
  onClose,
}: {
  note: Note;
  workspace: NotesWorkspace;
  onClose(): void;
}) {
  const [authority, setAuthority] = useState<MemberAuthority>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState("");
  const [access, setAccess] = useState("read");
  const [agents, setAgents] = useState(false);
  const session = workspace.session;
  const profiles = useSyncExternalStore(
    session.profiles.subscribe,
    session.profiles.snapshot,
    session.profiles.snapshot,
  );
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      await workspace.resolve(note, controller.signal);
      const state = await workspace.sharing(note.channel, controller.signal);
      const roles = state.authority;
      controller.signal.throwIfAborted();
      setAuthority(roles);
      setAgents(state.labels.includes(AGENTS_LABEL));
      await session.profiles.ensure(Object.keys(roles.roles));
    })().catch((error: unknown) => {
      if (!controller.signal.aborted) setError(message(error));
    });
    return () => controller.abort();
  }, [workspace, note, session]);
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await work();
      const state = await workspace.sharing(note.channel);
      const current = state.authority;
      setAuthority(current);
      setAgents(state.labels.includes(AGENTS_LABEL));
      await session.profiles.ensure(Object.keys(current.roles));
    } catch (error) {
      setError(message(error));
    } finally {
      setBusy(false);
    }
  };
  const owner = authority?.roles[session.viewer ?? ""] === "owner";
  const name = (pubkey: string) =>
    profiles.get(pubkey)?.name ?? formatPublicKey(pubkey) ?? pubkey;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      preventClose={busy}
      title={`Share ${note.title}`}
      description="Access includes the current note and all retained revisions."
      size="default"
    >
      <div className={styles.stack}>
        {!authority && !error && <p role="status">Reading current access…</p>}
        {error && <p role="alert">{error}</p>}
        {owner && (
          <Checkbox
            label="Share with my agents automatically"
            checked={agents}
            disabled={busy}
            onCheckedChange={(checked) => {
              void run(async () => {
                await workspace.setAudience(note, checked);
                setAgents(checked);
              });
            }}
          />
        )}
        {authority && (
          <ul className={styles.members}>
            {Object.entries(authority.roles).map(([pubkey, role]) => (
              <li key={pubkey}>
                <div>
                  <span>{name(pubkey)}</span>
                  <small className="text-caption text-subtle">{pubkey}</small>
                </div>
                {authority.canManage &&
                pubkey !== session.viewer &&
                role !== "owner" ? (
                  <Select
                    label={`Access for ${name(pubkey)}`}
                    value={
                      role === "admin"
                        ? "admin"
                        : role === "guest"
                          ? "read"
                          : "edit"
                    }
                    disabled={busy}
                    groups={[
                      {
                        label: "Note access",
                        options: [
                          ...(role === "admin"
                            ? [{ value: "admin", label: "Administrator" }]
                            : []),
                          { value: "read", label: "Can read" },
                          { value: "edit", label: "Can edit" },
                          { value: "remove", label: "Remove access" },
                        ],
                      },
                    ]}
                    onValueChange={(value) => {
                      if (value === "admin") return;
                      void run(async () => {
                        const next = await workspace.setMember(
                          note,
                          pubkey,
                          value as "read" | "edit" | "remove",
                        );
                        setAuthority(next);
                        if (value === "remove") setAgents(false);
                      });
                    }}
                  />
                ) : (
                  <span className="text-caption text-subtle">
                    {role === "owner"
                      ? "Owner"
                      : role === "admin"
                        ? "Administrator"
                        : role === "guest"
                          ? "Can read"
                          : "Can edit"}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        {authority?.canManage && (
          <form
            className={styles.stack}
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                await workspace.setMember(
                  note,
                  key.trim(),
                  access as "read" | "edit",
                );
                setKey("");
              });
            }}
          >
            <Field label="Person or agent public key">
              <Input
                value={key}
                onValueChange={setKey}
                placeholder="64-character public key"
                disabled={busy}
              />
            </Field>
            <div className={styles.actions}>
              <Select
                label="Access"
                value={access}
                disabled={busy}
                groups={[
                  {
                    label: "Note access",
                    options: [
                      { value: "read", label: "Can read" },
                      { value: "edit", label: "Can edit" },
                    ],
                  },
                ]}
                onValueChange={setAccess}
              />
              <Button type="submit" disabled={busy || !key.trim()}>
                Share note
              </Button>
            </div>
          </form>
        )}
        <p className="text-caption text-subtle">
          Editors can also delete and restore this note. Administrators can
          change roles and remove members.
        </p>
      </div>
    </Dialog>
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
