import { test, expect } from "./fixture.mjs";
import { open, settle, anchor, expectAnchor, wheel } from "./timeline.mjs";

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

// Native selection and scroll-follow ownership require real layout in both hosts.
test.describe("provisional reply cancellation", () => {
  test.use({ productionBroker: true, readState: true, threadUnread: true });
  for (const surface of ["channel", "thread"]) {
    for (const cancellation of ["selection", "scroll"]) {
      test(`${surface}: ${cancellation} cancels the preview and preserves reading intent on arrival`, async ({
        page,
        app,
      }) => {
        await open(page, app);
        const root =
          surface === "thread"
            ? app.histories
                .get("primary/alpha")
                .find((row) => row.content === "Thread root 1")
            : app.histories.get("primary/alpha").at(-1);
        let history = page.getByRole("region", {
          name: "Channel message history",
          exact: true,
        });
        let input = page
          .getByRole("article", { name: "Conversation", exact: true })
          .getByRole("textbox");
        let last = root;
        if (surface === "thread") {
          // Enough rows for real upward scrolling; no pagination or scale claim.
          for (let index = 0; index < 24; index++) {
            const reply = app.reply(root.id, false, false);
            if (index === 20) last = reply;
          }
          await history
            .locator(`[data-message-id="${root.id}"]`)
            .getByRole("button", { name: /^View thread:/ })
            .click();
          history = page.getByRole("region", {
            name: "Thread messages",
            exact: true,
          });
          input = page
            .getByRole("complementary", { name: "Thread", exact: true })
            .getByRole("textbox");
          await expect(history).toHaveAttribute("aria-busy", "false");
        }
        await input.fill("Keep this draft");
        const prose = history
          .locator(`[data-message-id="${last.id}"] p`)
          .first();
        await expect(prose).toBeInViewport();
        await settle(page, history);
        const bottomGap = () =>
          history.evaluate(
            (element) =>
              element.scrollHeight - element.clientHeight - element.scrollTop,
          );
        await expect.poll(bottomGap).toBeLessThan(4);
        const points = await prose.evaluate((element) => {
          const text = element.firstChild;
          const point = (offset) => {
            const range = document.createRange();
            range.setStart(text, offset);
            range.setEnd(text, offset + 1);
            const box = range.getBoundingClientRect();
            const result = { x: box.x + 1, y: box.y + box.height / 2 };
            if (
              !element.contains(document.elementFromPoint(result.x, result.y))
            )
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
          await expect(input).not.toBeFocused();
          if (cancellation === "selection")
            await page.mouse.move(points.end.x, points.end.y, { steps: 8 });
          else await wheel(page, -350, history);
        } finally {
          await page.mouse.up();
        }
        if (cancellation === "selection") {
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
        } else {
          await expect.poll(bottomGap).toBeGreaterThan(250);
        }
        await expect(
          page.getByRole("button", { name: "Cancel reply target" }),
        ).toHaveCount(0);
        await expect(input).toHaveText("Keep this draft");
        await expect(input).not.toBeFocused();
        await settle(page, history);
        const before = await history.evaluate((element) => {
          const top = element.getBoundingClientRect().top;
          const row = [...element.querySelectorAll("[data-message-id]")].find(
            (row) => row.getBoundingClientRect().top >= top,
          );
          return {
            id: row.dataset.messageId,
            y: row.getBoundingClientRect().top - top,
          };
        });
        let latest;
        for (let index = 0; index < 3; index++)
          latest =
            surface === "thread"
              ? app.reply(root.id)
              : app.append(
                  "primary",
                  "alpha",
                  `Arrival after cancel ${index}`,
                  true,
                  false,
                );
        const arrival = history.locator(`[data-message-id="${latest.id}"]`);
        if (cancellation === "selection") {
          await expect(arrival).toBeInViewport();
          await settle(page, history);
          await expect.poll(bottomGap).toBeLessThan(4);
          await expect(
            page.getByRole("button", { name: /^\d+ new messages?$/ }),
          ).toHaveCount(0);
        } else {
          // The arrival badge is the completion barrier before checking no jump.
          await expect(
            page.getByRole("button", { name: "3 new messages", exact: true }),
          ).toBeVisible();
          await settle(page, history);
          await expect(arrival).not.toBeInViewport();
          await expect
            .poll(() =>
              history.evaluate((element, before) => {
                const row = element.querySelector(
                  `[data-message-id="${before.id}"]`,
                );
                return row
                  ? Math.abs(
                      row.getBoundingClientRect().top -
                        element.getBoundingClientRect().top -
                        before.y,
                    )
                  : Infinity;
              }, before),
            )
            .toBeLessThan(4);
        }
      });
    }
  }
});
