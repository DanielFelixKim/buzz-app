// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { OnboardingScreen } from "./OnboardingScreen";

const failed = vi.hoisted(() => ({ value: false }));
vi.mock("../../bundled/builderlab/oauth/browser", async (original) => ({
  ...(await original<object>()),
  savedSignIn: { subscribe: () => () => {}, failed: () => failed.value },
}));

it("warns on every onboarding page while a retired browser sign-in isn't removed", () => {
  failed.value = true;
  render(
    <OnboardingScreen labelledBy="t" intro={<h1 id="t">Welcome</h1>}>
      {null}
    </OnboardingScreen>,
  );
  expect(screen.getByRole("alert").textContent).toMatch(/Buzz keeps trying/);
});
