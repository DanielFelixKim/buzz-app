import { expect, it, vi } from "vitest";
import { federatedFixture } from "../../features/federated-identity/testing";
import { deferred } from "./test-helpers";
import type { HostResponse } from "../../features/host/service";
import { createNativeBackend } from "./communities/native";
import { createNativeSession } from "./session";

const me = (subject: string) => ({
  status: 200,
  headers: {},
  body: JSON.stringify({
    subject,
    email: ` ${subject}@example.com `,
    capabilities: { can_use_remote_agents: true },
  }),
});

it("reads each native session's account once and fences requests and viewers to it", async () => {
  const h = federatedFixture();
  h.request.mockResolvedValueOnce(me("first"));
  const session = createNativeSession(h.service);
  expect(session.snapshot().status).toBe("signed-out");
  await session.signIn();
  await expect.poll(() => session.snapshot().status).toBe("signed-in");
  expect(session.snapshot().account).toEqual({
    subject: "first",
    email: "first@example.com",
    canUseRemoteAgents: true,
    canUseBuilderlabDecisions: false,
    canDeleteBuzzCommunities: false,
  });
  expect(h.request).toHaveBeenLastCalledWith({
    path: "/api/goose/v1/auth/me",
    method: "GET",
    headers: { Accept: "application/json" },
  });
  const first = session.credential();
  const viewer = session.viewerSession();
  expect(viewer).toMatchObject({ federated: "user:1" });
  expect(viewer.storage).toMatch(/^builderlab-[0-9a-f]{32}$/);
  h.request.mockResolvedValueOnce({ status: 200, headers: {}, body: "{}" });
  await session.request(first, { path: "/v1/buzz/communities/list" });
  expect(h.request).toHaveBeenLastCalledWith({
    path: "/api/goose/v1/buzz/communities/list",
  });

  h.request.mockResolvedValueOnce(me("second"));
  h.publish({ revision: "user:2" });
  expect(viewer.signal.aborted).toBe(true);
  await expect.poll(() => session.snapshot().account?.subject).toBe("second");
  await expect(session.request(first, { path: "/v1/auth/me" })).rejects.toThrow(
    "session changed",
  );
  expect(session.viewerSession()).toMatchObject({ federated: "user:2" });
  session.signOut();
  await expect.poll(() => session.snapshot().status).toBe("signed-out");
  expect(() => session.credential()).toThrow("Sign in to Builderlab first.");
  expect(h.request).toHaveBeenCalledTimes(3);
  session.dispose();
});

it("fails closed when the account cannot be read and retries on sign-in", async () => {
  const h = federatedFixture();
  h.request.mockResolvedValueOnce({ status: 403, headers: {}, body: "{}" });
  h.publish({ status: "signed-in", revision: "user:1" });
  const session = createNativeSession(h.service);
  await expect
    .poll(() => session.snapshot())
    .toEqual({
      status: "signed-out",
      error: "Could not load your Builderlab account. Try again.",
    });
  h.request.mockResolvedValueOnce(me("user"));
  await session.signIn();
  await expect.poll(() => session.snapshot().status).toBe("signed-in");
  expect(h.service.signIn).not.toHaveBeenCalled();
  session.dispose();
});

it("joins the shared native sign-in and leaves it running when a view closes", async () => {
  const h = federatedFixture();
  h.publish({ status: "signing-in" });
  const session = createNativeSession(h.service);
  expect(session.snapshot().status).toBe("pending");
  const joined = session.ensureSignedIn(new AbortController().signal);
  session.abandon();
  expect(h.service.cancelSignIn).not.toHaveBeenCalled();
  h.request.mockResolvedValueOnce(me("user"));
  h.publish({ status: "signed-in", revision: "user:1" });
  await expect(joined).resolves.toBeUndefined();
  expect(h.service.signIn).not.toHaveBeenCalled();
  session.cancel();
  expect(h.service.cancelSignIn).toHaveBeenCalledOnce();
  session.dispose();
});

it("settles a sign-in wait when native sign-in leaves the session unchanged", async () => {
  const h = federatedFixture();
  h.publish({ status: "unavailable", failure: "native-unavailable" });
  // Native returns the same snapshot, as it does before restore finishes.
  vi.mocked(h.service.signIn).mockImplementationOnce(async () =>
    h.service.snapshot(),
  );
  const session = createNativeSession(h.service);
  await expect(
    session.ensureSignedIn(new AbortController().signal),
  ).rejects.toThrow("Builderlab sign-in did not finish. Try again.");
  expect(h.service.signIn).toHaveBeenCalledOnce();
  session.dispose();
});

it("shows a session the adapter ended as signed out, asking to sign in again", async () => {
  const h = federatedFixture();
  h.request.mockResolvedValueOnce(me("user"));
  h.publish({ status: "signed-in", revision: "user:1" });
  const session = createNativeSession(h.service);
  await expect.poll(() => session.snapshot().status).toBe("signed-in");
  h.publish({
    status: "reauthentication-required",
    revision: "user:2",
    failure: "reauthentication-required",
  });
  expect(session.snapshot()).toEqual({
    status: "signed-out",
    error: "Your Builderlab sign-in ended. Sign in again.",
  });
  session.dispose();
});

