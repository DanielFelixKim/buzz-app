import { expect, it, vi } from "vitest";
import type { Credential } from "./browser";
import { createSavedSignIn, type Credential as Saved } from "./browser";
import { createOAuthSession } from "./session";
import { deferred } from "../test-helpers";

// A test can hold the account-storage step that follows a restore.
const storage = vi.hoisted(() => ({
  gate: undefined as Promise<void> | undefined,
}));
vi.mock("../session", async (original) => {
  const actual = await original<typeof import("../session")>();
  return {
    ...actual,
    accountStorage: async (subject: string) => {
      await storage.gate;
      return actual.accountStorage(subject);
    },
  };
});

const credential: Credential = {
  value: "private-token",
  account: {
    subject: "user",
    email: "a@example.com",
    canUseRemoteAgents: true,
    canUseBuilderlabDecisions: false,
  },
};
it("keeps credentials outside UI snapshots and clears them on sign-out and disposal", async () => {
  const acquire = vi.fn(async () => credential);
  const session = createOAuthSession(acquire);
  const listener = vi.fn();
  const unsubscribe = session.subscribe(listener);
  await session.signIn();
  expect(session.snapshot()).toEqual({
    status: "signed-in",
    account: credential.account,
  });
  expect(session.credential()).toBe(credential);
  session.signOut();
  expect(() => session.credential()).toThrow("Sign in");
  expect(session.snapshot()).toEqual({ status: "signed-out" });
  expect(listener).toHaveBeenCalled();
  listener.mockClear();
  unsubscribe();
  await session.signIn();
  session.dispose();
  expect(listener).not.toHaveBeenCalled();
  expect(() => session.credential()).toThrow("Sign in");
  await session.signIn();
  await expect(
    session.ensureSignedIn(new AbortController().signal),
  ).rejects.toThrow("session is closed");
  expect(acquire).toHaveBeenCalledTimes(2);
});
it.each(["cancel", "signOut", "dispose"] as const)(
  "%s settles a creation wait and rejects late credentials",
  async (action) => {
    const release = deferred<Credential>();
    let signal: AbortSignal | undefined;
    const session = createOAuthSession(async (current) => {
      signal = current;
      return release.promise;
    });
    const pending = session.signIn();
    const rejected = expect(
      session.ensureSignedIn(new AbortController().signal),
    ).rejects.toThrow("Sign-in canceled.");
    try {
      expect(session.snapshot().status).toBe("pending");
      session[action]();
      expect(signal?.aborted).toBe(true);
      await rejected;
    } finally {
      release.resolve(credential);
      await pending;
    }
    expect(session.snapshot()).toEqual({ status: "signed-out" });
    expect(() => session.credential()).toThrow("Sign in");
  },
);
it("a stale failure cannot replace a new sign-in", async () => {
  const old = deferred<Credential>();
  const acquire = vi
    .fn()
    .mockImplementationOnce(() => old.promise)
    .mockResolvedValueOnce(credential);
  const session = createOAuthSession(acquire);
  const pending = session.signIn();
  session.cancel();
  await session.signIn();
  old.reject(new Error("stale failure"));
  await pending;
  expect(session.snapshot()).toEqual({
    status: "signed-in",
    account: credential.account,
  });
  expect(session.credential()).toBe(credential);
});
it("creation joins an existing Settings login and aborts its wait without canceling the shared attempt", async () => {
  const release = deferred<Credential>();
  const acquire = vi.fn(() => release.promise);
  const session = createOAuthSession(acquire);
  const settings = session.signIn();
  const canceled = new AbortController();
  const aborted = expect(
    session.ensureSignedIn(canceled.signal),
  ).rejects.toMatchObject({ name: "AbortError" });
  const waiting = session.ensureSignedIn(new AbortController().signal);
  try {
    canceled.abort();
    await aborted;
    expect(session.snapshot().status).toBe("pending");
    expect(acquire).toHaveBeenCalledTimes(1);
  } finally {
    release.resolve(credential);
    await settings;
    await waiting;
  }
  expect(session.credential()).toBe(credential);
  await session.ensureSignedIn(new AbortController().signal);
  expect(acquire).toHaveBeenCalledTimes(1);
});

