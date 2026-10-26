import { test, expect } from "./source-fixture.mjs";
import { watchPageErrors } from "./page-errors.mjs";

test("Back and Forward restore note navigation, filters, drafts, dialogs and conversation panes", async ({
  page,
}) => {
  const errors = watchPageErrors(page);
  await page.goto("/tests/fixtures/working-notes.html");
  const search = page.getByRole("searchbox", { name: "Search working notes" });
  await search.fill("Storage");
  await search.press("Enter");
  await page
    .getByRole("button", { name: /Storage research.*Findings/ })
    .click();
  let document = page.getByRole("article", {
    name: "Storage research",
    exact: true,
  });
  await document
    .getByRole("button", { name: "Edit note", exact: true })
    .click();
  await document
    .getByRole("textbox", { name: "Markdown", exact: true })
    .fill("Keep my unsaved research");
  await page.goBack();
  await expect(
    document.getByRole("button", { name: "Edit note", exact: true }),
  ).toBeVisible();
  await page.goForward();
  await expect(
    document.getByRole("textbox", { name: "Markdown", exact: true }),
  ).toHaveValue("Keep my unsaved research");
  await document.getByRole("button", { name: "Cancel editing" }).click();
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
  await page.getByRole("tab", { name: "Notes", exact: true }).click();
  await expect(search).toHaveValue("Storage");
  await page.getByRole("button", { name: "New note", exact: true }).click();
  const create = page.getByRole("dialog", { name: "New working note" });
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
  await page.getByRole("button", { name: "Existing shared notes" }).click();
  await expect(
    page.getByRole("button", { name: "Back to working notes" }),
  ).toBeVisible();
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
    .getByRole("button", { name: "Edit note", exact: true })
    .click();
  await research
    .getByRole("textbox", { name: "Markdown", exact: true })
    .fill("Unsaved pane research");
  await page.goBack();
  await expect(
    research.getByRole("button", { name: "Edit note", exact: true }),
  ).toBeVisible();
  await page.goForward();
  await expect(
    research.getByRole("textbox", { name: "Markdown", exact: true }),
  ).toHaveValue("Unsaved pane research");
  await research.getByRole("button", { name: "Cancel editing" }).click();
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
  await page
    .getByRole("button", { name: "Toggle tab pane", exact: true })
    .click();
  await expect(research).not.toBeVisible();
  await page.goBack();
  await expect(research).toBeVisible();
  await page.goForward();
  await expect(research).not.toBeVisible();
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
  await page
    .getByRole("button", { name: /Delivery plan.*Written by Carl/ })
    .click();
  const document = page.getByRole("article", { name: "Delivery plan" });
  await document
    .getByRole("button", { name: "Edit note", exact: true })
    .click();
  await document
    .getByRole("textbox", { name: "Markdown", exact: true })
    .fill("# Taylor’s revision\n\nReady for another agent.");
  await document.getByRole("button", { name: "Insert note link" }).click();
  await page
    .getByRole("combobox", { name: "Note", exact: true })
    .fill("Storage research");
  await page.getByRole("option", { name: "Storage research" }).click();
  await document.getByRole("button", { name: "Save note" }).click();
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
  await expect(
    page
      .getByRole("article", { name: "Storage research" })
      .getByRole("button", { name: "Delivery plan", exact: true }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Delivery plan" }).click();
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
  await document.getByRole("button", { name: "Note actions" }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "Export Markdown" }).click();
  expect((await download).suggestedFilename()).toBe("Delivery plan.md");
  await page.screenshot({ path: testInfo.outputPath("connected-notes.png") });
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
  const create = page.getByRole("dialog", { name: "New working note" });
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
    document.getByText("A durable finding.", { exact: true }),
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
      .getByText("A durable finding.", { exact: true }),
  ).toBeVisible();
  expect(errors.unexplained()).toEqual([]);
});

test("copies a legacy shared note deliberately while keeping the original readable", async ({
  page,
}) => {
  const errors = watchPageErrors(page);
  await page.goto("/tests/fixtures/working-notes.html");
  await page.getByRole("button", { name: "Existing shared notes" }).click();
  await page.getByRole("button", { name: "Open Carl folder" }).click();
  await page.getByRole("button", { name: /Legacy research/ }).click();
  await page.getByRole("button", { name: "Copy as working note" }).click();
  const copy = page.getByRole("dialog", { name: "New working note" });
  await expect(copy).toContainText("The original shared note stays readable.");
  await copy.getByRole("button", { name: "Create note", exact: true }).click();
  await expect(
    page
      .getByRole("article", { name: "Legacy research" })
      .getByRole("button", { name: "Edit note", exact: true }),
  ).toBeVisible();
  expect(
    (await page.evaluate(() => window.workingNotesFixture.legacy())).map(
      (note) => note.content,
    ),
  ).toEqual(["# Earlier findings\n\nKeep this shared reference readable."]);
  expect(errors.unexplained()).toEqual([]);
});

test("preserves a conflicting draft and opens note links in the conversation’s right pane", async ({
  page,
}, testInfo) => {
  const errors = watchPageErrors(page);
  await page.goto("/tests/fixtures/working-notes.html");
  await page
    .getByRole("button", { name: /Connected notes plan.*A working plan/ })
    .click();
  const document = page.getByRole("article", { name: "Connected notes plan" });
  await document
    .getByRole("button", { name: "Edit note", exact: true })
    .click();
  await document
    .getByRole("textbox", { name: "Markdown", exact: true })
    .fill("My unsaved draft");
  await page.evaluate(() =>
    window.workingNotesFixture.agentEdit(
      window.workingNotesFixture.plan,
      "Carl’s concurrent revision",
    ),
  );
  await document.getByRole("button", { name: "Save note" }).click();
  const conflict = page.getByRole("dialog", {
    name: "This note has a newer revision",
  });
  await expect(conflict).toContainText("Carl’s concurrent revision");
  await conflict
    .getByRole("button", { name: "I’ve compared; keep my draft" })
    .click();
  await expect(
    document.getByRole("textbox", { name: "Markdown", exact: true }),
  ).toHaveValue("My unsaved draft");
  await document.getByRole("button", { name: "Save note" }).click();
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
    .getByRole("button", { name: /Connected notes plan.*A working plan/ })
    .click();
  const document = page.getByRole("article", { name: "Connected notes plan" });
  await expect(document.getByText("You have read access.")).toBeVisible();
  await expect(
    document.getByRole("button", { name: "Edit note", exact: true }),
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
