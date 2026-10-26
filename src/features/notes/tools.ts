import type { AddedTool } from "../../buzz-mcp/session-tools";
import type { BuzzClient } from "../../buzz-mcp/client";
import { eventDto, hasEventProof } from "../relay/events";
import { attestedOwner } from "../agents/owner-attestation";
import { memberAuthority } from "../channel-members/administration-protocol";
import {
  NoteConflict,
  NOTE_KIND,
  AGENTS_LABEL,
  independentNoteStorage,
  noteTag,
  noteAddress,
  noteUrl,
  readNote,
  readNoteHistory,
  saveNote,
  type Note,
  type NoteRead,
  type NoteAddress,
} from "./model";
import { readNotesPage, type NotesWorkspace } from "./workspace";

const str = { type: "string" };
const addressFields = { id: str, channel: str };
const string = (args: Record<string, unknown>, key: string) => {
  if (typeof args[key] !== "string") throw new Error(`${key} is required.`);
  return args[key] as string;
};
const asReader =
  (client: BuzzClient): NoteRead =>
  (filters) =>
    client.query(filters);
const format = (note: Note, community: string) =>
  JSON.stringify({
    id: note.id,
    channel: note.channel,
    revision: note.revision,
    title: note.title,
    deleted: note.deleted,
    link: noteUrl(note, community),
    markdown: note.markdown,
  });

/** Reads and content writes always use the caller's custody/relay connection.
 * The owner's coordinator is used only for its verified agent-sharing policy. */
