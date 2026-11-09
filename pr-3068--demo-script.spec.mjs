// Demo recording for buzz-app#3068. NOT a test, never committed.
// DEMO_MODE=steer: turn_started -> turn_steered (same turnId) -> turn_completed.
// DEMO_MODE=cancel: today's cancel-and-reprompt: turn_started -> turn_completed
//   {outcome:"cancelled"} -> turn_started (new turnId) -> turn_completed.
import { test, expect } from "./fixture.mjs";
import { open, settle } from "./timeline.mjs";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import { mkdirSync, writeFileSync } from "node:fs";

const MODE = process.env.DEMO_MODE ?? "steer";
const OUT = process.env.DEMO_OUT ?? "/tmp/demo-3068";
const LABEL = process.env.DEMO_LABEL ?? MODE;
const SIZE = { width: 1280, height: 800 };

test.use({
  productionBroker: true,
  readState: true,
  historyCounts: { alpha: 1, beta: 1 },
  viewport: SIZE,
  video: { mode: "on", size: SIZE },
});

test("demo", async ({ page, app }) => {
  test.setTimeout(180_000);
  mkdirSync(OUT, { recursive: true });
  const marks = {};
  const t0 = Date.now();
  const mark = (name) => (marks[name] = (Date.now() - t0) / 1000);
  const key = generateSecretKey();
  const agent = getPublicKey(key);
  app.serveProfile(key, { name: "Remote agent", is_agent: true });
  await page.route("**/agent-library", (route) =>
    route.fulfill({
      json: {
        definitions: [],
        identities: [{ pubkey: agent, name: "Remote agent" }],
      },
    }),
  );
  await open(page, app);
  await expect.poll(() => app.relay.hasRoute("primary", "observer")).toBe(true);

  // Caption bar drawn over the real app so the recording explains each frame.
  const caption = (step) =>
    page.evaluate(
      ([label, step]) => {
        let bar = document.getElementById("demo-caption");
        if (!bar) {
          bar = document.createElement("div");
          bar.id = "demo-caption";
          bar.style.cssText =
            "position:fixed;left:0;right:0;bottom:0;z-index:2147483647;padding:10px 16px;" +
            "font:600 15px/1.35 -apple-system,system-ui,sans-serif;color:#fff;" +
            "background:rgba(20,20,28,.88);pointer-events:none;white-space:pre-line";
          document.body.appendChild(bar);
        }
        bar.textContent = `${label}\n${step}`;
      },
      [LABEL, step],
    );

  const now = () => Math.floor(Date.now() / 1000);
  const T1 = "task-A";
  const T2 = "task-B";
  let seq = 0;
  const frame = (turnId, kind, payload = {}) =>
    app.observer(
      {
        kind,
        seq: ++seq,
        payload,
        channelId: "alpha",
        sessionId: "demo-session",
        turnId,
        timestamp: new Date().toISOString(),
      },
      key,
    );
  let liveTurn;
  const pulse = setInterval(() => {
    if (liveTurn) frame(liveTurn, "turn_liveness");
  }, 3000);
  const shot = async (name) => {
    await settle(page).catch(() => {});
    await page.screenshot({ path: `${OUT}/${name}.png` });
  };

  await caption("Waiting for a mention…");
  await page.waitForTimeout(1500);
  mark("start");

  // 1. A user mentions the agent; the agent starts a turn for it.
  const first = app.append(
    "primary",
    "alpha",
    "@Remote agent summarize the release notes for 1.42",
    true,
    true,
    undefined,
    undefined,
    [["p", agent]],
    now(),
  );
  await page.waitForTimeout(600);
  frame(T1, "turn_started", { source: "mention", triggeringEventIds: [first.id] });
  liveTurn = T1;
  await caption(
    '1. First mention → agent publishes turn_started { turnId: "task-A", triggeringEventIds: [first] }',
  );
  const history = page.getByRole("region", { name: "Channel message history" });
  await expect(
    history.getByRole("button", { name: /View agent activity:/ }),
  ).toBeVisible();
  await page.waitForTimeout(3500);
  await shot("1-first-working");
  mark("first-working");

  // 2. Mid-turn, the same user mentions the agent again.
  // Steering joins only a mention that replies where the turn does: its thread.
  await page
    .locator(`[data-channel-timeline] [data-message-id="${first.id}"]`)
    .hover();
  await page
    .locator(`[data-channel-timeline] [data-message-id="${first.id}"]`)
    .getByRole("button", { name: "Reply", exact: true })
    .click();
  const panel = page.getByRole("complementary", { name: "Thread", exact: true });
  await expect(panel).toBeVisible();
  await page.mouse.move(0, 0);
  await page.waitForTimeout(1500);
  const second = app.append(
    "primary",
    "alpha",
    "@Remote agent also call out the breaking changes",
    true,
    true,
    first.id,
    undefined,
    [["p", agent]],
    now(),
  );
  app.threadSummary(first.id, [app.viewer], 1);
  await page.waitForTimeout(700);
  if (MODE === "steer") {
    frame(T1, "turn_steered", { source: "mention", triggeringEventIds: [second.id] });
    await caption(
      '2. Second mention in the thread, mid-turn → agent publishes turn_steered { turnId: "task-A", triggeringEventIds: [second] }',
    );
  } else {
    frame(T1, "turn_completed", { outcome: "cancelled" });
    await page.waitForTimeout(400);
    frame(T2, "turn_started", { source: "mention", triggeringEventIds: [second.id] });
    liveTurn = T2;
    await caption(
      '2. Second mention in the thread, mid-turn → today: turn_completed { turnId: "task-A", outcome: "cancelled" }, then turn_started { turnId: "task-B", triggeringEventIds: [second] }',
    );
  }
  mark("second");
  await page.waitForTimeout(4500);
  await shot("2-after-second-mention");

  // 3. The agent replies and finishes its turn.
  const reply = finalizeEvent(
    {
      kind: 9,
      content:
        "Release notes for 1.42: faster channel loading, new reminders panel, and agent activity in threads.\n\n**Breaking changes:** the legacy `/v1/agents` endpoint is removed, and plugins must declare `host` permissions.",
      tags: [
        ["h", "alpha"],
        ["e", first.id, "", "reply"],
      ],
      created_at: now(),
    },
    key,
  );
  app.histories.get("primary/alpha").push(reply);
  app.relay.publish("primary", reply);
  app.threadSummary(first.id, [app.viewer, agent], 2);
  await page.waitForTimeout(500);
  liveTurn = undefined;
  frame(MODE === "steer" ? T1 : T2, "turn_completed", {
    outcome: "completed",
  });
  await caption(
    MODE === "steer"
      ? '3. Agent replies → turn_completed { turnId: "task-A" }: both mentions end with the turn, neither shows Stopped'
      : '3. Agent replies → turn_completed { turnId: "task-B" }: the first mention still shows Stopped',
  );
  mark("done");
  await page.waitForTimeout(5000);
  await shot("3-done");
  clearInterval(pulse);
  writeFileSync(`${OUT}/marks.json`, JSON.stringify(marks, null, 2));
});
