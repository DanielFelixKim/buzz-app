import { test, expect } from "./fixture.mjs";
import { open, settle, anchor, expectAnchor } from "./timeline.mjs";

test.use({ historyCounts: { alpha: 30, beta: 1 }, developmentReact: true });

// Browser-only: reply transitions must preserve real composer/scrollport geometry.
// A DOM emulator cannot prove that the clicked message stays at its reading Y.
test("holding to reply near the bottom preserves the reading position and Escape cancels", async ({
  page,
  app,
}) => {
  await open(page, app);
  const input = page.getByRole("textbox", {
    name: "Message #Alpha",
    exact: true,
  });
  await input.fill("Keep this draft");
  const editor = await input.evaluateHandle((element) => element);
  const history = page.getByRole("region", { name: "Channel message history" });
  const last = app.histories.get("primary/alpha").at(-1);
  const message = history
    .locator(`[data-message-id="${last.id}"]`)
    .locator("p")
    .first();
  await expect(message).toBeInViewport();
  await settle(page, history);
  const before = await anchor(page);
  const motion = await history.evaluateHandle((element, before) => {
    let frame;
    const drift = [];
    const sample = () => {
      const row = element.querySelector(`[data-message-id="${before.id}"] p`);
      drift.push(
        row
          ? Math.abs(
              row.getBoundingClientRect().top -
                element.getBoundingClientRect().top -
                before.y,
            )
          : Infinity,
      );
      frame = requestAnimationFrame(sample);
    };
    sample();
    return {
      stop() {
        cancelAnimationFrame(frame);
        return drift;
      },
    };
  }, before);
  await message.hover();
  await page.mouse.down();
  await expect(
    page.getByRole("button", { name: "Cancel reply target" }),
  ).toBeVisible();
  await page.mouse.up();
  await expect(page.getByRole("textbox")).toBeFocused();
  await expect(
    page.getByRole("button", { name: "Cancel reply target" }),
  ).toBeVisible();
  expect(await editor.evaluate((element) => element.isConnected)).toBe(true);
  await expect(page.getByRole("textbox")).toHaveText("Keep this draft");
  await settle(page, history);
  await expectAnchor(page, before);
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Cancel reply target" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toBeFocused();
  await settle(page, history);
  await expectAnchor(page, before);
  await expect(input).toHaveText("Keep this draft");
  // Reverse the preview motion before it finishes, as with quick repeated replies.
  for (let cycle = 0; cycle < 2; cycle++) {
    await message.hover();
    await page.mouse.down();
    await expect(
      page.getByRole("button", { name: "Cancel reply target" }),
    ).toBeVisible();
    await page.mouse.up();
    await expect(
      page.getByRole("button", { name: "Cancel reply target" }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("button", { name: "Cancel reply target" }),
    ).toHaveCount(0);
  }
  await settle(page, history);
  expect(await editor.evaluate((element) => element.isConnected)).toBe(true);
  await editor.dispose();
  const drift = await motion.evaluate((tracker) => tracker.stop());
  await motion.dispose();
  expect(
    Math.max(...drift),
    "reading anchor stays still throughout the transition",
  ).toBeLessThan(4);
});

// Native selection must survive a hold that becomes a drag after the preview.
test("dragging after the reply preview selects text without focusing the composer", async ({
  page,
  app,
}) => {
  await open(page, app);
  const input = page.getByRole("textbox", {
    name: "Message #Alpha",
    exact: true,
  });
  await input.fill("Keep this draft");
  const history = page.getByRole("region", { name: "Channel message history" });
  const last = app.histories.get("primary/alpha").at(-1);
  const prose = history.locator(`[data-message-id="${last.id}"] p`).first();
  await expect(prose).toBeInViewport();
  await settle(page, history);
  const points = await prose.evaluate((element) => {
    const text = element.firstChild;
    const point = (offset) => {
      const range = document.createRange();
      range.setStart(text, offset);
      range.setEnd(text, offset + 1);
      const box = range.getBoundingClientRect();
      const result = { x: box.x + 1, y: box.y + box.height / 2 };
      if (!element.contains(document.elementFromPoint(result.x, result.y)))
        throw new Error("Selection starts on exposed message prose");
      return result;
    };
    return { start: point(1), end: point(12) };
  });
  await page.mouse.move(points.start.x, points.start.y);
  await page.mouse.down();
  try {
    await expect(
      page.getByRole("button", { name: "Cancel reply target" }),
    ).toBeVisible();
    await expect(page.getByRole("textbox")).not.toBeFocused();
    await page.mouse.move(points.end.x, points.end.y, { steps: 8 });
  } finally {
    await page.mouse.up();
  }
  await expect
    .poll(() =>
      prose.evaluate((element) => {
        const selection = document.getSelection();
        return (
          !!selection?.toString() &&
          element.contains(selection.anchorNode) &&
          element.contains(selection.focusNode)
        );
      }),
    )
    .toBe(true);
  await expect(
    page.getByRole("button", { name: "Cancel reply target" }),
  ).toHaveCount(0);
  await expect(input).toHaveText("Keep this draft");
  await expect(input).not.toBeFocused();
});