it("keeps one website store per account across sign-ins and restarts", async () => {
  const first = createOAuthSession(async () => credential);
  await first.signIn();
  const storage = first.viewerSession().storage;
  expect(storage).toMatch(/^builderlab-[0-9a-f]{32}$/);
  first.dispose();
  // A new plugin lifetime is a Buzz restart: the memory-only credential is gone.
  const restarted = createOAuthSession(async () => credential);
  await restarted.signIn();
  expect(restarted.viewerSession().storage).toBe(storage);
  const other = createOAuthSession(async () => ({
    ...credential,
    account: { ...credential.account, subject: "other" },
  }));
  await other.signIn();
  expect(other.viewerSession().storage).not.toBe(storage);
});

it("gives each sign-in a separate viewer lifetime and revokes only deliberate sign-out or replacement", async () => {
  const revoke = vi.fn();
  const session = createOAuthSession(async () => credential, revoke);
  await session.signIn();
  const first = session.viewerSession();
  expect(first).toMatchObject({ credential: credential.value });
  expect(JSON.stringify(session.snapshot())).not.toContain(credential.value);
  session.cancel();
  expect(first.signal.aborted).toBe(true);
  expect(revoke).not.toHaveBeenCalled();
  await session.signIn();
  const second = session.viewerSession();
  expect(second.signal).not.toBe(first.signal);
  expect(second.signal.aborted).toBe(false);
  session.signOut();
  expect(second.signal.aborted).toBe(true);
  expect(revoke).toHaveBeenCalledExactlyOnceWith(credential);
  await session.signIn();
  const third = session.viewerSession();
  session.dispose();
  expect(third.signal.aborted).toBe(true);
  expect(revoke).toHaveBeenCalledTimes(1);
});

it("ensureSignedIn starts and joins a fresh Settings login from signed-out", async () => {
  const login = deferred<Credential>();
  const session = createOAuthSession(() => login.promise);
  const pending = session.ensureSignedIn(new AbortController().signal);
  expect(session.snapshot().status).toBe("pending");
  login.resolve(credential);
  await expect(pending).resolves.toBeUndefined();
  expect(session.viewerSession().signal.aborted).toBe(false);
  session.dispose();
});

/** One app launch's keychain item, the shared owner over it and a host
 * whose `v1/auth/me` accepts whatever is saved. */
function keychain(value: string | null = null) {
  vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://builderlab.example");
  const store = {
    value,
    load: vi.fn(async () => store.value),
    save: vi.fn(async (next: string) => {
      store.value = next;
    }),
    clear: vi.fn(async () => {
      store.value = null;
    }),
  };
  const host = {
    request: vi.fn(async () => ({
      status: 200,
      headers: {},
      body: JSON.stringify({ subject: "user", email: "a@example.com" }),
    })),
  };
  const saved = createSavedSignIn(store);
  const plugin = (acquire = async () => credential, release = vi.fn()) => ({
    release,
    session: createOAuthSession(acquire, release, host, saved),
  });
  return { store, host, saved, plugin };
}
const as = (value: string): Saved => ({ ...credential, value });

it("restores a saved sign-in, saves a new one and deletes it on sign-out", async () => {
  const k = keychain("saved-token");
  const { session, release } = k.plugin();
  expect(session.snapshot()).toEqual({ status: "pending", checking: true });
  await vi.waitFor(() => expect(session.snapshot().status).toBe("signed-in"));
  expect(session.credential().value).toBe("saved-token");
  expect(k.store.save).not.toHaveBeenCalled();
  await session.signOut();
  expect(k.store.value).toBeNull();
  // A restored sign-in is revoked by the shared owner's logout.
  await vi.waitFor(() =>
    expect(k.host.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        headers: { "X-BB-Session-Credential": "saved-token" },
      }),
    ),
  );
  expect(release).not.toHaveBeenCalled();
  await session.signIn();
  expect(k.store.value).toBe("private-token");
});

