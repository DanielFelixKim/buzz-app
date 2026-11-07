import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDoctor } from "./doctor";
import { doctorFixture, deferred } from "./doctor-testing";
import { ReadError } from "./errors";

const fixtures: ReturnType<typeof doctorFixture>[] = [];
const setup = (options?: Parameters<typeof doctorFixture>[0]) => {
  const fixture = doctorFixture(options);
  fixtures.push(fixture);
  return { ...fixture, doctor: createDoctor(fixture.relay) };
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5);
});
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.owner.dispose();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const offline = () =>
  new ReadError("unavailable", "Community unavailable", 503);

it("does not start idle inventory or preference reads when retrying an unrelated issue", async () => {
  const h = setup();
  h.failures.set(30622, new ReadError("denied", "Visibility refused", 403));
  await h.session.channelLifecycle.refreshVisibility();
  h.failures.clear();
  await h.doctor.retry();
  expect(h.count(30175)).toBe(0);
  expect(h.count(30078)).toBe(0);
});

it("sequences finite source retries and ignores repeated individual or combined actions during the batch", async () => {
  const h = setup();
  for (const kind of [30622, 30078])
    h.failures.set(kind, new ReadError("denied", "Read refused", 403));
  await Promise.all([
    h.session.sidebarPreferences.refresh(),
    h.session.channelLifecycle.refreshVisibility(),
  ]);
  const sidebarStarted = deferred<void>();
  const sidebar = deferred<[]>();
  const visibilityStarted = deferred<void>();
  const visibility = deferred<[]>();
  const order: number[] = [];
  h.query.mockImplementation(async (filters) => {
    const kind = filters[0]?.kinds?.[0];
    if (kind === 30078) {
      order.push(kind);
      sidebarStarted.resolve();
      await sidebar.promise;
      throw new ReadError("denied", "Sidebar still refused", 403);
    }
    if (kind === 30622) {
      order.push(kind);
      visibilityStarted.resolve();
      return visibility.promise;
    }
    return [];
  });
  const retry = h.doctor.retry();
  try {
    await sidebarStarted.promise;
    expect(h.doctor.snapshot().busy).toBe(true);
    expect(
      h.doctor
        .snapshot()
        .issues.filter((issue) => issue.busy)
        .map((issue) => issue.id),
    ).toEqual(["sidebar"]);
    await h.doctor.retry();
    await h.doctor.retry("visibility");
    expect(order).toEqual([30078]);
    sidebar.resolve([]);
    await visibilityStarted.promise;
    expect(order).toEqual([30078, 30622]);
    expect(
      h.doctor.snapshot().issues.find((issue) => issue.id === "sidebar"),
    ).toMatchObject({ busy: false, failure: 1 });
    expect(h.doctor.snapshot().busy).toBe(true);
    expect(
      h.doctor
        .snapshot()
        .issues.filter((issue) => issue.busy)
        .map((issue) => issue.id),
    ).toEqual(["visibility"]);
  } finally {
    sidebar.resolve([]);
    visibility.resolve([]);
    await retry;
  }
  expect(h.doctor.snapshot().issues.map((issue) => issue.id)).toEqual([
    "sidebar",
  ]);
});

it("keeps a connection incident while its session is replaced by a pending reconnect", () => {
  const h = setup(),
    next = setup();
  h.setConnection({ status: "error", error: "Connection unavailable" });
  expect(h.doctor.snapshot().issues[0]?.id).toBe("connection");
  h.setConnection({
    status: "connecting",
    session: next.session,
    generation: 1,
  });
  expect(h.doctor.snapshot()).toMatchObject({
    checking: true,
    issues: [
      expect.objectContaining({ id: "connection", busy: true, quiet: false }),
    ],
  });
  h.setConnection({ status: "ready" });
  expect(h.doctor.snapshot()).toMatchObject({ checking: false, issues: [] });
});

