import { afterEach, describe, expect, it, vi } from "vitest";
import { signed } from "../relay/testing";
import {
  NOTE_KIND,
  NoteConflict,
  noteMarkdownLink,
  noteTag,
  noteTemplate,
  noteUrl,
  parseNote,
  parseNoteUrl,
  readNote,
  readNoteHistory,
  saveNote,
} from "./model";
import { createNotesWorkspace, readNotesPage } from "./workspace";
import { noteTools } from "./tools";
import { notesFixture } from "./testing";
import { buzzLinkTarget, parseBuzzLink } from "../navigation/buzz-links";
import { deepLinkStep } from "../navigation/deep-links";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose();
});
async function fixture() {
  const f = await notesFixture();
  cleanup.push(f.dispose);
  const workspace = createNotesWorkspace(f.session);
  cleanup.push(workspace.dispose);
  return { ...f, workspace };
}

describe("connected note revisions", () => {
  it.each([false, true])(
    "preserves the conversation anchor through the note lifecycle (anchored=%s)",
    async (anchored) => {
      const f = await fixture();
      let original = f.seed("Plan", "Original");
      let root: string | undefined;
      if (anchored) {
        const anchor = signed(f.viewer, {
          kind: 9,
          tags: [["h", original.channel]],
          content: "Conversation anchor",
        });
        root = anchor.id;
        f.accepted.push(anchor);
        const event = signed(f.viewer, {
          ...original.event,
          tags: [...original.event.tags.map((tag) => [...tag]), ["root", root]],
        });
        const note = parseNote(event);
        if (!note) throw new Error("Expected anchored note");
        original = note;
        f.heads.set(note.id, event);
        f.revisions.splice(0, 1, event);
        // Losing an unchanged anchor later must not prevent editing the note.
        f.accepted.splice(f.accepted.indexOf(anchor), 1);
      }
      const updated = await f.workspace.save(original, {
        title: "Plan",
        markdown: "Human edit",
      });
      await f.edit(f.carl, updated, { title: "Plan", markdown: "Agent edit" });
      const current = await readNote(f.workspace.read, original);
      const deleted = await f.workspace.save(
        current,
        { title: "Plan", markdown: "" },
        "delete",
      );
      const restored = await f.workspace.save(
        deleted,
        { title: "Plan", markdown: original.markdown, restoreFrom: original },
        "restore",
      );
      expect(restored.markdown).toBe("Original");
      expect(f.revisions).toHaveLength(5);
      for (const event of f.revisions)
        expect(noteTag(event, "root")).toBe(root);
      for (const [index, event] of f.revisions.entries())
        expect(noteTag(event, "prev")).toBe(f.revisions[index - 1]?.id);
    },
  );
  it("rejects an artifact revision used as a conversation anchor without advancing the head", async () => {
    const f = await fixture(),
      original = f.seed("Plan", "Original");
    f.accepted.push(
      signed(f.viewer, {
        ...original.event,
        tags: original.event.tags.map((tag) => [...tag]),
      }),
    );
    const template = noteTemplate(
      original,
      { title: "Plan", markdown: "Edit" },
      original,
    );
    await expect(
      f.client(f.viewer).publish({
        ...template,
        tags: [
          ...template.tags.filter(([key]) => key !== "root"),
          ["root", original.revision],
        ],
      }),
    ).rejects.toThrow("root must be an existing conversation anchor in home");
    expect(f.heads.get(original.id)?.id).toBe(original.revision);
    expect(f.revisions).toHaveLength(1);
  });
  it("reports a competing save accepted between preflight and publication", async () => {
    const f = await fixture(),
      note = f.seed("Plan", "Original");
    await expect(
      saveNote(
        f.workspace.read,
        async (template) => {
          await f.edit(f.carl, note, {
            title: "Plan",
            markdown: "Concurrent change",
          });
          return f.client(f.viewer).publish(template);
        },
        note,
        { title: "Plan", markdown: "My draft" },
      ),
    ).rejects.toBeInstanceOf(NoteConflict);
    expect(f.heads.get(note.id)?.content).toBe("Concurrent change");
  });
  it("detects a second writer without publishing the first writer’s stale draft", async () => {
    const f = await fixture(),
      note = f.seed("Plan", "First version");
    const newer = await f.edit(f.carl, note, {
      title: "Plan",
      markdown: "Carl’s change",
    });
    await expect(
      f.workspace.save(note, { title: "Plan", markdown: "Unsaved local work" }),
    ).rejects.toBeInstanceOf(NoteConflict);
    expect(f.heads.get(note.id)?.id).toBe(newer.id);
    expect(f.revisions).toHaveLength(2);
  });
  it("keeps the accepted head when its timestamp is older than a retained revision", async () => {
    const f = await fixture(),
      note = f.seed("Plan", "Original");
    const current = signed(f.carl, {
      ...noteTemplate(
        note,
        { title: "Plan", markdown: "Accepted later" },
        note,
      ),
      tags: noteTemplate(
        note,
        { title: "Plan", markdown: "Accepted later" },
        note,
      ).tags.map((tag) => [...tag]),
      created_at: 1,
    });
    f.heads.set(note.id, current);
    f.revisions.push(current);
    expect((await readNote(f.workspace.read, note)).markdown).toBe(
      "Accepted later",
    );
    expect(
      (await readNoteHistory(f.workspace.read, note)).revisions.map(
        (item) => item.markdown,
      ),
    ).toEqual(["Accepted later", "Original"]);
  });
  it("preserves unfamiliar annotations and refuses unknown document versions", async () => {
    const f = await fixture(),
      note = f.seed("Plan", "Original");
    const annotated = {
      ...note,
      event: {
        ...note.event,
        tags: [...note.event.tags, ["custom", "keep", "all fields"]],
      },
    };
    expect(
      noteTemplate(note, { title: "Renamed", markdown: "Edit" }, annotated)
        .tags,
    ).toContainEqual(["custom", "keep", "all fields"]);
    const tombstone = parseNote({
      ...note.event,
      ...noteTemplate(
        note,
        { title: note.title, markdown: "" },
        note,
        "delete",
      ),
    });
    if (!tombstone) throw new Error("Expected deletion head");
    expect(
      noteTemplate(
        note,
        { title: "Plan", markdown: "Restored", restoreFrom: annotated },
        tombstone,
        "restore",
      ).tags,
    ).toContainEqual(["custom", "keep", "all fields"]);
    const future = parseNote({
      ...note.event,
      tags: note.event.tags.map((tag) =>
        tag[0] === "note" ? ["note", "2"] : tag,
      ),
    });
    expect(future?.editable).toBe(false);
    if (!future) throw new Error("Expected readable future note");
    expect(() =>
      noteTemplate(future, { title: "Plan", markdown: "Edit" }, future),
    ).toThrow(/unsupported/);
  });
  it("deletes with an envelope-only tombstone and restores against that exact head", async () => {
    const f = await fixture(),
      original = f.seed("Plan", "Keep history");
    const deleted = await f.workspace.save(
      original,
      { title: "Plan", markdown: "" },
      "delete",
    );
    expect(deleted.deleted).toBe(true);
    expect(deleted.event.content).toBe("");
    expect(
      deleted.event.tags.some(([tag]) =>
        ["title", "note", "custom"].includes(tag ?? ""),
      ),
    ).toBe(false);
    const listed = await f.workspace.list();
    expect(listed.notes).toMatchObject([{ id: original.id, deleted: true }]);
    const restored = await f.workspace.save(
      deleted,
      { title: "Plan", markdown: original.markdown },
      "restore",
    );
    expect(restored.markdown).toBe("Keep history");
    expect(restored.event.tags).toContainEqual(["prev", deleted.revision]);
    expect((await f.workspace.history(original)).revisions).toHaveLength(3);
  });
  it("requires read and write permission for current content and retained history", async () => {
    const f = await fixture(),
      note = f.seed("Private plan", "Private", false);
    const outsider = (filters: Parameters<typeof f.workspace.read>[0]) =>
      f.client(f.sam).query(filters);
    await expect(readNote(outsider, note)).rejects.toThrow(/unavailable/);
    expect((await readNoteHistory(outsider, note)).revisions).toEqual([]);
    await f.workspace.setMember(note, f.sam.pubkey, "read");
    expect((await readNote(outsider, note)).markdown).toBe("Private");
    expect((await readNoteHistory(outsider, note)).revisions).toHaveLength(1);
    await expect(
      saveNote(
        outsider,
        (template) => f.client(f.sam).publish(template),
        note,
        { title: "Plan", markdown: "No" },
      ),
    ).rejects.toThrow(/denied/);
    await f.workspace.setMember(note, f.sam.pubkey, "remove");
    await expect(readNote(outsider, note)).rejects.toThrow(/unavailable/);
  });
});

