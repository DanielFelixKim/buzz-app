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
  /** Keystrokes: wall ms per step, with React and other timed work in it. */
  phases?: Record<string, { ms: number; react: number; marked: number }>;
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
  flags: number;
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

  function attribute(
    kind: Attributed["kind"],
    span: Span,
    target?: string,
    phases?: Attributed["phases"],
  ) {
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
        ...(phases ? { phases } : {}),
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
      // Mounts have no alternate and are not counted. A subtree React skipped
      // keeps its old child fibers, whose alternates and flags are stale, so
      // descend only where the child list was rebuilt, and count a fiber only
      // when it performed work (PerformedWork, flag 1) in this render.
      const self = new Map<string, [number, number]>();
      const stack: Fiber[] = [current];
      let visited = 0;
      while (stack.length && visited < 200_000) {
        const fiber = stack.pop() as Fiber;
        visited++;
        const previous = fiber.alternate;
        if (previous && fiber !== current && fiber.flags & 1) {
          commit.fibers++;
          const name = fiberName(fiber);
          if (name) {
            const entry = self.get(name) ?? [0, 0];
            entry[0] += fiber.selfBaseDuration ?? 0;
            entry[1]++;
            self.set(name, entry);
          }
        }
        if (previous && previous.child === fiber.child) continue;
        for (let child = fiber.child; child; child = child.sibling)
          stack.push(child);
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
    type Hook = {
      onCommitFiberRoot?: (id: number, root: { current?: Fiber }) => unknown;
    };
    const global = globalThis as { __REACT_DEVTOOLS_GLOBAL_HOOK__?: Hook };
    const observe = (root: { current?: Fiber }) => {
      try {
        onCommit(root);
      } catch {
        /* Diagnostics never break rendering. */
      }
    };
    const existing = global.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    // React Refresh may have installed the hook already; observe through it.
    if (existing) {
      const previous = existing.onCommitFiberRoot;
      existing.onCommitFiberRoot = function (id, root) {
        observe(root);
        return previous?.call(this, id, root);
      };
      return;
    }
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
        observe(root);
      },
      onCommitFiberUnmount() {},
      onPostCommitFiberRoot() {},
      setStrictMode() {},
    } as Hook;
  }

  function composerTarget(event: Event) {
    const element = event.target as Element | null;
    if (element?.closest?.("[data-lag-control]")) return "control";
    const box = element?.closest?.('[role="textbox"]');
    if (!box) return "other";
    const label = box.getAttribute("aria-label") ?? "";
    if (label.startsWith("Reply to thread")) return "thread";
    if (label.startsWith("Message ")) return "channel";
    if (label.startsWith("Edit message")) return "edit";
    return "composer";
  }

  /** Splits a keystroke's wall time into the steps the main thread ran:
   *  wait     key event created → first keydown listener (thread was busy)
   *  handlers keydown/keypress/beforeinput/input dispatch and their
   *           microtasks: the editor's work, plus React when it flushes there
   *  between  handlers done → the next frame starts: other tasks, scheduled
   *           React renders and the wait for the display's next frame
   *  layout   style and layout, forced at the start of that frame
   *  paint    the rest of the frame (other frame callbacks, paint) until the
   *           next task runs
   * React and timed marks overlapping each step are reported beside it. */
  type Phase = "wait" | "handlers" | "between" | "layout" | "paint";
  const PHASES: Phase[] = ["wait", "handlers", "between", "layout", "paint"];
  type KeyTiming = {
    start: number;
    listened: number;
    handled: number;
    frame?: number;
    laidOut?: number;
    target: string;
  };
  let pending: KeyTiming | undefined;

  function overlapMs<T extends Span>(list: T[], from: number, to: number) {
    let total = 0;
    for (const item of list) {
      const start = Math.max(item.at, from);
      const end = Math.min(item.at + item.ms, to);
      if (end > start) total += end - start;
    }
    return total;
  }

  function phasesOf(key: KeyTiming, end: number) {
    const frame = key.frame ?? end;
    const laidOut = key.laidOut ?? frame;
    const bounds: Record<Phase, [number, number]> = {
      wait: [key.start, key.listened],
      handlers: [key.listened, key.handled],
      between: [key.handled, frame],
      layout: [frame, laidOut],
      paint: [laidOut, end],
    };
    const result = {} as Record<
      Phase,
      { ms: number; react: number; marked: number }
    >;
    for (const phase of PHASES) {
      const [from, to] = bounds[phase];
      const ms = Math.max(0, to - from);
      const commitMarks = commits;
      const otherMarks = marks.filter((item) => item.source !== "react.commit");
      result[phase] = {
        ms: round(ms),
        react: round(overlapMs(commitMarks, from, to)),
        marked: round(overlapMs(otherMarks, from, to)),
      };
    }
    return result;
  }

  const keyPhases: (Record<
    Phase,
    { ms: number; react: number; marked: number }
  > & {
    target: string;
    total: number;
  })[] = [];

  function startKeyTiming() {
    const handledNow = () => {
      const key = pending;
      if (!key || key.frame !== undefined) return;
      queueMicrotask(() => {
        if (pending === key && key.frame === undefined)
          key.handled = performance.now();
      });
    };
    // First listener on the way in: the key has reached the main thread.
    window.addEventListener(
      "keydown",
      (event) => {
        const listened = performance.now();
        const key: KeyTiming = {
          start: event.timeStamp,
          listened,
          handled: listened,
          target: composerTarget(event),
        };
        pending = key;
        requestAnimationFrame(() => {
          key.frame = performance.now();
          // Forces this frame's style and layout now, so they are timed.
          void document.documentElement.getBoundingClientRect();
          key.laidOut = performance.now();
          setTimeout(() => {
            const end = performance.now();
            if (pending === key) pending = undefined;
            const total = end - key.start;
            const span = { at: key.start, ms: total, target: key.target };
            push(keys, span, 20_000);
            const phases = phasesOf(key, end);
            push(
              keyPhases,
              { ...phases, target: key.target, total: round(total) },
              20_000,
            );
            if (total >= SLOW_KEY_MS)
              attribute("key", span, key.target, phases);
          }, 0);
        });
      },
      true,
    );
    // Last listeners on the way out of each input event of this keystroke.
    for (const type of ["keydown", "keypress", "beforeinput", "input"])
      window.addEventListener(type, handledNow, false);
  }

  /** A plain text box outside React, ProseMirror and app state. If it hitches
   * too, the main thread is busy with something else; if only the composer
   * does, the composer's own work is slow. Hide with its ×; bring it back
   * with __buzzLag.control(true). */
  function control(show: boolean) {
    const existing = document.querySelector("[data-lag-control]");
    if (!show) {
      existing?.remove();
      return;
    }
    if (existing) return;
    const box = document.createElement("div");
    box.setAttribute("data-lag-control", "");
    box.style.cssText =
      "position:fixed;left:8px;bottom:8px;z-index:2147483647;display:flex;" +
      "gap:4px;align-items:flex-start;padding:4px;border-radius:6px;" +
      "background:rgba(255,200,0,.85);font:12px system-ui;color:#000";
    const input = document.createElement("textarea");
    input.placeholder = "lag control: type here too";
    input.rows = 2;
    input.spellcheck = false;
    input.style.cssText =
      "width:200px;resize:none;font:12px system-ui;border:0;border-radius:4px;padding:4px";
    const close = document.createElement("button");
    close.textContent = "×";
    close.title = "Hide (bring back with __buzzLag.control(true))";
    close.style.cssText =
      "border:0;background:none;cursor:pointer;font:14px system-ui";
    close.onclick = () => box.remove();
    box.append(input, close);
    document.body.append(box);
  }

  function startMonitors() {
    startKeyTiming();
    if (document.body) control(true);
    else
      document.addEventListener("DOMContentLoaded", () => control(true), {
        once: true,
      });
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

  /** Per input: where keystroke time went, for all keys and for slow ones.
   * Each phase gives p50/p90 ms and its share of the summed wall time, with
   * how much of it React commits and timed marks covered. */
  function phaseSummary() {
    const groups = new Map<string, typeof keyPhases>();
    for (const key of keyPhases) {
      for (const name of [key.target, `${key.target}:slow`]) {
        if (name.endsWith(":slow") && key.total < SLOW_KEY_MS) continue;
        const list = groups.get(name) ?? [];
        list.push(key);
        groups.set(name, list);
      }
    }
    return Object.fromEntries(
      [...groups].map(([name, list]) => {
        const total = list.reduce((sum, key) => sum + key.total, 0) || 1;
        return [
          name,
          {
            n: list.length,
            ...Object.fromEntries(
              PHASES.map((phase) => {
                const values = list.map((key) => key[phase].ms);
                const sum = values.reduce((a, b) => a + b, 0);
                const { p50, p90 } = percentiles(values);
                return [
                  phase,
                  {
                    p50,
                    p90,
                    share: round((sum / total) * 100),
                    react: round(
                      list.reduce((a, key) => a + key[phase].react, 0) /
                        list.length,
                    ),
                    marked: round(
                      list.reduce((a, key) => a + key[phase].marked, 0) /
                        list.length,
                    ),
                  },
                ];
              }),
            ),
          },
        ];
      }),
    );
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
      phases: phaseSummary(),
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
    control: (show = true) => {
      if (enabled) control(show);
    },
  });
}

export type LagRecorder = ReturnType<typeof createLagRecorder>;

/** Development builds only; production and unit tests get a no-op recorder. */
export const lagRecorder = createLagRecorder(
  import.meta.env?.DEV === true && import.meta.env?.MODE !== "test",
);
if (lagRecorder.enabled)
  (globalThis as { __buzzLag?: LagRecorder }).__buzzLag = lagRecorder;