it("shares capability checks for a minute and updates only flags without retiring the sign-in", async () => {
  let now = Date.now();
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  const h = federatedFixture();
  vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://builderlab.example");
  h.request.mockResolvedValueOnce({
    ...me("user"),
    body: JSON.stringify({
      ...JSON.parse(me("user").body),
      name: "Original",
      expires_at: "2030",
    }),
  });
  const session = createNativeSession(h.service);
  try {
    await session.signIn();
    await expect.poll(() => session.snapshot().status).toBe("signed-in");
    const credential = session.credential();
    const communities = createNativeBackend(session, async () => {});
    await expect(communities.auth()).resolves.toMatchObject({
      name: "Original",
      expiresAt: "2030",
      capabilities: { can_delete_buzz_communities: false },
    });
    const viewer = session.viewerSession();
    const notifications = vi.fn();
    session.subscribe(notifications);
    now += 59_999;
    await session.refreshCapabilities();
    expect(h.request).toHaveBeenCalledTimes(1);
    now += 1;
    const held = deferred<HostResponse>();
    h.request.mockReturnValueOnce(held.promise);
    const first = session.refreshCapabilities();
    const second = session.refreshCapabilities();
    expect(h.request).toHaveBeenCalledTimes(2);
    expect(session.snapshot().account?.canUseRemoteAgents).toBe(true);
    held.resolve({
      status: 200,
      headers: {},
      body: JSON.stringify({
        subject: "different",
        email: "changed@example.org",
        name: "Changed",
        expires_at: "2040",
        capabilities: {
          can_use_remote_agents: false,
          can_use_builderlab_decisions: true,
          can_delete_buzz_communities: true,
        },
      }),
    });
    await Promise.all([first, second]);
    expect(session.snapshot().account).toEqual({
      name: "Original",
      expiresAt: "2030",
      subject: "user",
      email: "user@example.com",
      canUseRemoteAgents: false,
      canUseBuilderlabDecisions: true,
      canDeleteBuzzCommunities: true,
    });
    await expect(communities.auth()).resolves.toMatchObject({
      name: "Original",
      expiresAt: "2030",
      capabilities: { can_delete_buzz_communities: true },
    });
    expect(h.request).toHaveBeenCalledTimes(2);
    expect(session.credential()).toBe(credential);
    expect(credential.account).toBe(session.snapshot().account);
    expect(session.viewerSession()).toBe(viewer);
    expect(viewer.signal.aborted).toBe(false);
    expect(notifications).toHaveBeenCalledOnce();
    await session.refreshCapabilities();
    expect(h.request).toHaveBeenCalledTimes(2);
    now += 60_000;
    h.request.mockResolvedValueOnce({
      status: 200,
      headers: {},
      body: JSON.stringify({
        capabilities: {
          can_use_remote_agents: false,
          can_use_builderlab_decisions: true,
          can_delete_buzz_communities: true,
        },
      }),
    });
    await session.refreshCapabilities();
    expect(notifications).toHaveBeenCalledOnce();
  } finally {
    session.dispose();
    clock.mockRestore();
    vi.unstubAllEnvs();
  }
});

it.each(["HTTP 401", "HTTP 503", "network", "JSON", "shape"])(
  "keeps cached permissions after a failed %s refresh and waits a minute before retrying",
  async (failure) => {
    let now = Date.now();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const h = federatedFixture();
    h.request.mockResolvedValueOnce(me("user"));
    const session = createNativeSession(h.service);
    try {
      await session.signIn();
      await expect.poll(() => session.snapshot().status).toBe("signed-in");
      const previous = session.snapshot();
      now += 60_000;
      if (failure === "network")
        h.request.mockRejectedValueOnce(new Error("Offline"));
      else
        h.request.mockResolvedValueOnce({
          status:
            failure === "HTTP 401" ? 401 : failure === "HTTP 503" ? 503 : 200,
          headers: {},
          body:
            failure === "JSON"
              ? "{"
              : failure === "shape"
                ? '{"capabilities":[]}'
                : "{}",
        });
      await session.refreshCapabilities();
      expect(session.snapshot()).toBe(previous);
      now += 59_999;
      await session.refreshCapabilities();
      expect(h.request).toHaveBeenCalledTimes(2);
      now += 1;
      h.request.mockResolvedValueOnce({
        status: 200,
        headers: {},
        body: '{"capabilities":{"can_use_remote_agents":false}}',
      });
      await session.refreshCapabilities();
      expect(h.request).toHaveBeenCalledTimes(3);
      expect(session.snapshot().account?.canUseRemoteAgents).toBe(false);
    } finally {
      session.dispose();
      clock.mockRestore();
    }
  },
);

it.each(["sign-out", "new-login", "dispose"])(
  "discards a capability response after %s",
  async (action) => {
    const h = federatedFixture();
    h.request.mockResolvedValueOnce(me("first"));
    const session = createNativeSession(h.service);
    await session.signIn();
    await expect.poll(() => session.snapshot().status).toBe("signed-in");
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
    const held = deferred<HostResponse>();
    h.request.mockReturnValueOnce(held.promise);
    const checking = session.refreshCapabilities();
    try {
      if (action === "dispose") session.dispose();
      else session.signOut();
      if (action === "new-login") {
        h.request.mockResolvedValueOnce(me("second"));
        await session.signIn();
        await expect
          .poll(() => session.snapshot().account?.subject)
          .toBe("second");
      }
      const previous = session.snapshot();
      held.resolve({
        status: 200,
        headers: {},
        body: '{"capabilities":{"can_use_remote_agents":false,"can_use_builderlab_decisions":true}}',
      });
      await checking;
      expect(session.snapshot()).toBe(previous);
    } finally {
      held.resolve(me("first"));
      await checking;
      session.dispose();
      clock.mockRestore();
    }
  },
);
