import { useEffect, useMemo, useRef, useState } from "react";
import { noteKey, type Note } from "../../features/notes/model";
import type { NotesWorkspace } from "../../features/notes/workspace";
import { writeView } from "../../shared/view-state";
import { DotsThreeIcon } from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Input } from "../../shared/design-system/ui/Input";
import {
  MenuRoot,
  MenuTrigger,
  MenuPopup,
  MenuItem,
  MenuCheckboxItem,
} from "../../shared/design-system/ui/Menu";
import { Select } from "../../shared/design-system/ui/Select";
import { NoteEditor, type NoteEditorHandle } from "./NoteEditor";
import type { NoteFocus } from "./NoteDocument";
import { NoteSaveAction } from "./NoteSaveAction";
import readerStyles from "./NotesPage.module.css";
import styles from "./WorkingNotes.module.css";

export type NewDraft = {
  id: string;
  title: string;
  markdown: string;
  agents?: boolean;
  autoSave?: boolean;
};

/** Creation uses the document editor; storage is allocated only after typing. */
export function NewNoteDocument({
  workspace,
  initial,
  catalogue,
  active,
  onDraftChange,
  onCreated,
}: {
  workspace: NotesWorkspace;
  initial: NewDraft;
  catalogue: readonly Note[];
  active: boolean;
  onDraftChange(draft: NewDraft): void;
  onCreated(note: Note, autoSave: boolean, focus?: NoteFocus): void;
}) {
  const [title, setTitle] = useState(initial.title);
  const [markdown, setMarkdown] = useState(initial.markdown);
  const [agents, setAgents] = useState(initial.agents ?? true);
  const [autoSave, setAutoSave] = useState(initial.autoSave ?? true);
  const [source, setSource] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [composing, setComposing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [accepted, setAccepted] = useState<Note>();
  const pending = useRef(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const handedOff = useRef(false);
  const titleInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState("");
  const [unverified, setUnverified] = useState<string[]>([]);
  const [toolbarTarget, setToolbarTarget] = useState<HTMLDivElement | null>(
    null,
  );
  const editor = useRef<NoteEditorHandle>(null);
  const body = useRef<HTMLDivElement>(null);
  const blankPress = useRef(false);
  const changedAt = useRef<number | undefined>(undefined);
  const attempt = useRef<(NewDraft & { agents: boolean }) | undefined>(
    undefined,
  );
  const draft = useMemo(
    () => ({ id: initial.id, title, markdown, agents, autoSave }),
    [initial.id, title, markdown, agents, autoSave],
  );
  const latest = useRef(draft);
  latest.current = draft;
  const callbacks = useRef({ onDraftChange, onCreated });
  callbacks.current = { onDraftChange, onCreated };
  const dirty = !!(title.trim() || markdown.trim());
  useEffect(() => {
    callbacks.current.onDraftChange(draft);
  }, [draft]);
  useEffect(() => {
    if (active) titleInput.current?.focus();
  }, [active]);
  useEffect(() => {
    if (!accepted || composing || handedOff.current) return;
    handedOff.current = true;
    const nextTitle = title.trim() || "Untitled note";
    if (nextTitle !== accepted.title || markdown !== accepted.markdown)
      workspace.drafts.set(noteKey(accepted), {
        base: accepted,
        title: nextTitle,
        markdown,
      });
    writeView(
      workspace.session.scope,
      `note-auto-save:${noteKey(accepted)}`,
      autoSave,
    );
    const selection = editor.current?.selection();
    const focus: NoteFocus | undefined =
      document.activeElement === titleInput.current
        ? {
            target: "title",
            start: titleInput.current?.selectionStart ?? 0,
            end: titleInput.current?.selectionEnd ?? 0,
            source: false,
          }
        : selection
          ? { target: "body", ...selection }
          : undefined;
    callbacks.current.onCreated(accepted, autoSave, focus);
  }, [accepted, composing, title, markdown, autoSave, workspace]);
  useEffect(() => {
    if (!dirty) return;
    const prevent = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [dirty]);
  const save = async (confirmed = false) => {
    if (
      pending.current ||
      accepted ||
      (!dirty && !attempt.current) ||
      composing
    )
      return;
    const controller = new AbortController();
    request.current = controller;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      if (!attempt.current && agents && !confirmed) {
        const access = await workspace.agentAccess(controller.signal);
        controller.signal.throwIfAborted();
        if (access.unverified.length) {
          setUnverified(access.unverified);
          return;
        }
      }
      // Reuse both UUID and payload after an uncertain creation receipt.
      // Later typing is retained as a draft against the accepted first revision.
      attempt.current ??= {
        ...latest.current,
        title: latest.current.title.trim() || "Untitled note",
      };
      const note = await workspace.create(attempt.current, controller.signal);
      controller.signal.throwIfAborted();
      setAccepted(note);
    } catch (error) {
      if (controller.signal.aborted) return;
      setError(
        error instanceof Error ? error.message : "The note could not be saved.",
      );
    } finally {
      request.current = null;
      pending.current = false;
      setBusy(false);
    }
  };
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    if (
      !active ||
      !autoSave ||
      !(title.trim() || markdown.trim()) ||
      accepted ||
      error ||
      (agents && unverified.length) ||
      composing ||
      linkOpen
    ) {
      changedAt.current = undefined;
      return;
    }
    if (busy) return;
    changedAt.current ??= Date.now();
    const timer = window.setTimeout(
      () => void saveRef.current(),
      Math.max(0, Math.min(1500, 10_000 - (Date.now() - changedAt.current))),
    );
    return () => window.clearTimeout(timer);
  }, [
    active,
    autoSave,
    accepted,
    error,
    agents,
    unverified,
    composing,
    linkOpen,
    busy,
    title,
    markdown,
  ]);
  const community = workspace.session.scope.replace(/:[0-9a-f]{64}$/, "");
  return (
    <article className={styles.documentPane} aria-label="New note">
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: blank-space clicks extend the existing textbox hit area; keyboard users reach that textbox with Tab. */}
      <section
        className={readerStyles.document}
        aria-label="Note contents"
        onCompositionStart={() => setComposing(true)}
        onCompositionEnd={() => setComposing(false)}
        onPointerDown={(event) => {
          blankPress.current = event.target === event.currentTarget;
        }}
        onClick={(event) => {
          const blank = blankPress.current;
          blankPress.current = false;
          if (
            blank &&
            event.target === event.currentTarget &&
            event.button === 0 &&
            !event.metaKey &&
            !event.ctrlKey &&
            !event.altKey &&
            !event.shiftKey &&
            body.current &&
            event.clientY >= body.current.getBoundingClientRect().bottom
          )
            editor.current?.focusEnd();
        }}
      >
        <Field label="Title" labelVisibility="hidden">
          <Input
            ref={titleInput}
            appearance="heading"
            placeholder="Untitled note"
            value={title}
            onValueChange={setTitle}
          />
        </Field>
        <div className={styles.actions}>
          <Select
            label="Document mode"
            variant="compact"
            size="sm"
            value="editing"
            onValueChange={() => {}}
            disabled
            groups={[
              {
                label: "Document mode",
                options: [{ value: "editing", label: "Editing" }],
              },
            ]}
          />
          <NoteSaveAction
            shown={(dirty || !!attempt.current) && (!autoSave || !!error)}
            loading={busy}
            onClick={() => void save()}
          >
            {error ? "Retry save" : "Save"}
          </NoteSaveAction>
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
              <MenuItem
                onClick={() => {
                  setAutoSave(!autoSave);
                }}
              >
                {autoSave ? "Disable auto-save" : "Enable auto-save"}
              </MenuItem>
              <MenuItem onClick={() => setSource(!source)}>
                {source ? "Formatted text" : "Markdown source"}
              </MenuItem>
              <MenuCheckboxItem
                checked={agents}
                disabled={busy || !!attempt.current}
                onCheckedChange={setAgents}
              >
                Share with my agents
              </MenuCheckboxItem>
            </MenuPopup>
          </MenuRoot>
        </div>
        <p role="status" className="text-caption text-subtle">
          {busy ? "Saving…" : dirty ? "Unsaved changes" : "Start writing…"}
        </p>
        {error && (
          <p role="alert">Auto-save is paused. Your draft is kept. {error}</p>
        )}
        {agents && unverified.length > 0 && (
          <div className={styles.stack}>
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
              . You can create with verified agents, or turn off agent sharing
              to create privately.
            </p>
            <Button size="sm" disabled={busy} onClick={() => void save(true)}>
              Create with verified agents
            </Button>
          </div>
        )}
        <div ref={body}>
          <NoteEditor
            ref={editor}
            value={markdown}
            editing
            disabled={false}
            onChange={setMarkdown}
            notes={catalogue}
            community={community}
            linkOpen={active && linkOpen}
            onLinkOpenChange={setLinkOpen}
            onSave={() => void save()}
            toolbarTarget={toolbarTarget}
            source={source}
            onSourceChange={setSource}
          >
            {null}
          </NoteEditor>
        </div>
      </section>
      <div
        ref={setToolbarTarget}
        className={styles.editorDock}
        hidden={source}
      />
    </article>
  );
}
