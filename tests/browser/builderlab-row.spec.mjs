import { test, expect } from "./source-fixture.mjs";

// Real pointer targets, text wrapping and menu geometry need browser layout.
test("compact rows keep navigation and menu actions independent at enlarged text", async ({
  page,
}) => {
  await page.goto("/tests/browser/builderlab-row.html");
  const trigger = page.getByRole("button", {
    name: "More actions for Researcher",
  });
  const open = page.getByRole("button", { name: "View Researcher" });
  for (const [width, scale] of [
    [390, "200%"],
    [1440, "100%"],
  ]) {
    await page.setViewportSize({ width, height: 1100 });
    await page.evaluate(
      (scale) => (document.documentElement.style.fontSize = scale),
      scale,
    );
    await expect(trigger).toBeVisible();
    const bounds = await trigger.boundingBox();
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    const label = await page
      .getByText("Researcher", { exact: true })
      .boundingBox();
    const status = await page
      .getByText("In Agents", { exact: true })
      .boundingBox();
    expect(label.x + label.width).toBeLessThanOrEqual(bounds.x);
    expect(status.x + status.width).toBeLessThanOrEqual(bounds.x);
    expect(
      status.y >= label.y + label.height || status.x >= label.x + label.width,
    ).toBe(true);
    await trigger.focus();
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("menuitem", { name: "Copy key" }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
  }
  await trigger.click();
  await page.getByRole("menuitem", { name: "Copy key" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-copied", "yes");
  expect(await page.locator("html").getAttribute("data-opened")).toBeNull();
  await open.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("html")).toHaveAttribute("data-opened", "yes");
});

test("agent artwork stays top aligned before and after loading", async ({
  page,
}) => {
  let release;
  const held = new Promise((resolve) => (release = resolve));
  await page.route("**/fixture-avatar.png", async (route) => {
    await held;
    await route.fulfill({
      path: "tests/fixtures/design-system/assets/avatar.png",
    });
  });
  await page.goto("/tests/browser/builderlab-row.html?avatar", {
    waitUntil: "domcontentloaded",
  });
  const avatar = page.locator(".buzz-avatar");
  const title = page.getByText("Researcher", { exact: true });
  try {
    await expect(avatar).toBeVisible();
    const before = await avatar.boundingBox();
    const heading = await title.boundingBox();
    expect(before.y).toBe(heading.y);
    release();
    await expect(avatar.locator("img")).toHaveAttribute("data-loaded", "true");
    expect(await avatar.boundingBox()).toEqual(before);
  } finally {
    release();
  }
});
