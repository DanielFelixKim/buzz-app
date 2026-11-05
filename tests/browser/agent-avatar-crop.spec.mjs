import { test, expect } from "./source-fixture.mjs";

// The saved artwork must be the framed part of the image, painted by a real canvas.
test("pans and zooms an uploaded agent avatar into the saved artwork", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/agent-avatar-crop.html");
  // A 200x100 image: red on the left half, blue on the right.
  const artwork = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 200;
    canvas.height = 100;
    const context = canvas.getContext("2d");
    context.fillStyle = "#ff0000";
    context.fillRect(0, 0, 100, 100);
    context.fillStyle = "#0000ff";
    context.fillRect(100, 0, 100, 100);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve));
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  });
  await page.getByLabel("Upload an image", { exact: true }).setInputFiles({
    name: "split.png",
    mimeType: "image/png",
    buffer: Buffer.from(artwork),
  });
  const frame = page.getByRole("application", { name: "Image position" });
  await expect(frame).toBeVisible();
  await expect(frame.locator("[data-avatar-shape]")).toHaveAttribute(
    "data-avatar-shape",
    "squircle",
  );
  await page.getByRole("slider", { name: "Zoom" }).fill("2");
  // Drag the image right until its red half fills the frame.
  const box = await frame.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 2, box.y + box.height / 2, {
    steps: 4,
  });
  await page.mouse.up();
  await page.screenshot({
    path: test.info().outputPath("agent-avatar-crop.png"),
  });
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const saved = page.getByRole("img", { name: "Saved avatar" });
  await expect(saved).toBeVisible();
  const pixels = await saved.evaluate(async (image) => {
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0);
    const at = (x, y) => Array.from(context.getImageData(x, y, 1, 1).data);
    return {
      size: [image.naturalWidth, image.naturalHeight],
      left: at(10, 256),
      right: at(500, 256),
    };
  });
  expect(pixels).toEqual({
    size: [512, 512],
    left: [255, 0, 0, 255],
    right: [255, 0, 0, 255],
  });
});
