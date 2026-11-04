import { describe, expect, it, vi } from "vitest";
import {
  answerWorkforce,
  hostRoute,
  routeKey,
  type WorkforceRoute,
  type WorkforceSeam,
} from "./workforce";

const agent = "b".repeat(64);
const identity = {
  community_id: "c1",
  human_pubkey: "a".repeat(64),
  agent_pubkey: agent,
};
const eligible: WorkforceRoute = {
  kind: "eligible",
  gatewayOrigin: "https://gateway.test",
  identity,
  access: "unrestricted",
};
const blocked: WorkforceRoute = {
  kind: "blocked",
  gatewayOrigin: "https://gateway.test",
  reason: "auth",
  message: "Sign in to Block again to use its models.",
};
const binding = { v: 1, client_session_id: "u1", identity };
const turn = { trigger_kind: "message", trigger_id: "e1" };

function seam(route: WorkforceRoute, overrides: Partial<WorkforceSeam> = {}) {
  return {
    routeReady: vi.fn(async () => route),
    routeFor: vi.fn(() => route),
    subscribeRoute: vi.fn(() => () => {}),
    bindSession: vi.fn(() => ({ ok: true as const, binding, persist: true })),
    inferenceBundle: vi.fn(() => ({
      ok: true as const,
      value: { "x-workforce-launcher-session": "u1" },
    })),
    discoveryBundle: vi.fn(() => ({
      ok: true as const,
      value: { "x-workforce-buzz-purpose": "discovery" },
    })),
    bindingAdmits: vi.fn(() => ({ ok: true as const })),
    turnContext: vi.fn(() => turn),
    ...overrides,
  } satisfies WorkforceSeam;
}

describe("hostRoute", () => {
  it("is external only without a seam or for an external route", async () => {
    const signal = new AbortController().signal;
    expect(await hostRoute(undefined, agent, signal)).toEqual({
      kind: "external",
    });
    expect(await hostRoute(seam({ kind: "external" }), agent, signal)).toEqual({
      kind: "external",
    });
    expect(await hostRoute(seam(blocked), agent, signal)).toBe(blocked);
  });

  it("opens an eligible agent with its discovery headers, or blocked", async () => {
    const signal = new AbortController().signal;
    expect(await hostRoute(seam(eligible), agent, signal)).toEqual({
      kind: "eligible",
      gatewayOrigin: "https://gateway.test",
      identity,
      discovery: { "x-workforce-buzz-purpose": "discovery" },
    });
    const invalid = seam(eligible, {
      discoveryBundle: () => ({ ok: false, message: "Context is invalid" }),
    });
    expect(await hostRoute(invalid, agent, signal)).toEqual({
      kind: "blocked",
      gatewayOrigin: "https://gateway.test",
      message: "Context is invalid",
    });
  });
});

describe("routeKey", () => {
  it("changes with the kind, gateway or community", () => {
    const keys = new Set(
      [
        { kind: "external" } as const,
        eligible,
        blocked,
        { ...eligible, gatewayOrigin: "https://other.test" },
        { ...eligible, identity: { ...identity, community_id: "c2" } },
      ].map(routeKey),
    );
    expect(keys.size).toBe(5);
    expect(routeKey({ ...eligible, access: "open_models_only" })).toBe(
      routeKey(eligible),
    );
  });
});

describe("answerWorkforce", () => {
  const bind = {
    op: "bind",
    agent,
    event: "resume",
    saved: binding,
    turn,
  } as const;

  it("binds and bundles a run on an eligible route", () => {
    const workforce = seam(eligible);
    expect(answerWorkforce(workforce, bind)).toEqual({
      ok: true,
      binding,
      bundle: { "x-workforce-launcher-session": "u1" },
      persist: true,
    });
    expect(workforce.bindSession).toHaveBeenCalledWith(
      eligible,
      binding,
      "resume",
    );
    expect(workforce.inferenceBundle).toHaveBeenCalledWith(binding, turn);
  });

  it("never binds without an eligible route or a valid turn", () => {
    expect(answerWorkforce(undefined, bind).ok).toBe(false);
    expect(answerWorkforce(seam(blocked), bind)).toEqual({
      ok: false,
      message: blocked.message,
    });
    expect(answerWorkforce(seam({ kind: "external" }), bind).ok).toBe(false);
    expect(
      answerWorkforce(seam(eligible), {
        ...bind,
        turn: { error: "The message has no channel" },
      }),
    ).toEqual({ ok: false, message: "The message has no channel" });
    const conflict = seam(eligible, {
      bindSession: () => ({
        ok: false,
        error: "identity_conflict",
        message: "This session belongs to another identity",
      }),
    });
    expect(answerWorkforce(conflict, bind)).toEqual({
      ok: false,
      message: "This session belongs to another identity",
    });
  });

  it("admits a run's binding from the latest route, without rebinding", () => {
    const workforce = seam(blocked, {
      bindingAdmits: () => ({
        ok: false,
        reason: "auth",
        message: blocked.message,
      }),
    });
    expect(answerWorkforce(workforce, { op: "admit", agent, binding })).toEqual(
      { ok: false, message: blocked.message },
    );
    expect(workforce.bindSession).not.toHaveBeenCalled();
    expect(
      answerWorkforce(seam(eligible), { op: "admit", agent, binding }),
    ).toEqual({ ok: true });
  });
});