describe("channel orchestration", () => {
  it("checks each latest profile independently and excludes unverified identities without blocking verified siblings", async () => {
    const f = await fixture();
    f.profiles.push(
      signed(f.carl, {
        kind: 0,
        content: "{}",
        tags: [],
        created_at: 2_000_000_000,
      }),
    );
    const access = await f.workspace.agentAccess();
    expect(access.unverified).toEqual([f.carl.pubkey]);
    expect(access.verified).toEqual([f.ned.pubkey]);
    const note = await f.workspace.create({
      id: crypto.randomUUID(),
      title: "Plan",
      markdown: "Work",
      agents: true,
    });
    expect(f.channels.get(note.channel)?.roles[f.carl.pubkey]).toBeUndefined();
    expect(f.channels.get(note.channel)?.roles[f.ned.pubkey]).toBe("bot");
  });
  it("does not regrant access after automatic sharing changes on another client", async () => {
    const f = await fixture(),
      note = f.seed("Plan", "Selected access");
    await f.workspace.resolve(note);
    const channel = f.channels.get(note.channel);
    if (!channel) throw new Error("Missing channel");
    channel.labels = channel.labels.filter(
      (label) => label !== "buzz.notes.agents",
    );
    delete channel.roles[f.ned.pubkey];
    channel.updated++;
    const get = noteTools(() => f.workspace).find(
      (tool) => tool.name === "note_get",
    );
    if (!get) throw new Error("Missing note_get");
    await expect(get.call(f.client(f.ned), {}, note)).rejects.toThrow(
      /unavailable/,
    );
    expect(channel.roles[f.ned.pubkey]).toBeUndefined();
    expect(f.accepted.filter((event) => event.kind === 9000)).toEqual([]);
  });
  it("refuses sharing a channel that also contains another document’s deletion head", async () => {
    const f = await fixture(),
      note = f.seed("Plan", "Private", false),
      other = f.seed("Other", "Unrelated", false);
    const tombstone = signed(f.viewer, {
      ...noteTemplate(
        other,
        { title: other.title, markdown: "" },
        other,
        "delete",
      ),
      tags: noteTemplate(
        other,
        { title: other.title, markdown: "" },
        other,
        "delete",
      ).tags.map((tag) => (tag[0] === "h" ? ["h", note.channel] : [...tag])),
    });
    f.heads.set(other.id, tombstone);
    await expect(
      f.workspace.setMember(note, f.sam.pubkey, "read"),
    ).rejects.toThrow(/other documents/);
    const channel = f.channels.get(note.channel);
    if (!channel) throw new Error("Missing channel");
    channel.roles[f.carl.pubkey] = "admin";
    channel.updated++;
    const share = noteTools(() => f.workspace).find(
      (tool) => tool.name === "note_share",
    );
    if (!share) throw new Error("Missing note_share");
    await expect(
      share.call(
        f.client(),
        {},
        { ...note, pubkey: f.sam.pubkey, access: "read" },
      ),
    ).rejects.toThrow(/other documents/);
    expect(channel.roles[f.sam.pubkey]).toBeUndefined();
  });
  it("refuses creation recovery in storage already containing another note", async () => {
    const f = await fixture(),
      note = f.seed("Existing", "Private", false),
      id = crypto.randomUUID();
    const channel = f.channels.get(note.channel);
    if (!channel) throw new Error("Missing channel");
    channel.labels = ["buzz.notes", `buzz.notes.${id}`];
    channel.updated++;
    await expect(
      f.workspace.create({ id, title: "New", markdown: "Draft", agents: true }),
    ).rejects.toThrow(/another document/);
    expect(channel.roles[f.carl.pubkey]).toBeUndefined();
    expect(f.accepted.filter((event) => event.kind === 9000)).toEqual([]);
  });
  it("refuses creation before allocating storage on an unsupported connection", async () => {
    const f = await fixture();
    const unsupported = createNotesWorkspace({
      ...f.session,
      configArtifactWriter: undefined,
    });
    cleanup.push(unsupported.dispose);
    await expect(
      unsupported.create({
        id: crypto.randomUUID(),
        title: "Plan",
        markdown: "Work",
        agents: false,
      }),
    ).rejects.toThrow(/does not advertise/);
    expect(f.channels.size).toBe(0);
  });
  it("grants a verified owned agent access on request only under the standing policy", async () => {
    const f = await fixture(),
      note = f.seed("Plan", "Shared work");
    const channel = f.channels.get(note.channel);
    if (!channel) throw new Error("Missing channel");
    delete channel.roles[f.ned.pubkey];
    channel.updated++;
    const get = noteTools(() => f.workspace).find(
      (tool) => tool.name === "note_get",
    );
    if (!get) throw new Error("Missing note_get");
    const reply = JSON.parse(
      (await get.call(
        f.client(f.ned),
        {},
        { id: note.id, channel: note.channel },
      )) as string,
    );
    expect(reply.markdown).toBe("Shared work");
    expect(channel.roles[f.ned.pubkey]).toBe("bot");
  });
  it("rejects a cursor that could overwrite the discovery identity filter", async () => {
    const read = vi.fn(async () => []);
    await expect(
      readNotesPage(read, "a".repeat(64), "b".repeat(64), {
        until: 1,
        before_id: "c".repeat(64),
        authors: ["d".repeat(64)],
      } as Parameters<typeof readNotesPage>[3]),
    ).rejects.toThrow(/cursor/);
    expect(read).not.toHaveBeenCalled();
  });
  it("creates a private system channel and admits only verified agents", async () => {
    const f = await fixture();
    const note = await f.workspace.create({
      id: crypto.randomUUID(),
      title: "Agent plan",
      markdown: "Shared work",
      agents: true,
    });
    const channel = f.channels.get(note.channel);
    expect(channel?.type).toBe("system");
    expect(channel?.roles).toEqual({
      [f.viewer.pubkey]: "owner",
      [f.carl.pubkey]: "bot",
      [f.ned.pubkey]: "bot",
    });
    expect(
      f.accepted.find((event) => event.kind === 9007)?.tags,
    ).toContainEqual(["visibility", "private"]);
    expect(channel?.labels).toContain("buzz.notes.agents");
  });
  it("does not create storage after an incomplete agent inventory", async () => {
    const f = await fixture();
    f.unavailableInventory();
    await expect(
      f.workspace.create({
        id: crypto.randomUUID(),
        title: "Plan",
        markdown: "Draft",
        agents: true,
      }),
    ).rejects.toThrow(/agent list is incomplete/);
    expect(f.channels.size).toBe(0);
    expect(f.accepted).toEqual([]);
  });
  it("recovers a refused first revision in the same channel using the same note ID", async () => {
    const f = await fixture(),
      draft = {
        id: crypto.randomUUID(),
        title: "Plan",
        markdown: "Work",
        agents: false,
      };
    f.failNextArtifact();
    await expect(f.workspace.create(draft)).rejects.toThrow(/Reuse note ID/);
    expect(f.channels.size).toBe(1);
    const note = await f.workspace.create(draft);
    expect(note.id).toBe(draft.id);
    expect(f.channels.size).toBe(1);
    expect(f.revisions).toHaveLength(1);
  });
  it("recovers an accepted first revision after its acknowledgment is lost", async () => {
    const f = await fixture(),
      draft = {
        id: crypto.randomUUID(),
        title: "Plan",
        markdown: "Work",
        agents: false,
      };
    f.loseNextReceipt();
    await expect(f.workspace.create(draft)).rejects.toThrow(/not confirmed/);
    expect((await f.workspace.create(draft)).markdown).toBe("Work");
    expect(f.channels.size).toBe(1);
    expect(f.revisions).toHaveLength(1);
  });
  it("adds a reader as guest in one operation, with no intervening edit grant", async () => {
    const f = await fixture(),
      note = f.seed("Plan", "Work", false);
    await f.workspace.setMember(note, f.sam.pubkey, "read");
    const invitations = f.accepted.filter((event) => event.kind === 9000);
    expect(invitations).toHaveLength(1);
    expect(invitations[0]?.tags).toContainEqual(["role", "guest"]);
    expect(f.channels.get(note.channel)?.roles[f.sam.pubkey]).toBe("guest");
  });
  it("keeps role confirmations current and supports explicit administrators", async () => {
    const f = await fixture(),
      note = f.seed("Plan", "Work", false);
    await f.workspace.setMember(note, f.sam.pubkey, "admin", undefined, {
      expectedRole: "absent",
    });
    expect(f.channels.get(note.channel)?.roles[f.sam.pubkey]).toBe("admin");
    const before = f.accepted.length;
    await expect(
      f.workspace.setMember(note, f.sam.pubkey, "read", undefined, {
        expectedRole: "member",
      }),
    ).rejects.toThrow(/access changed/);
    expect(f.accepted).toHaveLength(before);
    await f.workspace.setMember(note, f.sam.pubkey, "read", undefined, {
      expectedRole: "admin",
    });
    expect(f.channels.get(note.channel)?.roles[f.sam.pubkey]).toBe("guest");
  });
  it("confirms participating agent access when the relay stores the bot role", async () => {
    const f = await fixture(),
      note = f.seed("Plan", "Work", false);
    const state = await f.workspace.setMember(note, f.carl.pubkey, "edit");
    expect(state.roles[f.carl.pubkey]).toBe("bot");
    expect(f.channels.get(note.channel)?.labels).not.toContain(
      "buzz.notes.agents",
    );
  });
  it("keeps note access administration unavailable to an editor", async () => {
    const f = await fixture(),
      note = f.seed("Plan", "Work", false);
    const channel = f.channels.get(note.channel);
    if (!channel) throw new Error("Missing note channel");
    channel.roles[f.viewer.pubkey] = "member";
    channel.updated++;
    await expect(
      f.workspace.setMember(note, f.sam.pubkey, "admin"),
    ).rejects.toThrow(/cannot change/);
    expect(channel.roles[f.sam.pubkey]).toBeUndefined();
  });
  it("keeps deliberate restrictions when a new owned agent asks for access", async () => {
    const f = await fixture(),
      restricted = f.seed("Restricted", "Only owner", false);
    const get = noteTools(() => f.workspace).find(
      (tool) => tool.name === "note_get",
    );
    if (!get) throw new Error("Missing note_get");
    await expect(get.call(f.client(), {}, restricted)).rejects.toThrow(
      /unavailable/,
    );
    expect(
      f.channels.get(restricted.channel)?.roles[f.carl.pubkey],
    ).toBeUndefined();
  });
  it("pages system-channel discovery without claiming a capped result is complete", async () => {
    const f = await fixture();
    for (let index = 0; index < 101; index++)
      f.seed(`Plan ${index}`, "Text", false);
    const page = await f.workspace.list();
    expect(page.notes).toHaveLength(100);
    expect(page.more).toBe(true);
    const next = await f.workspace.list(page.cursor);
    expect(next.notes).toHaveLength(1);
    expect(next.more).toBe(false);
    expect(
      new Set([...page.notes, ...next.notes].map((note) => note.id)).size,
    ).toBe(101);
  });
});