it("does not expose or retry a known account/community outside the Doctor's visible scope", async () => {
  const h = setup();
  const scoped = createDoctor(
    h.relay,
    h.relay.snapshot().viewer,
    "https://other.example",
  );
  h.setConnection({ status: "error", error: "Private community refusal" });
  expect(scoped.snapshot().issues).toEqual([]);
  await scoped.retry();
  expect(h.relay.retry).not.toHaveBeenCalled();
});

it("shows a delayed notice even when the first retry is still pending", async () => {
  const h = setup();
  h.failures.set(30078, offline());
  await h.session.sidebarPreferences.refresh();
  expect(h.doctor.snapshot().issues[0]?.quiet).toBe(true);
  let release!: (events: []) => void, started!: () => void;
  const reading = new Promise<void>((resolve) => {
    started = resolve;
  });
  h.query.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
        started();
      }),
  );
  const pending = h.session.sidebarPreferences.refresh();
  await reading;
  try {
    await vi.advanceTimersByTimeAsync(3_000);
    expect(h.doctor.snapshot().issues).toEqual([
      expect.objectContaining({ id: "sidebar", busy: true, quiet: false }),
    ]);
  } finally {
    release([]);
    await pending;
  }
});

it("makes one fresh attempt if an inventory read already pending at Retry settles with an old failure", async () => {
  const h = setup();
  h.failures.set(30622, new ReadError("denied", "Visibility refused", 403));
  await h.session.channelLifecycle.refreshVisibility();
  let reject!: (error: unknown) => void, started!: () => void;
  const reading = new Promise<void>((resolve) => {
    started = resolve;
  });
  h.query.mockImplementationOnce(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
        started();
      }),
  );
  const inventory = h.session.agentChoices.refresh();
  await reading;
  h.failures.clear();
  const retry = h.doctor.retry();
  reject(new ReadError("denied", "Read started before Retry", 403));
  await Promise.all([inventory, retry]);
  expect(h.session.agentChoices.snapshot().complete).toBe(true);
  expect(h.doctor.snapshot().issues).toEqual([]);
  expect(h.count(30175)).toBe(2);
});

it("one Retry covers exhausted visibility, partial inventory and sidebar reads, retaining issues while pending", async () => {
  const h = setup();
  for (const kind of [30622, 30175, 30078]) h.failures.set(kind, offline());
  const reads = Promise.all([
    h.session.channelLifecycle.refreshVisibility(),
    h.session.agentChoices.refresh(),
    h.session.sidebarPreferences.refresh(),
  ]);
  await vi.advanceTimersByTimeAsync(6_000);
  await reads;
  expect(
    h.doctor
      .snapshot()
      .issues.map((issue) => issue.id)
      .sort(),
  ).toEqual(["agents", "sidebar", "visibility"]);
  expect(h.session.agentChoices.snapshot().selectable).toHaveLength(1);
  h.failures.clear();
  const retry = h.doctor.retry();
  expect(h.doctor.snapshot().issues).toHaveLength(3);
  expect(h.doctor.snapshot().busy).toBe(true);
  expect(
    h.doctor
      .snapshot()
      .issues.filter((issue) => issue.busy)
      .map((issue) => issue.id),
  ).toEqual(["sidebar"]);
  await retry;
  expect(h.session.channelLifecycle.snapshot().status).toBe("ready");
  expect(h.session.agentChoices.snapshot().complete).toBe(true);
  expect(h.session.sidebarPreferences.snapshot().status).toBe("ready");
  expect(h.doctor.snapshot().issues).toEqual([]);
  expect(h.count(30622)).toBe(5);
  expect(h.count(30175)).toBe(5);
  expect(h.sign).not.toHaveBeenCalled();
  expect(h.publish).not.toHaveBeenCalled();
});

