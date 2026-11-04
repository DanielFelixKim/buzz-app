import { test, expect } from "./source-fixture.mjs";
import { watchPageErrors } from "./page-errors.mjs";

async function settleNotePane(page) {
  await expect(
    page.getByRole("region", { name: "Note details", exact: true }),
  ).toBeVisible();
}

async function disableAutoSave(page, document) {
  await document.getByRole("button", { name: "Note actions" }).click();
  await page
    .getByRole("menuitem", { name: "Disable auto-save", exact: true })
    .click();
}

function floatingPaint(element) {
  const style = getComputedStyle(element);
  return {
    background: style.backgroundColor,
    border: style.borderTopWidth,
    borderColor: style.borderTopColor,
    radius: style.borderTopLeftRadius,
    shadow: style.boxShadow,
    blur: style.backdropFilter,
  };
}

test("Back and Forward restore note navigation, filters, drafts, dialogs and conversation panes", async ({
  page,
}, testInfo) => {
  const errors = watchPageErrors(page);
  await page.goto("/tests/fixtures/working-notes.html");
  const search = page.getByRole("searchbox", { name: "Search notes" });
  const filter = page.getByRole("button", {
    name: "Filter notes",
    exact: true,
  });
  await filter.focus();
  await filter.press("Enter");
  const deleted = page.getByRole("menuitemcheckbox", {
    name: "Show deleted notes",
    exact: true,
  });
  await expect(deleted).not.toBeChecked();
  await deleted.press("Space");
  await expect(filter).toBeFocused();
  await page.goBack();
  await filter.click();
  await expect(deleted).not.toBeChecked();
  await page.keyboard.press("Escape");
  await page.goForward();
  await filter.click();
  await expect(deleted).toBeChecked();
  await deleted.click();
  const list = page.getByRole("list", { name: "Notes", exact: true });
  await expect(list.getByRole("link")).toHaveText([
    "Connected notes plan",
    "Storage research",
  ]);
  await expect(
    list.getByRole("link", { name: "Connected notes plan", exact: true }),
  ).toHaveAttribute("href", /^buzz:\/\/note\?/);
  const measure = await list.evaluate(
    () => 52 * parseFloat(getComputedStyle(document.documentElement).fontSize),
  );
  const listBounds = await list.boundingBox();
  expect(listBounds.width).toBe(measure);
  expect(
    Math.abs(listBounds.x * 2 + listBounds.width - page.viewportSize().width),
  ).toBeLessThan(1);
  await page.screenshot({ path: testInfo.outputPath("notes-list.png") });
  const links = await list.getByRole("link").all();
  const first = await links[0].boundingBox();
  const second = await links[1].boundingBox();
  expect(second.y).toBeGreaterThan(first.y + first.height);
  expect(second.x).toBe(first.x);
  await search.fill("no matching document");
  await search.press("Enter");
  await expect(
    page.getByRole("status").filter({ hasText: "No matching notes." }),
  ).toBeVisible();
  await expect(list.getByRole("link")).toHaveCount(0);
  await search.fill("Storage");
  await search.press("Enter");
  const researchLink = list.getByRole("link", {
    name: "Storage research",
    exact: true,
  });
  await researchLink.focus();
  await researchLink.press("Enter");
  await expect(search).not.toBeVisible();
  await settleNotePane(page);
  await expect(
    page.getByRole("complementary", { name: "Note editor" }),
  ).toHaveCount(0);
  await expect(page.getByRole("tablist", { name: "Open notes" })).toHaveCount(
    0,
  );
  const detail = await page
    .getByRole("region", { name: "Note details", exact: true })
    .boundingBox();
  expect(detail.width).toBeGreaterThan(page.viewportSize().width - 40);
  let document = page.getByRole("article", {
    name: "Storage research",
    exact: true,
  });
  await expect(
    document.getByRole("textbox", { name: "Title", exact: true }),
  ).toBeFocused();
  await disableAutoSave(page, document);
  await expect(
    document.getByRole("combobox", { name: "Document mode", exact: true }),
  ).toContainText("Editing");
  await document
    .getByRole("textbox", { name: "Document body", exact: true })
    .fill("Keep my unsaved research");
  await page
    .getByRole("button", { name: "Back to notes", exact: true })
    .click();
  await expect(search).toBeFocused();
  await expect(search).toHaveValue("Storage");
  await list
    .getByRole("link", { name: "Storage research", exact: true })
    .click();
  await expect(document).toContainText("Keep my unsaved research");
  await document
    .getByRole("combobox", { name: "Document mode", exact: true })
    .click();
  await page.getByRole("option", { name: "Viewing", exact: true }).click();
  await document
    .getByRole("combobox", { name: "Document mode", exact: true })
    .click();
  await page.getByRole("option", { name: "Editing", exact: true }).click();
  await expect(
    document.getByRole("textbox", { name: "Document body", exact: true }),
  ).toHaveText("Keep my unsaved research");
  await page.goBack();
  await expect(
    document.getByRole("combobox", { name: "Document mode", exact: true }),
  ).toContainText("Viewing");
  await page.goForward();
  await expect(
    document.getByRole("textbox", { name: "Document body", exact: true }),
  ).toHaveText("Keep my unsaved research");
  await document.getByRole("button", { name: "Discard changes" }).click();
  await document
    .getByRole("button", { name: "Share note", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Share access" }),
  ).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("dialog", { name: "Share access" })).toHaveCount(
    0,
  );
  await page.goForward();
  await expect(
    page.getByRole("dialog", { name: "Share access" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await document.getByRole("button", { name: "Note actions" }).click();
  await page.getByRole("menuitem", { name: "Revision history" }).click();
  const history = page.getByRole("dialog", { name: "Revision history" });
  await history.getByRole("button", { name: /Storage research/ }).click();
  await expect(
    history.getByRole("region", { name: "Selected revision" }),
  ).toBeVisible();
  await page.goBack();
  await expect(
    history.getByRole("region", { name: "Selected revision" }),
  ).toHaveCount(0);
  await page.goForward();
  await expect(
    history.getByRole("region", { name: "Selected revision" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "Back to notes", exact: true })
    .click();
  await expect(search).toHaveValue("Storage");
  await page.getByRole("button", { name: "New note", exact: true }).click();
  const create = page.getByRole("article", { name: "New note", exact: true });
  await disableAutoSave(page, create);
  await create
    .getByRole("textbox", { name: "Title", exact: true })
    .fill("Draft survives history");
  await page.goBack();
  await expect(create).not.toBeVisible();
  await page.goForward();
  await expect(
    create.getByRole("textbox", { name: "Title", exact: true }),
  ).toHaveValue("Draft survives history");
  await page
    .getByRole("button", { name: "Back to notes", exact: true })
    .click();
  await search.fill("Connected");
  await search.press("Enter");
  await page
    .getByRole("link", { name: "Connected notes plan", exact: true })
    .click();
  await expect(
    page.getByRole("article", { name: "Connected notes plan", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("article", { name: "Storage research", exact: true }),
  ).not.toBeVisible();
  await page.goBack();
  await expect(
    page.getByRole("button", { name: "New note", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Conversation", exact: true }).click();
  await page
    .getByRole("link", { name: "Connected notes plan", exact: true })
    .click();
  document = page.getByRole("article", {
    name: "Connected notes plan",
    exact: true,
  });
  await expect(document).toBeVisible();
  await expect(
    document.getByRole("combobox", { name: "Document mode", exact: true }),
  ).toContainText("Editing");
  await document
    .getByRole("combobox", { name: "Document mode", exact: true })
    .click();
  await page.getByRole("option", { name: "Viewing", exact: true }).click();
  await document
    .getByRole("link", { name: "Storage research", exact: true })
    .click();
  await expect(
    page.getByRole("article", { name: "Storage research", exact: true }),
  ).toBeVisible();
  await page.goBack();
  await expect(document).toBeVisible();
  await page.goForward();
  await expect(
    page.getByRole("article", { name: "Storage research", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("textbox", { name: /message/i })).toBeVisible();
  const research = page.getByRole("article", {
    name: "Storage research",
    exact: true,
  });
  await expect(
    research.getByRole("combobox", { name: "Document mode", exact: true }),
  ).toContainText("Editing");
  await research
    .getByRole("combobox", { name: "Document mode", exact: true })
    .click();
  await page.getByRole("option", { name: "Viewing", exact: true }).click();
  await research
    .getByRole("combobox", { name: "Document mode", exact: true })
    .click();
  await page.getByRole("option", { name: "Editing", exact: true }).click();
  await research
    .getByRole("textbox", { name: "Document body", exact: true })
    .fill("Unsaved pane research");
  await page.goBack();
  await expect(
    research.getByRole("combobox", { name: "Document mode", exact: true }),
  ).toContainText("Viewing");
  await page.goForward();
  await expect(
    research.getByRole("textbox", { name: "Document body", exact: true }),
  ).toHaveText("Unsaved pane research");
  await research.getByRole("button", { name: "Discard changes" }).click();
  await research
    .getByRole("button", { name: "Share note", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Share access" }),
  ).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("dialog", { name: "Share access" })).toHaveCount(
    0,
  );
  await page.goForward();
  await expect(
    page.getByRole("dialog", { name: "Share access" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  expect(page.url()).not.toContain("Unsaved");
  const address = () =>
    page.evaluate(() => window.workingNotesFixture.navigation());
  const researchVisit = (await address()).entry.id;
  await page
    .getByRole("button", { name: "Toggle tab pane", exact: true })
    .click();
  await expect(research).not.toBeVisible();
  // Collapsing the pane changes layout, without inventing a history visit.
  expect((await address()).entry.id).toBe(researchVisit);
  await page
    .getByRole("button", { name: "Toggle tab pane", exact: true })
    .click();
  await expect(research).toBeVisible();
  await page
    .getByRole("button", { name: "Close Storage research tab", exact: true })
    .click();
  await expect(document).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("textbox", { name: /message/i })).toBeVisible();
  await expect(research).not.toBeVisible();
  await page.goForward();
  await expect(document).toBeVisible();
  await expect(research).not.toBeVisible();
  // Reopening is a fresh visit; closing an inactive sibling keeps it selected.
  await document
    .getByRole("combobox", { name: "Document mode", exact: true })
    .click();
  await page.getByRole("option", { name: "Viewing", exact: true }).click();
  await document
    .getByRole("link", { name: "Storage research", exact: true })
    .click();
  await expect(research).toBeVisible();
  const reopened = (await address()).entry.id;
  expect(reopened).not.toBe(researchVisit);
  await page
    .getByRole("button", {
      name: "Close Connected notes plan tab",
      exact: true,
    })
    .click();
  await expect(research).toBeVisible();
  expect((await address()).entry.id).toBe(reopened);
  await page
    .getByRole("tab", { name: "Storage research", exact: true })
    .click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Close all tabs", exact: true })
    .click();
  await expect(research).not.toBeVisible();
  await expect
    .poll(async () => (await address()).entry.target.note)
    .toBeUndefined();
  expect((await address()).canGoForward).toBe(false);
  expect(errors.unexplained()).toEqual([]);
});

test("human and agents edit, link, share and export the same working note", async ({
  page,
}, testInfo) => {
  const errors = watchPageErrors(page);
  await page.goto("/tests/fixtures/working-notes.html");
  await expect(page.getByRole("button", { name: "New note" })).toBeVisible();
  const created = await page.evaluate(() =>
    window.workingNotesFixture.agentCreate(
      "Delivery plan",
      "# First draft\n\nWritten by Carl.",
    ),
  );
  await page
    .getByRole("button", { name: "Refresh notes", exact: true })
    .click();
  await expect(
    page
      .getByRole("list", { name: "Notes", exact: true })
      .getByRole("link")
      .first(),
  ).toHaveText("Delivery plan");
  await page.getByRole("link", { name: "Delivery plan", exact: true }).click();
  const document = page.getByRole("article", { name: "Delivery plan" });
  await expect(document.locator("[data-avatar-shape]")).toHaveAttribute(
    "data-avatar-shape",
    "squircle",
  );
  await disableAutoSave(page, document);
  const canvas = document.getByRole("region", {
    name: "Document content",
    exact: true,
  });
  const mode = document.getByRole("combobox", {
    name: "Document mode",
    exact: true,
  });
  await expect(mode).toContainText("Editing");
  await expect(
    document.getByRole("textbox", { name: "Document body", exact: true }),
  ).toBeVisible();
  const initialBody = document.getByRole("textbox", {
    name: "Document body",
    exact: true,
  });
  await initialBody.evaluate((field) => {
    field.focus();
    field.setSelectionRange(0, 0);
  });
  const title = document.getByRole("textbox", { name: "Title", exact: true });
  await title.click();
  await expect(title).toBeFocused();
  const initialPage = document.getByRole("region", {
    name: "Note contents",
    exact: true,
  });
  const pageBounds = await initialPage.boundingBox();
  const initialBodyBounds = await initialBody.boundingBox();
  await page.mouse.move(initialBodyBounds.x + 2, initialBodyBounds.y + 10);
  await page.mouse.down();
  await page.mouse.move(
    pageBounds.x + 8,
    pageBounds.y + pageBounds.height - 8,
    { steps: 5 },
  );
  await expect
    .poll(() =>
      page.evaluate(() => window.getSelection()?.toString().length ?? 0),
    )
    .toBeGreaterThan(0);
  await page.mouse.up();
  await expect
    .poll(() =>
      page.evaluate(() => window.getSelection()?.toString().length ?? 0),
    )
    .toBeGreaterThan(0);
  await initialPage.click({ position: { x: 8, y: pageBounds.height - 8 } });
  await expect(initialBody).toBeFocused();
  await page.keyboard.type(" Appended at the end.");
  await expect(initialBody).toContainText(
    "Written by Carl. Appended at the end.",
  );
  await document
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  await expect(mode).toContainText("Viewing");
  await expect(document).toContainText("Carl");
  await expect(document).toContainText("Saved");
  await expect(document.locator("time")).toHaveAttribute(
    "datetime",
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/,
  );
  await settleNotePane(page);
  await expect(document.getByRole("region", { name: "Backlinks" })).toHaveCount(
    0,
  );
  await expect(document.getByText("Linked from", { exact: true })).toHaveCount(
    0,
  );
  await document.getByRole("button", { name: "Note actions" }).click();
  await expect(
    page.getByRole("menuitem", { name: "Linked notes", exact: true }),
  ).toHaveCount(0);
  const menuPaint = await page
    .getByRole("menu", { name: "Note actions", exact: true })
    .evaluate(floatingPaint);
  await page.keyboard.press("Escape");
  await expect(
    document.getByRole("button", { name: "Note actions" }),
  ).toBeFocused();
  const viewingBounds = await canvas.boundingBox();
  const channelMeasure = await canvas.evaluate(
    () => 52 * parseFloat(getComputedStyle(document.documentElement).fontSize),
  );
  expect(viewingBounds.width).toBe(channelMeasure);
  expect(
    Math.abs(
      viewingBounds.x * 2 + viewingBounds.width - page.viewportSize().width,
    ),
  ).toBeLessThan(1);
  const scrollport = document.getByRole("region", {
    name: "Note contents",
    exact: true,
  });
  const toolbar = document.getByRole("group", {
    name: "Document formatting",
    exact: true,
  });
  await expect(toolbar).toHaveCount(0);
  const modeBounds = await mode.boundingBox();
  const sectionGap = await scrollport.evaluate((element) =>
    parseFloat(getComputedStyle(element).rowGap),
  );
  await expect(document.getByRole("status")).toHaveText(/^Saved /);
  expect(
    await document
      .getByRole("status")
      .evaluate((label) => !!label.querySelector("time")),
  ).toBe(true);
  expect(
    Math.abs(viewingBounds.y - modeBounds.y - modeBounds.height - sectionGap),
  ).toBeLessThan(1);
  const viewingTitle = await document
    .getByRole("textbox", { name: "Title", exact: true })
    .boundingBox();
  await expect(
    document.getByRole("button", { name: "Save", exact: true }),
  ).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("viewing.png") });
  await document
    .getByRole("combobox", { name: "Document mode", exact: true })
    .click();
  await page.getByRole("option", { name: "Editing", exact: true }).click();

  await expect(toolbar).toBeVisible();
  const toolbarBounds = await toolbar.boundingBox();
  expect(toolbarBounds.width).toBe(channelMeasure);
  expect(toolbarBounds.x).toBe(viewingBounds.x);
  const paneBounds = await document.boundingBox();
  const paneInset = await scrollport.evaluate((element) =>
    parseFloat(getComputedStyle(element).paddingInlineStart),
  );
  expect(
    Math.abs(
      paneBounds.y +
        paneBounds.height -
        toolbarBounds.y -
        toolbarBounds.height -
        paneInset,
    ),
  ).toBeLessThan(1);
  expect(await toolbar.evaluate(floatingPaint)).toEqual(menuPaint);
  expect(
    await toolbar.evaluate((element) =>
      parseFloat(getComputedStyle(element).paddingLeft),
    ),
  ).toBeGreaterThan(0);
  const editingBounds = await canvas.boundingBox();
  const editingTitle = await document
    .getByRole("textbox", { name: "Title", exact: true })
    .boundingBox();
  expect(Math.abs(editingBounds.x - viewingBounds.x)).toBeLessThan(1);
  expect(Math.abs(editingBounds.y - viewingBounds.y)).toBeLessThan(1);
  expect(editingTitle).toEqual(viewingTitle);
  await expect(
    document.getByRole("button", { name: "Toggle formatting", exact: true }),
  ).toHaveCount(0);
  await expect(
    document.getByRole("button", { name: "Close formatting", exact: true }),
  ).toHaveCount(0);
  await expect(
    document.getByRole("button", { name: "Save", exact: true }),
  ).toHaveCount(0);
  await expect(
    document.getByRole("group", { name: "Formatting options" }),
  ).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("editing-clean.png") });
  await document
    .getByRole("textbox", { name: "Document body", exact: true })
    .focus();
  await document
    .getByRole("textbox", { name: "Document body", exact: true })
    .press("ControlOrMeta+k");
  await expect(page.getByRole("dialog", { name: "Add link" })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("dialog", { name: "Add link" })).toHaveCount(0);
  await page.goForward();
  await expect(page.getByRole("dialog", { name: "Add link" })).toBeVisible();
  await page
    .getByRole("combobox", { name: "Note", exact: true })
    .fill("Delivery plan");
  await page
    .getByRole("option", { name: "Delivery plan", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Add link" })
    .getByRole("button", { name: "Save", exact: true })
    .click();
  await document.getByRole("button", { name: "Save", exact: true }).click();
  await expect(document.getByRole("status")).toHaveText(/^Saved /);
  await expect(document.locator("[data-avatar-shape]")).toHaveAttribute(
    "data-avatar-shape",
    "circle",
  );

  await document
    .getByRole("link", { name: "Delivery plan", exact: true })
    .click();
  await expect(
    page.getByRole("article", { name: "Delivery plan", exact: true }),
  ).toHaveCount(1);
  await expect(document.getByRole("alert")).toHaveCount(0);

  await document
    .getByRole("combobox", { name: "Document mode", exact: true })
    .click();
  await page.getByRole("option", { name: "Editing", exact: true }).click();
  const longBody = document.getByRole("textbox", {
    name: "Document body",
    exact: true,
  });
  await longBody.fill(
    Array.from({ length: 100 }, (_, index) => `Draft paragraph ${index}.`).join(
      "\n\n",
    ),
  );
  await scrollport.evaluate((element) => {
    element.scrollTop = 0;
  });
  const pinnedBounds = await toolbar.boundingBox();
  await scrollport.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect
    .poll(() => scrollport.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
  expect(await toolbar.boundingBox()).toEqual(pinnedBounds);
  await scrollport.evaluate((element) => {
    element.scrollTop = 0;
  });
  await document
    .getByRole("textbox", { name: "Document body", exact: true })
    .fill("# Taylor’s revision\n\nReady for another agent.");
  const body = document.getByRole("textbox", {
    name: "Document body",
    exact: true,
  });
  await expect(
    document.getByRole("group", { name: "Formatting options" }),
  ).toBeVisible();
  await body.evaluate((element) => {
    const start = element.value.indexOf("Ready");
    element.setSelectionRange(start, start + 5);
  });
  await document.getByRole("button", { name: "Bold", exact: true }).click();
  await expect(body.locator("strong")).toHaveText("Ready");
  const save = document.getByRole("button", { name: "Save", exact: true });
  await expect(save).toHaveAttribute("data-variant", "prominent");
  await expect(save).toHaveAttribute("data-size", "sm");
  const saveBounds = await save.boundingBox();
  const contentBounds = await canvas.boundingBox();
  const documentBounds = await document.boundingBox();
  expect(saveBounds.width).toBeLessThan(contentBounds.width);
  const modeSaveBounds = await mode.boundingBox();
  const refreshSaveBounds = await document
    .getByRole("button", { name: "Refresh note", exact: true })
    .boundingBox();
  expect(saveBounds.x).toBeGreaterThan(modeSaveBounds.x + modeSaveBounds.width);
  expect(saveBounds.x + saveBounds.width).toBeLessThan(refreshSaveBounds.x);
  expect(saveBounds.y + saveBounds.height).toBeLessThan(
    documentBounds.y + documentBounds.height,
  );
  await mode.click();
  await page.getByRole("option", { name: "Viewing", exact: true }).click();
  await expect(canvas).toContainText("Taylor’s revision");
  await expect(save).toBeVisible();
  expect(
    (
      await page.evaluate(
        (address) => window.workingNotesFixture.agentRead(address),
        created,
      )
    ).markdown,
  ).toContain("Written by Carl");
  await mode.click();
  await page.getByRole("option", { name: "Editing", exact: true }).click();
  await expect(body.locator("strong")).toHaveText("Ready");

  await document.getByRole("button", { name: "Note actions" }).click();
  await page
    .getByRole("menuitem", { name: "Markdown source", exact: true })
    .click();
  await expect(toolbar).toHaveCount(0);
  await expect(
    document.getByRole("textbox", { name: "Markdown", exact: true }),
  ).toHaveValue(/\*\*Ready\*\*/);
  const source = document.getByRole("textbox", {
    name: "Markdown",
    exact: true,
  });
  await source.evaluate((field) => field.setSelectionRange(0, 0));
  const sourcePageBounds = await scrollport.boundingBox();
  await scrollport.click({
    position: { x: 8, y: sourcePageBounds.height - 8 },
  });
  await expect(source).toBeFocused();
  expect(
    await source.evaluate(
      (field) =>
        field.selectionStart === field.value.length &&
        field.selectionEnd === field.value.length,
    ),
  ).toBe(true);
  await document.getByRole("button", { name: "Note actions" }).click();
  await page
    .getByRole("menuitem", { name: "Formatted text", exact: true })
    .click();
  await expect(toolbar).toBeVisible();
  await expect(body.locator("strong")).toHaveText("Ready");
  await body.press("ArrowRight");
  await body.press("ControlOrMeta+End");
  await page.screenshot({ path: testInfo.outputPath("document-editing.png") });

  await body.press("[");
  await body.press("[");
  await expect(
    page
      .getByRole("dialog", { name: "Add link" })
      .getByRole("textbox", { name: "Text", exact: true }),
  ).toHaveValue("");
  await page
    .getByRole("combobox", { name: "Note", exact: true })
    .fill("Storage research");
  await page.getByRole("option", { name: "Storage research" }).click();
  await page
    .getByRole("dialog", { name: "Add link" })
    .getByRole("button", { name: "Save", exact: true })
    .click();
  await document.getByRole("button", { name: "Save", exact: true }).click();
  await expect(document.getByRole("status")).toHaveText(/^Saved /);
  expect(
    (
      await page.evaluate(
        (address) => window.workingNotesFixture.agentRead(address),
        created,
      )
    ).markdown,
  ).toContain("Taylor’s revision");
  await document
    .getByRole("link", { name: "Storage research", exact: true })
    .click();
  await expect(
    page.getByRole("article", { name: "Storage research" }),
  ).toBeVisible();
  await page
    .getByRole("article", { name: "Storage research" })
    .getByRole("button", { name: "Note actions" })
    .click();
  await page
    .getByRole("menuitem", { name: "Linked notes", exact: true })
    .click();
  await page
    .getByRole("menu", { name: "Linked notes", exact: true })
    .getByRole("menuitem", { name: "Delivery plan", exact: true })
    .click();
  await expect(document).toBeVisible();
  await document
    .getByRole("button", { name: "Share note", exact: true })
    .click();
  const sharing = page.getByRole("dialog", { name: "Share access" });
  // Capture the browser clipboard boundary without writing to the host clipboard.
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text) => {
          window.noteCopiedLink = text;
        },
      },
    });
  });
  await expect(sharing).toContainText("all retained revisions");
  await expect(
    sharing.getByRole("region", { name: "Member list", exact: true }),
  ).toHaveAttribute("data-refreshing", "false");
  await sharing
    .getByRole("searchbox", { name: "Search people and agents", exact: true })
    .fill(await page.evaluate(() => window.workingNotesFixture.sam));
  await sharing.getByRole("button", { name: /^Add Sam .* as$/ }).click();
  await page.getByRole("menuitem", { name: /View only/ }).click();
  const addConfirmation = page.getByRole("dialog", {
    name: "Add member?",
    exact: true,
  });
  await addConfirmation
    .getByRole("button", { name: "Add with view-only access", exact: true })
    .click();
  await expect(
    sharing.getByRole("region", { name: "Member list", exact: true }),
  ).toHaveAttribute("data-refreshing", "false");
  await expect(
    sharing
      .getByRole("region", { name: "Member list", exact: true })
      .getByText("Sam", { exact: true }),
  ).toBeVisible();
  await expect(sharing.getByRole("button", { name: "Done" })).toBeEnabled();
  expect(
    (
      await page.evaluate(
        (address) => window.workingNotesFixture.readAsSam(address),
        created,
      )
    ).length,
  ).toBe(1);
  await sharing
    .getByRole("button", { name: "Actions for Sam", exact: true })
    .click();
  await page.getByRole("menuitemradio", { name: "Admin", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Change access to Admin?", exact: true })
    .getByRole("button", { name: "Set as admin", exact: true })
    .click();
  await expect(
    sharing.getByRole("region", { name: "Member list", exact: true }),
  ).toContainText("Admin");
  await expect(sharing.getByRole("button", { name: "Done" })).toBeEnabled();
  await sharing
    .getByRole("button", { name: "Actions for Sam", exact: true })
    .click();
  await page
    .getByRole("menuitemradio", { name: "Participating", exact: true })
    .click();
  await page
    .getByRole("dialog", {
      name: "Change access to Participating?",
      exact: true,
    })
    .getByRole("button", { name: "Set to participating", exact: true })
    .click();
  await expect(
    sharing.getByRole("region", { name: "Member list", exact: true }),
  ).not.toContainText("Admin");
  await expect(
    sharing.getByRole("button", { name: "Done", exact: true }),
  ).toBeEnabled();
  await sharing.getByRole("button", { name: "Copy link", exact: true }).click();
  await expect(
    sharing.getByRole("button", { name: "Link copied", exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => window.noteCopiedLink)).toBe(created.link);
  await sharing
    .getByRole("searchbox", { name: "Search people and agents" })
    .fill("");
  for (const theme of ["light", "dark"]) {
    await page.evaluate((value) => {
      document.documentElement.classList.toggle("dark", value === "dark");
    }, theme);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 950 });
      await page.evaluate((narrow) => {
        document.documentElement.style.fontSize = narrow ? "20px" : "";
      }, width === 390);
      await expect(sharing).toBeInViewport({ ratio: 1 });
      await expect(
        sharing.getByRole("searchbox", { name: "Search people and agents" }),
      ).toBeVisible();
      await expect(
        sharing.getByRole("checkbox", {
          name: "Share with my agents automatically",
        }),
      ).toHaveCount(0);
      await expect(
        sharing.getByRole("button", { name: "Done" }),
      ).toBeInViewport({
        ratio: 1,
      });
      await page.screenshot({
        path: testInfo.outputPath(`note-share-${theme}-${width}.png`),
      });
    }
  }
  await page.setViewportSize({ width: 1440, height: 950 });
  await page.evaluate(() => {
    document.documentElement.classList.remove("dark");
    document.documentElement.style.fontSize = "";
  });
  await page.keyboard.press("Escape");
  await expect(
    document.getByRole("button", { name: "Share note", exact: true }),
  ).toBeFocused();
  await document.getByRole("button", { name: "Note actions" }).click();
  await page.getByRole("menuitem", { name: "Copy note link" }).click();
  await expect(
    document.getByText("Note link copied", { exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => window.noteCopiedLink)).toBe(created.link);
  await document.getByRole("button", { name: "Note actions" }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "Export Markdown" }).click();
  expect((await download).suggestedFilename()).toBe("Delivery plan.md");
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("separator", { name: "Resize main and secondary panels" }),
  ).toHaveCount(0);
  const fullPaneWidth = await page
    .getByRole("region", { name: "Note details", exact: true })
    .evaluate((element) => element.clientWidth);
  expect((await document.boundingBox()).width).toBe(fullPaneWidth);
  for (const theme of ["light", "dark"]) {
    await page.evaluate((value) => {
      document.documentElement.classList.toggle("dark", value === "dark");
    }, theme);
    await page.screenshot({
      path: testInfo.outputPath(`note-full-${theme}.png`),
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "20px";
    });
    await expect(document).toBeVisible();
    await expect(
      page.getByRole("searchbox", { name: "Search notes" }),
    ).not.toBeVisible();
    await page
      .getByRole("button", { name: "Back to notes", exact: true })
      .click();
    await expect(
      page.getByRole("searchbox", { name: "Search notes" }),
    ).toBeFocused();
    await page.screenshot({
      path: testInfo.outputPath(`notes-list-narrow-${theme}.png`),
    });
    await page.goBack();
    await expect(document).toBeVisible();
    await mode.click();
    await page.getByRole("option", { name: "Editing", exact: true }).click();
    await expect(
      page.getByRole("option", { name: "Editing", exact: true }),
    ).toHaveCount(0);
    await expect(toolbar).toBeVisible();
    const narrowPane = await document.boundingBox();
    const narrowToolbar = await toolbar.boundingBox();
    await expect(
      toolbar.getByRole("button", { name: "Markdown source", exact: true }),
    ).toHaveCount(0);
    expect(narrowToolbar.x).toBeGreaterThan(narrowPane.x);
    expect(narrowToolbar.x + narrowToolbar.width).toBeLessThan(
      narrowPane.x + narrowPane.width,
    );
    await page.screenshot({
      path: testInfo.outputPath(`note-full-narrow-${theme}.png`),
    });
    await mode.click();
    await page.getByRole("option", { name: "Viewing", exact: true }).click();
    await page.setViewportSize({ width: 1440, height: 950 });
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "";
    });
  }
  expect(errors.unexplained()).toEqual([]);
});

test("creates, deletes and restores a working note through the editor", async ({
  page,
}) => {
  const errors = watchPageErrors(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/tests/fixtures/working-notes.html");
  await page.evaluate(() => window.workingNotesFixture.unverifyCarl());
  await page.getByRole("button", { name: "New note", exact: true }).click();
  const create = page.getByRole("article", { name: "New note", exact: true });
  await create
    .getByRole("textbox", { name: "Title", exact: true })
    .fill("Research draft");
  await create
    .getByRole("textbox", { name: "Document body", exact: true })
    .fill("A durable finding.");
  await expect(
    create.getByText(/These agents could not be verified/),
  ).toHaveCount(0);
  const document = page.getByRole("article", { name: "Research draft" });
  await expect(
    document.getByRole("combobox", { name: "Document mode", exact: true }),
  ).toContainText("Editing");
  await document
    .getByRole("combobox", { name: "Document mode", exact: true })
    .click();
  await page.getByRole("option", { name: "Viewing", exact: true }).click();
  await expect(
    page.getByRole("searchbox", { name: "Search notes" }),
  ).not.toBeVisible();
  await page
    .getByRole("button", { name: "Back to notes", exact: true })
    .click();
  await expect(
    page.getByRole("searchbox", { name: "Search notes" }),
  ).toBeVisible();
  await page.goBack();
  await expect(document).toBeVisible();

  await expect(
    document
      .getByRole("paragraph")
      .filter({ hasText: /^A durable finding\.$/ }),
  ).toBeVisible();
  await document
    .getByRole("button", { name: "Note actions", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Delete note", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Delete this note?" })
    .getByRole("button", { name: "Delete note", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Choose a revision to restore" })
    .click();
  const history = page.getByRole("dialog", { name: "Revision history" });
  await history.getByRole("button", { name: /Research draft/ }).click();
  await history
    .getByRole("button", { name: "Use this revision in editor" })
    .click();
  await page.getByRole("button", { name: "Restore note", exact: true }).click();
  await expect(
    page
      .getByRole("article", { name: "Research draft" })
      .getByRole("paragraph")
      .filter({ hasText: /^A durable finding\.$/ }),
  ).toBeVisible();
  expect(errors.unexplained()).toEqual([]);
});

test("discovers only channel-backed notes while leaving published records untouched", async ({
  page,
}) => {
  const errors = watchPageErrors(page);
  await page.goto("/tests/fixtures/working-notes.html");
  const list = page.getByRole("list", { name: "Notes", exact: true });
  await expect(list.getByRole("link")).toHaveText([
    "Connected notes plan",
    "Storage research",
  ]);
  await expect(
    page.getByRole("button", { name: "Refresh notes", exact: true }),
  ).toHaveAttribute("aria-busy", "false");
  const published = await page.evaluate(() =>
    window.workingNotesFixture.legacy(),
  );
  expect(published).toHaveLength(1);
  await page.evaluate(() =>
    window.workingNotesFixture.agentCreate(
      "Agent research",
      "Written in a private note channel.",
    ),
  );
  await page
    .getByRole("button", { name: "Refresh notes", exact: true })
    .click();
  await expect(list.getByRole("link").first()).toHaveText("Agent research");
  await list.getByRole("link", { name: "Agent research", exact: true }).click();
  const note = page.getByRole("article", {
    name: "Agent research",
    exact: true,
  });
  await expect(note).toContainText("Carl");
  await expect(note).toContainText("Saved");
  await expect(note).toContainText("Written in a private note channel.");
  await expect(
    note.getByRole("combobox", { name: "Document mode", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Back to notes", exact: true })
    .click();
  await expect(list.getByRole("link")).toHaveCount(3);
  await expect(
    list.getByRole("link", { name: "Legacy research", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Make editable copy", exact: true }),
  ).toHaveCount(0);
  const kinds = await page.evaluate(() =>
    window.workingNotesFixture.queryKinds(),
  );
  expect(kinds).toContain(45010);
  expect(kinds).not.toContain(30023);
  expect(
    await page.evaluate(() => window.workingNotesFixture.legacy()),
  ).toEqual(published);
  expect(errors.unexplained()).toEqual([]);
});

test("preserves a conflicting draft and opens note links in the conversation’s right pane", async ({
  page,
}, testInfo) => {
  const errors = watchPageErrors(page);
  await page.goto("/tests/fixtures/working-notes.html");
  await page
    .getByRole("link", { name: "Connected notes plan", exact: true })
    .click();
  const document = page.getByRole("article", { name: "Connected notes plan" });
  await disableAutoSave(page, document);
  await document
    .getByRole("combobox", { name: "Document mode", exact: true })
    .click();
  await page.getByRole("option", { name: "Editing", exact: true }).click();
  await document
    .getByRole("textbox", { name: "Document body", exact: true })
    .fill("My unsaved draft");
  await page.evaluate(() =>
    window.workingNotesFixture.agentEdit(
      window.workingNotesFixture.plan,
      "Carl’s concurrent revision",
    ),
  );
  await document.getByRole("button", { name: "Save", exact: true }).click();
  const conflict = page.getByRole("dialog", {
    name: "This note has a newer revision",
  });
  await expect(conflict).toContainText("Carl’s concurrent revision");
  await conflict
    .getByRole("button", { name: "I’ve compared; keep my draft" })
    .click();
  await expect(
    document.getByRole("textbox", { name: "Document body", exact: true }),
  ).toHaveText("My unsaved draft");
  await document.getByRole("button", { name: "Save", exact: true }).click();
  await expect(document.getByRole("status")).toHaveText(/^Saved /);
  await page.getByRole("button", { name: "Conversation", exact: true }).click();
  await page
    .getByRole("link", { name: "Connected notes plan", exact: true })
    .click();
  await expect(page.getByRole("textbox", { name: /message/i })).toBeVisible();
  await expect(
    page.getByRole("article", { name: "Connected notes plan" }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("note-beside-conversation.png"),
  });
  expect(errors.unexplained()).toEqual([]);
});

// Browser boundary: the real rich-text editor must retain native focus and
// selection through acceptance; DOM geometry proves the animated CTA's slot.
test("auto-saves the editor without losing focus and animates manual Save into the action row", async ({
  page,
}, testInfo) => {
  const errors = watchPageErrors(page);
  await page.goto("/tests/fixtures/working-notes.html");
  await page
    .getByRole("link", { name: "Connected notes plan", exact: true })
    .click();
  const document = page.getByRole("article", {
    name: "Connected notes plan",
    exact: true,
  });
  const body = document.getByRole("textbox", {
    name: "Document body",
    exact: true,
  });
  await body.fill("Automatically saved body");
  await expect(body).toBeFocused();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.workingNotesFixture.head(window.workingNotesFixture.plan.id)
            .markdown,
      ),
    )
    .toBe("Automatically saved body");
  await expect(document.getByRole("status")).toHaveText(/^Saved /);
  await expect(body).toBeFocused();
  await expect(
    document.getByRole("combobox", { name: "Document mode" }),
  ).toContainText("Editing");
  await expect(
    document.getByRole("button", { name: "Save", exact: true }),
  ).toHaveCount(0);
  await disableAutoSave(page, document);
  await body.fill("Manual body");
  const save = document.getByRole("button", { name: "Save", exact: true });
  for (const theme of ["light", "dark"]) {
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 950 });
      await page.evaluate(
        ({ theme, width }) => {
          document.documentElement.classList.toggle("dark", theme === "dark");
          document.documentElement.style.fontSize = width === 390 ? "20px" : "";
        },
        { theme, width },
      );
      await expect(save).toBeInViewport({ ratio: 1 });
      await expect
        .poll(async () => (await save.boundingBox()).width)
        .toBeGreaterThan(40);
      const order = await document.evaluate((article) => {
        const mode = article.querySelector('[role="combobox"]');
        const save = [...article.querySelectorAll("button")].find(
          (button) => button.textContent === "Save",
        );
        const refresh = article.querySelector('[aria-label="Refresh note"]');
        return (
          !!mode &&
          !!save &&
          !!refresh &&
          !!(
            mode.compareDocumentPosition(save) &
            Node.DOCUMENT_POSITION_FOLLOWING
          ) &&
          !!(
            save.compareDocumentPosition(refresh) &
            Node.DOCUMENT_POSITION_FOLLOWING
          )
        );
      });
      expect(order).toBe(true);
      const saveBox = await save.boundingBox();
      const modeBox = await document
        .getByRole("combobox", { name: "Document mode" })
        .boundingBox();
      const refreshBox = await document
        .getByRole("button", { name: "Refresh note" })
        .boundingBox();
      expect(saveBox.x).toBeGreaterThan(modeBox.x + modeBox.width);
      expect(saveBox.x + saveBox.width).toBeLessThan(refreshBox.x);
      await page.screenshot({
        path: testInfo.outputPath(`manual-save-${theme}-${width}.png`),
      });
    }
  }
  await save.click();
  await expect(document.getByRole("status")).toHaveText(/^Saved /);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.workingNotesFixture.head(window.workingNotesFixture.plan.id)
            .markdown,
      ),
    )
    .toBe("Manual body");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await document.getByRole("combobox", { name: "Document mode" }).click();
  await page.getByRole("option", { name: "Editing", exact: true }).click();
  await body.fill("Reduced motion draft");
  await expect(save).toBeVisible();
  await document.getByRole("button", { name: "Note actions" }).click();
  await page
    .getByRole("menuitem", { name: "Enable auto-save", exact: true })
    .click();
  await expect(save).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.workingNotesFixture.head(window.workingNotesFixture.plan.id)
            .markdown,
      ),
    )
    .toBe("Reduced motion draft");
  // First-save creation crosses from the blank draft to its accepted address.
  // Native rich-editor selection and history replacement need a browser.
  await page
    .getByRole("button", { name: "Back to notes", exact: true })
    .click();
  await page.getByRole("button", { name: "New note", exact: true }).click();
  const fresh = page.getByRole("article", { name: "New note", exact: true });
  await expect(page.getByRole("dialog", { name: "New note" })).toHaveCount(0);
  await expect(
    fresh.getByRole("textbox", { name: "Title", exact: true }),
  ).toBeFocused();
  await expect(
    fresh.getByRole("textbox", { name: "Title", exact: true }),
  ).toHaveValue("");
  await expect(fresh.getByRole("status")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("fresh-note.png") });
  const freshBody = fresh.getByRole("textbox", {
    name: "Document body",
    exact: true,
  });
  await freshBody.fill("A fresh thought");
  await freshBody.evaluate((field) => field.setSelectionRange(2, 7));
  const savedNew = page.getByRole("article", {
    name: "Untitled note",
    exact: true,
  });
  const savedBody = savedNew.getByRole("textbox", {
    name: "Document body",
    exact: true,
  });
  await expect(savedNew.getByRole("status")).toHaveText(/^Saved /);
  await expect(savedBody).toHaveText("A fresh thought");
  await expect(savedBody).toBeFocused();
  expect(
    await savedBody.evaluate((field) => [
      field.selectionStart,
      field.selectionEnd,
    ]),
  ).toEqual([2, 7]);
  const createdAddress = await page.evaluate(
    () => window.workingNotesFixture.navigation().entry.target.route.params,
  );
  expect(createdAddress.view).toBe("note");
  await page.goBack();
  await expect(
    page.getByRole("button", { name: "New note", exact: true }),
  ).toBeVisible();
  await page.goForward();
  await expect(savedBody).toHaveText("A fresh thought");
  await page
    .getByRole("button", { name: "Back to notes", exact: true })
    .click();
  await page.getByRole("button", { name: "New note", exact: true }).click();
  await page
    .getByRole("article", { name: "New note", exact: true })
    .getByRole("button", { name: "Share note", exact: true })
    .click();
  const explicitShare = page.getByRole("dialog", {
    name: "Share access",
    exact: true,
  });
  await expect(explicitShare).toBeVisible();
  await expect(
    explicitShare.getByRole("button", {
      name: /Actions for Carl|Actions for Ned/,
    }),
  ).toHaveCount(0);
  await explicitShare
    .getByRole("button", { name: "Done", exact: true })
    .click();
  await expect(
    page
      .getByRole("article", { name: "Untitled note", exact: true })
      .getByRole("textbox", { name: "Document body", exact: true }),
  ).toHaveText("");
  expect(errors.unexplained()).toEqual([]);
});

test("reader access hides editing while preserving history", async ({
  page,
}) => {
  const errors = watchPageErrors(page);
  await page.goto("/tests/fixtures/working-notes.html");
  await expect(page.getByRole("button", { name: "New note" })).toBeVisible();
  await page.evaluate(() =>
    window.workingNotesFixture.makeReader(window.workingNotesFixture.plan),
  );
  await page
    .getByRole("link", { name: "Connected notes plan", exact: true })
    .click();
  const document = page.getByRole("article", { name: "Connected notes plan" });
  await expect(document.getByText("You have read access.")).toBeVisible();
  await expect(
    document.getByRole("combobox", { name: "Document mode", exact: true }),
  ).toHaveCount(0);
  await expect(
    document.getByRole("textbox", { name: "Document body", exact: true }),
  ).toHaveCount(0);
  await expect(
    document.getByRole("group", { name: "Document formatting", exact: true }),
  ).toHaveCount(0);
  await document.getByRole("button", { name: "Note actions" }).click();
  await page.getByRole("menuitem", { name: "Revision history" }).click();
  await expect(
    page.getByRole("dialog", { name: "Revision history" }),
  ).toContainText("Connected notes plan");
  await expect(
    page.getByRole("button", { name: "Use this revision in editor" }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.evaluate(() =>
    window.workingNotesFixture.revoke(window.workingNotesFixture.plan),
  );
  await document.getByRole("button", { name: "Refresh note" }).click();
  await expect(
    page.getByRole("article", { name: "Working note" }).getByRole("alert"),
  ).toBeVisible();
  await expect(
    page
      .getByRole("article", { name: "Working note" })
      .getByText("A working plan for people and their agents."),
  ).toHaveCount(0);
  expect(errors.unexplained()).toEqual([]);
});
