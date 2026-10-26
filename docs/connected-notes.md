# Connected working notes

The bundled `buzz.relay-notes` plugin owns the Notes browser and contributes one
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

## Navigation and compatibility

`buzz://note?community=<https-origin>&channel=<uuid>&id=<uuid>` binds a document
to its community and stable identity. The shared parser is used by chat,
Markdown and OS ingress. The Notes browser keeps its collection visible and opens documents in a
resizable, tabbed right sidebar, following the original shared-notes viewer.
On narrow screens the editor fills the workspace; Back to notes returns to the
collection without discarding drafts. It uses the same editor as the channel’s
right-pane panel. Both use the existing browser-history driver.
Notes-page destinations record the selected note, committed search, deleted-note
filter, editing mode, share/link/delete/history dialog, selected revision and
history page. New-note destinations contain a draft identifier. Conversation
destinations optionally carry the same note presentation; Back/Forward restores
linked notes and pane dismissal without navigating away from the conversation.
The host applies note restoration after restoring its conversation tab visit.

History contains addresses and presentation only, never draft titles or bodies.
Unsaved document drafts and new-note drafts survive Back/Forward in the current
session; refreshing or restarting is not offline draft persistence. Replaying a
destination reads current permissions and does not repeat a save, share, delete
or restore. Legacy note addresses remain accepted.

Legacy NIP-23 routes continue to open the existing reader. Copying is a deliberate
new-document operation with an explicit audience. Original events and links stay
unchanged; retirement of legacy authoring is a later migration decision.

## Verification boundary

`features/notes/model.test.ts` exercises signed state, owner attestations,
permissions, CAS, partial creation, pagination and human/agent publication using
real sessions and outboxes with an in-memory upstream. The Chromium/WebKit
`working-notes.spec.mjs` journeys use the registered production plugin and channel
workspace to cover editing, conflict dialogs, links, sharing, export, restoration,
legacy copying and the right-pane layout. The affected native package separately
tests artifact signing, including the strict deletion envelope without chat `ms`.

These checks do not establish a packaged-native live-relay round trip, OS delivery,
or capacity at thousands of note channels. Those require an agreed isolated
identity/data setup; no existing notes or production membership need be changed
to run the fixtures.
