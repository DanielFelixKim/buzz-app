import { useEffect, useSyncExternalStore } from "react";
import type { BuilderlabSession } from "./session";

export type Capabilities = Readonly<{
  canUseRemoteAgents: boolean;
  canUseBuilderlabDecisions: boolean;
  canDeleteBuzzCommunities?: boolean;
}>;

/** Refresh only permissions. Failed attempts also cool down for one minute. */
export function createCapabilityRefresh(
  previous: Capabilities,
  read: () => Promise<unknown>,
  update: (capabilities: Capabilities) => void,
) {
  let checkedAt = Date.now();
  let pending: Promise<void> | undefined;
  return function refresh(): Promise<void> {
    if (pending) return pending;
    if (Date.now() - checkedAt < 60_000) return Promise.resolve();
    checkedAt = Date.now();
    pending = (async () => {
      try {
        const value = await read();
        if (!value || typeof value !== "object" || Array.isArray(value)) return;
        const capabilities = (value as { capabilities?: unknown }).capabilities;
        if (
          capabilities !== undefined &&
          (!capabilities ||
            typeof capabilities !== "object" ||
            Array.isArray(capabilities))
        )
          return;
        const flags = capabilities as Record<string, unknown> | undefined;
        const next: Capabilities = {
          canUseRemoteAgents: flags?.can_use_remote_agents === true,
          canUseBuilderlabDecisions:
            flags?.can_use_builderlab_decisions === true,
          canDeleteBuzzCommunities: flags?.can_delete_buzz_communities === true,
        };
        if (
          next.canUseRemoteAgents === previous.canUseRemoteAgents &&
          next.canUseBuilderlabDecisions ===
            previous.canUseBuilderlabDecisions &&
          next.canDeleteBuzzCommunities === previous.canDeleteBuzzCommunities
        )
          return;
        previous = next;
        update(next);
      } catch {
        // A failed capability check does not end sign-in or erase permissions.
      } finally {
        pending = undefined;
      }
    })();
    return pending;
  };
}

const signedOut = Object.freeze({ status: "signed-out" as const });
const noSubscribe = () => () => {};
const noSnapshot = () => signedOut;

/** Refresh on entry to permission-gated surfaces, including disabled ones. */
export function useCapabilities(session?: BuilderlabSession) {
  const state = useSyncExternalStore(
    session?.subscribe ?? noSubscribe,
    session?.snapshot ?? noSnapshot,
  );
  useEffect(() => {
    if (state.status === "signed-in") void session?.refreshCapabilities();
  }, [session, state]);
  return state;
}
