import type { Context } from "@deepseek-ai/cordis";
import { createContributions } from "../../plugins/contributions";
import { modelProxyRecovery } from "./model-proxy-recovery";
import { withTimeout } from "../../plugins/timeout";

/** Native wire body without authentication headers. Path is relative to upstream. */
export type ModelProxyRequest = Readonly<{ path: string; body: string }>;
/** A request transformation, looked up anew for every model request. */
export type AgentModelProxy = Readonly<{
  id: string;
  harness: string;
  run(
    request: ModelProxyRequest,
  ): Promise<string | undefined> | string | undefined;
}>;

export class ModelProxyFailure extends Error {
  constructor(
    readonly code:
      | "callback_failed"
      | "callback_timeout"
      | "invalid_body"
      | "output_too_large",
    readonly pluginId: string,
  ) {
    super(`Plugin model proxy ${pluginId} failed (${code})`);
  }
}

export function createModelProxies(root: Context) {
  const contributions = createContributions<AgentModelProxy>(root);
  return {
    register(ctx: Context, proxy: AgentModelProxy) {
      if (!ctx.pluginOwner?.modelProxies?.includes(proxy.harness))
        throw new Error(
          `Declare host.modelProxies access for ${proxy.harness}`,
        );
      if (typeof proxy.run !== "function")
        throw new Error("A proxy needs a callback");
      contributions.register(ctx, proxy);
    },
    async dispatch(harness: string, request: ModelProxyRequest) {
      // Snapshot before awaiting. An admitted callback finishes even after unload.
      const handlers = contributions
        .snapshot()
        .filter((p) => p.harness === harness)
        .sort((a, b) => a.key.localeCompare(b.key));
      const groups = new Map<string, typeof handlers>();
      for (const handler of handlers) {
        const group = groups.get(handler.pluginId) ?? [];
        group.push(handler);
        groups.set(handler.pluginId, group);
      }
      const deadline = Date.now() + 25000;
      let body = request.body;
      plugins: for (const [pluginId, group] of groups) {
        const original = body;
        let policy: ReturnType<typeof modelProxyRecovery>;
        try {
          policy = modelProxyRecovery(pluginId);
        } catch {
          throw new ModelProxyFailure("callback_failed", pluginId);
        }
        for (const handler of group) {
          for (let attempt = 0; ; attempt++) {
            try {
              const next = await withTimeout(
                Promise.resolve().then(() => handler.run({ ...request, body })),
                "Model proxy callback timed out",
                Math.max(1, deadline - Date.now()),
              );
              if (next !== undefined) {
                if (typeof next !== "string")
                  throw new ModelProxyFailure("invalid_body", pluginId);
                if (
                  new TextEncoder().encode(next).byteLength >
                  64 * 1024 * 1024
                )
                  throw new ModelProxyFailure("output_too_large", pluginId);
                body = next;
              }
              break;
            } catch (cause) {
              const code =
                cause instanceof ModelProxyFailure
                  ? cause.code
                  : cause instanceof Error &&
                      cause.message === "Model proxy callback timed out"
                    ? "callback_timeout"
                    : "callback_failed";
              const error = new ModelProxyFailure(code, pluginId);
              const retry =
                policy.retry && attempt === 0 && code !== "callback_timeout";
              console.warn("Buzz model proxy failure", {
                plugin: pluginId,
                code,
                attempt: attempt + 1,
                action: retry ? "retry" : policy.fallback ? "bypass" : "stop",
              });
              if (retry) continue;
              if (!policy.fallback) throw error;
              body = original;
              continue plugins;
            }
          }
        }
      }
      return body;
    },
  };
}
