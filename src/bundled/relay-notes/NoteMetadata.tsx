import type { NoteEvent } from "../../features/notes/model";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { Button } from "../../shared/design-system/ui/Button";
import { relativeTimestamp } from "../../shared/relative-timestamp";
import { noteTag } from "./collection";
import styles from "./NotesPage.module.css";

export function NoteByline({
  note,
  author,
  picture,
  openProfile,
}: {
  note: NoteEvent;
  author: string;
  picture?: string | undefined;
  openProfile?: (() => void) | undefined;
}) {
  return (
    <p className={`${styles.byline} text-caption text-secondary`}>
      <NoteAuthor name={author} picture={picture} open={openProfile} /> ·
      Updated <NoteTime note={note} />
      {note.kind === 30023 && <NoteIdentifier note={note} />}
    </p>
  );
}

export function NoteIdentifier({
  note,
  separator = true,
}: {
  note: { readonly tags: readonly (readonly string[])[] };
  separator?: boolean;
}) {
  const identifier = noteTag(note, "d");
  return identifier ? (
    <>
      {separator && " · "}
      <code
        className={`${styles.identifier} text-mono font-mono`}
        title={`Saved as ${identifier}`}
      >
        {identifier}
      </code>
    </>
  ) : null;
}

export function NoteTime({ note }: { note: Pick<NoteEvent, "created_at"> }) {
  const date = new Date(note.created_at * 1000);
  const days = Math.floor((Date.now() / 1000 - note.created_at) / 86400);
  // The shared recency ladder switches to calendar dates after a week; notes
  // keep older timestamps relative too, with the exact date in the title.
  const label =
    days >= 7
      ? new Intl.RelativeTimeFormat(undefined, { numeric: "always" }).format(
          -days,
          "day",
        )
      : relativeTimestamp(note.created_at);
  return (
    <time
      dateTime={date.toISOString()}
      title={date.toLocaleString(undefined, {
        dateStyle: "full",
        timeStyle: "long",
      })}
    >
      {label}
    </time>
  );
}

export function NoteAuthor({
  name,
  picture,
  open,
}: {
  name: string;
  picture?: string | undefined;
  open?: (() => void) | undefined;
}) {
  const identity = (
    <>
      <Avatar
        src={picture}
        alt=""
        fallback={name}
        size="compact"
        shape="squircle"
      />
      <span>{name}</span>
    </>
  );
  return open ? (
    <Button
      variant="plain"
      size="inline"
      aria-label={`View ${name} profile`}
      onClick={open}
    >
      {identity}
    </Button>
  ) : (
    <span className={styles.byline}>{identity}</span>
  );
}
