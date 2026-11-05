import { describe, expect, it, vi } from "vitest";
import type { HostRequest, HostResponse } from "../../host/service";
import type { AgentKey } from "../membership";
import {
  MODEL_ACCESS_PATH,
  WorkforceRoutes,
  type WorkforceMembership,
} from "./route";
import type { WorkforceDescriptor } from "./descriptor";

const GATEWAY = "https://gateway.example";
const LISTED = {
  id: "22222222-2222-4222-8222-222222222222",
  origin: "https://block.example",
};
const OTHER = {
  id: "44444444-4444-4444-8444-444444444444",
  origin: "https://other.example",
};
const DESCRIPTOR: WorkforceDescriptor = {
  version: 1,
  gateway: GATEWAY,
  communities: [LISTED, OTHER],
};
const OWNER = "a".repeat(64);
const key = (name: string) => name as AgentKey;

/** A request function whose responses the test settles one by one. */
function gateway() {
  const pending: {
    request: HostRequest;
    respond: (response: HostResponse | Error) => void;
  }[] = [];
  const request = vi.fn(
    (request: HostRequest) =>
      new Promise<HostResponse>((resolve, reject) =>
        pending.push({
          request,
          respond: (response) =>
            response instanceof Error ? reject(response) : resolve(response),
        }),
      ),
  );
  const answer = async (body: string, status = 200) => {
    const next = pending.shift();
    if (!next) throw new Error("No request pending");
    next.respond({ status, headers: {}, body });
    await Promise.resolve();
    await Promise.resolve();
    return next.request;
  };
  return { request, pending, answer };
}

function member(
  name: string,
  session: object | undefined,
  overrides: Partial<WorkforceMembership> = {},
): WorkforceMembership {
  return {
    key: key(name),
    origin: LISTED.origin,
    owner: OWNER,
    pubkey: name.padEnd(64, "0").replace(/[^0-9a-f]/g, "0"),
    community: session && { id: LISTED.id, session },
    ...overrides,
  };
}

function setup(descriptor: WorkforceDescriptor | null = DESCRIPTOR) {
  const routes = new WorkforceRoutes(() => descriptor);
  const net = gateway();
  routes.bindRequest(net.request);
  return { routes, ...net };
}

