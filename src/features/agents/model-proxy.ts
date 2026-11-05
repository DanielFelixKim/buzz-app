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
    readonly code: "callback_failed" | "callback_timeout" | "invalid_body",
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
      const deadline = Date.now() + 25000;
      return (async () => {
        let body = request.body;
        for (const handler of handlers) {
          let policy: ReturnType<typeof modelProxyRecovery>;
          try {
            policy = modelProxyRecovery(handler.pluginId);
          } catch {
            throw new ModelProxyFailure("callback_failed", handler.pluginId);
          }
          for (let attempt = 0; ; attempt++) {
            try {
              const next = await withTimeout(
                Promise.resolve().then(() => handler.run({ ...request, body })),
                "Model proxy callback timed out",
                Math.max(1, deadline - Date.now()),
              );
              if (next !== undefined) {
                if (typeof next !== "string")
                  throw new ModelProxyFailure("invalid_body", handler.pluginId);
                body = next;
              }
              break;
            } catch (cause) {
              const code =
                cause instanceof Error &&
                cause.message === "Model proxy callback timed out"
                  ? "callback_timeout"
                  : cause instanceof ModelProxyFailure &&
                      cause.code === "invalid_body"
                    ? "invalid_body"
                    : "callback_failed";
              const error = new ModelProxyFailure(code, handler.pluginId);
              const retry =
                policy.retry && attempt === 0 && code !== "callback_timeout";
              console.warn("Buzz model proxy failure", {
                plugin: handler.pluginId,
                code,
                attempt: attempt + 1,
                action: retry ? "retry" : policy.fallback ? "bypass" : "stop",
              });
              if (retry) continue;
              if (!policy.fallback) throw error;
              break;
            }
          }
        }
        return body;
      })();
    },
  };
}
