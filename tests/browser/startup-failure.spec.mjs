import { test, expect } from "./fixture.mjs";

// A startup that can't finish shows "Buzz couldn’t open" from launch-init.js,
// which needs nothing from the app bundle; a slow one offers Reload. Each
// journey injects one failure, named by `expectedStartupFailure`.
// The build throws only where a journey's `failAt` says.
test.use({ launchAnimation: true, startupFailureFixture: true });

// The fixture build's entry, which index.html loads as a module.
const MAIN = "**/assets/index-*.js";
const failurePage = (page) =>
  page.getByRole("main", { name: "Buzz couldn’t open" });
/** The page says what happened, offers Reload, and keeps the error behind a
 * collapsed Details that contains `detail`. */
async function expectFailure(page, detail) {
  const failure = failurePage(page);
  await expect(failure).toBeVisible();
  await expect(failure.getByRole("alert")).toHaveText(
    "Buzz couldn’t openSomething went wrong while starting. Your messages and settings are safe.",
  );
  // The stuck launch and the empty app are gone.
  await expect(page.getByRole("status", { name: "Opening Buzz" })).toHaveCount(
    0,
  );
  await expect(page.locator("#root")).toBeHidden();
  await expect(failure.getByRole("button", { name: "Reload" })).toBeFocused();
  const details = failure.locator("details");
  await expect(details).not.toHaveAttribute("open");
  await failure.getByText("Details", { exact: true }).click();
  await expect(details).toHaveAttribute("open");
  await expect(details).toContainText(detail);
  return failure;
}

test.describe("when the app bundle doesn’t load", () => {
  test.use({ expectedStartupFailure: "/assets/index-" });

  test("says Buzz couldn’t open, and Reload opens it", async ({
    page,
    app,
  }) => {
    await page.route(MAIN, (route) => route.fulfill({ status: 404, body: "" }));
    await page.goto(app.origin, { waitUntil: "domcontentloaded" });
    const failure = await expectFailure(page, "/assets/index-");
    // Only the desktop app can restart itself.
    await expect(
      failure.getByRole("button", { name: "Restart Buzz" }),
    ).toHaveCount(0);

    await page.unroute(MAIN);
    await failure.getByRole("button", { name: "Reload" }).click();
    await expect(
      page.getByRole("region", { name: "Channel message history" }),
    ).toContainText("primary alpha message 0");
    await expect(failurePage(page)).toHaveCount(0);
  });

  test("offers Restart Buzz on the desktop", async ({ page, app }) => {
    await page.addInitScript(() => {
      window.__restarts = [];
      window.__TAURI_INTERNALS__ = {
        invoke: async (command) => {
          window.__restarts.push(command);
        },
      };
    });
    await page.route(MAIN, (route) => route.fulfill({ status: 404, body: "" }));
    await page.goto(app.origin, { waitUntil: "domcontentloaded" });
    const failure = await expectFailure(page, "/assets/index-");
    await failure.getByRole("button", { name: "Restart Buzz" }).click();
    await expect
      .poll(() => page.evaluate(() => window.__restarts))
      .toContain("update_restart");
  });
});

test.describe("when startup throws", () => {
  test.use({ expectedStartupFailure: "Fixture startup failure" });
  const failAt = (page, where) =>
    page.addInitScript((where) => {
      window.__buzzFixtureStartupFailure = where;
    }, where);

  test("before React has the app, says Buzz couldn’t open", async ({
    page,
    app,
  }) => {
    await failAt(page, "services");
    await page.goto(app.origin, { waitUntil: "domcontentloaded" });
    await expectFailure(page, "Fixture startup failure: storage unavailable");
  });

  test("when the app throws while rendering, says Buzz couldn’t open rather than leaving an empty window", async ({
    page,
    app,
  }) => {
    await failAt(page, "render");
    await page.goto(app.origin, { waitUntil: "domcontentloaded" });
    await expectFailure(page, "Fixture startup failure: render");
  });
});

test("a slow launch says so after 20 seconds and offers Reload, then opens as usual", async ({
  page,
  app,
}) => {
  await page.clock.install();
  // The app bundle arrives only when released, so the launch can't end first.
  let release;
  const arrived = new Promise((resolve) => {
    release = resolve;
  });
  await page.route(MAIN, async (route) => {
    await arrived;
    await route.continue();
  });
  try {
    // A module script holds DOMContentLoaded until it runs.
    await page.goto(app.origin, { waitUntil: "commit" });
    const launch = page.getByRole("status", { name: "Opening Buzz" });
    await expect(launch).toBeVisible();
    // Its 20 seconds start once launch-init.js has run.
    await page.waitForFunction(() => window.__buzzStartup);
    await page.clock.runFor(19_000);
    await expect(launch).not.toContainText("taking longer");
    await page.clock.runFor(1_000);
    await expect(launch).toContainText("This is taking longer than usual.");
    await expect(launch.getByRole("button", { name: "Reload" })).toBeVisible();
    await expect(failurePage(page)).toHaveCount(0);

    release();
    await expect(
      page.getByRole("region", { name: "Channel message history" }),
    ).toContainText("primary alpha message 0");
    await expect(launch).toHaveCount(0);
    await expect(failurePage(page)).toHaveCount(0);
  } finally {
    release();
  }
});
