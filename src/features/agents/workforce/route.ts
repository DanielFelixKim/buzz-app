import type { HostRequest, HostResponse } from "../../host/service";
import type { AgentKey } from "../membership";
import {
  discoveryBundle,
  identityErrors,
  type WorkforceIdentity,
} from "./contract";
import { workforceDescriptor, type WorkforceDescriptor } from "./descriptor";

// One owner decides, per local agent membership, whether its inference goes
// through the Workforce gateway. Only an origin the descriptor doesn't name
// is external. A named community stays blocked until its exact NIP-11 ID,
// the agent's identity and a model-access probe all check out, and goes back
// to pending on any change, so it never passes through external (direct
// providers) or a stale eligible route on the way.
//
// Every route carries the membership's eligibility revision. It rises
// synchronously whenever the route returns to pending (a membership change,
// removal, a 401/403, a retried failure), before any probe starts, and once
// more when a probe started at the current revision publishes its result. A
// probe that settles after the revision moved is discarded. So an answer is
// only ever valid at one revision, and native admission (which owns the
// handles and generations) can apply the highest revision it has seen and
// terminally revoke what opened under an older one. Nothing here re-probes
// on a schedule: a re-probe revokes the turns running under the old revision.

export type BlockedReason =
  | "readiness_pending"
  | "descriptor_invalid"
  | "community_id_missing"
  | "community_id_mismatch"
  | "identity_invalid"
  | "auth"
  | "network"
  | "gateway_error";
/** The gateway's model-access answer, unchanged: `open_models_only` true,
 * false or null. Never reinterpreted here; the gateway enforces it, and
 * gateway-filtered discovery lists what the membership may use. */
export type WorkforceAccess =
  | "open_models_only"
  | "unrestricted"
  | "unresolved";
export type EligibleRoute = Readonly<{
  kind: "eligible";
  revision: number;
  gatewayOrigin: string;
  identity: WorkforceIdentity;
  access: WorkforceAccess;
}>;
export type BlockedRoute = Readonly<{
  kind: "blocked";
  revision: number;
  gatewayOrigin: string;
  reason: BlockedReason;
  message: string;
}>;
export type WorkforceRoute =
  | Readonly<{ kind: "external"; revision: number }>
  | EligibleRoute
  | BlockedRoute;

/** A local agent membership as Agents knows it. `community` is undefined
 * while the community has no live relay session, then what that session's
 * transport read from NIP-11 `read_state_snapshot.community_id` when it was
 * created (undefined id: none), with the session it came from. A socket
 * reconnect keeps the session, so it changes nothing; a replaced session is
 * new evidence and returns the route to pending, even with the same ID. An
 * older session's ID never stands in for a new one's. */
export type WorkforceMembership = Readonly<{
  key: AgentKey;
  origin: string;
  owner: string;
  pubkey: string;
  community?: Readonly<{ id: string | undefined; session: object }> | undefined;
}>;
/** Sends one GET through a native grant for the gateway origin. */
export type WorkforceRequest = (request: HostRequest) => Promise<HostResponse>;

export const MODEL_ACCESS_PATH = "/internal/v1/workforce/model-access";
const MESSAGES: Record<BlockedReason, string> = {
  readiness_pending: "Checking Workforce access for this agent…",
  descriptor_invalid:
    "This build's Workforce configuration is invalid, so its agents can't run.",
  community_id_missing:
    "This community didn't identify itself, so its agents can't use the Workforce gateway. Try again once it reconnects.",
  community_id_mismatch:
    "This community's ID doesn't match this build's Workforce configuration, so its agents can't run.",
  identity_invalid:
    "This agent's owner or key isn't valid for Workforce routing.",
  auth: "The Workforce gateway didn't accept your employee sign-in. Check that you're signed in on a managed device, then try again.",
  network:
    "Buzz couldn't reach the Workforce gateway. Check your network or VPN connection, then try again.",
  gateway_error:
    "The Workforce gateway couldn't confirm model access. Try again shortly.",
};

type Readiness =
  | Readonly<{ status: "probing"; settled: Promise<void> }>
  | Readonly<{ status: "ready"; access: WorkforceAccess }>
  | Readonly<{ status: "failed"; reason: BlockedReason }>;

export class WorkforceRoutes {
  private readonly members = new Map<AgentKey, WorkforceMembership>();
  /** By (AgentKey, gateway origin, community ID): the app doesn't know the
   * employee principal, so the agent binding is the cache boundary. */
  private readonly readiness = new Map<string, Readiness>();
  /** Kept after a membership is removed, so a membership that comes back
   * never reuses a revision. */
  private readonly revisions = new Map<AgentKey, number>();
  private readonly listeners = new Map<AgentKey, Set<() => void>>();
  private request: WorkforceRequest | undefined;
  private readonly descriptor: WorkforceDescriptor | null | "invalid";

