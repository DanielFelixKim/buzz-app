import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

// Browser-only contract: the real session reads `#p`-addressed reactions over
// the relay transport, verifies their target by id, and the Inbox page lists,
// filters and opens them. Grouping, seen-state and trust matrices stay in the
// RTL and session tests.
test.use({
  productionBroker: true,
  readState: true,
  dmLabels: true,
  inboxReactions: true,
});

test("Inbox lists reactions to my message, filters to them and opens the message", async ({
  page,
  app,
}) => {
  await open(page, app);
  await page.getByRole("button", { name: "Inbox", exact: true }).click();
  const inbox = page.getByRole("region", { name: "Inbox", exact: true });
  const rows = inbox
    .getByRole("list", { name: "Inbox conversations" })
    .getByRole("listitem");
  const reaction = rows.filter({ hasText: "reacted" });
  await expect(reaction).toHaveCount(1);
  await expect(reaction).toContainText("Bob Fixture and 1 other reacted 👍 🎉");
  await expect(reaction).toContainText("Should we ship reactions in Inbox?");
  await expect(reaction.getByRole("img", { name: "Unread" })).toBeVisible();
  await expect(inbox.getByRole("alert")).toHaveCount(0);
  await inbox
    .getByRole("button", { name: "Inbox filters", exact: true })
    .click();
  await page
    .getByRole("menu", { name: "Inbox filters", exact: true })
    .getByRole("menuitemradio", { name: "Reactions", exact: true })
    .click();
  await expect(rows).toHaveCount(1);
  await reaction.getByRole("button", { name: /^Open / }).click();
  const detail = inbox.getByRole("region", { name: /^Conversation in / });
  await expect(
    detail.getByText("Should we ship reactions in Inbox?").first(),
  ).toBeVisible();
  await expect(reaction.getByRole("img", { name: "Unread" })).toHaveCount(0);
});
