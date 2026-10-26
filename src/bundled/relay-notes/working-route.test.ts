import { expect, it } from "vitest";
import {
  parseOpenTarget,
  type JsonValue,
} from "../../features/navigation/targets";
import { workingRoute, workingTarget } from "./working-route";

const id = "11111111-1111-4111-8111-111111111111";
const channel = "22222222-2222-4222-8222-222222222222";
const target = {
  version: 1,
  kind: "page",
  pluginId: "buzz.relay-notes",
  pageId: "notes",
} as const;
it("round-trips browser, editor, dialog, revision and new-draft addresses without content", () => {
  for (const value of [
    { view: "browse", query: "Research", trash: true },
    { view: "note", id, channel, edit: true, dialog: "link" },
    {
      view: "note",
      id,
      channel,
      dialog: "history",
      revision: "a".repeat(64),
      offset: 100,
    },
    { view: "new", draft: id },
  ]) {
    const route = workingRoute(value as JsonValue);
    expect(route).toEqual(value);
    if (!route) throw new Error("Missing route");
    expect(parseOpenTarget(workingTarget(target, route))).toMatchObject({
      route: { params: value },
    });
  }
  expect(workingRoute({ id, channel })).toEqual({ view: "note", id, channel });
});
it.each([
  { view: "note", id, channel, markdown: "private draft" },
  { view: "note", id, channel, revision: "a".repeat(64) },
  { view: "note", id, channel, dialog: "share", offset: 100 },
  { view: "new", draft: "bad" },
  { view: "browse", edit: true },
  { view: "browse", query: "x".repeat(513) },
])("rejects malformed or content-bearing presentation: %o", (value) => {
  expect(workingRoute(value)).toBeUndefined();
});
