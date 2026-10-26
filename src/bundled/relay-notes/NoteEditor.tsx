import { useEffect, useRef, useState, type ReactNode } from "react";
import { EditableInput } from "../../features/messages/EditableInput";
import { ComposerFormattingTools } from "../../features/messages/ComposerFormattingTools";
import { ComposerLinkDialog } from "../../features/messages/ComposerLinkDialog";
import type {
  ComposerFormat,
  ComposerInputElement,
  ComposerLinkEdit,
} from "../../features/messages/composer-dom";
import { composerMarkdown } from "../../features/messages/composer-markdown";
import { MAX_NOTE_BYTES, noteUrl, type Note } from "../../features/notes/model";
import { Button } from "../../shared/design-system/ui/Button";
import { Textarea } from "../../shared/design-system/ui/Textarea";
import { noteEditorDraft } from "./editor-markdown";
import styles from "./WorkingNotes.module.css";

const noDecorations = () => [];

/** A document body using the composer's editing engine, without chat behavior. */
export function NoteEditor({
  value,
  editing,
  children,
  onChange,
  disabled,
  notes,
  community,
  linkOpen,
  onLinkOpenChange,
  onSave,
}: {
  value: string;
  editing: boolean;
  children: ReactNode;
  onChange(value: string): void;
  disabled: boolean;
  notes: readonly Note[];
  community: string;
  linkOpen: boolean;
  onLinkOpenChange(open: boolean): void;
  onSave(): void;
}) {
  const input = useRef<ComposerInputElement>(null);
  const [draft, setDraft] = useState(() => noteEditorDraft(value));
  const [formats, setFormats] = useState<readonly ComposerFormat[]>([]);
  const [link, setLink] = useState<ComposerLinkEdit>();
  const [source, setSource] = useState(false);
  const emitted = useRef(value);
  useEffect(() => {
    if (value === emitted.current) return;
    emitted.current = value;
    setDraft(noteEditorDraft(value));
  }, [value]);
  useEffect(() => {
    if (!linkOpen) {
      setLink(undefined);
      return;
    }
    if (source) setSource(false);
    setLink((old) => old ?? input.current?.editLink() ?? undefined);
  }, [linkOpen, source]);
  const editLink = (edit?: ComposerLinkEdit) => {
    const next = edit ?? input.current?.editLink();
    if (!next) return;
    setLink(next);
    onLinkOpenChange(true);
  };
  return (
    <div className={styles.stack}>
      <div
        className={styles.editorToolbar}
        data-viewing={!editing || undefined}
        inert={!editing}
        aria-hidden={!editing || undefined}
      >
        {!source && (
          <ComposerFormattingTools
            persistent
            disabled={disabled || !editing}
            activeFormats={formats}
            toggleFormat={(format) => input.current?.toggleFormat(format)}
            editLink={() => editLink()}
          >
            {null}
          </ComposerFormattingTools>
        )}
        <Button
          size="sm"
          variant="ghost"
          aria-pressed={source}
          onClick={() => setSource(!source)}
          disabled={disabled || !editing}
        >
          {source ? "Formatted text" : "Markdown source"}
        </Button>
      </div>
      <section className={styles.editorBody} aria-label="Document content">
        <div hidden={!editing}>
          {source ? (
            <Textarea
              aria-label="Markdown"
              value={value}
              rows={18}
              variant="code"
              disabled={disabled || !editing}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                  event.preventDefault();
                  onSave();
                }
              }}
              onChange={(event) => {
                emitted.current = event.target.value;
                onChange(event.target.value);
                setDraft(noteEditorDraft(event.target.value));
              }}
            />
          ) : (
            <div className="text-body">
              <EditableInput
                ref={input}
                draft={draft}
                value={draft.text}
                disabled={disabled || !editing}
                placeholder="Write your document…"
                aria-label="Document body"
                maxLength={MAX_NOTE_BYTES}
                decorationsFor={noDecorations}
                onDraftChange={(next) => {
                  setDraft(next);
                  const markdown = composerMarkdown(next);
                  emitted.current = markdown;
                  onChange(markdown);
                }}
                onFormatsChange={setFormats}
                onEditLink={editLink}
                onKeyDown={(event) => {
                  if (
                    !event.defaultPrevented &&
                    (event.metaKey || event.ctrlKey) &&
                    !event.altKey &&
                    !event.shiftKey &&
                    event.key.toLowerCase() === "k"
                  ) {
                    event.preventDefault();
                    editLink();
                  }

                  if (
                    (event.metaKey || event.ctrlKey) &&
                    event.key === "Enter"
                  ) {
                    event.preventDefault();
                    onSave();
                  }
                  if (
                    event.key === "[" &&
                    input.current?.value[input.current.selectionStart - 1] ===
                      "["
                  ) {
                    event.preventDefault();
                    const start = input.current.selectionStart - 1;
                    input.current.setSelectionRange(
                      start,
                      input.current.selectionEnd,
                    );
                    const next = input.current.editLink();
                    if (next) editLink({ ...next, text: "" });
                  }
                }}
              />
            </div>
          )}
        </div>
        {!editing && children}
      </section>
      {editing && linkOpen && link && (
        <ComposerLinkDialog
          edit={link}
          input={input}
          disabled={disabled || !editing}
          destinations={notes
            .filter((note) => !note.deleted)
            .map((note) => ({
              label: note.title,
              href: noteUrl(note, community),
            }))}
          close={() => onLinkOpenChange(false)}
        />
      )}
    </div>
  );
}