it("runs the human–agent editing loop on the same records with caller-authored writes", async () => {
  const f = await fixture();
  const tools = noteTools(() => f.workspace);
  const set = tools.find((tool) => tool.name === "note_set"),
    get = tools.find((tool) => tool.name === "note_get");
  if (!set || !get) throw new Error("Missing note tools");
  const first = JSON.parse(
    (await set.call(
      f.client(),
      {},
      { id: crypto.randomUUID(), title: "Plan", text: "Carl’s plan" },
    )) as string,
  );
  const opened = await f.workspace.open(first);
  expect(opened.event.pubkey).toBe(f.carl.pubkey);
  const human = await f.workspace.save(opened, {
    title: "Plan",
    markdown: "Taylor’s changes",
  });
  const agentRead = JSON.parse(
    (await get.call(f.client(), {}, first)) as string,
  );
  expect(agentRead.revision).toBe(human.revision);
  expect(agentRead.markdown).toBe("Taylor’s changes");
  await set.call(
    f.client(),
    {},
    {
      ...first,
      revision: human.revision,
      title: "Plan",
      text: "Carl’s update",
    },
  );
  const other = JSON.parse(
    (await get.call(f.client(f.ned), {}, first)) as string,
  );
  expect(other.markdown).toBe("Carl’s update");
  expect(f.heads.get(first.id)?.pubkey).toBe(f.carl.pubkey);
  expect(f.revisions).toHaveLength(3);
});

