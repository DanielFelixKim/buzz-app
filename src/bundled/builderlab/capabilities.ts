import { useEffect, useSyncExternalStore } from "react";
import type { BuilderlabSession } from "./session";

export type Capabilities = Readonly<{
  canUseRemoteAgents: boolean;
  canUseBuilderlabDecisions: boolean;
  canDeleteBuzzCommunities?: boolean;
}>;

const capabilityFields = {
  canUseRemoteAgents: "can_use_remote_agents",
  canUseBuilderlabDecisions: "can_use_builderlab_decisions",
  canDeleteBuzzCommunities: "can_delete_buzz_communities",
} as const satisfies Record<keyof Capabilities, string>;
const capabilityKeys = Object.keys(capabilityFields) as (keyof Capabilities)[];

/** Only literal true grants a capability; missing flags are denied. */
export function capabilitiesFrom(raw: unknown): Capabilities {
  const flags = raw as Record<string, unknown> | null | undefined;
  return Object.fromEntries(
    capabilityKeys.map((key) => [key, flags?.[capabilityFields[key]] === true]),
  ) as Capabilities;
}

function sameCapabilities(a: Capabilities, b: Capabilities): boolean {
  return capabilityKeys.every((key) => a[key] === b[key]);
}

/** Refresh only permissions. Failed attempts also cool down for one minute. */
export function createCapabilityRefresh(
  previous: Capabilities,
  read: () => Promise<unknown>,
  update: (capabilities: Capabilities) => void,
  checkedAt = Date.now(),
) {
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
        const next = capabilitiesFrom(capabilities);
        if (sameCapabilities(previous, next)) return;
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

/** Return the full session snapshot and refresh permissions on gated surfaces. */
export function useSessionWithCapabilityRefresh(session?: BuilderlabSession) {
  const state = useSyncExternalStore(
    session?.subscribe ?? noSubscribe,
    session?.snapshot ?? noSnapshot,
  );
  useEffect(() => {
    if (state.status === "signed-in") void session?.refreshCapabilities();
  }, [session, state]);
  return state;
}
