import { test, expect } from "./source-fixture.mjs";
import { watchPageErrors } from "./page-errors.mjs";

async function settleNotePane(page) {
  await expect(
    page.getByRole("region", { name: "Note details", exact: true }),
  ).toBeVisible();
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
  const list = page.getByRole("list", { name: "Notes", exact: true });
  await expect(list.getByRole("link")).toHaveText([
    "Connected notes plan",
    "Storage research",
  ]);
  await expect(
    list.getByRole("link", { name: "Connected notes plan", exact: true }),
  ).toHaveAttribute("href", /^buzz:\/\/note\?/);
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
  await document
    .getByRole("combobox", { name: "Document mode", exact: true })
    .click();
  await page.getByRole("option", { name: "Editing", exact: true }).click();
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
    page.getByRole("dialog", { name: "Share Storage research" }),
  ).toBeVisible();
  await page.goBack();
  await expect(
    page.getByRole("dialog", { name: "Share Storage research" }),
  ).toHaveCount(0);
  await page.goForward();
  await expect(
    page.getByRole("dialog", { name: "Share Storage research" }),
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
  const create = page.getByRole("dialog", { name: "New note" });
  await create
    .getByRole("textbox", { name: "Title", exact: true })
    .fill("Draft survives history");
  await page.goBack();
  await expect(create).toHaveCount(0);
  await page.goForward();
  await expect(
    create.getByRole("textbox", { name: "Title", exact: true }),
  ).toHaveValue("Draft survives history");
  await page.keyboard.press("Escape");
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
    page.getByRole("dialog", { name: "Share Storage research" }),
  ).toBeVisible();
  await page.goBack();
  await expect(
    page.getByRole("dialog", { name: "Share Storage research" }),
  ).toHaveCount(0);
  await page.goForward();
  await expect(
    page.getByRole("dialog", { name: "Share Storage research" }),
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
  const canvas = document.getByRole("region", {
    name: "Document content",
    exact: true,
  });
  const mode = document.getByRole("combobox", {
    name: "Document mode",
    exact: true,
  });
  await expect(mode).toContainText("Viewing");
  await expect(document).toContainText("Carl");
  await expect(document).toContainText("Updated");
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
  const linkedNotes = page.getByRole("menuitem", {
    name: "Linked notes",
    exact: true,
  });
  await linkedNotes.focus();
  await linkedNotes.press("ArrowRight");
  const linkedMenu = page.getByRole("menu", {
    name: "Linked notes",
    exact: true,
  });
  await expect(linkedMenu).toContainText("No links from the loaded notes.");
  await page.keyboard.press("Escape");
  await expect(linkedNotes).toBeVisible();
  const menuPaint = await page
    .getByRole("menu", { name: "Note actions", exact: true })
    .evaluate(floatingPaint);
  await page.keyboard.press("Escape");
  await expect(
    document.getByRole("button", { name: "Note actions" }),
  ).toBeFocused();
  const viewingBounds = await canvas.boundingBox();
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
  await expect(document.getByText("Saved", { exact: true })).toBeVisible();
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
  const pinnedSave = await document
    .getByRole("button", { name: "Save", exact: true })
    .boundingBox();
  expect(pinnedSave.y + pinnedSave.height).toBeLessThanOrEqual(pinnedBounds.y);
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
  await expect(save).toHaveAttribute("data-size", "lg");
  const saveBounds = await save.boundingBox();
  const contentBounds = await canvas.boundingBox();
  const documentBounds = await document.boundingBox();
  expect(Math.abs(saveBounds.width - contentBounds.width)).toBeLessThan(1);
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
  await expect(document.getByText("Saved", { exact: true })).toBeVisible();
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
  const sharing = page.getByRole("dialog", { name: "Share Delivery plan" });
  await sharing
    .getByRole("textbox", { name: "Person or agent public key" })
    .fill(await page.evaluate(() => window.workingNotesFixture.sam));
  await sharing
    .getByRole("button", { name: "Share note", exact: true })
    .click();
  await expect(sharing.getByText("Sam", { exact: true })).toBeVisible();
  expect(
    (
      await page.evaluate(
        (address) => window.workingNotesFixture.readAsSam(address),
        created,
      )
    ).length,
  ).toBe(1);
  await page.evaluate(
    (address) => window.workingNotesFixture.makeAdministrator(address),
    created,
  );
  await page.keyboard.press("Escape");
  await document
    .getByRole("button", { name: "Share note", exact: true })
    .click();
  const samAccess = sharing.getByRole("combobox", {
    name: "Access for Sam",
    exact: true,
  });
  await expect(samAccess).toContainText("Administrator");
  await samAccess.click();
  await page.getByRole("option", { name: "Can edit", exact: true }).click();
  await expect(samAccess).toContainText("Can edit");
  await page.keyboard.press("Escape");
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
  const create = page.getByRole("dialog", { name: "New note" });
  await create
    .getByRole("textbox", { name: "Title", exact: true })
    .fill("Research draft");
  await create
    .getByRole("textbox", { name: "Markdown", exact: true })
    .fill("A durable finding.");
  await create
    .getByRole("button", { name: "Create note", exact: true })
    .click();
  await expect(create).toContainText("These agents could not be verified");
  await expect(create).toContainText("Carl");
  await create
    .getByRole("button", { name: "Create with verified agents" })
    .click();
  const document = page.getByRole("article", { name: "Research draft" });
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
  await expect(note).toContainText("Updated");
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
  await expect(document.getByText("Saved", { exact: true })).toBeVisible();
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
