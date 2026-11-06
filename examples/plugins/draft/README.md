# Owner draft reader

Give your own local agents the `draft_get` tool to read an unsent draft for one
explicit channel ID and optional thread root ID on this device. Install and
enable this folder as an external plugin. Requires a host exposing the optional
`BuzzClient.readDraft` capability; older or standalone hosts report it unavailable.

The tool returns text, recipient identities and whether the source is the live
composer or saved draft. It does not send, clear or focus the composer. Attached
file bytes and sent-message editing text are excluded. Conflicting mounted
editors must be resolved in Buzz first. Close detached Huddle chat before
reading its draft, because unsaved text in another window cannot be verified. Plugins are trusted unsandboxed code;
load this plugin only when your local agents should be able to read your drafts.