describe("WorkforceRoutes", () => {
  it("is external for every membership without a descriptor", () => {
    const { routes, request } = setup(null);
    routes.setMembership(member("b1", {}));
    expect(routes.configured).toBe(false);
    expect(routes.routeFor(key("b1")).kind).toBe("external");
    expect(request).not.toHaveBeenCalled();
  });

  it("blocks everything when the descriptor is invalid", () => {
    const routes = new WorkforceRoutes(() => {
      throw new Error("bad");
    });
    routes.setMembership(member("b1", {}));
    expect(routes.routeFor(key("b1"))).toMatchObject({
      kind: "blocked",
      reason: "descriptor_invalid",
    });
  });

  it("goes pending, probes with discovery headers, then is eligible at a fresh revision", async () => {
    const { routes, answer } = setup();
    const session = {};
    routes.setMembership(member("b1", session));
    const pending = routes.routeFor(key("b1"));
    expect(pending).toMatchObject({
      kind: "blocked",
      reason: "readiness_pending",
      revision: 1,
    });
    const request = await answer('{"open_models_only":null}');
    expect(request.url).toBe(`${GATEWAY}${MODEL_ACCESS_PATH}`);
    expect(request.method).toBe("GET");
    expect(request.headers).toMatchObject({
      "x-workforce-buzz-community-id": LISTED.id,
      "x-workforce-buzz-human-pubkey": OWNER,
    });
    expect(Object.keys(request.headers ?? {}).sort()).toEqual([
      "accept",
      "x-workforce-buzz-agent-pubkey",
      "x-workforce-buzz-community-id",
      "x-workforce-buzz-human-pubkey",
      "x-workforce-launcher-client",
    ]);
    expect(routes.routeFor(key("b1"))).toEqual({
      kind: "eligible",
      revision: 2,
      gatewayOrigin: GATEWAY,
      identity: {
        community_id: LISTED.id,
        human_pubkey: OWNER,
        agent_pubkey: member("b1", session).pubkey,
      },
      access: "unresolved",
      harnesses: [],
    });
  });

  it.each([
    [
      '{"open_models_only":true}',
      200,
      { kind: "eligible", access: "open_models_only" },
    ],
    [
      '{"open_models_only":false}',
      200,
      { kind: "eligible", access: "unrestricted", harnesses: [] },
    ],
    [
      '{"open_models_only":false,"harnesses":["pi","codex","pi","future"]}',
      200,
      {
        kind: "eligible",
        access: "unrestricted",
        harnesses: ["pi", "codex", "future"],
      },
    ],
    [
      '{"open_models_only":true,"harnesses":[]}',
      200,
      { kind: "eligible", harnesses: [] },
    ],
    [
      '{"open_models_only":true,"harnesses":"pi"}',
      200,
      { kind: "blocked", reason: "gateway_error" },
    ],
    [
      '{"open_models_only":true,"harnesses":["Pi"]}',
      200,
      { kind: "blocked", reason: "gateway_error" },
    ],
    ['{"harnesses":["pi"]}', 200, { kind: "blocked", reason: "gateway_error" }],
    ["", 401, { kind: "blocked", reason: "auth" }],
    ["", 403, { kind: "blocked", reason: "auth" }],
    ["", 500, { kind: "blocked", reason: "gateway_error" }],
    ["not json", 200, { kind: "blocked", reason: "gateway_error" }],
    [
      '{"open_models_only":"yes"}',
      200,
      { kind: "blocked", reason: "gateway_error" },
    ],
    [
      '{"open_models_only":true,"x":1}',
      200,
      { kind: "blocked", reason: "gateway_error" },
    ],
  ])("maps %s (%i) to its route", async (body, status, route) => {
    const { routes, answer } = setup();
    routes.setMembership(member("b1", {}));
    await answer(body, status);
    expect(routes.routeFor(key("b1"))).toMatchObject(route);
  });

  it("blocks on a network failure, never external", async () => {
    const { routes, pending } = setup();
    routes.setMembership(member("b1", {}));
    pending.shift()?.respond(new Error("offline"));
    await vi.waitFor(() =>
      expect(routes.routeFor(key("b1"))).toMatchObject({
        kind: "blocked",
        reason: "network",
      }),
    );
  });

  it("decides each membership on its own: external, mismatched, missing and eligible side by side", async () => {
    const { routes, answer, request } = setup();
    routes.setMembership(
      member("ext", {}, { origin: "https://external.example" }),
    );
    routes.setMembership(
      member("mismatch", {}, { community: { id: OTHER.id, session: {} } }),
    );
    routes.setMembership(
      member("missing", {}, { community: { id: undefined, session: {} } }),
    );
    routes.setMembership(member("offline", undefined));
    routes.setMembership(member("ok", {}));
    routes.setMembership(
      member(
        "other",
        {},
        { origin: OTHER.origin, community: { id: OTHER.id, session: {} } },
      ),
    );
    expect(request).toHaveBeenCalledTimes(2);
    await answer('{"open_models_only":false}');
    await answer("", 401);
    expect(routes.routeFor(key("ext")).kind).toBe("external");
    expect(routes.routeFor(key("mismatch"))).toMatchObject({
      reason: "community_id_mismatch",
    });
    expect(routes.routeFor(key("missing"))).toMatchObject({
      reason: "community_id_missing",
    });
    expect(routes.routeFor(key("offline"))).toMatchObject({
      reason: "readiness_pending",
    });
    expect(routes.routeFor(key("ok")).kind).toBe("eligible");
    expect(routes.routeFor(key("other"))).toMatchObject({ reason: "auth" });
  });

  it("a socket reconnect on the same session changes nothing; a replaced session goes pending even with the same ID", async () => {
    const { routes, answer, request } = setup();
    const session = {};
    routes.setMembership(member("b1", session));
    await answer('{"open_models_only":false}');
    const ready = routes.routeFor(key("b1"));
    const listener = vi.fn();
    routes.subscribeRoute(key("b1"), listener);
    routes.setMembership(member("b1", session));
    expect(routes.routeFor(key("b1"))).toEqual(ready);
    expect(listener).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(1);

    routes.setMembership(member("b1", undefined));
    expect(routes.routeFor(key("b1"))).toMatchObject({
      reason: "readiness_pending",
      revision: 3,
    });
    routes.setMembership(member("b1", {}));
    expect(routes.routeFor(key("b1"))).toMatchObject({
      reason: "readiness_pending",
      revision: 4,
    });
    expect(listener).toHaveBeenCalledTimes(2);
    await answer('{"open_models_only":false}');
    expect(routes.routeFor(key("b1"))).toMatchObject({
      kind: "eligible",
      revision: 5,
    });
  });

  it("discards a probe that settles after the revision moved", async () => {
    const { routes, answer } = setup();
    routes.setMembership(member("b1", {}));
    // The owner changes while the first probe is out.
    routes.setMembership(member("b1", {}, { owner: "c".repeat(64) }));
    expect(routes.routeFor(key("b1"))).toMatchObject({
      reason: "readiness_pending",
      revision: 2,
    });
    await answer('{"open_models_only":false}');
    expect(routes.routeFor(key("b1"))).toMatchObject({
      reason: "readiness_pending",
      revision: 2,
    });
    const second = await answer('{"open_models_only":false}');
    expect(second.headers?.["x-workforce-buzz-human-pubkey"]).toBe(
      "c".repeat(64),
    );
    expect(routes.routeFor(key("b1"))).toMatchObject({
      kind: "eligible",
      revision: 3,
    });
  });

  it("invalidates on a 401/403 from inference: pending at a new revision until a new probe settles", async () => {
    const { routes, answer } = setup();
    routes.setMembership(member("b1", {}));
    await answer('{"open_models_only":false}');
    routes.invalidate(key("b1"));
    expect(routes.routeFor(key("b1"))).toMatchObject({
      reason: "readiness_pending",
      revision: 3,
    });
    await answer("", 403);
    expect(routes.routeFor(key("b1"))).toMatchObject({
      reason: "auth",
      revision: 4,
    });
  });

  it("blocks a removed membership, never external, and never reuses its revision", async () => {
    const { routes, answer } = setup();
    routes.setMembership(member("b1", {}));
    await answer('{"open_models_only":false}');
    routes.removeMembership(key("b1"));
    expect(routes.routeFor(key("b1"))).toMatchObject({
      kind: "blocked",
      reason: "readiness_pending",
      revision: 3,
    });
    routes.setMembership(member("b1", {}));
    expect(routes.routeFor(key("b1")).revision).toBe(4);
  });

  it("keeps concurrent agents apart: one's change doesn't touch another's revision or cache", async () => {
    const { routes, answer } = setup();
    routes.setMembership(member("b1", {}));
    routes.setMembership(member("b2", {}));
    await answer('{"open_models_only":false}');
    await answer('{"open_models_only":true}');
    routes.invalidate(key("b1"));
    expect(routes.routeFor(key("b2"))).toMatchObject({
      kind: "eligible",
      revision: 2,
      access: "open_models_only",
    });
  });

  it("gives a turn its current route without waiting, retrying a failed probe in the background", async () => {
    const { routes, answer, pending } = setup();
    routes.setMembership(member("b1", {}));
    expect(routes.routeForTurn(key("b1"))).toMatchObject({
      kind: "blocked",
      reason: "readiness_pending",
    });
    await answer("", 500);
    expect(routes.routeForTurn(key("b1"))).toMatchObject({
      kind: "blocked",
      reason: "gateway_error",
    });
    expect(pending).toHaveLength(1);
    expect(routes.routeFor(key("b1"))).toMatchObject({
      reason: "readiness_pending",
    });
    await answer('{"open_models_only":false}');
    expect(routes.routeForTurn(key("b1"))).toMatchObject({
      kind: "eligible",
      revision: 4,
    });
    expect(pending).toHaveLength(0);
  });

  it("blocks a membership it was never told about while a descriptor is configured", () => {
    const { routes } = setup();
    expect(routes.routeFor(key("unknown"))).toMatchObject({
      kind: "blocked",
      reason: "readiness_pending",
    });
  });

  it("ignores a late 401/403 from an older revision", async () => {
    const { routes, answer, request } = setup();
    routes.setMembership(member("b1", {}));
    await answer('{"open_models_only":false}');
    const ready = routes.routeFor(key("b1"));
    routes.invalidate(key("b1"), ready.revision - 1);
    expect(routes.routeFor(key("b1"))).toEqual(ready);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("stays pending without a request path, and probes once one is bound", async () => {
    const routes = new WorkforceRoutes(() => DESCRIPTOR);
    routes.setMembership(member("b1", {}));
    expect(routes.routeFor(key("b1"))).toMatchObject({
      reason: "readiness_pending",
    });
    const net = gateway();
    const unbind = routes.bindRequest(net.request);
    expect(net.request).toHaveBeenCalledTimes(1);
    await net.answer('{"open_models_only":false}');
    expect(routes.routeFor(key("b1")).kind).toBe("eligible");
    unbind();
    routes.invalidate(key("b1"));
    expect(net.request).toHaveBeenCalledTimes(1);
  });
});
