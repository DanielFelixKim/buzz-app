import { test, expect } from "./source-fixture.mjs";

test("previews an emoji agent avatar in a squircle", async ({ page }) => {
  await page.goto("/tests/fixtures/agent-avatar-picker.html");
  await page.getByRole("tab", { name: "Emoji", exact: true }).click();
  await expect(
    page
      .getByRole("button", { name: "Choose emoji" })
      .locator("[data-avatar-shape]"),
  ).toHaveAttribute("data-avatar-shape", "squircle");
  await page.screenshot({
    path: test.info().outputPath("agent-avatar-squircle.png"),
  });
});

test("frames an uploaded agent avatar in a squircle", async ({ page }) => {
  await page.goto("/tests/fixtures/agent-avatar-picker.html");
  await page.getByLabel("Upload an image", { exact: true }).setInputFiles({
    name: "dot.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1cAAAAASUVORK5CYII=",
      "base64",
    ),
  });
  await expect(
    page.getByRole("img", { name: "Selected avatar" }),
  ).toHaveAttribute("data-avatar-shape", "squircle");
});