  constructor(descriptor: () => WorkforceDescriptor | null) {
    let parsed: WorkforceDescriptor | null | "invalid";
    try {
      parsed = descriptor();
    } catch {
      parsed = "invalid";
    }
    this.descriptor = parsed;
  }

  /** Whether any membership could route through Workforce in this build. */
  get configured() {
    return this.descriptor !== null;
  }

  /** Lets readiness probes go out through `request` until the returned
   * function is called. Pending memberships are probed at once. */
  bindRequest(request: WorkforceRequest) {
    this.request = request;
    for (const key of this.members.keys()) this.probe(key);
    return () => {
      if (this.request === request) this.request = undefined;
    };
  }

  /** Records `member`'s current state. Any change to what decides its route
   * returns it to pending and probes it again. */
  setMembership(member: WorkforceMembership) {
    const prior = this.members.get(member.key);
    if (
      prior &&
      prior.origin === member.origin &&
      prior.owner === member.owner &&
      prior.pubkey === member.pubkey &&
      prior.community?.session === member.community?.session &&
      prior.community?.id === member.community?.id
    )
      return;
    if (prior) this.forget(prior);
    this.members.set(member.key, member);
    this.bump(member.key);
    this.probe(member.key);
    this.notify(member.key);
  }

  removeMembership(key: AgentKey) {
    const prior = this.members.get(key);
    if (!prior) return;
    this.forget(prior);
    this.members.delete(key);
    this.bump(key);
    this.notify(key);
  }

  /** The membership's route now. An unknown membership is external only when
   * this build has no Workforce configuration; otherwise it is pending. */
  routeFor(key: AgentKey): WorkforceRoute {
    const decided = this.decide(key);
    if (decided.kind !== "pending") return decided.route;
    const state = this.readiness.get(decided.cache);
    return state?.status === "ready"
      ? Object.freeze({
          kind: "eligible",
          revision: this.revision(key),
          gatewayOrigin: decided.gateway,
          identity: decided.identity,
          access: state.access,
        })
      : blocked(
          decided.gateway,
          state?.status === "failed" ? state.reason : "readiness_pending",
          this.revision(key),
        );
  }

