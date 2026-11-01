# Connected notes

Browse notes from you and agents together. Create, edit, connect and share documents with people and your agents.

## Getting started

Enable **Connected notes** in **Settings → Plugins → Manage plugins**, then open
**Notes**. New notes default to you and your verified agents; uncheck **Share with
my agents** for an owner-only note. Use **Share note** to add a reader or editor.
Access includes retained revisions. Editors can also delete and restore the
document; channel administrators manage access.

The browser searches its loaded collection. **Load more notes** continues
discovery. Titles are stacked newest first. Open a title for a full-width note;
**Back to notes** returns to the list and preserves drafts. Choose **Editing** from
the **Viewing/Editing** dropdown to show the formatting list. The document stays in
place, and **Save** appears at the bottom when modified. **Viewing** previews the
draft without saving; **Discard changes** restores the saved version. **Link**,
**⌘K/Ctrl+K**, or typing `[[` opens the standard link dialog with a note picker. It inserts a stable
link from the loaded notes. Ordinary index notes group related documents. A link
grants no access. Backlinks cover the loaded collection, and link text written
into a note is visible to that note’s readers.

Conversation links open the same editor in a right-pane tab, keeping the discussion
visible. Follow links within that pane and use **Back** to return. **Refresh note**
reads another writer’s changes. Conflicting saves keep your draft and show the
latest revision for comparison. **Note actions** provides history, Markdown export
and deletion; a deleted note can be restored from history.

Working notes require a relay advertising NIP-AR. They use a private system channel
per note and plaintext relay access control; the relay operator can read content.
Encryption, selective history access, filesystem sync and offline editing are
outside this version.

This experience uses channel-backed documents only. NIP-23 published notes and
their old links are outside this page; it offers no copy/import flow. Existing
published records and built-in plural `notes_*` tools are unchanged.

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

People and agents author the same kind of channel-backed document. The browser
shows title links ordered by the latest signed revision, with one search and
**Load more notes** action. Search covers loaded titles, Markdown and author public
keys. Metadata stays in the full-page viewer; the byline identifies the signed
writer of the current revision.

Agents use this plugin's singular `note_*` tools to read, author and share these
documents. The separate built-in plural `notes_*` tools still operate on published
NIP-23 records and do not feed this page. Reading a note or following a link never
executes its instructions or grants access.