it("does not call the owner’s writer when an unauthorized agent asks to share", async () => {
  const f = await fixture(),
    note = f.seed("Plan", "Work");
  const share = noteTools(() => f.workspace).find(
    (tool) => tool.name === "note_share",
  );
  if (!share) throw new Error("Missing share tool");
  const spy = vi.spyOn(f.workspace, "setMember");
  await expect(
    share.call(
      f.client(),
      {},
      { ...note, pubkey: f.sam.pubkey, access: "edit" },
    ),
  ).rejects.toThrow(/cannot administer/);
  expect(spy).not.toHaveBeenCalled();
  expect(f.channels.get(note.channel)?.roles[f.sam.pubkey]).toBeUndefined();
});

it("uses stable, community-bound note links across Markdown, chat and OS ingress", async () => {
  const f = await fixture(),
    note = f.seed("Plan [new]", "Work");
  const url = noteUrl(note, "wss://notes.example.test");
  expect(parseNoteUrl(url)).toEqual({
    id: note.id,
    channel: note.channel,
    community: f.origin,
  });
  expect(noteMarkdownLink(note, f.origin)).toContain("Plan \\[new\\]");
  expect(parseBuzzLink(url)?.format).toBe("note");
  const target = buzzLinkTarget(url, {
    viewer: f.viewer.pubkey,
    communityOrigin: f.origin,
  });
  expect(target).toMatchObject({
    kind: "page",
    pluginId: "buzz.relay-notes",
    pageId: "notes",
    route: { params: { id: note.id, channel: note.channel } },
  });
  expect(
    deepLinkStep(url, { viewer: f.viewer.pubkey, selected: f.origin }),
  ).toEqual({ open: target });
  expect(parseNoteUrl(`${url}&id=${note.id}`)).toBeUndefined();
  expect(
    parseNoteUrl(
      url.replace(
        "https%3A%2F%2Fnotes.example.test",
        "https%3A%2F%2Fevil%40notes.example.test",
      ),
    ),
  ).toBeUndefined();
  expect(NOTE_KIND).toBe(45010);
  expect(
    await readNotesPage(f.workspace.read, f.viewer.pubkey, f.relay.pubkey),
  ).toMatchObject({ more: false });
});
