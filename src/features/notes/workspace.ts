import { attestedOwner } from "../agents/owner-attestation";
import {
  memberAuthority,
  type MemberAuthority,
} from "../channel-members/administration-protocol";
import type { RelaySession } from "../relay/session";
import { hasEventProof, type RelayEvent } from "../relay/events";
import { channelIdentity } from "../relay/channel-labels";
import {
  AGENTS_LABEL,
  NoteConflict,
  NOTE_KIND,
  NOTE_LABEL,
  NOTE_PAGE,
  PUBKEY,
  UUID,
  noteAddress,
  independentNoteStorage,
  noteTag,
  noteTemplate,
  parseNote,
  readNote,
  readNoteHistory,
  saveNote,
  validateDraft,
  type Note,
  type NoteAddress,
  type NoteDraft,
  type NotePublish,
  type NoteRead,
} from "./model";

type Cursor = { until: number; before_id: string };
export type NotesPage = {
  notes: Note[];
  more: boolean;
  cursor?: Cursor | undefined;
};
export type NewNote = NoteDraft & { id: string; agents: boolean };
const documentLabel = (id: string) => `${NOTE_LABEL}.${id}`;

/** Feature-owned orchestration; the session and host retain all signing/access authority. */
export function createNotesWorkspace(session: RelaySession) {
  const lifetime = new AbortController();
  const signal = (caller?: AbortSignal) =>
    AbortSignal.any([
      lifetime.signal,
      AbortSignal.timeout(30_000),
      ...(caller ? [caller] : []),
    ]);
  const snapshot = async (
    filters: Parameters<NoteRead>[0],
    caller?: AbortSignal,
  ) => {
    const active = signal(caller);
    active.throwIfAborted();
    if (!session.snapshotRead)
      throw new Error("Connect to your community to use working notes.");
    let events: readonly RelayEvent[];
    try {
      events = await session.snapshotRead(filters, { signal: active });
    } catch (error) {
      // Initial signed roster discovery can invalidate a concurrent finite read.
      // Retry that read once under the new access epoch; caller cancellation,
      // timeouts and terminal relay refusals never authorize a retry.
      if (
        active.aborted ||
        !(error instanceof DOMException) ||
        error.name !== "AbortError"
      )
        throw error;
      events = await session.snapshotRead(filters, { signal: active });
    }
    active.throwIfAborted();
    return events;
  };
  const read: NoteRead = snapshot;
  const publish: NotePublish = async (template, caller) => {
    const active = signal(caller);
    const writer = session.configArtifactWriter;
    if (!writer)
      throw new Error(
        "Saving working notes is unavailable on this connection.",
      );
    const event = await writer.sign(
      {
        ...template,
        tags: template.tags.map((tag) => [...tag]),
        created_at: Math.floor(Date.now() / 1000),
      },
      active,
    );
    active.throwIfAborted();
    await writer.publish(event, active);
    active.throwIfAborted();
    return event;
  };
  async function resolve(address: NoteAddress, caller?: AbortSignal) {
    noteAddress(address);
    const active = signal(caller);
    await session.channels.resolve?.([address.channel], {
      signal: active,
      consistency: "strong",
    });
    active.throwIfAborted();
  }
  async function sharing(channel: string, caller?: AbortSignal) {
    if (!session.relayAuthor || !session.viewer)
      throw new Error("Connect to read note sharing.");
    const relayAuthor = session.relayAuthor;
    const events = await snapshot(
      [39000, 39001, 39002].map((kind) => ({
        kinds: [kind],
        authors: [relayAuthor],
        "#d": [channel],
        limit: 1,
        consistency: "strong" as const,
      })),
      caller,
    );
    const authority = memberAuthority(
      events,
      channel,
      session.viewer,
      relayAuthor,
    );
    const metadata = events.find(
      (event) =>
        event.kind === 39000 &&
        event.pubkey === relayAuthor &&
        noteTag(event, "d") === channel,
    );
    if (!metadata) throw new Error("Note sharing is unavailable.");
    const identity = channelIdentity(metadata);
    return {
      authority,
      metadata,
      labels: identity.labels,
      type: identity.type,
      private: metadata.tags.some(
        (tag) => tag.length === 1 && tag[0] === "private",
      ),
    };
  }
  const authority = async (
    channel: string,
    caller?: AbortSignal,
  ): Promise<MemberAuthority> => (await sharing(channel, caller)).authority;
  const independent = (
    address: NoteAddress,
    state: Awaited<ReturnType<typeof sharing>>,
  ) => independentNoteStorage(address, state.metadata);
  async function singleNote(address: NoteAddress, caller?: AbortSignal) {
    const heads = await read(
      [
        {
          kinds: [NOTE_KIND],
          "#h": [address.channel],
          limit: 2,
          consistency: "strong",
        },
      ],
      caller,
    );
    const [head] = heads;
    if (heads.length !== 1 || !head || noteTag(head, "d") !== address.id)
      throw new Error(
        "This storage contains other documents. Create a separate working copy before sharing this note.",
      );
  }
  async function agentAccess(caller?: AbortSignal) {
    session.agentChoices.ensure(true, true);
    if (
      !session.agentChoices.snapshot().complete ||
      session.agentChoices.snapshot().pending
    )
      await session.agentChoices.refresh(true);
    signal(caller).throwIfAborted();
    const choices = session.agentChoices.snapshot();
    if (!choices.complete || choices.pending)
      throw new Error(
        "Your agent list is incomplete. Refresh it or choose Only me.",
      );
    const keys = [...new Set(choices.selectable.map((agent) => agent.pubkey))];
    const verified: string[] = [];
    const unverified: string[] = [];
    for (let offset = 0; offset < keys.length; offset += 3) {
      const batch = keys.slice(offset, offset + 3);
      const profiles = await snapshot(
        batch.map((key) => ({
          kinds: [0],
          authors: [key],
          limit: 1,
          consistency: "strong",
        })),
        caller,
      );
      for (const key of batch) {
        const profile = profiles?.find(
          (event) =>
            event.kind === 0 && event.pubkey === key && hasEventProof(event),
        );
        if (profile && (await attestedOwner(profile)) === session.viewer)
          verified.push(key);
        else unverified.push(key);
      }
    }
    return { verified, unverified };
  }
  const ownedAgents = async (caller?: AbortSignal) =>
    (await agentAccess(caller)).verified;
  const syncing = new Map<string, Promise<void>>();
  async function reconcile(address: NoteAddress, caller?: AbortSignal) {
    const prior = syncing.get(address.channel);
    if (prior) return prior;
    const work = (async () => {
      const state = await sharing(address.channel, caller);
      if (!independent(address, state) || !state.labels.includes(AGENTS_LABEL))
        return;
      const roles = state.authority;
      // Only the owning user's app maintains its standing agent-sharing policy.
      if (roles.roles[session.viewer ?? ""] !== "owner") return;
      const choices = session.agentChoices.snapshot();
      const candidates = choices.selectable.map((agent) => agent.pubkey);
      const missing = candidates.some((key) => !roles.roles[key]);
      const keys = missing ? await ownedAgents(caller) : candidates;
      if (missing) {
        await singleNote(address, caller);
        await resolve(address, caller);
        for (const key of keys)
          if (!roles.roles[key])
            await session.memberAdditions.add(address.channel, key);
      }
      // A disappearing inventory entry alone is not revocation evidence. An
      // explicitly archived agent is removed, after current role/owner checks.
      const archived = session.agentChoices.snapshot().archives.archived;
      for (const key of Object.keys(roles.roles)) {
        if (
          keys.includes(key) ||
          key === session.viewer ||
          !archived.includes(key)
        )
          continue;
        await session.profiles.ensure([key]);
        const profile = session.profiles.event?.(key);
        if (
          profile &&
          hasEventProof(profile) &&
          (await attestedOwner(profile)) === session.viewer
        )
          await setMember(address, key, "remove", caller, false);
      }
    })();
    syncing.set(address.channel, work);
    try {
      await work;
    } finally {
      if (syncing.get(address.channel) === work)
        syncing.delete(address.channel);
    }
  }
  async function setAudience(
    address: NoteAddress,
    agents: boolean,
    caller?: AbortSignal,
  ) {
    await resolve(address, caller);
    const base = await session.channelDetails.load(
      address.channel,
      signal(caller),
    );
    const state = await sharing(address.channel, caller);
    if (!independent(address, state))
      throw new Error("This document does not use independent note sharing.");
    const roles = state.authority;
    if (roles.roles[session.viewer ?? ""] !== "owner")
      throw new Error("Only the note owner can change automatic agent access.");
    if (agents) {
      await singleNote(address, caller);
      await ownedAgents(caller);
    }
    const labels = [
      ...(base.labels ?? []).filter((label) => label !== AGENTS_LABEL),
      ...(agents ? [AGENTS_LABEL] : []),
    ];
    await session.channelDetails.save(
      base,
      { ...base, labels },
      signal(caller),
    );
    if (agents) await reconcile(address, caller);
  }
  async function setMember(
    address: NoteAddress,
    key: string,
    access: "read" | "edit" | "remove",
    caller?: AbortSignal,
    restrict = true,
  ) {
    if (!PUBKEY.test(key)) throw new Error("Choose a valid public key.");
    await resolve(address, caller);
    const state = await sharing(address.channel, caller);
    if (!independent(address, state))
      throw new Error("This document does not use independent note sharing.");
    await singleNote(address, caller);
    const roles = state.authority;
    if (
      !roles.canManage ||
      key === session.viewer ||
      roles.roles[key] === "owner"
    )
      throw new Error("You cannot change this person’s note access.");
    if (restrict && access !== "edit" && state.labels.includes(AGENTS_LABEL)) {
      const profiles = await snapshot(
        [{ kinds: [0], authors: [key], limit: 1, consistency: "strong" }],
        caller,
      );
      const profile = profiles?.[0];
      if (
        profile &&
        hasEventProof(profile) &&
        (await attestedOwner(profile)) === session.viewer
      )
        await setAudience(address, false, caller);
    }
    const role = access === "read" ? "guest" : "member";
    const previous = roles.roles[key];
    if (previous) {
      if (access === "remove" || previous !== role)
        await session.memberAdministration.run(address.channel, {
          pubkey: key,
          expectedRole: previous,
          role: access === "remove" ? "remove" : role,
        });
    } else if (access !== "remove") {
      if (!session.outbox?.supports(9000))
        throw new Error("Sharing is unavailable on this connection.");
      // A reader is admitted directly as guest, never briefly as an editor.
      const id = session.outbox.send({
        kind: 9000,
        content: "",
        tags: [
          ["h", address.channel],
          ["p", key],
          ["role", role],
        ],
      });
      await session.channelWrites.delivered(id);
      await session.channels.refreshRoster?.(address.channel, {
        signal: signal(caller),
        consistency: "strong",
      });
    }
    const confirmed = await authority(address.channel, caller);
    if (
      access === "remove"
        ? !!confirmed.roles[key]
        : confirmed.roles[key] !== role
    )
      throw new Error(
        "The sharing change could not be confirmed. Refresh access before retrying.",
      );
    return confirmed;
  }
  async function create(
    input: NewNote,
    caller?: AbortSignal,
    author: NotePublish = publish,
  ) {
    if (!session.configArtifactWriter)
      throw new Error(
        "This connection does not advertise support for working-note revisions.",
      );
    validateDraft(input);
    if (!UUID.test(input.id))
      throw new Error("Use a new note UUID and reuse it when retrying.");
    // Resolve automatic recipients before creating any channel.
    const recipients = input.agents ? await ownedAgents(caller) : [];
    if (!session.viewer || !session.relayAuthor)
      throw new Error("Connect to create a note.");
    const label = documentLabel(input.id);
    const found = await read(
      [
        {
          kinds: [39000],
          authors: [session.relayAuthor],
          "#P": [session.viewer],
          "#t": [label],
          limit: 2,
          consistency: "strong",
        },
      ],
      caller,
    );
    if (found.length > 1)
      throw new Error(
        "Multiple storage channels match this note. Resolve them before creating another.",
      );
    let channel = found[0] ? noteTag(found[0], "d") : undefined;
    if (found[0] && (!channel || !UUID.test(channel)))
      throw new Error("The note’s storage identity is invalid.");
    if (
      found[0] &&
      (!found[0].tags.some((tag) => tag.length === 1 && tag[0] === "private") ||
        found[0].tags.find(([key]) => key === "t")?.[1] !== "system")
    )
      throw new Error(
        "The note’s storage channel has unexpected access settings.",
      );
    if (!channel)
      channel = await session.channelCreation.create({
        name: `Note ${input.id.slice(0, 8)}`,
        visibility: "private",
        system: true,
        labels: [NOTE_LABEL, label, ...(input.agents ? [AGENTS_LABEL] : [])],
      });
    const address = noteAddress({ id: input.id, channel });
    await resolve(address, caller);
    const state = await sharing(channel, caller);
    if (
      !independent(address, state) ||
      state.authority.roles[session.viewer] !== "owner"
    )
      throw new Error(
        "The note’s storage channel has unexpected access settings.",
      );
    const existing = await read(
      [
        {
          kinds: [NOTE_KIND],
          "#h": [channel],
          "#d": [input.id],
          limit: 1,
          consistency: "strong",
        },
      ],
      caller,
    );
    if (existing[0]) {
      const note = parseNote(existing[0]);
      if (!note || note.id !== input.id || note.channel !== channel)
        throw new Error("The existing document has an unsupported format.");
      if (
        note.deleted ||
        note.title !== input.title.trim() ||
        note.markdown !== input.markdown
      )
        throw new NoteConflict(note);
      return note;
    }
    const otherDocuments = await read(
      [
        {
          kinds: [NOTE_KIND],
          "#h": [channel],
          limit: 1,
          consistency: "strong",
        },
      ],
      caller,
    );
    if (otherDocuments.length)
      throw new Error(
        "This storage already contains another document. Use a new note ID.",
      );
    for (const key of recipients)
      await session.memberAdditions.add(channel, key);
    try {
      const event = await author(noteTemplate(address, input), caller);
      const current = await readNote(read, address, caller);
      if (current.revision !== event.id)
        throw new Error(
          "The note has changed. Open its latest revision before editing.",
        );
      return current;
    } catch (error) {
      throw new Error(
        `Note creation was not confirmed. Reuse note ID ${input.id} to recover its storage and check the result. ${error instanceof Error ? error.message : ""}`,
      );
    }
  }
  const list = (cursor?: Cursor, caller?: AbortSignal) =>
    readNotesPage(
      read,
      session.viewer ?? "",
      session.relayAuthor ?? "",
      cursor,
      caller,
    );
  return {
    session,
    read,
    publish,
    list,
    create,
    resolve,
    authority,
    sharing,
    ownedAgents,
    agentAccess,
    reconcile,
    setMember,
    setAudience,
    open: async (address: NoteAddress, caller?: AbortSignal) => {
      await resolve(address, caller);
      return readNote(read, address, caller);
    },
    save: (
      base: Note,
      draft: NoteDraft,
      op?: "update" | "delete" | "restore",
      caller?: AbortSignal,
    ) => saveNote(read, publish, base, draft, op, caller),
    history: (address: NoteAddress, offset = 0, caller?: AbortSignal) =>
      readNoteHistory(read, address, offset, caller),
    dispose: () => lifetime.abort(),
  };
}
export type NotesWorkspace = ReturnType<typeof createNotesWorkspace>;

