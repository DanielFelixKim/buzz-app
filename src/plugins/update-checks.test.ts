import { expect, it, vi } from "vitest";
import {
  createPluginUpdateChecks,
  pluginUpdateCheck,
  pluginUpdateAvailable,
} from "./update-checks";
import type { PluginImports, PluginInfo } from "./types";
const plugin = (id = "example.one", path = "one") =>
  ({
    manifest: { id, name: id, apiVersion: 1 },
    source: "external",
    enabled: true,
    revision: "installed",
    previous: null,
    reloadable: true,
    error: null,
    updateSource: {
      repository: "https://example.com/plugins",
      reference: "main",
      path,
    },
  }) satisfies PluginInfo;
const preview = (revision: string) => ({
  token: "",
  source: "https://example.com/plugins",
  commit: null,
  warnings: [],
  candidates: [plugin(), plugin("example.two", "two")].map((item) => ({
    path: item.updateSource.path,
    manifest: item.manifest,
    revision,
  })),
});

it("shares one acquisition and generation across repeated checks and sibling paths", async () => {
  let finish!: (value: ReturnType<typeof preview>) => void;
  const checkGit = vi.fn(
    () =>
      new Promise<ReturnType<typeof preview>>((resolve) => {
        finish = resolve;
      }),
  );
  const checks = createPluginUpdateChecks({
    checkGit,
  } as unknown as PluginImports);
  const first = checks.check(plugin());
  const sequence = pluginUpdateCheck(checks.snapshot(), plugin())?.sequence;
  const again = checks.check(plugin());
  const sibling = checks.check(plugin("example.two", "two"));
  await Promise.resolve();
  expect(checkGit).toHaveBeenCalledOnce();
  expect(pluginUpdateCheck(checks.snapshot(), plugin())?.sequence).toBe(
    sequence,
  );
  finish(preview("new"));
  await Promise.all([first, again, sibling]);
  expect(pluginUpdateAvailable(checks.snapshot(), plugin())).toBe(true);
  expect(
    pluginUpdateAvailable(checks.snapshot(), plugin("example.two", "two")),
  ).toBe(true);
});

it("does not promote an old pending acquisition over a newer observed read", async () => {
  let finish!: (value: ReturnType<typeof preview>) => void;
  const checkGit = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue(preview("newest"));
  const checks = createPluginUpdateChecks({
    checkGit,
  } as unknown as PluginImports);
  const first = checks.check(plugin());
  checks.observe(plugin())("newer");
  const joined = checks.check(plugin());
  expect(pluginUpdateCheck(checks.snapshot(), plugin())?.revision).toBe(
    "newer",
  );
  await Promise.resolve();
  finish(preview("installed"));
  await first;
  expect(pluginUpdateCheck(checks.snapshot(), plugin())?.revision).not.toBe(
    "installed",
  );
  await joined;
  expect(checkGit).toHaveBeenCalledTimes(2);
  expect(pluginUpdateCheck(checks.snapshot(), plugin())?.revision).toBe(
    "newest",
  );
});

it("rejects an older observed read after a newer source acquisition completes", async () => {
  const checkGit = vi.fn(async () => preview("installed"));
  const checks = createPluginUpdateChecks({
    checkGit,
  } as unknown as PluginImports);
  const older = checks.observe(plugin());
  await checks.check(plugin());
  older("stale");
  expect(pluginUpdateCheck(checks.snapshot(), plugin())?.revision).toBe(
    "installed",
  );
  expect(pluginUpdateAvailable(checks.snapshot(), plugin())).toBe(false);
});

it.each([false, true])(
  "clears availability after an unavailable source (missing=%s)",
  async (missing) => {
    const checkGit = vi.fn().mockResolvedValueOnce(preview("new"));
    if (missing)
      checkGit.mockResolvedValue({
        ...preview("new"),
        candidates: [],
        warnings: ["one: Missing plugin"],
      });
    else checkGit.mockRejectedValue(new Error("offline"));
    const checks = createPluginUpdateChecks({
      checkGit,
    } as unknown as PluginImports);
    await checks.check(plugin());
    expect(pluginUpdateAvailable(checks.snapshot(), plugin())).toBe(true);
    await checks.check(plugin());
    const result = pluginUpdateCheck(checks.snapshot(), plugin());
    expect(result?.checking).toBe(false);
    expect(result?.revision).toBeUndefined();
    expect(result?.error).toContain(
      missing ? "one: Missing plugin" : "offline",
    );
    expect(pluginUpdateAvailable(checks.snapshot(), plugin())).toBe(false);
  },
);

it("records a failed preview read without keeping a stale revision", () => {
  const checks = createPluginUpdateChecks(undefined);
  checks.observe(plugin())("new");
  checks.observe(plugin())(undefined, "Source unavailable");
  expect(pluginUpdateAvailable(checks.snapshot(), plugin())).toBe(false);
  expect(pluginUpdateCheck(checks.snapshot(), plugin())?.error).toBe(
    "Source unavailable",
  );
});

