# Connected working notes

The bundled `buzz.relay-notes` plugin owns one channel-backed Notes browser and contributes one
document panel plus five agent tools. `features/notes` owns the shared protocol
model and channel orchestration. Existing session reads, channel creation,
membership operations, signing and panel routing retain their authority; there is
no separate notes backend or local mirror.

## Storage and sharing

A working note is a kind-45010 NIP-AR artifact with immutable `type=buzz.note`, a
UUID `d`, its home channel `h`, and Markdown content. `note=1` identifies this
app’s editable payload version. Saves are complete snapshots with a required
`prev` for updates, deletion and restoration. The relay’s accepted head defines
the current version, including a deletion head; event timestamps do not choose it.
The optional `root` is a conversation anchor in the home channel, never a note
revision ID. Standalone notes omit it; edits, deletion and restoration preserve
an existing anchor. Only `prev` links the artifact's revisions.
Unknown payload versions remain readable, and unrelated tags survive edits.
Deletion publishes only the artifact envelope; history restoration preserves the
chosen revision’s annotations. Titles are limited to 512 UTF-8 bytes and bodies
to 32 KiB, with an additional complete-frame bound.

Each independently shared note has one private **system** channel labelled
`buzz.notes` and `buzz.notes.<note-uuid>`. `buzz.notes.agents` is the owner’s opt-in
automatic-sharing policy. Labels describe storage and policy, never membership
authority. Sharing reads fresh relay-signed 39000/39001/39002 state and refuses a
channel containing another artifact, including another artifact’s deletion head.
Readers enter directly as `guest`; editors use `member` (owned agents may be
`bot`). Editors can delete/restore. Channel role semantics still apply; the app
does not promise that an editor cannot send invitations through another client.

**Share note** uses the current `ChannelMembersDialog` search, filters, identity
rows, role menus and confirmations. System channels have no public/general-access
setting. Note-specific settings retain the automatic-agent toggle and history
notice. Membership changes still pass through NotesWorkspace's private,
independent-note and administration checks; a confirmation's expected role must
match a fresh roster before any write. The UI supports explicit admin access;
the singular agent tool's read/edit/remove contract is unchanged. The dialog's
Copy link action uses the note URL rather than opening its backing channel.

Automatic recipients come from `session.agentChoices`, require a complete
inventory and a verified NIP-OA owner attestation, and are reconciled when the
browser loads notes or a verified owned agent requests a known note. Deliberately
restricted notes never gain that policy implicitly. Disappearance from an
incomplete inventory is not removal evidence. An explicitly archived owned agent
can be removed; changing an owned agent to read-only or removing it disables the
automatic policy first. Disabling automatic sharing preserves existing members
until an explicit membership change.

Ownership checks query each agent's latest signed profile independently. An
unattested agent is excluded without blocking verified siblings. Before creating
with agent sharing, the dialog names unverified agents and requires an explicit
"Create with verified agents" confirmation; disabling agent sharing creates a
private note. No profile or attestation is repaired or overwritten by this flow.

Channel read permission covers current content and retained history. Contents
are plaintext to the relay operator. Encryption and selective-history permissions
are outside this format. Links and index notes confer no access. Written titles
inside link text are ordinary source-note content.

## Reads, discovery and recovery

The connection must advertise `nip-ar` before artifact writes are offered. Named
kind-45010 `#h`/`#d` queries retrieve current heads, including tombstones. History
uses the HTTP query contract’s `artifact: history`; it must be a single filter
and must not include `consistency`. History pages contain 100 revisions, through
offset 10,000; reaching the bound is disclosed.

Discovery pages the viewer’s signed system rosters, then metadata carrying the
note labels, then named artifact heads. It does not subscribe to every document
as a conversation. Search, link pickers and backlinks cover loaded notes only;
the browser offers further pages. This avoids a silent first-page completeness
claim, but is not a measured thousand-channel capacity guarantee.

Creation resolves owned-agent recipients before allocating storage. The caller
supplies a UUID and reuses it on retry. The owner’s signed creator/label lookup
finds an already-created channel, then checks the current artifact before
retrying the first snapshot. A changed document is never overwritten during
recovery. Failed creation can leave an empty private system channel; retry the
same UUID. Empty-channel deletion and retention-policy administration remain
ordinary channel operations. Deleting a note retains its channel and membership.

Updates compare the revision read by the editor, publish `prev`, and confirm the
accepted head. Relay conflict refusals fetch the newer version for comparison.
The editor preserves the draft, including when access changes; fresh reads that
fail withhold the cached document and remove it from the local catalogue. Initial
roster discovery can invalidate a concurrent session read; only that cancelled
read is retried once. Writes are never retried automatically.

## Agent tools

The singular tools operate on NIP-AR notes, separately from legacy plural
`notes_get`, `notes_set` and `notes_rm`. A connected owning app supplies the
coordinator. Ordinary reads and content writes use the calling agent’s own client
and identity. Only verified standing membership uses the owner’s coordinator.
Sharing never borrows its writer or administration role.

| Tool | Inputs and result |
| --- | --- |
| `note_get` | `id, channel` for a note; omit both to list and pass its returned `cursor` for the next page. |
| `note_set` | `id, title` and exactly one of `text, path`. For creation omit `channel, revision`; for editing supply both. |
| `note_history` | `id, channel`, optional `offset` in the advertised page range. |
| `note_delete` | `id, channel, revision`; restore with `restore=true, title, text`. |
| `note_share` | `id, channel, pubkey, access=read|edit|remove`; requires the caller’s administration role. |