/** The same paged discovery for people and agents, always as its actual reader. */
export async function readNotesPage(
  read: NoteRead,
  viewer: string,
  relayAuthor: string,
  cursor?: Cursor,
  caller?: AbortSignal,
): Promise<NotesPage> {
  if (!PUBKEY.test(viewer) || !PUBKEY.test(relayAuthor))
    throw new Error("Connect to read notes.");
  if (
    cursor !== undefined &&
    (!cursor ||
      typeof cursor !== "object" ||
      Array.isArray(cursor) ||
      Object.keys(cursor).sort().join() !== "before_id,until" ||
      !Number.isSafeInteger(cursor.until) ||
      cursor.until < 0 ||
      typeof cursor.before_id !== "string" ||
      !PUBKEY.test(cursor.before_id))
  )
    throw new Error("Invalid note-list cursor.");
  const rosters = await read(
    [
      {
        kinds: [39002],
        authors: [relayAuthor],
        "#p": [viewer],
        "#t": ["system"],
        limit: NOTE_PAGE,
        ...cursor,
      },
    ],
    caller,
  );
  const ordered = [...rosters].sort(
    (a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id),
  );
  const last = ordered.at(-1);
  if (
    cursor &&
    last &&
    !(
      last.created_at < cursor.until ||
      (last.created_at === cursor.until && last.id > cursor.before_id)
    )
  )
    throw new Error("The note list did not advance. Refresh to try again.");
  const ids = rosters.flatMap((event) => {
    const id = noteTag(event, "d");
    return id &&
      UUID.test(id) &&
      event.tags.some(([key, value]) => key === "p" && value === viewer)
      ? [id]
      : [];
  });
  const notes: Note[] = [];
  if (ids.length) {
    const metadata = await read(
      [
        {
          kinds: [39000],
          authors: [relayAuthor],
          "#d": ids,
          "#t": [NOTE_LABEL],
          limit: NOTE_PAGE,
        },
      ],
      caller,
    );
    const addresses = metadata.flatMap((event) => {
      const channel = noteTag(event, "d");
      const labels = event.tags.filter(
        ([key, value]) =>
          key === "t" &&
          value?.startsWith(`${NOTE_LABEL}.`) &&
          value !== AGENTS_LABEL,
      );
      const id =
        labels.length === 1
          ? labels[0]?.[1]?.slice(NOTE_LABEL.length + 1)
          : undefined;
      return channel && ids.includes(channel) && id && UUID.test(id)
        ? [{ id, channel }]
        : [];
    });
    if (addresses.length) {
      // Named generic d queries return relay heads, including tombstones.
      const events = await read(
        [
          {
            kinds: [NOTE_KIND],
            "#h": addresses.map((item) => item.channel),
            "#d": addresses.map((item) => item.id),
            limit: NOTE_PAGE,
            consistency: "strong",
          },
        ],
        caller,
      );
      for (const event of events) {
        const note = parseNote(event);
        if (
          note &&
          addresses.some(
            (item) => item.id === note.id && item.channel === note.channel,
          )
        )
          notes.push(note);
      }
    }
  }
  return {
    notes,
    more: rosters.length === NOTE_PAGE,
    ...(last ? { cursor: { until: last.created_at, before_id: last.id } } : {}),
  };
}