it("drops an obsolete installation retry after rollback rejoins the original read", async () => {
  let finish!: (value: ReturnType<typeof preview>) => void;
  const checkGit = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue(preview("obsolete"));
  const checks = createPluginUpdateChecks({
    checkGit,
  } as unknown as PluginImports);
  const original = plugin();
  const first = checks.check(original);
  await Promise.resolve();
  const obsolete = checks.check({ ...original, revision: "temporary" });
  const latest = checks.check(original, undefined, false);
  await Promise.resolve();
  finish(preview("new"));
  await Promise.all([first, obsolete, latest]);
  expect(checkGit).toHaveBeenCalledOnce();
  expect(pluginUpdateCheck(checks.snapshot(), original)?.revision).toBe("new");
});

it("does not retry a replaced source after its old read settles", async () => {
  let finish!: (value: ReturnType<typeof preview>) => void;
  const checkGit = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue(preview("new"));
  const checks = createPluginUpdateChecks({
    checkGit,
  } as unknown as PluginImports);
  const original = plugin();
  const first = checks.check(original);
  await Promise.resolve();
  const obsolete = checks.check({ ...original, revision: "temporary" });
  const replacement = {
    ...original,
    updateSource: {
      ...original.updateSource,
      repository: "https://example.com/replacement",
    },
  };
  await checks.check(replacement);
  finish(preview("old"));
  await Promise.all([first, obsolete]);
  expect(checkGit).toHaveBeenCalledTimes(2);
  expect(pluginUpdateCheck(checks.snapshot(), replacement)?.revision).toBe(
    "new",
  );
});

it("retires queued automatic reads when eligibility is revoked", async () => {
  let finish!: (value: ReturnType<typeof preview>) => void;
  let eligible = true;
  const checkGit = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue(preview("new"));
  const checks = createPluginUpdateChecks({
    checkGit,
  } as unknown as PluginImports);
  const first = checks.check(plugin(), undefined, true, () => eligible);
  await Promise.resolve();
  checks.observe(plugin())("newer");
  const queued = checks.check(plugin(), undefined, true, () => eligible);
  eligible = false;
  finish(preview("old"));
  await Promise.all([first, queued]);
  expect(checkGit).toHaveBeenCalledOnce();
});

it("rechecks automatic eligibility after authorization resolves", async () => {
  let finish!: (value: null) => void;
  let eligible = true;
  const authorize = vi.fn(
    () =>
      new Promise<null>((resolve) => {
        finish = resolve;
      }),
  );
  const checkGit = vi.fn(async () => preview("new"));
  const checks = createPluginUpdateChecks({
    checkGit,
  } as unknown as PluginImports);
  const checking = checks.check(plugin(), authorize, true, () => eligible);
  expect(authorize).toHaveBeenCalledOnce();
  eligible = false;
  finish(null);
  await checking;
  expect(checkGit).not.toHaveBeenCalled();
});

it("settles the matching pending indicator after automatic eligibility is revoked", async () => {
  let finish!: (value: ReturnType<typeof preview>) => void;
  let eligible = true;
  const checkGit = vi.fn(
    () =>
      new Promise<ReturnType<typeof preview>>((resolve) => {
        finish = resolve;
      }),
  );
  const checks = createPluginUpdateChecks({
    checkGit,
  } as unknown as PluginImports);
  const checking = checks.check(plugin(), undefined, true, () => eligible);
  await Promise.resolve();
  eligible = false;
  finish(preview("new"));
  await checking;
  expect(pluginUpdateCheck(checks.snapshot(), plugin())?.checking).toBe(false);
  expect(
    pluginUpdateCheck(checks.snapshot(), plugin())?.revision,
  ).toBeUndefined();
  expect(pluginUpdateCheck(checks.snapshot(), plugin())?.error).toBeNull();
});

it("keeps an authorized shared read alive for an eligible sibling", async () => {
  let authorize!: (value: null) => void;
  let eligible = true;
  const sign = vi.fn(
    () =>
      new Promise<null>((resolve) => {
        authorize = resolve;
      }),
  );
  const checkGit = vi.fn(async () => preview("new"));
  const checks = createPluginUpdateChecks({
    checkGit,
  } as unknown as PluginImports);
  const first = checks.check(plugin(), sign, true, () => eligible);
  const sibling = checks.check(
    plugin("example.two", "two"),
    sign,
    true,
    () => true,
  );
  eligible = false;
  authorize(null);
  await Promise.all([first, sibling]);
  expect(checkGit).toHaveBeenCalledOnce();
  expect(
    pluginUpdateAvailable(checks.snapshot(), plugin("example.two", "two")),
  ).toBe(true);
  expect(pluginUpdateCheck(checks.snapshot(), plugin())?.checking).toBe(false);
});
