/** Development-only main-thread lag recorder.
 *
 * Answers "what was the main thread doing while typing felt slow?" with
 * aggregate evidence, never message content: keystroke-to-paint latency by
 * composer, event-loop stalls, React commit costs with their slowest
 * components, and timed work marks from the relay, activity, presence, typing
 * and view-storage paths. Each slow keystroke or stall keeps the marks and
 * commits that overlapped it. Production builds and unit tests get a no-op.
 *
 * The dev server loads it before the app (scripts/lag-log.ts): it installs a
 * minimal React DevTools hook so development builds report each commit's
 * fiber timings, and it posts a report every 15 seconds. */

type Mark = { at: number; ms: number; source: string; detail?: string };
type Commit = {
  at: number;
  ms: number;
  fibers: number;
  top?: [string, number, number][];
};
type Span = { at: number; ms: number };
type Attributed = Span & {
  kind: "key" | "stall";
  target?: string;
  marks: Record<string, { n: number; ms: number; detail?: string }>;
  commits: { n: number; ms: number; top: [string, number, number][] };
};

const MARK_LIMIT = 20_000;
const COMMIT_LIMIT = 5_000;
const ATTRIBUTED_LIMIT = 1_000;
const SLOW_KEY_MS = 50;
const STALL_MS = 50;
const SLOW_COMMIT_MS = 8;
const FLUSH_MS = 15_000;

const push = <T>(list: T[], value: T, limit: number) => {
  list.push(value);
  if (list.length > limit) list.splice(0, list.length - limit);
};
const round = (ms: number) => Math.round(ms * 10) / 10;

function percentiles(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) =>
    sorted.length
      ? round(
          sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ??
            0,
        )
      : undefined;
  return {
    n: sorted.length,
    p50: at(0.5),
    p90: at(0.9),
    p99: at(0.99),
    max: sorted.length ? round(sorted.at(-1) ?? 0) : undefined,
  };
}

type Fiber = {
  type: unknown;
  child: Fiber | null;
  sibling: Fiber | null;
  alternate: Fiber | null;
  memoizedProps: unknown;
  memoizedState: unknown;
  actualDuration?: number;
  selfBaseDuration?: number;
};
type Named = {
  displayName?: string;
  name?: string;
  render?: { displayName?: string; name?: string };
  type?: { displayName?: string; name?: string };
};

function fiberName(fiber: Fiber): string | undefined {
  const type = fiber.type as Named | null;
  if (!type || (typeof type !== "object" && typeof type !== "function"))
    return undefined;
  return (
    type.displayName ||
    type.name ||
    type.render?.displayName ||
    type.render?.name ||
    type.type?.displayName ||
    type.type?.name ||
    undefined
  );
}

