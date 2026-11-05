// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LockedCommunity } from "./LockedCommunity";
import { admits, relayGates } from "./lock";
import { federatedFixture } from "./testing";

const ipc = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: ipc.invoke }));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("admits a signed-in session, or an offline one only until its saved session ends", () => {
  const { service, publish } = federatedFixture();
  const now = Date.parse("2026-11-05T12:00:00Z");
  expect(admits(service.snapshot(), now)).toBe(false);
  publish({ status: "signed-in" });
  expect(admits(service.snapshot(), now)).toBe(true);
  publish({ status: "restoring" });
  expect(admits(service.snapshot(), now)).toBe(false);
  publish({
    status: "unavailable",
    failure: "network-unavailable",
    expiresAt: "2026-11-05T13:00:00Z",
  });
  expect(admits(service.snapshot(), now)).toBe(true);
  expect(admits(service.snapshot(), Date.parse("2026-11-05T13:00:01Z"))).toBe(
    false,
  );
  // Secure storage refusing is not the network: nothing to read offline.
  publish({ failure: "storage-unavailable" });
  expect(admits(service.snapshot(), now)).toBe(false);
  publish({ status: "reauthentication-required", failure: null });
  expect(admits(service.snapshot(), now)).toBe(false);
});

it("asks native which communities are the organization's, and ends offline reading on time", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse("2026-11-05T12:00:00Z"));
  ipc.invoke.mockResolvedValue(true);
  const { service, publish } = federatedFixture();
  const gate = relayGates(service)("wss://relay.example");
  if (!gate) throw new Error("Native gate expected");
  expect(await gate.protects).toBe(true);
  expect(ipc.invoke).toHaveBeenCalledWith("federated_identity_protects", {
    relay: "wss://relay.example",
  });
  const listener = vi.fn();
  gate.subscribe(listener);
  publish({
    status: "unavailable",
    failure: "network-timeout",
    expiresAt: "2026-11-05T12:30:00Z",
  });
  expect(gate.admits()).toBe(true);
  listener.mockClear();
  vi.advanceTimersByTime(30 * 60_000);
  expect(listener).toHaveBeenCalledOnce();
  expect(gate.admits()).toBe(false);
});

it("protects nothing without native identity", () => {
  const { service } = federatedFixture();
  expect(
    relayGates({ ...service, apiAvailable: false })("wss://relay.example"),
  ).toBeUndefined();
});

it("opens the browser sign-in once when a locked community is selected", async () => {
  const user = userEvent.setup();
  const { service, publish } = federatedFixture();
  publish({ status: "reauthentication-required" });
  vi.mocked(service.signIn).mockImplementation(async () => {
    publish({ status: "signing-in" });
    return service.snapshot();
  });
  render(<LockedCommunity identity={service} />);
  expect(
    screen.getByRole("heading", { name: "Sign in to continue" }),
  ).toBeVisible();
  expect(service.signIn).toHaveBeenCalledOnce();
  expect(
    await screen.findByText(/Finish signing in in your browser/),
  ).toBeVisible();

  // A cancel leaves the choice to the person; nothing reopens by itself.
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(
    await screen.findByText(
      "Your sign-in has ended. Sign in again to see this community.",
    ),
  ).toBeVisible();
  expect(service.signIn).toHaveBeenCalledOnce();
  await user.click(screen.getByRole("button", { name: "Sign in" }));
  expect(service.signIn).toHaveBeenCalledTimes(2);
});

it("waits while the saved sign-in is checked, and explains an offline end", () => {
  const { service, publish } = federatedFixture();
  publish({ status: "restoring" });
  render(<LockedCommunity identity={service} />);
  expect(screen.getByText("Checking your sign-in…")).toBeVisible();
  expect(service.signIn).not.toHaveBeenCalled();
  act(() => publish({ status: "unavailable", failure: "network-unavailable" }));
  expect(
    screen.getByText(
      "Your sign-in has ended. Connect to the internet to sign in again.",
    ),
  ).toBeVisible();
  expect(screen.getByRole("button", { name: "Try again" })).toBeVisible();
  expect(service.signIn).not.toHaveBeenCalled();
});

it("keeps its verdict while native checks the saved session again", async () => {
  ipc.invoke.mockRejectedValue(new Error("native-unavailable"));
  const { service, publish } = federatedFixture();
  publish({ status: "restoring" });
  const gate = relayGates(service)("wss://relay.example");
  if (!gate) throw new Error("Native gate expected");
  // An IPC failure loses only the cache gate; native still refuses the relay.
  expect(await gate.protects).toBe(false);
  expect(gate.admits()).toBe(false);
  publish({ status: "signed-in" });
  expect(gate.admits()).toBe(true);
  publish({ status: "restoring" });
  expect(gate.admits()).toBe(true);
  publish({ status: "reauthentication-required" });
  expect(gate.admits()).toBe(false);
  publish({ status: "restoring" });
  expect(gate.admits()).toBe(false);
});
