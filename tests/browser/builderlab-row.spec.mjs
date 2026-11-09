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
});