function createLagRecorder(enabled: boolean) {
  const marks: Mark[] = [];
  const commits: Commit[] = [];
  const keys: (Span & { target: string })[] = [];
  const stalls: Span[] = [];
  const attributed: Attributed[] = [];
  const totals = new Map<string, { n: number; ms: number }>();
  const startedAt = Date.now();
  let lastFlush = 0;

  function mark(source: string, ms: number, detail?: string) {
    if (!enabled) return;
    const at = performance.now() - ms;
    push(marks, { at, ms, source, ...(detail ? { detail } : {}) }, MARK_LIMIT);
    const total = totals.get(source) ?? { n: 0, ms: 0 };
    total.n++;
    total.ms += ms;
    totals.set(source, total);
  }
  /** Times synchronous work and returns its result. */
  function time<T>(source: string, work: () => T, detail?: string): T {
    if (!enabled) return work();
    const started = performance.now();
    try {
      return work();
    } finally {
      mark(source, performance.now() - started, detail);
    }
  }

  function attribute(kind: Attributed["kind"], span: Span, target?: string) {
    const from = span.at;
    const to = span.at + span.ms;
    const overlapping = <T extends Span>(list: T[]) =>
      list.filter((item) => item.at < to && item.at + item.ms > from);
    const byMark: Attributed["marks"] = {};
    for (const item of overlapping(marks)) {
      const entry = byMark[item.source] ?? { n: 0, ms: 0 };
      byMark[item.source] = entry;
      entry.n++;
      entry.ms = round(entry.ms + item.ms);
      if (item.detail && !entry.detail) entry.detail = item.detail;
    }
    const inSpan = overlapping(commits);
    const components = new Map<string, [number, number]>();
    for (const commit of inSpan)
      for (const [name, ms, n] of commit.top ?? []) {
        const entry = components.get(name) ?? [0, 0];
        entry[0] += ms;
        entry[1] += n;
        components.set(name, entry);
      }
    push(
      attributed,
      {
        kind,
        at: round(span.at),
        ms: round(span.ms),
        ...(target ? { target } : {}),
        marks: byMark,
        commits: {
          n: inSpan.length,
          ms: round(inSpan.reduce((sum, commit) => sum + commit.ms, 0)),
          top: [...components]
            .sort((a, b) => b[1][0] - a[1][0])
            .slice(0, 12)
            .map(([name, [ms, n]]) => [name, round(ms), n]),
        },
      },
      ATTRIBUTED_LIMIT,
    );
  }

  function onCommit(root: { current?: Fiber }) {
    const current = root.current;
    const ms = current?.actualDuration;
    if (!current || typeof ms !== "number") return;
    const commit: Commit = {
      at: performance.now() - ms,
      ms: round(ms),
      fibers: 0,
    };
    if (ms >= SLOW_COMMIT_MS) {
      // Fibers that re-rendered in this commit, by component, with self time.
      // Mounts have no alternate and are not counted.
      const self = new Map<string, [number, number]>();
      const stack: Fiber[] = current.child ? [current.child] : [];
      let visited = 0;
      while (stack.length && visited < 200_000) {
        const fiber = stack.pop() as Fiber;
        visited++;
        const previous = fiber.alternate;
        if (
          previous &&
          (fiber.memoizedProps !== previous.memoizedProps ||
            fiber.memoizedState !== previous.memoizedState)
        ) {
          commit.fibers++;
          const name = fiberName(fiber);
          if (name) {
            const entry = self.get(name) ?? [0, 0];
            entry[0] += fiber.selfBaseDuration ?? 0;
            entry[1]++;
            self.set(name, entry);
          }
        }
        if (fiber.sibling) stack.push(fiber.sibling);
        if (fiber.child) stack.push(fiber.child);
      }
      commit.top = [...self]
        .sort((a, b) => b[1][0] - a[1][0])
        .slice(0, 15)
        .map(([name, [ms, n]]) => [name, round(ms), n]);
    }
    push(commits, commit, COMMIT_LIMIT);
    mark("react.commit", ms);
  }

  function installReactHook() {
    const global = globalThis as { __REACT_DEVTOOLS_GLOBAL_HOOK__?: unknown };
    if (global.__REACT_DEVTOOLS_GLOBAL_HOOK__) return;
    let id = 0;
    global.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      supportsFiber: true,
      renderers: new Map(),
      isDisabled: false,
      checkDCE() {},
      inject() {
        return ++id;
      },
      onScheduleFiberRoot() {},
      onCommitFiberRoot(_id: number, root: { current?: Fiber }) {
        try {
          onCommit(root);
        } catch {
          /* Diagnostics never break rendering. */
        }
      },
      onCommitFiberUnmount() {},
      onPostCommitFiberRoot() {},
      setStrictMode() {},
    };
  }

  function composerTarget(event: Event) {
    const element = event.target as Element | null;
    const box = element?.closest?.('[role="textbox"]');
    if (!box) return "other";
    const label = box.getAttribute("aria-label") ?? "";
    if (label.startsWith("Reply to thread")) return "thread";
    if (label.startsWith("Message ")) return "channel";
    if (label.startsWith("Edit message")) return "edit";
    return "composer";
  }

  function startMonitors() {
    // Keystroke to the task after the next frame: a paint opportunity.
    window.addEventListener(
      "keydown",
      (event) => {
        const start = event.timeStamp;
        const target = composerTarget(event);
        requestAnimationFrame(() =>
          setTimeout(() => {
            const span = { at: start, ms: performance.now() - start, target };
            push(keys, span, 20_000);
            if (span.ms >= SLOW_KEY_MS) attribute("key", span, target);
          }, 0),
        );
      },
      true,
    );
    // Event-loop stalls; WebKit has no long-task entries.
    let expected = performance.now() + STALL_MS;
    document.addEventListener("visibilitychange", () => {
      expected = performance.now() + STALL_MS;
    });
    setInterval(() => {
      const now = performance.now();
      const lag = now - expected;
      if (lag >= STALL_MS && !document.hidden) {
        const span = { at: expected, ms: lag };
        push(stalls, span, 20_000);
        attribute("stall", span);
      }
      expected = now + STALL_MS;
      if (now - lastFlush > FLUSH_MS) {
        lastFlush = now;
        flush();
      }
    }, STALL_MS);
  }

  function summary() {
    const byTarget = new Map<string, number[]>();
    for (const key of keys) {
      const list = byTarget.get(key.target) ?? [];
      list.push(key.ms);
      byTarget.set(key.target, list);
    }
    const minutes = Math.max((Date.now() - startedAt) / 60_000, 1 / 60);
    const blamed = new Map<string, { n: number; ms: number }>();
    for (const item of attributed)
      for (const [source, { ms }] of Object.entries(item.marks)) {
        const entry = blamed.get(source) ?? { n: 0, ms: 0 };
        entry.n++;
        entry.ms = round(entry.ms + ms);
        blamed.set(source, entry);
      }
    const components = new Map<string, [number, number]>();
    for (const commit of commits)
      for (const [name, ms, n] of commit.top ?? []) {
        const entry = components.get(name) ?? [0, 0];
        entry[0] += ms;
        entry[1] += n;
        components.set(name, entry);
      }
    return {
      minutes: round(minutes),
      keys: Object.fromEntries(
        [...byTarget].map(([target, values]) => [target, percentiles(values)]),
      ),
      stalls: percentiles(stalls.map((stall) => stall.ms)),
      commits: {
        ...percentiles(commits.map((commit) => commit.ms)),
        slow: commits.filter((commit) => commit.ms >= SLOW_COMMIT_MS).length,
      },
      /** Every timed source: count and ms per minute. */
      rates: Object.fromEntries(
        [...totals]
          .sort((a, b) => b[1].ms - a[1].ms)
          .map(([source, { n, ms }]) => [
            source,
            { perMin: round(n / minutes), msPerMin: round(ms / minutes) },
          ]),
      ),
      /** Sources present during slow keys and stalls, by overlapping ms. */
      blamed: Object.fromEntries([...blamed].sort((a, b) => b[1].ms - a[1].ms)),
      /** Components in slow commits, by total self ms. */
      components: [...components]
        .sort((a, b) => b[1][0] - a[1][0])
        .slice(0, 30)
        .map(([name, [ms, n]]) => [name, round(ms), n]),
    };
  }

  function exported() {
    return {
      version: 1,
      startedAt: new Date(startedAt).toISOString(),
      exportedAt: new Date().toISOString(),
      userAgent: navigator.userAgent,
      summary: summary(),
      slowest: [...attributed].sort((a, b) => b.ms - a.ms).slice(0, 60),
      recent: attributed.slice(-200),
    };
  }

  /** The dev server writes it to .profiles/lag/ (scripts/lag-log.ts). */
  function flush() {
    if (!attributed.length && !keys.length) return;
    void fetch("/__buzz-lag", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(exported()),
    }).catch(() => {});
  }

  if (enabled) {
    installReactHook();
    if (typeof window !== "undefined" && typeof document !== "undefined")
      startMonitors();
  }

  return Object.freeze({
    enabled,
    mark,
    time,
    summary,
    export: exported,
    flush,
  });
}

export type LagRecorder = ReturnType<typeof createLagRecorder>;

/** Development builds only; production and unit tests get a no-op recorder. */
export const lagRecorder = createLagRecorder(
  import.meta.env?.DEV === true && import.meta.env?.MODE !== "test",
);
if (lagRecorder.enabled)
  (globalThis as { __buzzLag?: LagRecorder }).__buzzLag = lagRecorder;