it("shows a failed save as a retryable error and a failed delete as an unfinished sign-out", async () => {
  const k = keychain();
  k.store.save.mockRejectedValueOnce(new Error("denied"));
  k.store.clear.mockRejectedValueOnce(new Error("denied"));
  const { session, release } = k.plugin();
  await vi.waitFor(() => expect(session.snapshot().status).toBe("signed-out"));
  await session.signIn();
  expect(session.snapshot()).toEqual({
    status: "signed-out",
    error: "Could not save your Builderlab sign-in. Try again.",
  });
  await vi.waitFor(() => expect(release).toHaveBeenCalledWith(credential));
  await session.signIn();
  expect(session.snapshot().status).toBe("signed-in");
  await session.signOut();
  expect(session.snapshot()).toEqual({
    status: "signed-in",
    account: credential.account,
    error: "Couldn’t finish signing out of Builderlab. Try again.",
  });
  expect(k.store.value).toBe("private-token");
  await session.signOut();
  expect(session.snapshot()).toEqual({ status: "signed-out" });
  expect(k.store.value).toBeNull();
});

it("deletes after a save still running at sign-out, so the save cannot bring it back", async () => {
  const k = keychain();
  const saving = deferred<void>();
  k.store.save.mockImplementationOnce(async (next) => {
    await saving.promise;
    k.store.value = next;
  });
  const { session, release } = k.plugin();
  await vi.waitFor(() => expect(session.snapshot().status).toBe("signed-out"));
  const signingIn = session.signIn();
  await vi.waitFor(() => expect(k.store.save).toHaveBeenCalled());
  const signingOut = session.signOut();
  saving.resolve();
  await Promise.all([signingIn, signingOut]);
  expect(k.store.value).toBeNull();
  expect(session.snapshot()).toEqual({ status: "signed-out" });
  // The discarded sign-in is revoked, not left running.
  await vi.waitFor(() => expect(release).toHaveBeenCalledWith(credential));
});

it("leaves nothing saved when Welcome cancels a held save and the plugin signs out", async () => {
  const k = keychain();
  const saving = deferred<void>();
  k.store.save.mockImplementationOnce(async (next) => {
    await saving.promise;
    k.store.value = next;
  });
  const { session } = k.plugin();
  await vi.waitFor(() => expect(session.snapshot().status).toBe("signed-out"));
  const welcome = new AbortController();
  const revoke = vi.fn(async () => {});
  const accepting = k.saved.accept(as("welcome"), revoke, welcome.signal);
  welcome.abort();
  const signingOut = session.signOut();
  saving.resolve();
  await expect(accepting).rejects.toThrow();
  await signingOut;
  await vi.waitFor(() => expect(revoke).toHaveBeenCalled());
  expect(k.store.value).toBeNull();
  expect(session.snapshot().status).toBe("signed-out");
});

it("follows a second Welcome sign-in: the plugin shows B and retires A", async () => {
  const k = keychain();
  const { session } = k.plugin();
  await vi.waitFor(() => expect(session.snapshot().status).toBe("signed-out"));
  const revokeA = vi.fn(async () => {});
  const a = as("a");
  await k.saved.accept(a, revokeA, new AbortController().signal);
  await vi.waitFor(() => expect(session.snapshot().status).toBe("signed-in"));
  const viewerA = session.viewerSession();
  const b = { value: "b", account: { ...credential.account, subject: "b" } };
  await k.saved.accept(b, vi.fn(), new AbortController().signal);
  await vi.waitFor(() => expect(session.credential()).toBe(b));
  expect(session.snapshot().account?.subject).toBe("b");
  expect(viewerA.signal.aborted).toBe(true);
  expect(k.store.value).toBe("b");
  await vi.waitFor(() => expect(revokeA).toHaveBeenCalledWith(a));
  await expect(session.request(a, { path: "/v1/apps" })).rejects.toThrow(
    "session changed",
  );
});

