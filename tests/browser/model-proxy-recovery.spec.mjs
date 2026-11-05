import {
  closeSettings,
  openSettings,
  selectSettingsSection,
} from "./navigation.mjs";
import { test, expect } from "./fixture.mjs";
test.use({ pluginFixtures: true, historyCounts: { alpha: 0, beta: 0 } });

// Real Settings owns the plugin details and browser persistence. Callback policy
// combinations stay in service tests; this checks their owner-facing entry point.
test("plugin recovery preferences survive reopening Manage plugins", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await openSettings(page);
  await selectSettingsSection(page, "Manage plugins");
  await page
    .getByRole("button", { name: "View Provider fixture details", exact: true })
    .click();
  const retry = page.getByRole("switch", {
    name: "Retry failed model transformations",
  });
  const fallback = page.getByRole("switch", {
    name: "Continue if this model proxy fails",
  });
  await expect(retry).not.toBeChecked();
  await expect(fallback).not.toBeChecked();
  await retry.click();
  await fallback.click();
  await closeSettings(page);
  await page.reload();
  await openSettings(page);
  await selectSettingsSection(page, "Manage plugins");
  await page
    .getByRole("button", { name: "View Provider fixture details", exact: true })
    .click();
  await expect(retry).toBeChecked();
  await expect(fallback).toBeChecked();
});
