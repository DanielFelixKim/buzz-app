import { openPage } from "./navigation.mjs";
import { test, expect } from "./fixture.mjs";

test.use({
  productionBroker: true,
  channelLifecycle: true,
  pluginFixtures: true,
  historyCounts: { alpha: 1, beta: 1 },
});

// Real read owners and native button animations must work together after the
// temporary Developer simulation is removed. Deferred requests expose the queue.
test("Doctor disables the queue and shakes each failed row before the batch ends", async ({
  page,
  app,
}, testInfo) => {
  await page.emulateMedia({
    colorScheme: "dark",
    reducedMotion: "no-preference",
  });
  await page.goto(app.origin);
  await openPage(page, "Messages");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const session = window.fixtureRelay.snapshot().session;
        return [
          session.live.snapshot().status,
          session.sidebarPreferences.snapshot().status,
          session.channelLifecycle.snapshot().status,
        ];
      }),
    )
    .toEqual(["connected", "ready", "ready"]);
  const gates = () => ({
    sidebar: {
      started: Promise.withResolvers(),
      done: Promise.withResolvers(),
    },
    visibility: {
      started: Promise.withResolvers(),
      done: Promise.withResolvers(),
    },
  });
  let pending = gates();
  let held = false;
  let failing = true;
  const order = [];
  await page.route("**/api/relay/**/query", async (route) => {
    const filters = route.request().postDataJSON();
    const source = filters.some((filter) => filter.kinds?.includes(30622))
      ? "visibility"
      : filters.some((filter) => filter["#d"]?.includes("channel-sections"))
        ? "sidebar"
        : undefined;
    if (!source || !failing) return route.continue();
    if (held) {
      order.push(source);
      pending[source].started.resolve();
      await pending[source].done.promise;
    }
    app.report.sidebarActivityFailures ??= [];
    app.report.sidebarActivityFailures.push(route.request().url());
    return route.fulfill({ status: 403, json: { error: "Read refused" } });
  });
  await page.evaluate(async () => {
    const session = window.fixtureRelay.snapshot().session;
    await Promise.all([
      session.sidebarPreferences.refresh(),
      session.channelLifecycle.refreshVisibility(),
    ]);
  });
  const toast = page.getByRole("dialog", {
    name: "Buzz is having issues",
    exact: true,
  });
  await expect(toast).toBeVisible();
  await toast.screenshot({
    path: testInfo.outputPath("doctor-toast-dark.png"),
  });
  await toast.getByRole("button", { name: "View issues", exact: true }).click();
  const doctor = page.getByRole("dialog", { name: "Buzz Doctor", exact: true });
  const all = doctor.getByRole("button", { name: "Retry all", exact: true });
  const sidebar = doctor.getByRole("button", {
    name: "Retry sidebar preferences",
    exact: true,
  });
  const visibility = doctor.getByRole("button", {
    name: "Retry hidden conversations",
    exact: true,
  });
  for (const control of [sidebar, visibility, all])
    await control.evaluate((button) => {
      const animate = button.animate.bind(button);
      button.animate = (...args) => {
        const animation = animate(...args);
        button.doctorAnimation = animation;
        button.dataset.observedFeedback = String(
          Number(button.dataset.observedFeedback ?? 0) + 1,
        );
        return animation;
      };
    });
  held = true;
  try {
    await sidebar.click();
    await pending.sidebar.started.promise;
    await expect(all).toBeDisabled();
    await expect(all).not.toHaveAttribute("data-loading", "true");
    await expect(visibility).toBeDisabled();
    await expect(sidebar).toHaveAttribute("data-loading", "true");
    await doctor.screenshot({
      path: testInfo.outputPath("doctor-individual-retry-dark.png"),
    });
    pending.sidebar.done.resolve();
    await expect(sidebar).toHaveAttribute("data-observed-feedback", "1");
    await expect(all).toBeEnabled();
    pending = gates();
    order.length = 0;
    await all.click();
    await pending.sidebar.started.promise;
    for (const control of [all, sidebar, visibility])
      await expect(control).toBeDisabled();
    await expect(all).toHaveAttribute("data-loading", "true");
    await expect(sidebar).toHaveAttribute("data-loading", "true");
    await expect(visibility).not.toHaveAttribute("data-loading", "true");
    await doctor.screenshot({
      path: testInfo.outputPath("doctor-retry-all-dark.png"),
    });
    pending.sidebar.done.resolve();
    await pending.visibility.started.promise;
    await expect(sidebar).toHaveAttribute("data-observed-feedback", "2");
    await expect(sidebar).toBeDisabled();
    await expect(sidebar).not.toHaveAttribute("data-loading", "true");
    await expect(visibility).toHaveAttribute("data-loading", "true");
    expect(order).toEqual(["sidebar", "visibility"]);
    // Capture a native app-generated shake frame; resume playback afterwards.
    await sidebar.evaluate((button) => {
      button.doctorAnimation.pause();
      button.doctorAnimation.currentTime = 55;
    });
    await doctor.screenshot({
      path: testInfo.outputPath("doctor-failed-row-dark.png"),
    });
    await sidebar.evaluate((button) => button.doctorAnimation.play());
    await expect(all).not.toHaveAttribute("data-observed-feedback", "1");
    pending.visibility.done.resolve();
    await expect(visibility).toHaveAttribute("data-observed-feedback", "1");
    await expect(all).toHaveAttribute("data-observed-feedback", "1");
    await expect(all).toBeEnabled();
  } finally {
    pending.sidebar.done.resolve();
    pending.visibility.done.resolve();
    held = false;
  }
  failing = false;
  await all.click();
  await expect(doctor).toContainText("Everything is working again.");
});