it("retires the browser sign-in at once when NIP-FI takes over, retrying its delete until it succeeds", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const k = keychain("a");
    const { session, release } = k.plugin();
    await vi.waitFor(() => expect(session.snapshot().status).toBe("signed-in"));
    const a = session.credential();
    k.store.clear.mockRejectedValueOnce(new Error("busy"));
    k.host.request.mockClear();
    session.retire();
    // Unusable now: a running call's next request sends nothing as A.
    expect(session.snapshot().status).toBe("signed-out");
    await expect(session.request(a, { path: "/v1/apps" })).rejects.toThrow(
      "session changed",
    );
    await vi.waitFor(() =>
      expect(session.snapshot().error).toMatch(/keeps trying/),
    );
    // Another session in this launch never restores the retained item.
    expect(k.store.value).toBe("a");
    const restarted = k.plugin();
    await vi.waitFor(() =>
      expect(restarted.session.snapshot().status).toBe("signed-out"),
    );
    // Revoked at once; the restart reads nothing.
    expect(k.host.request).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: "GET" }),
    );
    await vi.advanceTimersByTimeAsync(5000);
    expect(k.store.value).toBeNull();
    await vi.waitFor(() =>
      expect(k.host.request).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "POST",
          headers: { "X-BB-Session-Credential": "a" },
        }),
      ),
    );
    expect(release).not.toHaveBeenCalled();
    expect(session.snapshot()).toEqual({ status: "signed-out" });
  } finally {
    vi.useRealTimers();
  }
});

it("starts signed out, without an error, when nothing saved is accepted", async () => {
  const { session } = keychain().plugin();
  await vi.waitFor(() =>
    expect(session.snapshot()).toEqual({ status: "signed-out" }),
  );
});

const b = {
  ...credential,
  value: "b",
  account: { ...credential.account, subject: "b" },
};
const ok = {
  status: 200,
  headers: {},
  body: JSON.stringify({ subject: "user", email: "a@example.com" }),
};

it("a restore held across a NIP-FI takeover never brings A back", async () => {
  const k = keychain("a");
  const held = deferred<void>();
  storage.gate = held.promise;
  const { session } = k.plugin();
  try {
    await vi.waitFor(() => expect(k.saved.current()?.value).toBe("a"));
    session.retire();
    held.resolve();
    await vi.waitFor(() => expect(k.store.value).toBeNull());
  } finally {
    storage.gate = undefined;
  }
  // Native B signing out later finds nothing to reselect.
  await new Promise((resolve) => setTimeout(resolve));
  expect(k.saved.current()).toBeUndefined();
  expect(session.snapshot()).toEqual({ status: "signed-out" });
  expect(() => session.credential()).toThrow("Sign in");
});

it("a browser sign-in held across a NIP-FI takeover saves nothing and is revoked", async () => {
  const k = keychain();
  const acquired = deferred<Saved>();
  const { session, release } = k.plugin(() => acquired.promise);
  await vi.waitFor(() => expect(session.snapshot().status).toBe("signed-out"));
  const signingIn = session.signIn();
  session.retire();
  acquired.resolve(as("a"));
  await signingIn;
  expect(k.store.save).not.toHaveBeenCalled();
  expect(k.store.value).toBeNull();
  expect(k.saved.current()).toBeUndefined();
  expect(session.snapshot().status).toBe("signed-out");
  await vi.waitFor(() =>
    expect(release).toHaveBeenCalledWith(
      expect.objectContaining({ value: "a" }),
    ),
  );
});

