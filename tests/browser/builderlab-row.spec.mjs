import { test, expect } from "./source-fixture.mjs";

// Opacity and container reflow need a browser; keep request state in unit tests.
test("narrow agent rows show Copy key without hover and retain desktop reveal", async ({
  page,
}) => {
  await page.goto("/tests/browser/builderlab-row.html");
  const copy = page.getByRole("button", { name: "Copy key" });
  for (const [width, scale, opacity] of [
    [390, "200%", "1"],
    [1440, "100%", "0"],
  ]) {
    await page.setViewportSize({ width, height: 1100 });
    await page.evaluate((scale) => {
      document.documentElement.style.fontSize = scale;
      document.activeElement.blur();
    }, scale);
    await page.mouse.move(0, 0);
    await expect(copy.locator("..")).toHaveCSS("opacity", opacity);
    await copy.focus();
    await expect(copy).toBeFocused();
    await expect(copy.locator("..")).toHaveCSS("opacity", "1");
  }
  const open = page.getByRole("button", { name: "Open Researcher in Agents" });
  const key = page.getByText("ab".repeat(32), { exact: true });
  await key.click();
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.toString()))
    .toBe("ab".repeat(32));
  expect(await page.locator("html").getAttribute("data-opened")).toBeNull();
  await copy.click();
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
