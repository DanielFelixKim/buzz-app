import { test, expect } from "./fixture.mjs";
import { newChat } from "./navigation.mjs";

const solo = "33333333-3333-4333-8333-333333333333";
const team = "55555555-5555-4555-8555-555555555555";
test.use({
  productionBroker: true,
  dmLabels: true,
  dmMembers: { "dm-peer": [0] },
  channelIds: [solo, team],
  channelNames: { [solo]: "Alpha", [team]: "Beta" },
  soloChannels: [solo],
  ownSoloChannels: [solo],
  historyCounts: { [solo]: 2, [team]: 1 },
});

// Browser-only: real shell composition, routed exact-root editor, keyboard
// activation and dialog focus. Content/count matrices stay in the store tests.
test("Drafts below Inbox opens its draft filter and shares live counts with Solo, Team and DM icons", async ({
  page,
  app,
}) => {
  const root = app.histories.get(`primary/${team}`)[0].id;
  const scope = `https://primary.example:${app.viewer}`;
  await page.addInitScript(
    ({ scope, solo, team, root }) => {
      for (const [key, text] of [
        [`draft:${solo}`, "Solo pending"],
        ["draft:dm-peer", "DM pending"],
        [`draft:${team}:thread:${root}`, "Team reply pending"],
      ])
        localStorage.setItem(
          `buzz-view.v1:${JSON.stringify([scope, key])}`,
          JSON.stringify(text),
        );
    },
    { scope, solo, team, root },
  );
  await page.goto(app.origin);
  await newChat(page);
  const soloRow = page.locator(`[data-solo-channel-id="${solo}"]`);
  const dmRow = page.locator(`button[data-channel-id="dm-peer"]`);
  await expect(dmRow.locator("[data-draft-indicator]")).toBeVisible();
  // Profile resolution is independent of drafts. Neither supported label may
  // acquire the draft count as part of its accessible name.
  await expect(dmRow).toHaveAccessibleName(
    new RegExp(`^(?:Alice Fixture|${app.participants[0].slice(0, 10)})$`),
  );
  await expect(dmRow).toHaveAccessibleDescription(/1 draft/);
  const teamRow = page.locator(`button[data-channel-id="${team}"]`);
  await expect(soloRow.locator("[data-draft-indicator]")).toBeVisible();
  await expect(teamRow.locator("[data-draft-indicator]")).toBeVisible();
  await expect(soloRow).toHaveAccessibleName("Alpha");
  await expect(soloRow).toHaveAccessibleDescription("1 draft");
  await expect(teamRow).toHaveAccessibleName("Beta");
  await expect(teamRow).toHaveAccessibleDescription("1 draft");
  // Only real layout can establish a common row-edge anchor and hover stability.
  const soloPencil = soloRow.locator("[data-draft-indicator]");
  const teamPencil = teamRow.locator("[data-draft-indicator]");
  const right = (icon) =>
    icon.evaluate((node) => node.getBoundingClientRect().right);
  const expectAligned = async () => {
    await expect
      .poll(async () =>
        Math.abs((await right(soloPencil)) - (await right(teamPencil))),
      )
      .toBeLessThan(1);
  };
  await expectAligned();
  await expect
    .poll(async () =>
      Math.abs(
        (await right(dmRow.locator("[data-draft-indicator]"))) -
          (await right(teamPencil)),
      ),
    )
    .toBeLessThan(1);
  const pencilRight = await right(soloPencil);
  await soloRow.hover();
  await expectAligned();
  await expect.poll(() => right(soloPencil)).toBe(pencilRight);
  const menu = page.getByRole("button", {
    name: "Actions for Alpha",
    exact: true,
  });
  await expect(menu).toBeVisible();
  expect(
    (await menu.boundingBox()).x + (await menu.boundingBox()).width,
  ).toBeLessThanOrEqual((await soloPencil.boundingBox()).x);
  await teamRow.hover();
  await expectAligned();
  const pages = page.getByRole("navigation", { name: "Pages", exact: true });
  const drafts = pages.getByRole("button", { name: /^Drafts/ });
  await expect(drafts).toHaveAccessibleName("Drafts");
  await expect(drafts).toHaveAccessibleDescription("3 drafts");
  await expect(drafts.locator("[data-draft-count]")).toHaveText("3");
  expect(
    await pages.locator(".navigation-item-label").allTextContents(),
  ).toEqual(expect.arrayContaining(["Inbox", "Drafts"]));
  await drafts.focus();
  await drafts.press("Enter");
  const inbox = page.getByRole("region", { name: "Inbox", exact: true });
  await expect(inbox.getByRole("button", { name: "Inbox filters" })).toHaveText(
    "Drafts",
  );
  const inboxButton = pages.getByRole("button", { name: "Inbox", exact: true });
  await expect(drafts).toHaveAttribute("aria-current", "page");
  await expect(inboxButton).not.toHaveAttribute("aria-current");
  const filter = inbox.getByRole("button", { name: "Inbox filters" });
  await filter.click();
  await page.getByRole("menuitemradio", { name: "All", exact: true }).click();
  await expect(inboxButton).toHaveAttribute("aria-current", "page");
  await expect(drafts).not.toHaveAttribute("aria-current");
  await newChat(page);
  await page.goBack();
  await expect(filter).toHaveText("All");
  await expect(inboxButton).toHaveAttribute("aria-current", "page");
  await page.goForward();
  await expect(drafts).not.toHaveAttribute("aria-current");
  await page.goBack();
  await expect(filter).toHaveText("All");
  await drafts.click();
  await expect(drafts).toHaveAttribute("aria-current", "page");
  await inboxButton.click();
  await expect(filter).toHaveText("All");
  await drafts.click();
  await expect(filter).toHaveText("Drafts");
  await newChat(page);
  await page.goBack();
  await expect(filter).toHaveText("Drafts");
  await expect(drafts).toHaveAttribute("aria-current", "page");
  const list = inbox.getByRole("list", { name: "Drafts", exact: true });
  await list
    .getByRole("listitem")
    .filter({ hasText: "Team reply pending" })
    .getByRole("button")
    .click();
  const editor = inbox.getByRole("textbox", { name: "Reply to thread" });
  await expect(editor).toContainText("Team reply pending");
  // Saved text can render before the root is ready. Use the editor's keyboard
  // selection so deletion observes its own selection state.
  await expect(editor).toBeEditable();
  await expect(editor).toBeFocused();
  await editor.press("ControlOrMeta+A");
  await expect
    .poll(() =>
      editor.evaluate((node) => [node.selectionStart, node.selectionEnd]),
    )
    .toEqual([0, "Team reply pending".length]);
  await editor.press("Backspace");
  await expect(editor).toHaveText("");
  await expect(drafts).toHaveAccessibleDescription("2 drafts");
  await expect(drafts.locator("[data-draft-count]")).toHaveText("2");
  await expect(teamRow.locator("[data-draft-indicator]")).toHaveCount(0);
  await expect(teamRow).toHaveAccessibleDescription("");
  await inbox
    .getByRole("button", { name: "Close detail", exact: true })
    .click();
  await list
    .getByRole("listitem")
    .filter({ hasText: "DM pending" })
    .getByRole("button")
    .click();
  await inbox
    .getByRole("button", { name: "Delete draft…", exact: true })
    .click();
  await page
    .getByRole("alertdialog", { name: "Delete draft?" })
    .getByRole("button", { name: "Delete draft", exact: true })
    .click();
  await expect(drafts).toHaveAccessibleDescription("1 draft");
  await expect(dmRow.locator("[data-draft-indicator]")).toHaveCount(0);
  await list
    .getByRole("listitem")
    .filter({ hasText: "Solo pending" })
    .getByRole("button")
    .click();
  await inbox
    .getByRole("button", { name: "Delete draft…", exact: true })
    .click();
  await page
    .getByRole("alertdialog", { name: "Delete draft?" })
    .getByRole("button", { name: "Delete draft", exact: true })
    .click();
  await expect(drafts).toHaveText("Drafts");
  await expect(soloRow.locator("[data-draft-indicator]")).toHaveCount(0);
  await expect(soloRow).toHaveAccessibleDescription("");
  await expect(inbox.getByText("No drafts", { exact: true })).toBeVisible();
});