it("an A check held while Welcome saves B, then a delayed 401, keeps B saved across a restart", async () => {
  const k = keychain("a");
  const held = deferred<typeof ok>();
  k.host.request.mockImplementationOnce(() => held.promise);
  const { session } = k.plugin();
  await vi.waitFor(() => expect(k.host.request).toHaveBeenCalled());
  await k.saved.accept(
    b,
    vi.fn(async () => {}),
    new AbortController().signal,
  );
  // The plugin follows B although its restore of A was still pending.
  await vi.waitFor(() => expect(session.credential()).toBe(b));
  held.resolve({ ...ok, status: 401 });
  await vi.waitFor(() => expect(k.store.load).toHaveBeenCalledTimes(1));
  // Drains its queued writes, including the stale restore's fenced delete.
  await k.saved.dispose();
  expect(k.store.clear).not.toHaveBeenCalled();
  expect(k.store.value).toBe("b");
  const restarted = createOAuthSession(
    vi.fn(),
    vi.fn(),
    k.host,
    createSavedSignIn(k.store),
  );
  await vi.waitFor(() => expect(restarted.snapshot().status).toBe("signed-in"));
  expect(restarted.credential().value).toBe("b");
});

it("A, a denied delete at takeover, NIP-FI sign-out, then browser B: B stays saved", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const k = keychain("a");
    const { session } = k.plugin(async () => b);
    await vi.waitFor(() => expect(session.snapshot().status).toBe("signed-in"));
    k.store.clear.mockRejectedValueOnce(new Error("denied"));
    session.retire();
    await vi.waitFor(() => expect(k.saved.failed()).toBe(true));
    await session.signIn();
    expect(session.credential()).toBe(b);
    await vi.advanceTimersByTimeAsync(5000);
    expect(k.store.value).toBe("b");
    expect(session.credential()).toBe(b);
    expect(k.saved.failed()).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

it("a failed Welcome save settles after its revoke's first try, so Welcome can show a failed cleanup", async () => {
  const k = keychain();
  k.store.save.mockRejectedValueOnce(new Error("denied"));
  const revoke = vi.fn(async () => {
    throw new Error("offline");
  });
  await expect(
    k.saved.accept(as("w"), revoke, new AbortController().signal),
  ).rejects.toThrow("Could not save");
  expect(revoke).toHaveBeenCalledOnce();
  expect(k.saved.failed()).toBe(true);
  await k.saved.dispose();
});

it("shows a denied delete at once, without waiting on a slow revoke", async () => {
  const k = keychain("a");
  const slow = deferred<void>();
  const { session } = k.plugin();
  await vi.waitFor(() => expect(session.snapshot().status).toBe("signed-in"));
  k.host.request.mockImplementationOnce(async () => {
    await slow.promise;
    return { status: 200, headers: {}, body: "" };
  });
  k.store.clear.mockRejectedValueOnce(new Error("denied"));
  session.retire();
  await vi.waitFor(() => expect(k.saved.failed()).toBe(true));
  expect(session.snapshot().error).toMatch(/keeps trying/);
  slow.resolve();
  await k.saved.dispose();
});

it("after a relaunch, a revoked item whose delete is denied again is retried by the new owner", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const k = keychain("a");
    const { session } = k.plugin();
    await vi.waitFor(() => expect(session.snapshot().status).toBe("signed-in"));
    k.store.clear.mockRejectedValueOnce(new Error("denied"));
    session.retire();
    await vi.waitFor(() => expect(k.saved.failed()).toBe(true));
    await k.saved.dispose();
    // Relaunch: a fresh owner over the retained item, which Builderlab now
    // rejects; its delete is denied once more.
    expect(k.store.value).toBe("a");
    k.host.request.mockResolvedValue({ status: 401, headers: {}, body: "" });
    k.store.clear
      .mockRejectedValueOnce(new Error("denied"))
      .mockRejectedValueOnce(new Error("denied"));
    const saved = createSavedSignIn(k.store);
    const restarted = createOAuthSession(vi.fn(), vi.fn(), k.host, saved);
    await vi.waitFor(() =>
      expect(restarted.snapshot()).toEqual({
        status: "signed-out",
        error: expect.stringMatching(/keeps trying/),
      }),
    );
    expect(k.store.value).toBe("a");
    await vi.advanceTimersByTimeAsync(5000);
    expect(k.store.value).toBeNull();
    expect(saved.failed()).toBe(false);
    await saved.dispose();
  } finally {
    vi.useRealTimers();
  }
});
