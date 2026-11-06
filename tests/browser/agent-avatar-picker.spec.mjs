import { test, expect } from "./source-fixture.mjs";

// Read the saved PNG's decoded pixels; only a real canvas paints the emoji.
const savedAlpha = async (page) => {
  const saved = page.getByRole("img", { name: "Saved avatar" });
  await expect(saved).toBeVisible();
  return saved.evaluate(async (image) => {
    await image.decode();
    const bitmap = await createImageBitmap(image);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(bitmap, 0, 0);
    const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
    let painted = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i]) painted++;
    return {
      size: [bitmap.width, bitmap.height],
      corner: data[3],
      center: data[(256 * 512 + 256) * 4 + 3],
      painted,
    };
  });
};

test("saves an emoji over a transparent background in a squircle", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/agent-avatar-picker.html");
  await page.getByRole("tab", { name: "Emoji", exact: true }).click();
  const artwork = page
    .getByRole("button", { name: "Choose emoji" })
    .locator("[data-avatar-shape]");
  await expect(artwork).toHaveAttribute("data-avatar-shape", "squircle");
  await page
    .getByRole("button", { name: "Use transparent background" })
    .click();
  await expect(artwork).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await page.screenshot({
    path: test.info().outputPath("agent-avatar-transparent.png"),
  });
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const { size, corner, center, painted } = await savedAlpha(page);
  expect(size).toEqual([512, 512]);
  expect(corner).toBe(0);
  expect(center).toBeGreaterThan(0);
  expect(painted).toBeLessThan(512 * 512);
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
