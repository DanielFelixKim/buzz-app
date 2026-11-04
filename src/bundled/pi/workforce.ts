// Block mode for Pi: the plugin's side of the host's `workforce` calls and
// the route it opens each agent with. Context validation, serialization and
// session lifecycle are DXA-1152's (src/features/agents/workforce): Pi takes
// them as a `WorkforceSeam`, and without one every agent is external.
import type { AgentKey } from "../../features/agents/membership";
import type { PiWorkforceAnswer, PiWorkforceCall } from "./pi";

type Result<T> = { ok: true; value: T } | { ok: false; message: string };
type Identity = {
  community_id: string;
  human_pubkey: string;
  agent_pubkey: string;
};
export type WorkforceRoute =
  | { kind: "external" }
  | {
      kind: "eligible";
      gatewayOrigin: string;
      identity: Identity;
      access: string;
    }
  | { kind: "blocked"; gatewayOrigin: string; reason: string; message: string };
type Eligible = Extract<WorkforceRoute, { kind: "eligible" }>;
type SessionEvent = "resume" | "reset" | "new_generation" | "standalone";

/** The DXA-1152 functions Pi uses, as that module exports them. */
export type WorkforceSeam = Readonly<{
  routeReady(key: AgentKey, signal: AbortSignal): Promise<WorkforceRoute>;
  routeFor(key: AgentKey): WorkforceRoute;
  subscribeRoute(key: AgentKey, listener: () => void): () => void;
  bindSession(
    route: Eligible,
    saved: unknown,
    event: SessionEvent,
  ):
    | { ok: true; binding: unknown; persist: boolean }
    | { ok: false; error: string; message: string };
  inferenceBundle(
    binding: unknown,
    turn: unknown,
  ): Result<Record<string, string>>;
  discoveryBundle(route: Eligible): Result<Record<string, string>>;
  bindingAdmits(
    route: WorkforceRoute,
    binding: unknown,
  ): { ok: true } | { ok: false; reason: string; message: string };
  turnContext(delivery: unknown): unknown;
}>;

/** What the host is opened with: never external unless the route is. */
export type HostRoute =
  | { kind: "external" }
  | {
      kind: "eligible";
      gatewayOrigin: string;
      identity: Identity;
      discovery: Record<string, string>;
    }
  | { kind: "blocked"; gatewayOrigin?: string; message: string };

export function hostRoute(
  seam: WorkforceSeam | undefined,
  route: WorkforceRoute,
): HostRoute {
  if (route.kind !== "eligible") return route;
  if (!seam) return { kind: "external" };
  const discovery = seam.discoveryBundle(route);
  return discovery.ok
    ? {
        kind: "eligible",
        gatewayOrigin: route.gatewayOrigin,
        identity: route.identity,
        discovery: discovery.value,
      }
    : {
        kind: "blocked",
        gatewayOrigin: route.gatewayOrigin,
        message: discovery.message,
      };
}

/** A key that changes exactly when the host must open the agent again. */
export function routeKey(route: WorkforceRoute): string {
  return route.kind === "external"
    ? "external"
    : `${route.kind} ${route.gatewayOrigin} ${route.kind === "eligible" ? route.identity.community_id : ""}`;
}

const LEFT = "This agent can't use Block's model gateway now";

/** Answers the host from the agent's latest route: a binding for a run
 * before it is submitted, and before each model request, whether the run's
 * binding is still admitted. Never rebinds a run. */
export function answerWorkforce(
  seam: WorkforceSeam | undefined,
  call: PiWorkforceCall,
): PiWorkforceAnswer {
  if (!seam) return { ok: false, message: "Block mode is not available here" };
  const route = seam.routeFor(call.agent);
  if (call.op === "admit") {
    const admitted = seam.bindingAdmits(route, call.binding);
    return admitted.ok
      ? { ok: true }
      : { ok: false, message: admitted.message };
  }
  if (route.kind !== "eligible")
    return {
      ok: false,
      message: route.kind === "blocked" ? route.message : LEFT,
    };
  const turn = call.turn as { error?: unknown } | undefined;
  if (!turn || typeof turn.error === "string")
    return {
      ok: false,
      message: turn?.error
        ? String(turn.error)
        : "This turn has no Buzz context",
    };
  const bound = seam.bindSession(route, call.saved, call.event);
  if (!bound.ok) return { ok: false, message: bound.message };
  const bundle = seam.inferenceBundle(bound.binding, call.turn);
  if (!bundle.ok) return { ok: false, message: bundle.message };
  return {
    ok: true,
    binding: bound.binding,
    bundle: bundle.value,
    persist: bound.persist,
  };
}
