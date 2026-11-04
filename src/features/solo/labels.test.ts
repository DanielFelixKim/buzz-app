import { expect, it } from "vitest";
import type { ChannelSummary } from "../relay/contracts";
import {
  eligibleSolo,
  ownSolo,
  SOLO_NAMED_LABEL,
  SOLO_LABEL,
  soloChatLinkName,
  soloLabels,
  soloOwner,
} from "./labels";

const id = "22222222-2222-4222-8222-222222222222";

const owner = "a".repeat(64);
const guest = "b".repeat(64);

it.each([
  { name: "viewer's own chat", changes: {}, expected: true },
  {
    name: "View only chat the viewer joined",
    changes: { readOnly: true, viewerRole: "guest" },
    expected: false,
  },
  {
    name: "chat shared with the viewer",
    changes: { viewerRole: "member" },
    expected: false,
  },
  {
    name: "chat of unknown role",
    changes: { viewerRole: undefined },
    expected: false,
  },
  { name: "archived chat", changes: { archived: true }, expected: false },
  {
    name: "ordinary channel",
    changes: { channelType: "stream" },
    expected: false,
  },
] satisfies {
  name: string;
  changes: Partial<ChannelSummary>;
  expected: boolean;
}[])(
  "lists a $name in Solo only when it is the viewer's own",
  ({ changes, expected }) => {
    const channel: ChannelSummary = {
      id,
      name: "Chat",
      channelType: "solo",
      creator: owner,
      viewerRole: "owner",
      members: [owner, guest],
      ...changes,
    };
    expect(eligibleSolo(channel)).toBe(expected);
  },
);

it("names shared chats by their current name, falling back to the short ID", () => {
  expect(soloChatLinkName({ id, name: "Investigate the flaky test" })).toBe(
    "Investigate the flaky test",
  );
  expect(soloChatLinkName({ id, name: "PR 45 fixes" })).toBe("PR 45 fixes");
  expect(soloChatLinkName({ id, name: "  " })).toBe("22222222");
});

it("marks Solo only with its channel label", () => {
  expect(soloLabels([SOLO_LABEL])).toBe(true);
  expect(soloLabels([SOLO_NAMED_LABEL, SOLO_LABEL])).toBe(true);
  expect(soloLabels([SOLO_NAMED_LABEL])).toBe(false);
  expect(soloLabels([])).toBe(false);
  expect(soloLabels(undefined)).toBe(false);
});

it("files a Solo chat as the viewer's own only when its roster makes them owner", () => {
  expect(ownSolo({ channelType: "solo", viewerRole: "owner" })).toBe(true);
  for (const viewerRole of ["admin", "member", "guest", undefined] as const)
    expect(ownSolo({ channelType: "solo", viewerRole })).toBe(false);
  expect(ownSolo({ channelType: "stream", viewerRole: "owner" })).toBe(false);
  expect(ownSolo(undefined)).toBe(false);
});

it("presents a Solo chat's roster owner, falling back to its creator", () => {
  const solo = "solo" as const;
  expect(soloOwner({ channelType: solo, owners: ["a"], creator: "b" })).toBe(
    "a",
  );
  // A creator who handed ownership to several people is no longer shown.
  expect(
    soloOwner({ channelType: solo, owners: ["c", "d"], creator: "b" }),
  ).toBe("c");
  expect(
    soloOwner({ channelType: solo, owners: ["a", "b"], creator: "b" }),
  ).toBe("b");
  expect(soloOwner({ channelType: solo, creator: "b" })).toBe("b");
  expect(soloOwner({ channelType: solo })).toBeUndefined();
  expect(soloOwner({ channelType: "stream", owners: ["a"] })).toBeUndefined();
});