it("refreshes a failed Solo projection after its unchanged empty catalog recovers", async () => {
  const h = setup({ kit: true });
  h.failures.set(30078, offline());
  await h.session.soloPreferences.refresh();
  expect(h.doctor.snapshot().issues.map((issue) => issue.id)).toEqual([
    "catalog",
    "workspaces",
  ]);
  h.failures.clear();
  await h.doctor.retry();
  expect(h.session.channelKit.snapshot().status).toBe("ready");
  expect(h.session.soloPreferences.snapshot().status).toBe("ready");
  expect(h.doctor.snapshot().issues).toEqual([]);
  expect(h.count(30078)).toBe(2);
  expect(h.sign).not.toHaveBeenCalled();
  expect(h.publish).not.toHaveBeenCalled();
});

it("keeps an unrelated denial and partial local inventory visible when other reads recover", async () => {
  const h = setup();
  h.failures.set(
    30175,
    new ReadError("denied", "Inventory requires permission", 403),
  );
  h.failures.set(30078, offline());
  await Promise.all([
    h.session.agentChoices.refresh(),
    h.session.sidebarPreferences.refresh(),
  ]);
  expect(h.doctor.snapshot().issues.map((issue) => issue.id)).toEqual([
    "sidebar",
    "agents",
  ]);
  h.failures.delete(30078);
  await h.doctor.retry();
  expect(h.doctor.snapshot().issues.map((issue) => issue.id)).toEqual([
    "agents",
  ]);
  expect(h.session.agentChoices.snapshot().selectable).toHaveLength(1);
  expect(h.session.recovery?.snapshot().recovering).toBe(false);
});

it("retains every live rejection, including a refusal alongside transient and pending routes", () => {
  const h = setup();
  const live = {
    ...h.session.live,
    snapshot: () => ({
      status: "connected" as const,
      roster: { state: "verified" as const },
      heads: [],
      routes: [
        {
          id: "a",
          status: "error" as const,
          replay: "unknown" as const,
          error: "restricted: permission required",
        },
        {
          id: "b",
          status: "error" as const,
          replay: "unknown" as const,
          error: "Temporary failure",
        },
        { id: "c", status: "pending" as const, replay: "unknown" as const },
      ],
    }),
  };
  h.setConnection({ session: { ...h.session, live } });
  expect(h.doctor.snapshot().issues).toEqual([
    expect.objectContaining({
      id: "live",
      quiet: false,
      busy: false,
      details: ["restricted: permission required", "Temporary failure"],
    }),
  ]);
});

it("rebinds subscriptions on session replacement and releases all of them on unmount", async () => {
  const h = setup(),
    next = setup();
  const listener = vi.fn();
  const stop = h.doctor.subscribe(listener);
  h.setConnection({ session: next.session, generation: 1 });
  expect(h.doctor.snapshot().session).toBe(next.session);
  listener.mockClear();
  next.failures.set(30622, new ReadError("denied", "No permission", 403));
  await next.session.channelLifecycle.refreshVisibility();
  expect(listener).toHaveBeenCalled();
  expect(h.doctor.snapshot().issues.map((issue) => issue.id)).toEqual([
    "visibility",
  ]);
  stop();
  listener.mockClear();
  next.failures.clear();
  await next.session.channelLifecycle.refreshVisibility();
  expect(listener).not.toHaveBeenCalled();
});

it("does not retry a retired session's workspace projection after a held catalog read finishes", async () => {
  const h = setup({ kit: true }),
    next = setup();
  h.failures.set(30078, offline());
  await h.session.soloPreferences.refresh();
  h.doctor.snapshot();
  let release!: (events: []) => void;
  let started!: () => void;
  const reading = new Promise<void>((resolve) => {
    started = resolve;
  });
  h.query.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
        started();
      }),
  );
  const retry = h.doctor.retry();
  await reading;
  h.setConnection({ session: next.session, generation: 1 });
  expect(h.doctor.snapshot().busy).toBe(false);
  release([]);
  await retry;
  expect(h.session.soloPreferences.snapshot().status).toBe("error");
});
