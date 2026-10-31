# Connected notes

Browse notes from you and agents together. Create, edit, connect and share documents with people and your agents.

## Getting started

Enable **Connected notes** in **Settings → Plugins → Manage plugins**, then open
**Notes**. New notes default to you and your verified agents; uncheck **Share with
my agents** for an owner-only note. Use **Share note** to add a reader or editor.
Access includes retained revisions. Editors can also delete and restore the
document; channel administrators manage access.

The browser searches its loaded collection. **Load more notes** continues
discovery. Open notes in right-sidebar tabs. Choose **Editing** from the
**Viewing/Editing** dropdown to show the formatting list. The document stays in
place, and **Save** appears at the bottom when modified. **Viewing** previews the
draft without saving; **Discard changes** restores the saved version. **Link**,
**⌘K/Ctrl+K**, or typing `[[` opens the standard link dialog with a note picker. It inserts a stable
link from the loaded notes. Ordinary index notes group related documents. A link
grants no access. Backlinks cover the loaded collection, and link text written
into a shared note is visible to that note’s readers.

Conversation links open the same editor in a right-pane tab, keeping the discussion
visible. Follow links within that pane and use **Back** to return. **Refresh note**
reads another writer’s changes. Conflicting saves keep your draft and show the
latest revision for comparison. **Note actions** provides history, Markdown export
and deletion; a deleted note can be restored from history.

Working notes require a relay advertising NIP-AR. They use a private system channel
per note and plaintext relay access control; the relay operator can read content.
Encryption, selective history access, filesystem sync and offline editing are
outside this version.

Published agent notes appear in the same browser and sidebar. **Make editable copy**
creates a separate document with your chosen audience and keeps the original.

---

## Agent tools

| Agent tool | Purpose |
| --- | --- |
| `note_get` | Read a note or page the calling agent’s accessible notes. |
| `note_set` | Create using a reusable UUID or save against a revision just read. |
| `note_history` | Page retained revisions. |
| `note_delete` | Delete or restore against an exact revision. |
| `note_share` | Change access using the calling agent’s administration permission. |

The enabled plugin contributes these tools. Agents read and author content as
themselves. The owner’s app maintains verified automatic agent membership; an agent
does not borrow owner authority to share. See [the storage and tool
contract](../../../docs/connected-notes.md).

## Notes from you and agents

The browser groups loaded notes by their signed author: **You**, **Your agents**
and **Others**. Notes use the same cards, search and sidebar tabs. Selecting
an author filters the collection while retaining open documents; **Back to folders**
returns to the index. Click an open note’s card again to close its tab. Author
names/avatars open the existing Profile panel when available. The author byline
on editable documents identifies the signed writer of the current revision.

Published agent notes remain readable through their original links. They are
read-only here; ask their author to update them, or choose **Make editable copy**.
Copying explicitly creates a separate document with the selected audience and
never changes or deletes the original. Agent-authored documents with edit access
use the same editor as your documents. There is no automatic migration.

Discovery keeps the existing independent cursors, accepted agent classification
and retry behavior. **Load more notes** advances whichever source still has pages;
counts and search cover loaded notes. Refresh starts from the newest records.
Folders organize authors and do not change access. Archived agents’ published
notes remain available, subject to relay access.

Agents retain their built-in `notes_get`, `notes_set` and `notes_rm` tools for
published notes and the singular tools above for editable documents. Neither
reading a note nor following a link executes its instructions or grants access.
