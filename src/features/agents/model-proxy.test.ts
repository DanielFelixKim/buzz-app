import { Context } from "@deepseek-ai/cordis";
import { afterEach, expect, it, vi } from "vitest";
import { createModelProxies } from "./model-proxy";

it("requires a grant, chains active transforms and passes through after disposal", async () => {
  const root = new Context();
  root.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const registry = createModelProxies(root);
  const request = { path: "/v1/messages", body: "original" };
  expect(() =>
    registry.register(root, {
      id: "x",
      harness: "claude/type",
      run: () => "bad",
    }),
  ).toThrow("Declare host.modelProxies");
  expect(await registry.dispatch("claude/type", request)).toBe("original");
  const fiber = root
    .extend({
      pluginOwner: {
        id: "trimmer",
        revision: "1",
        modelProxies: ["claude/type"],
      },
    })
    .plugin((ctx) => {
      registry.register(ctx, {
        id: "b",
        harness: "claude/type",
        run: ({ body }) => `${body}b`,
      });
      registry.register(ctx, {
        id: "a",
        harness: "claude/type",
        run: ({ body }) => `${body}a`,
      });
    });
  await fiber.await();
  expect(await registry.dispatch("claude/type", request)).toBe("originalab");
  expect(await registry.dispatch("other/type", request)).toBe("original");
  await fiber.dispose();
  expect(await registry.dispatch("claude/type", request)).toBe("original");
  await root.fiber.dispose();
});

it("finishes an admitted transform across replacement and propagates failures", async () => {
  const root = new Context();
  root.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const registry = createModelProxies(root);
  let release!: (body: string) => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = new Promise<string>((resolve) => {
    release = resolve;
  });
  const owner = root.extend({
    pluginOwner: { id: "trimmer", revision: "1", modelProxies: ["codex/type"] },
  });
  const fiber = owner.plugin((ctx) =>
    registry.register(ctx, {
      id: "trim",
      harness: "codex/type",
      run: () => {
        entered();
        return pending;
      },
    }),
  );
  await fiber.await();
  const request = { path: "/responses", body: "original" };
  const admitted = registry.dispatch("codex/type", request);
  await started;
  await fiber.dispose();
  const replacement = owner.plugin((ctx) =>
    registry.register(ctx, {
      id: "trim",
      harness: "codex/type",
      run: () => {
        throw new Error("failed");
      },
    }),
  );
  await replacement.await();
  release("trimmed");
  expect(await admitted).toBe("trimmed");
  await expect(registry.dispatch("codex/type", request)).rejects.toThrow(
    "Plugin model proxy trimmer failed (callback_failed)",
  );
  await root.fiber.dispose();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it.each([
  { retry: true, fallback: false, failures: 1, expected: "trimmed", calls: 2 },
  { retry: false, fallback: true, failures: 2, expected: "original", calls: 1 },
  { retry: true, fallback: true, failures: 2, expected: "original", calls: 2 },
])(
  "recovers with $retry retry and $fallback fallback",
  async ({ retry, fallback, failures, expected, calls }) => {
    vi.stubGlobal("localStorage", {
      getItem: () => JSON.stringify({ retry, fallback }),
    });
    const root = new Context();
    root.provide("pluginStatus", {
      isActive: () => true,
      subscribe: () => () => {},
    });
    const registry = createModelProxies(root);
    const run = vi.fn(() => {
      if (failures-- > 0)
        throw new Error("private request text and credentials");
      return "trimmed";
    });
    const fiber = root
      .extend({
        pluginOwner: {
          id: "trimmer",
          revision: "1",
          modelProxies: ["claude/type"],
        },
      })
      .plugin((ctx) => {
        registry.register(ctx, { id: "trim", harness: "claude/type", run });
      });
    await fiber.await();
    expect(
      await registry.dispatch("claude/type", {
        path: "/messages",
        body: "original",
      }),
    ).toBe(expected);
    expect(run).toHaveBeenCalledTimes(calls);
    await root.fiber.dispose();
  },
);

it("attributes timeout without retrying a callback still running", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("localStorage", {
    getItem: () => JSON.stringify({ retry: true, fallback: false }),
  });
  const root = new Context();
  root.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const registry = createModelProxies(root);
  const run = vi.fn(() => new Promise<string>(() => {}));
  const fiber = root
    .extend({
      pluginOwner: {
        id: "trimmer",
        revision: "1",
        modelProxies: ["claude/type"],
      },
    })
    .plugin((ctx) =>
      registry.register(ctx, { id: "trim", harness: "claude/type", run }),
    );
  await fiber.await();
  const call = registry.dispatch("claude/type", {
    path: "/messages",
    body: "original",
  });
  const assertion = expect(call).rejects.toMatchObject({
    code: "callback_timeout",
    pluginId: "trimmer",
  });
  await vi.advanceTimersByTimeAsync(25000);
  await assertion;
  expect(run).toHaveBeenCalledTimes(1);
  await root.fiber.dispose();
});

it("bypasses only the failed plugin and keeps other transforms and diagnostics private", async () => {
  vi.stubGlobal("localStorage", {
    getItem: (key: string) =>
      key.endsWith(":b")
        ? JSON.stringify({ retry: true, fallback: true })
        : null,
  });
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const root = new Context();
  root.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const registry = createModelProxies(root);
  const failed = vi.fn(() => {
    throw new Error("secret-body Bearer secret");
  });
  for (const [id, run] of [
    ["a", ({ body }: { body: string }) => `${body}a`],
    ["b", failed],
    ["c", ({ body }: { body: string }) => `${body}c`],
  ] as const) {
    await root
      .extend({
        pluginOwner: { id, revision: "1", modelProxies: ["claude/type"] },
      })
      .plugin((ctx) =>
        registry.register(ctx, {
          id: "transform",
          harness: "claude/type",
          run,
        }),
      )
      .await();
  }
  try {
    expect(
      await registry.dispatch("claude/type", {
        path: "/messages",
        body: "original",
      }),
    ).toBe("originalac");
    expect(failed).toHaveBeenCalledTimes(2);
    expect(failed).toHaveBeenNthCalledWith(2, {
      path: "/messages",
      body: "originala",
    });
    expect(JSON.stringify(warning.mock.calls)).not.toContain("secret");
    expect(warning).toHaveBeenLastCalledWith("Buzz model proxy failure", {
      plugin: "b",
      code: "callback_failed",
      attempt: 2,
      action: "bypass",
    });
  } finally {
    warning.mockRestore();
    await root.fiber.dispose();
  }
});
