import { test, expect } from "./fixture.mjs";
import { openPage } from "./navigation.mjs";

// Real layout and pointer placement cannot be established in a DOM emulator.
// The native buttons are outside the webview; reserve their macOS footprint.
test.use({
  channelIds: ["htian-playground"],
  channelNames: { "htian-playground": "htian-playground" },
  historyCounts: { "htian-playground": 1 },
});

test("dock previews stay below the native window controls", async ({
  page,
  app,
}, testInfo) => {
  await page.addInitScript(() =>
    localStorage.setItem("buzz-appearance.v1", "system"),
  );
  await page.goto(app.origin);
  await openPage(page, "Messages");
  const activity = page.getByRole("tab", { name: "Activity", exact: true });
  const card = page.getByRole("dialog", { name: "Activity", exact: true });
  for (const [mode, width, fontSize] of [
    ["light", 1280, "16px"],
    ["dark", 1280, "16px"],
    ["light", 480, "16px"],
    ["dark", 760, "24px"],
  ]) {
    await page.emulateMedia({ colorScheme: mode });
    await page.setViewportSize({ width, height: 800 });
    await page.evaluate((size) => {
      document.documentElement.style.fontSize = size;
    }, fontSize);
    await activity.hover();
    await expect(card).toBeVisible();
    await card.evaluate((element) =>
      Promise.all(
        element.getAnimations().map((animation) => animation.finished),
      ),
    );
    const box = await card.boundingBox();
    await page.screenshot({
      path: testInfo.outputPath(`preview-${mode}-${width}.png`),
    });
    // macOS window controls occupy the top-left 80 × 32px of the webview.
    expect(box.x >= 80 || box.y >= 32).toBe(true);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    expect(box.y + box.height).toBeLessThanOrEqual(800);
    await card.getByRole("switch", { name: "Unread only" }).focus();
    await page.keyboard.press("Escape");
    await expect(card).toHaveCount(0);
    await page.mouse.move(width - 10, 780);
  }
});