// App/session/broker wiring must expose exhausted visibility reads on the
// Doctor and let its combined action recover. Timing/error matrices stay in
// service and mounted component tests.
test("Buzz Doctor consolidates an exhausted read, preserves dialog history and retries it", async ({
  page,
  app,
}, testInfo) => {
  let failing = true;
  let reads = 0;
  await page.goto(app.origin);
  await openPage(page, "Messages");
  // Startup can supersede visibility reads as roster evidence arrives. Count
  // one explicit visibility refresh after the live roster and visibility settle.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const session = window.fixtureRelay.snapshot().session;
        return [
          session.live.snapshot().status,
          session.channels.list().status,
          session.channelLifecycle.snapshot().status,
        ];
      }),
    )
    .toEqual(["connected", "ready", "ready"]);
  await page.route("**/api/relay/**/query", async (route) => {
    if (
      !route
        .request()
        .postDataJSON()
        .some((filter) => filter.kinds?.includes(30622))
    )
      return route.continue();
    reads++;
    if (!failing) return route.continue();
    app.report.startupFailures ??= [];
    app.report.startupFailures.push(route.request().url());
    return route.fulfill({
      status: 502,
      json: { error: "Fixture visibility unavailable" },
    });
  });
  await page.evaluate(() =>
    window.fixtureRelay.snapshot().session.channelLifecycle.refreshVisibility(),
  );
  const toast = page.getByRole("dialog", {
    name: "Buzz is having issues",
    exact: true,
  });
  await expect(toast).toBeVisible();
  expect(reads).toBe(4);
  await expect(
    page.getByText("Hidden conversations could not be refreshed."),
  ).toHaveCount(0);
  expect(
    await page.evaluate(
      () =>
        window.fixtureRelay.snapshot().session.recovery.snapshot().recovering,
    ),
  ).toBe(false);
  const input = page.getByRole("textbox", {
    name: "Message #Alpha",
    exact: true,
  });
  await input.fill("Doctor keeps this draft");
  for (const [mode, width] of [
    ["light", 1440],
    ["dark", 390],
  ]) {
    await page.emulateMedia({ colorScheme: mode });
    await page.setViewportSize({ width, height: 844 });
    await expect(page.locator("html")).toHaveAttribute("data-color-mode", mode);
    const toastHost = toast.locator("xpath=ancestor::li[@data-sonner-toast]");
    await expect(toastHost).toHaveCSS("opacity", "1");
    await expect(toastHost).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, 0)");
    await page.screenshot({
      path: testInfo.outputPath(`doctor-toast-${mode}-${width}.png`),
    });
    await toast.screenshot({
      path: testInfo.outputPath(`doctor-toast-card-${mode}-${width}.png`),
    });
    await toast
      .getByRole("button", { name: "View issues", exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "Buzz Doctor",
      exact: true,
    });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveCSS("opacity", "1");
    await expect(
      dialog.getByText("Hidden conversations", { exact: true }),
    ).toBeVisible();
    await expect(
      dialog.getByRole("button", {
        name: "Retry hidden conversations",
        exact: true,
      }),
    ).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath(`doctor-dialog-${mode}-${width}.png`),
    });
    await dialog.screenshot({
      path: testInfo.outputPath(`doctor-dialog-card-${mode}-${width}.png`),
    });
    await page.goBack();
    await expect(dialog).toHaveCount(0);
    await expect(input).toHaveText("Doctor keeps this draft");
    await page.goForward();
    await expect(dialog).toBeVisible();
    await dialog
      .getByRole("button", { name: "Close Buzz Doctor", exact: true })
      .click();
    await expect(dialog).toHaveCount(0);
    await page.goForward();
    await expect(dialog).toHaveCount(0);
  }
  failing = false;
  await toast.getByRole("button", { name: "Retry", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.fixtureRelay.snapshot().session.channelLifecycle.snapshot()
            .status,
      ),
    )
    .toBe("ready");
  await expect(toast).toHaveCount(0);
  await expect(input).toHaveText("Doctor keeps this draft");
  expect(reads).toBe(5);
});