Content results include UUID, channel, exact revision, title, deletion state,
Markdown and a community-bound link. For a deleted document use `note_delete`
with `restore=true`; `note_set` updates a live document. History results include
the retained snapshots and whether more remain.

## Document editing

The Viewing/Editing selector controls the document mode. New visits default to
Editing for editable notes; explicit Viewing/Editing history choices remain
authoritative. Read-only and deleted notes keep their reader presentation, and
retained drafts remain available after access changes. Editing reveals the
formatting list directly, without a formatting toggle. Both modes keep the same
title and body alignment; the body has no additional editor border or padding.
The toolbar is pinned in an inset pane-bottom floating surface outside the
document scrollport while Editing, with no reserved gap in Viewing. Its natural
height keeps document content and Save clear when controls wrap or text grows.
The hidden editor retains its selection and undo state. Viewing previews unsaved
text without publishing it.
A large, full-width prominent Save action stays above the toolbar while modified;
Discard changes restores the saved revision. Clean documents show no Save action.
`NoteEditor` reuses `EditableInput`, `ComposerFormattingTools`, `ComposerLinkDialog`
and the composer's ProseMirror schema/commands. Enter inserts a newline; saving
remains explicit. There are no chat send, recipient or attachment controls.
The standard Link action and Mod-K accept a URL or a loaded note; `[[` uses the
same dialog. Note destinations retain their stable community/channel/document URL.

Markdown remains the persisted format. The note-owned importer restores supported
inline formatting, lists, quotes and code into the existing schema. Unsupported
blocks, including headings and tables, remain editable Markdown source rather
than being discarded. **Note actions → Markdown source** opens source editing;
**Formatted text** in the same menu returns to the formatted editor. The
formatting bar hides in source mode. An untouched editor does not normalize the
original document. Rich edits use the shared
serializer; source spelling of supported constructs may normalize.

The browser lists linked note titles in newest-revision order, without
card previews, author folders or row metadata. Author and revision metadata remain
in the note viewer. The list, document content and formatting bar share the channel
timeline/composer's centered 52rem maximum width and shrink to fit narrow panes.
Notes retain the shared reader's heading, author/avatar and update byline,
document spacing, scrollport and Markdown styles, alongside access notices,
sharing, revision history, backlinks and draft actions.
Backlinks appear in **Note actions → Linked notes** as a submenu of source titles,
with empty and partial-collection guidance inside the submenu.

## Navigation and compatibility

`buzz://note?community=<https-origin>&channel=<uuid>&id=<uuid>` binds a document
to its community and stable identity. The shared parser is used by chat,
Markdown and OS ingress. Opening a title replaces the collection with a full-width
note view at every screen size. **Back to notes** returns to the same search and
collection without discarding drafts. Loaded editors stay mounted across these
visits. The full view uses the same document/editor as the channel’s right-pane
panel; conversation links still open beside the discussion. Both use the existing
browser-history driver.
Notes-page destinations record the selected note, committed search, deleted-note
filter, editing mode, share/link/delete/history dialog, selected revision and
history page. New-note destinations contain a draft identifier. Conversation
destinations optionally carry the same note presentation; Back/Forward restores
linked notes and their editor state without leaving the conversation.
The host applies note restoration after restoring its conversation tab visit.
Conversation note tabs use the same visit-retirement owner as Profile/GitHub
tabs: Back/Forward retains a return path, while closing a tab or closing all/other
tabs retires the closed notes' visits. Closing an inactive note preserves the
selected tab. Collapsing the tab pane changes layout without creating a visit.

History contains addresses and presentation only, never draft titles or bodies.
Unsaved document drafts and new-note drafts survive Back/Forward in the current
session; refreshing or restarting is not offline draft persistence. Replaying a
destination reads current permissions and does not repeat a save, share, delete
or restore. Earlier channel-backed `{id, channel}` addresses remain accepted.

This experience handles only channel-backed NIP-AR documents, regardless of whether
a person or agent authored them. It does not query, display, copy or import
NIP-23 published notes. Old published-note routes are no longer accepted by this
page. Existing published records and the separate built-in plural `notes_*`
tools are unchanged; there is no migration or deletion of those records.
Signed current-revision authors provide document bylines; this is not a new
claim about the original creator after collaborative edits. Discovery, pagination
and read authority belong to the existing NotesWorkspace owner.

## Verification boundary

`features/notes/model.test.ts` exercises signed state, owner attestations,
permissions, CAS, partial creation, pagination and human/agent publication using
real sessions and outboxes with an in-memory upstream. The Chromium/WebKit
`working-notes.spec.mjs` journeys use the registered production plugin and channel
workspace to cover editing, conflict dialogs, links, sharing, export, restoration,
NIP-23 separation and the conversation right-pane layout. The affected native
package separately tests artifact signing, including the strict deletion envelope
without chat `ms`.

These checks do not establish a packaged-native live-relay round trip, OS delivery,
or capacity at thousands of note channels. Those require an agreed isolated
identity/data setup; no existing notes or production membership need be changed
to run the fixtures.