export function noteTools(
  current: () => NotesWorkspace | undefined,
): AddedTool[] {
  function workspace(client: BuzzClient) {
    const value = current();
    if (
      !value ||
      value.session.viewer !== client.owner ||
      value.session.relayAuthor !== client.relayAuthor
    )
      throw new Error(
        "Working notes require this agent’s owning community to be connected.",
      );
    return value;
  }
  const community = (client: BuzzClient) =>
    workspace(client).session.scope.replace(/:[0-9a-f]{64}$/, "");
  const requireWrites = (client: BuzzClient) => {
    const value = workspace(client);
    if (!value.session.configArtifactWriter)
      throw new Error(
        "This connection does not advertise working-note revision support.",
      );
    return value;
  };
  const grantStandingAccess = async (
    client: BuzzClient,
    address: NoteAddress,
  ) => {
    const value = workspace(client);
    const owned = await value.ownedAgents();
    if (owned.includes(client.pubkey)) await value.reconcile(address);
  };
  function tool(
    name: string,
    description: string,
    properties: Record<string, object>,
    required: string[],
    call: AddedTool["call"],
  ): AddedTool {
    return {
      name,
      description,
      inputSchema: {
        type: "object",
        properties,
        required,
        additionalProperties: false,
      },
      call,
    };
  }
  return [
    tool(
      "note_get",
      "Read a connected working note by id and channel, or list accessible notes. Includes its revision for safe saving. Existing NIP-23 shared notes still use notes_get. Listing is paged; pass the returned cursor.",
      {
        ...addressFields,
        cursor: {
          type: "object",
          properties: { until: { type: "integer" }, before_id: str },
          required: ["until", "before_id"],
          additionalProperties: false,
        },
      },
      [],
      async (client, _context, args) => {
        if (args.id !== undefined || args.channel !== undefined) {
          const address = noteAddress(args);
          try {
            return format(
              await readNote(asReader(client), address),
              community(client),
            );
          } catch {
            // A verified owned agent can join only a note with the owner's standing policy.
            await grantStandingAccess(client, address);
          }
          return format(
            await readNote(asReader(client), address),
            community(client),
          );
        }
        const page = await readNotesPage(
          asReader(client),
          client.pubkey,
          client.relayAuthor ?? "",
          args.cursor as Parameters<typeof readNotesPage>[3],
        );
        return JSON.stringify({
          notes: page.notes.map((note) => ({
            id: note.id,
            channel: note.channel,
            revision: note.revision,
            title: note.title,
            deleted: note.deleted,
          })),
          more: page.more,
          ...(page.more ? { cursor: page.cursor } : {}),
        });
      },
    ),
    tool(
      "note_set",
      "Create or edit a connected Markdown working note. For creation omit channel/revision, supply a new UUID id, and reuse it on retries; the owner and their verified agents receive access. For editing, supply channel and the revision from note_get; stale saves fail and preserve your text. Pass text or a local UTF-8 path.",
      { ...addressFields, revision: str, title: str, text: str, path: str },
      ["id", "title"],
      async (client, _context, args) => {
        requireWrites(client);
        if ((args.text === undefined) === (args.path === undefined))
          throw new Error("Provide exactly one of text or path.");
        const markdown =
          args.path === undefined
            ? string(args, "text")
            : new TextDecoder("utf-8", { fatal: true }).decode(
                await client.read(string(args, "path")),
              );
        const draft = { title: string(args, "title"), markdown };
        if (args.channel === undefined) {
          const value = workspace(client);
          if (!(await value.ownedAgents()).includes(client.pubkey))
            throw new Error("This caller’s ownership could not be verified.");
          const note = await value.create(
            { ...draft, id: string(args, "id"), agents: true },
            undefined,
            (template) => client.publish(template),
          );
          return format(note, community(client));
        }
        const address = noteAddress(args);
        const read = asReader(client);
        const base = await readNote(read, address);
        if (base.revision !== string(args, "revision"))
          throw new NoteConflict(base);
        return format(
          await saveNote(
            read,
            (template) => client.publish(template),
            base,
            draft,
          ),
          community(client),
        );
      },
    ),
    tool(
      "note_history",
      "Read retained revisions of a connected note. Access is the same as the current note; offset pages are 100 revisions. To restore an older version, read it, then note_set its contents against the current revision.",
      {
        ...addressFields,
        offset: { type: "integer", minimum: 0, maximum: 10000 },
      },
      ["id", "channel"],
      async (client, _context, args) =>
        JSON.stringify(
          await readNoteHistory(
            asReader(client),
            noteAddress(args),
            args.offset === undefined ? 0 : Number(args.offset),
          ),
        ),
    ),
    tool(
      "note_delete",
      "Soft-delete or restore a connected note using its current revision. Restoring requires a title and Markdown text. The backing channel and sharing are retained.",
      {
        ...addressFields,
        revision: str,
        restore: { type: "boolean" },
        title: str,
        text: str,
      },
      ["id", "channel", "revision"],
      async (client, _context, args) => {
        requireWrites(client);
        const read = asReader(client),
          base = await readNote(read, noteAddress(args));
        if (base.revision !== string(args, "revision"))
          throw new NoteConflict(base);
        const restore = args.restore === true;
        const draft = restore
          ? { title: string(args, "title"), markdown: string(args, "text") }
          : { title: base.title, markdown: "" };
        return format(
          await saveNote(
            read,
            (template) => client.publish(template),
            base,
            draft,
            restore ? "restore" : "delete",
          ),
          community(client),
        );
      },
    ),
    tool(
      "note_share",
      "Explicitly give a person/agent read or edit access to a connected note, or remove them. Requires the calling agent’s channel administration permission; never borrows the owner’s authority. Readers receive retained history too. Default agent sharing is managed by the owner in the note’s Share dialog.",
      {
        ...addressFields,
        pubkey: str,
        access: { type: "string", enum: ["read", "edit", "remove"] },
      },
      ["id", "channel", "pubkey", "access"],
      async (client, _context, args) => {
        const address = noteAddress(args);
        await readNote(asReader(client), address);
        const pubkey = string(args, "pubkey"),
          access = string(args, "access");
        if (
          !/^[0-9a-f]{64}$/.test(pubkey) ||
          !["read", "edit", "remove"].includes(access)
        )
          throw new Error("Invalid sharing request.");
        const state = async () => {
          const events = (
            await client.query(
              [39000, 39001, 39002].map((kind) => ({
                kinds: [kind],
                authors: [client.relayAuthor],
                "#d": [address.channel],
                limit: 1,
                consistency: "strong",
              })),
            )
          ).map(eventDto);
          const metadata = events.find(
            (event) =>
              event.kind === 39000 &&
              event.pubkey === client.relayAuthor &&
              noteTag(event, "d") === address.channel,
          );
          if (!independentNoteStorage(address, metadata))
            throw new Error(
              "This document does not use independent note sharing.",
            );
          return {
            metadata,
            authority: memberAuthority(
              events,
              address.channel,
              client.pubkey,
              client.relayAuthor ?? "",
            ),
          };
        };
        const before = await state();
        if (
          !before.authority.canManage ||
          pubkey === client.pubkey ||
          before.authority.roles[pubkey] === "owner"
        )
          throw new Error("This agent cannot administer the note’s sharing.");
        if (
          access !== "edit" &&
          before.metadata?.tags.some(
            ([key, value]) => key === "t" && value === AGENTS_LABEL,
          )
        ) {
          const [profile] = (
            await client.query([
              {
                kinds: [0],
                authors: [pubkey],
                limit: 1,
                consistency: "strong",
              },
            ])
          ).map(eventDto);
          if (
            profile &&
            hasEventProof(profile) &&
            (await attestedOwner(profile)) === client.owner
          )
            throw new Error(
              "The owner must switch to selected sharing before restricting automatic agent access.",
            );
        }
        const heads = await client.query([
          {
            kinds: [NOTE_KIND],
            "#h": [address.channel],
            limit: 2,
            consistency: "strong",
          },
        ]);
        if (
          heads.length !== 1 ||
          !heads[0] ||
          noteTag(heads[0], "d") !== address.id
        )
          throw new Error(
            "This storage contains other documents. Create a separate working copy before sharing this note.",
          );
        const role = access === "read" ? "guest" : "member";
        await client.publish({
          kind: access === "remove" ? 9001 : 9000,
          content: "",
          tags: [
            ["h", address.channel],
            ["p", pubkey],
            ...(access === "remove" ? [] : [["role", role]]),
          ],
        });
        const after = await state();
        if (
          access === "remove"
            ? !!after.authority.roles[pubkey]
            : after.authority.roles[pubkey] !== role
        )
          throw new Error(
            "Sharing was not confirmed. Read access before retrying.",
          );
        return "Note access updated.";
      },
    ),
  ];
}
