import { test, expect } from "./source-fixture.mjs";
import { watchPageErrors } from "./page-errors.mjs";

// Browser-only regression: intrinsic source width must not move the Close action,
// conversation or composer outside the dock. Real signed live delivery proves the
// answer appears without a refresh, including after the source channel changes.
test("a long source keeps Bestie's live answer, avatar and controls inside the right panel", async ({
  page,
}) => {
  const errors = watchPageErrors(page);
  await page.goto("/tests/fixtures/bestie-catch-up.html?longSource");
  await page
    .getByRole("button", { name: "Launch channel", exact: true })
    .click();
  const row = page
    .locator("[data-message-id]")
    .filter({ hasText: "@Morgan Martin @Clay Delk @arjun PTAL" })
    .first();
  await row.locator("[data-message-action-anchor]").hover();
  const more = row.getByRole("button", { name: "More message actions" });
  await more.focus();
  await more.press("Enter");
  await page
    .getByRole("menuitem", { name: "Catch me up", exact: true })
    .click();

  const panel = page.getByRole("region", { name: "Bestie catch-up" });
  const close = panel.getByRole("button", { name: "Hide Bestie catch-up" });
  const input = panel.getByRole("textbox", { name: "Message Pollen" });
  await expect(input).toBeInViewport();
  await expect(close).toBeInViewport();
  const avatar = panel.locator("header .buzz-avatar img");
  await expect(avatar).toHaveAttribute("src", /buzzies-2\.png/);
  await expect(
    page.locator("[data-catch-up-launcher] .buzz-avatar img"),
  ).toHaveAttribute("src", /buzzies-2\.png/);

  await page
    .getByRole("button", { name: "Design channel", exact: true })
    .click();
  await expect(
    page.getByText("A different channel to browse while Bestie works.", {
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Deliver fixture response" }).click();
  const answer = panel.getByRole("heading", { name: "You’re caught up" });
  await expect(answer).toBeInViewport();
  await expect(panel).toContainText("check Morgan’s launch checklist");
  await expect(close).toBeInViewport();

  for (const [mode, width, scale] of [
    ["light", 1440, 1],
    ["dark", 1100, 1],
    ["light", 900, 2],
    ["dark", 420, 2],
  ]) {
    await page.evaluate(
      ({ mode, scale }) => {
        document.documentElement.dataset.colorMode = mode;
        document.documentElement.style.setProperty(
          "--buzz-text-scale",
          String(scale),
        );
      },
      { mode, scale },
    );
    await page.setViewportSize({ width, height: 1000 });
    await expect(close).toBeInViewport();
    await expect(input).toBeInViewport();
    await expect(
      panel.getByRole("button", { name: "View thread" }),
    ).toBeInViewport();
    await expect
      .poll(() =>
        panel.evaluate((element) => element.scrollWidth <= element.clientWidth),
      )
      .toBe(true);
  }
  await close.click();
  const reopen = page.getByRole("button", { name: /Show Bestie catch-up/ });
  await reopen.click();
  await expect(
    panel.getByRole("heading", { name: "You’re caught up" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(reopen).toBeFocused();
  expect(errors.unexplained()).toEqual([]);
});

// Real browser boundary: portal placement, focus restoration, bounded timeline
// and composer, and a signed live reply while the popover is closed. RTL owns
// submission/retry/scope matrices; these cases compare only actual placements.
for (const take of ["top-nav", "floating"]) {
  test(`${take} keeps the source in place and returns to a bounded live Bestie conversation`, async ({
    page,
  }, testInfo) => {
    const errors = watchPageErrors(page);
    await page.goto(
      `/tests/fixtures/bestie-catch-up.html?longSource&take=${take}`,
    );
    const sidebar = page.locator("#shell-navigation");
    await expect(
      sidebar.locator("[data-channel-id]").filter({ hasText: "Pollen" }),
    ).toBeVisible();
    await expect(
      sidebar
        .getByRole("navigation", { name: "Pages" })
        .getByRole("button", { name: "Pollen", exact: true }),
    ).toHaveCount(0);
    const launcher = page.getByRole("button", { name: /Open Pollen — Bestie/ });
    if (take === "top-nav") {
      await expect(
        page
          .locator("header .shell-search-action")
          .getByRole("button", { name: /Open Pollen/ }),
      ).toBeVisible();
    } else {
      await expect(
        page.locator("header").getByRole("button", { name: /Open Pollen/ }),
      ).toHaveCount(0);
    }
    await launcher.click();
    await page
      .getByRole("dialog", { name: "Pollen", exact: true })
      .getByRole("button", { name: "Chat with Pollen" })
      .click();
    await expect(
      page.getByRole("tab", { name: "Pollen", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Launch channel", exact: true })
      .click();
    const row = page
      .locator("[data-message-id]")
      .filter({ hasText: "@Morgan Martin @Clay Delk @arjun PTAL" })
      .first();
    await row.locator("[data-message-action-anchor]").hover();
    const more = row.getByRole("button", { name: "More message actions" });
    await more.focus();
    await more.press("Enter");
    await page
      .getByRole("menuitem", { name: "Ask Bestie…", exact: true })
      .click();
    const form = page.getByRole("dialog", { name: "Ask Pollen" });
    await expect(form.getByRole("textbox")).toBeFocused();
    // Browser paint boundary: a late host reset can erase shared control styling
    // while roles, focus and submission still work. DOM-only tests cannot see it.
    await expect
      .poll(() =>
        form.getByRole("textbox").evaluate((element) => {
          const style = getComputedStyle(element);
          return (
            parseFloat(style.paddingInlineStart) > 0 &&
            parseFloat(style.borderTopWidth) > 0
          );
        }),
      )
      .toBe(true);
    await expect(form).toContainText("This thread will be linked in your ask.");
    await form
      .getByRole("button", { name: "Catch me up", exact: true })
      .click();
    await expect(form.getByRole("textbox")).toHaveValue(
      /Catch me up on this thread/,
    );
    await form
      .getByRole("textbox")
      .fill("Catch me up on this launch decision.");
    await form.screenshot({
      path: `/tmp/bestie-${take}-${testInfo.project.name}-ask.png`,
    });
    await form.getByRole("button", { name: "Send", exact: true }).click();
    await expect(form).toBeHidden();
    await expect(more).toBeFocused();
    await expect(row).toBeVisible();
    // Toast actions open the ordinary preview through the real plugin host,
    // without navigating. Returning to the source still uses shared navigation.
    await page.getByRole("button", { name: "View ask", exact: true }).click();
    const toastPreview = page.getByRole("dialog", {
      name: "Pollen",
      exact: true,
    });
    await expect(
      toastPreview.getByRole("textbox", { name: "Message Pollen" }),
    ).toBeVisible();
    await expect(row).toBeVisible();
    await toastPreview
      .getByRole("button", { name: "View source in Launch" })
      .click();
    await expect(toastPreview).toBeHidden();
    await expect(row).toBeVisible();
    await page
      .getByRole("button", { name: "Design channel", exact: true })
      .click();
    await expect(
      page.getByText("A different channel to browse while Bestie works.", {
        exact: true,
      }),
    ).toBeVisible();
    const trigger = page.getByRole("button", { name: /Open Pollen — Bestie/ });
    await expect(trigger.locator("img")).toHaveAttribute(
      "src",
      /buzzies-2\.png/,
    );
    await page
      .getByRole("button", { name: "Deliver fixture response" })
      .click();
    await expect(trigger).toHaveAccessibleName(/unread replies/);
    await trigger.click();
    const popup = page.getByRole("dialog", { name: "Pollen", exact: true });
    const recent = popup.getByRole("button", {
      name: /Catch me up on this launch decision.*Unread reply/,
    });
    await expect(recent).toBeVisible();
    await popup.screenshot({
      path: `/tmp/bestie-${take}-${testInfo.project.name}-home.png`,
    });
    await recent.click();
    const composer = popup.getByRole("textbox", { name: "Message Pollen" });
    const close = popup.getByRole("button", { name: "Close Bestie" });
    await expect(
      popup.getByRole("heading", { name: "You’re caught up" }),
    ).toBeInViewport();
    await expect(composer).toBeInViewport();
    await composer.fill("Keep this follow-up draft");
    await page.keyboard.press("Escape");
    await expect(popup).toBeHidden();
    await expect(trigger).toBeFocused();
    await trigger.click();
    await popup
      .getByRole("button", { name: /Catch me up on this launch decision/ })
      .click();
    await expect(composer).toHaveText("Keep this follow-up draft");
    for (const [mode, width, scale] of [
      ["light", 1440, 1],
      ["dark", 1100, 1],
      ["light", 900, 2],
      ["dark", 420, 2],
    ]) {
      await page.evaluate(
        ({ mode, scale }) => {
          document.documentElement.dataset.colorMode = mode;
          document.documentElement.style.setProperty(
            "--buzz-text-scale",
            String(scale),
          );
        },
        { mode, scale },
      );
      await page.setViewportSize({ width, height: 1000 });
      await expect(close).toBeInViewport();
      await expect(composer).toBeInViewport();
      await expect(
        popup.getByRole("button", { name: "View source in Launch" }),
      ).toBeInViewport();
      await expect
        .poll(() =>
          popup.evaluate(
            (element) => element.scrollWidth <= element.clientWidth,
          ),
        )
        .toBe(true);
      await page.screenshot({
        path: `/tmp/bestie-${take}-${testInfo.project.name}-${width}.png`,
      });
    }
    await popup
      .getByRole("button", { name: "Open conversation", exact: true })
      .click();
    await expect(popup).toBeHidden();
    await expect(
      page.getByRole("heading", { name: "You’re caught up" }),
    ).toBeVisible();
    expect(errors.unexplained()).toEqual([]);
  });
}
