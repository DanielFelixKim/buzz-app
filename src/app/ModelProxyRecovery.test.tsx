// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ModelProxyRecovery } from "./ModelProxyRecovery";
import { modelProxyRecovery } from "../features/agents/model-proxy-recovery";
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});
it("persists owner choices separately for each plugin", async () => {
  const user = userEvent.setup();
  const view = render(<ModelProxyRecovery plugin="trimmer" />);
  expect(
    screen.getByRole("switch", { name: "Continue if this model proxy fails" }),
  ).not.toBeChecked();
  await user.click(
    screen.getByRole("switch", { name: "Retry failed model transformations" }),
  );
  await user.click(
    screen.getByRole("switch", { name: "Continue if this model proxy fails" }),
  );
  expect(modelProxyRecovery("trimmer")).toEqual({
    retry: true,
    fallback: true,
  });
  expect(modelProxyRecovery("other")).toEqual({
    retry: false,
    fallback: false,
  });
  view.unmount();
  render(<ModelProxyRecovery plugin="trimmer" />);
  expect(
    screen.getByRole("switch", { name: "Continue if this model proxy fails" }),
  ).toBeChecked();
});
it("reports a failed save and preserves the prior choice", async () => {
  const user = userEvent.setup();
  render(<ModelProxyRecovery plugin="trimmer" />);
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("quota");
  });
  await user.click(
    screen.getByRole("switch", { name: "Continue if this model proxy fails" }),
  );
  expect(screen.getByRole("alert")).toHaveTextContent("could not be saved");
  expect(
    screen.getByRole("switch", { name: "Continue if this model proxy fails" }),
  ).not.toBeChecked();
});