  /** The membership's route once readiness has settled: a turn waits on
   * this under its own signal. A failed probe is tried once more here, so
   * a turn after a network blip can succeed. */
  async routeReady(key: AgentKey, signal: AbortSignal) {
    signal.throwIfAborted();
    const decided = this.decide(key);
    if (decided.kind !== "pending") return decided.route;
    if (this.readiness.get(decided.cache)?.status === "failed") {
      // Nothing is admitted at a failed revision, so retrying for this turn
      // revokes nothing.
      this.readiness.delete(decided.cache);
      this.bump(key);
      this.notify(key);
    }
    // A probe discarded because the membership changed meanwhile leaves a
    // newer one in flight: wait for that too.
    for (let probing = this.probe(key); probing; probing = this.probe(key)) {
      const settled = probing;
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        void settled.finally(() => {
          signal.removeEventListener("abort", abort);
          resolve();
        });
      });
    }
    return this.routeFor(key);
  }

  subscribeRoute(key: AgentKey, listener: () => void) {
    const set = this.listeners.get(key) ?? new Set();
    set.add(listener);
    this.listeners.set(key, set);
    return () => {
      set.delete(listener);
      if (!set.size) this.listeners.delete(key);
    };
  }

  /** Drops what was learned about the membership's access, for a 401 or 403
   * from discovery or inference: it is pending until a new probe settles.
   * Given the revision the failing request ran under, a late failure from an
   * older revision doesn't discard a newer answer. */
  invalidate(key: AgentKey, revision?: number) {
    if (revision !== undefined && revision !== this.revision(key)) return;
    const decided = this.decide(key);
    if (decided.kind !== "pending") return;
    this.readiness.delete(decided.cache);
    this.bump(key);
    this.probe(key);
    this.notify(key);
  }

  private decide(key: AgentKey):
    | Readonly<{ kind: "decided"; route: WorkforceRoute }>
    | Readonly<{
        kind: "pending";
        gateway: string;
        identity: WorkforceIdentity;
        cache: string;
      }> {
    const revision = this.revision(key);
    const decided = (route: WorkforceRoute) =>
      ({ kind: "decided", route }) as const;
    const external = decided(Object.freeze({ kind: "external", revision }));
    const descriptor = this.descriptor;
    if (descriptor === null) return external;
    if (descriptor === "invalid")
      return decided(blocked("", "descriptor_invalid", revision));
    const member = this.members.get(key);
    const community =
      member &&
      descriptor.communities.find(({ origin }) => origin === member.origin);
    // Unknown here means not fed yet or removed: never external while a
    // descriptor is configured, so a stale key can't reach direct providers.
    if (!member) return decided(blocked("", "readiness_pending", revision));
    if (!community) return external;
    const gateway = descriptor.gateway;
    if (!member.community)
      return decided(blocked(gateway, "readiness_pending", revision));
    if (member.community.id === undefined)
      return decided(blocked(gateway, "community_id_missing", revision));
    if (member.community.id !== community.id)
      return decided(blocked(gateway, "community_id_mismatch", revision));
    const identity = Object.freeze({
      community_id: community.id,
      human_pubkey: member.owner,
      agent_pubkey: member.pubkey,
    });
    if (identityErrors(identity))
      return decided(blocked(gateway, "identity_invalid", revision));
    return {
      kind: "pending",
      gateway,
      identity,
      cache: JSON.stringify([key, gateway, community.id]),
    };
  }

  /** Starts a model-access probe for the membership when it needs one and a
   * request path is bound; returns the probe in flight, if any. */
  private probe(key: AgentKey): Promise<void> | undefined {
    const decided = this.decide(key);
    if (decided.kind !== "pending") return;
    const state = this.readiness.get(decided.cache);
    if (state?.status === "probing") return state.settled;
    if (state) return;
    const request = this.request;
    if (!request) return;
    const headers = discoveryBundle({ identity: decided.identity });
    if (!headers.ok) return;
    const started = this.revision(key);
    const settled = probeAccess(request, decided.gateway, headers.value).then(
      (result) => {
        if (this.readiness.get(decided.cache) !== probing) return;
        if (this.revision(key) !== started) {
          this.readiness.delete(decided.cache);
          return;
        }
        this.bump(key);
        this.readiness.set(
          decided.cache,
          Object.freeze(
            typeof result === "string"
              ? { status: "ready", access: result }
              : { status: "failed", reason: result.reason },
          ),
        );
        this.notify(key);
      },
    );
    const probing: Readiness = Object.freeze({ status: "probing", settled });
    this.readiness.set(decided.cache, probing);
    return settled;
  }

  private forget(member: WorkforceMembership) {
    const decided = this.decide(member.key);
    if (decided.kind === "pending") this.readiness.delete(decided.cache);
  }

  private revision(key: AgentKey) {
    return this.revisions.get(key) ?? 0;
  }

  private bump(key: AgentKey) {
    this.revisions.set(key, this.revision(key) + 1);
  }

  private notify(key: AgentKey) {
    for (const listener of [...(this.listeners.get(key) ?? [])]) listener();
  }
}

/** The gateway's model-access answer for this caller, or why it failed. */
export async function probeAccess(
  request: WorkforceRequest,
  gateway: string,
  headers: Readonly<Record<string, string>>,
): Promise<WorkforceAccess | Readonly<{ reason: BlockedReason }>> {
  let response: HostResponse;
  try {
    response = await request({
      url: `${gateway}${MODEL_ACCESS_PATH}`,
      method: "GET",
      headers: { accept: "application/json", ...headers },
      timeoutMs: 15_000,
    });
  } catch {
    return { reason: "network" };
  }
  if (response.status === 401 || response.status === 403)
    return { reason: "auth" };
  if (response.status !== 200) return { reason: "gateway_error" };
  let body: unknown;
  try {
    body = JSON.parse(response.body);
  } catch {
    return { reason: "gateway_error" };
  }
  if (
    typeof body !== "object" ||
    body === null ||
    Array.isArray(body) ||
    Object.keys(body).join() !== "open_models_only"
  )
    return { reason: "gateway_error" };
  const value = (body as { open_models_only: unknown }).open_models_only;
  return value === true
    ? "open_models_only"
    : value === false
      ? "unrestricted"
      : value === null
        ? "unresolved"
        : { reason: "gateway_error" };
}

const blocked = (
  gatewayOrigin: string,
  reason: BlockedReason,
  revision: number,
): BlockedRoute =>
  Object.freeze({
    kind: "blocked",
    revision,
    gatewayOrigin,
    reason,
    message: MESSAGES[reason],
  });

/** This app's routes, from this build's descriptor. */
export const workforceRoutes = new WorkforceRoutes(workforceDescriptor);
export const routeFor = (key: AgentKey) => workforceRoutes.routeFor(key);
export const routeReady = (key: AgentKey, signal: AbortSignal) =>
  workforceRoutes.routeReady(key, signal);
export const subscribeRoute = (key: AgentKey, listener: () => void) =>
  workforceRoutes.subscribeRoute(key, listener);
export const invalidateRoute = (key: AgentKey, revision?: number) =>
  workforceRoutes.invalidate(key, revision);
