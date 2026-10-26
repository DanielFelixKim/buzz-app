import { Context } from "@deepseek-ai/cordis";
import { expect, it } from "vitest";
import { AgentsService } from "../../features/agents/service";
import {
  fakeCommunities,
  fakeRelay,
  fakeNative,
} from "../../features/agents/service-testing";
import { memoryStorage } from "../../features/agents/test-fakes";
import { addedKey, sessionTools } from "../../buzz-mcp/session-tools";
import { apply, inject } from ".";
import { provideNavigation } from "../../features/navigation/service";
import { PanelsService } from "../../features/panels/service";
import { PagesService } from "../../features/pages/service";

it("owns the working-note tools and panel while preserving legacy note tools", async () => {
  const ctx = new Context();
  ctx.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const service = new AgentsService(
    ctx,
    fakeCommunities(fakeRelay()).communities,
    fakeNative(),
    memoryStorage(),
  );
  const pages = new PagesService(ctx);
  const panels = new PanelsService(ctx);
  provideNavigation(ctx, undefined);
  ctx.provide("relay", fakeRelay().relay);
  let scope: ReturnType<Context["plugin"]> | undefined;
  try {
    const before = addedKey(service.tools());
    const builtins = sessionTools(service.tools()).map((tool) => tool.name);
    expect(builtins).toEqual(
      expect.arrayContaining(["notes_get", "notes_set", "notes_rm"]),
    );
    expect(
      sessionTools(service.tools()).some((tool) => tool.name === "note"),
    ).toBe(false);
    scope = ctx
      .extend({ pluginOwner: { id: "buzz.relay-notes", revision: "bundled" } })
      .plugin({ inject, apply });
    await scope;
    const added = service.tools().map((tool) => tool.name);
    expect(added).toEqual([
      "note_get",
      "note_set",
      "note_history",
      "note_delete",
      "note_share",
    ]);
    expect(pages.snapshot()).toMatchObject([
      {
        id: "notes",
        title: "Notes",
        layout: "workspace",
        primary: true,
        placement: "topbar",
      },
    ]);
    expect(panels.snapshot()).toMatchObject([
      { id: "note", keepOpen: true, channelPlacement: "tab" },
    ]);
    expect(addedKey(service.tools())).not.toBe(before);
    expect(sessionTools(service.tools()).map((tool) => tool.name)).toEqual([
      ...builtins,
      ...added,
    ]);
    expect(
      sessionTools(service.tools()).some((tool) => tool.name === "note"),
    ).toBe(false);
    await scope.dispose();
    expect(service.tools()).toEqual([]);
    expect(pages.snapshot()).toEqual([]);
    expect(panels.snapshot()).toEqual([]);
    expect(addedKey(service.tools())).toBe(before);
    expect(sessionTools(service.tools()).map((tool) => tool.name)).toEqual(
      builtins,
    );
  } finally {
    await scope?.dispose();
    await ctx.fiber.dispose();
  }
});
