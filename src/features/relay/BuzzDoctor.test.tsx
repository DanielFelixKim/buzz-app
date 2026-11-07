// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { useSyncExternalStore } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BuzzDoctor, useDoctorIssue } from "./BuzzDoctor";
import { doctorFixture, deferred } from "./doctor-testing";
import { ReadError } from "./errors";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { createNavigationController } from "../navigation/controller";
import { createMemoryHistory } from "../navigation/history";
import { LiveStatus } from "../../bundled/channels/LiveStatus";

const fixtures: ReturnType<typeof doctorFixture>[] = [];
const controllers: ReturnType<typeof createNavigationController>[] = [];
beforeEach(() => {
  vi.stubGlobal("matchMedia", (media: string) => ({
    media,
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
});
afterEach(() => {
  cleanup();
  for (const fixture of fixtures.splice(0)) fixture.owner.dispose();
  for (const controller of controllers.splice(0)) controller.dispose();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("keeps a catalog-only recovery out of LiveStatus while Doctor hosts its notice", async () => {
  vi.useFakeTimers();
  const h = doctorFixture({ kit: true });
  fixtures.push(h);
  h.failures.set(30078, new ReadError("unavailable", "Catalog offline", 503));
  await h.session.channelKit.refresh();
  await vi.advanceTimersByTimeAsync(3_000);
  expect(h.session.recovery?.snapshot().shown).toBe(true);
  const controller = createNavigationController(createMemoryHistory());
  controllers.push(controller);
  render(
    <ToastProvider>
      <BuzzDoctor
        relay={h.relay}
        navigation={controller.navigation}
        open={false}
        onClose={() => {}}
      >
        <LiveStatus
          live={h.session.live}
          channelId={undefined}
          partialRoster={false}
          recovery={h.session.recovery}
        />
      </BuzzDoctor>
    </ToastProvider>,
  );
  expect(
    screen.queryByRole("status", { name: "Reconnecting to relay…" }),
  ).toBeNull();
});
function LocalNotice({ source, label }: { source: object; label: string }) {
  return useDoctorIssue(source) ? null : <p role="alert">{label}</p>;
}

it("returns lost focus to the current workspace when a focused toast action recovers", async () => {
  const h = doctorFixture();
  fixtures.push(h);
  h.failures.set(30622, new ReadError("denied", "Visibility refused", 403));
  await h.session.channelLifecycle.refreshVisibility();
  const controller = createNavigationController(createMemoryHistory());
  controllers.push(controller);
  render(
    <ToastProvider>
      <BuzzDoctor
        relay={h.relay}
        navigation={controller.navigation}
        open={false}
        onClose={() => {}}
        focusTarget={() =>
          document.getElementById("doctor-return") ?? undefined
        }
      >
        <input id="doctor-return" aria-label="Draft" />
      </BuzzDoctor>
    </ToastProvider>,
  );
  const toast = await screen.findByRole("dialog", {
    name: "Buzz is having issues",
  });
  const retry = within(toast).getByRole("button", {
    name: "Retry",
  });
  retry.focus();
  h.failures.clear();
  fireEvent.click(retry);
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "Buzz is having issues" }),
    ).toBeNull(),
  );
  await waitFor(() =>
    expect(screen.getByRole("textbox", { name: "Draft" })).toHaveFocus(),
  );
});

it.each(["toast", "row"] as const)(
  "blocks repeated actions while retrying from %s",
  async (source) => {
    const h = doctorFixture();
    fixtures.push(h);
    h.failures.set(30622, new ReadError("denied", "Visibility refused", 403));
    await h.session.channelLifecycle.refreshVisibility();
    const reading = deferred<void>();
    const result = deferred<[]>();
    h.query.mockImplementation(async () => {
      reading.resolve();
      return result.promise;
    });
    const controller = createNavigationController(createMemoryHistory());
    controllers.push(controller);
    const props = {
      relay: h.relay,
      navigation: controller.navigation,
      onClose() {},
    };
    const { rerender } = render(
      <ToastProvider>
        <BuzzDoctor {...props} open={source === "row"}>
          {null}
        </BuzzDoctor>
      </ToastProvider>,
    );
    const retry =
      source === "toast"
        ? within(
            await screen.findByRole("dialog", {
              name: "Buzz is having issues",
            }),
          ).getByRole("button", { name: "Retry" })
        : screen.getByRole("button", { name: "Retry hidden conversations" });
    fireEvent.click(retry);
    await reading.promise;
    try {
      expect(retry).toHaveAttribute("aria-busy", "true");
      expect(retry).toHaveAttribute("data-loading", "true");
      expect(retry).toBeDisabled();
      fireEvent.click(retry);
      rerender(
        <ToastProvider>
          <BuzzDoctor {...props} open>
            {null}
          </BuzzDoctor>
        </ToastProvider>,
      );
      const dialog = await screen.findByRole("dialog", { name: "Buzz Doctor" });
      const row = within(dialog).getByRole("button", {
        name: "Retry hidden conversations",
      });
      const all = within(dialog).getByRole("button", {
        name: "Retry all",
      });
      for (const control of [row, all]) {
        expect(control).toBeDisabled();
        fireEvent.click(control);
      }
      expect(row).toHaveAttribute("aria-busy", "true");
      if (source === "toast") expect(all).toHaveAttribute("aria-busy", "true");
      else expect(all).not.toHaveAttribute("aria-busy", "true");
      expect(h.query).toHaveBeenCalledTimes(2);
    } finally {
      await act(async () => {
        result.resolve([]);
      });
    }
    await waitFor(() =>
      expect(
        screen.getByRole("dialog", { name: "Buzz Doctor" }),
      ).toHaveTextContent("Everything is working again"),
    );
  },
);

it("shakes failed rows after Retry all, repeats direct feedback, and respects reduced motion", async () => {
  const h = doctorFixture();
  fixtures.push(h);
  h.failures.set(30622, new ReadError("denied", "Visibility refused", 403));
  await h.session.channelLifecycle.refreshVisibility();
  const controller = createNavigationController(createMemoryHistory());
  controllers.push(controller);
  render(
    <BuzzDoctor
      relay={h.relay}
      navigation={controller.navigation}
      open
      onClose={() => {}}
    >
      {null}
    </BuzzDoctor>,
  );
  const row = screen.getByRole("button", {
    name: "Retry hidden conversations",
  });
  const all = screen.getByRole("button", { name: "Retry all" });
  const cancel = vi.fn();
  const rowAnimation = vi.fn(() => ({ cancel }) as unknown as Animation);
  const allAnimation = vi.fn(() => ({ cancel }) as unknown as Animation);
  row.animate = rowAnimation;
  all.animate = allAnimation;
  fireEvent.click(row);
  await waitFor(() => expect(rowAnimation).toHaveBeenCalledTimes(1));
  expect(allAnimation).not.toHaveBeenCalled();
  fireEvent.click(row);
  await waitFor(() => expect(rowAnimation).toHaveBeenCalledTimes(2));
  fireEvent.click(all);
  await waitFor(() => expect(allAnimation).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(rowAnimation).toHaveBeenCalledTimes(3));
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  const reads = h.query.mock.calls.length;
  fireEvent.click(row);
  await waitFor(() => expect(h.query).toHaveBeenCalledTimes(reads + 1));
  await waitFor(() => expect(row).toBeEnabled());
  expect(rowAnimation).toHaveBeenCalledTimes(3);
  h.failures.clear();
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  fireEvent.click(row);
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Retry hidden conversations" }),
    ).toBeNull(),
  );
  expect(rowAnimation).toHaveBeenCalledTimes(3);
});

it("offers one toast, opens individual actions, preserves unrelated local feedback and stays open after recovery", async () => {
  const h = doctorFixture(),
    other = doctorFixture();
  fixtures.push(h, other);
  h.failures.set(
    30622,
    new ReadError("denied", "Visibility needs permission", 403),
  );
  await h.session.channelLifecycle.refreshVisibility();
  const controller = createNavigationController(createMemoryHistory());
  controllers.push(controller);
  const navigation = controller.navigation;
  function Host() {
    const state = useSyncExternalStore(
      navigation.subscribe,
      navigation.snapshot,
    );
    return (
      <ToastProvider>
        <BuzzDoctor
          relay={h.relay}
          navigation={navigation}
          open={state.entry.target.kind === "doctor"}
          onClose={() =>
            navigation.dismiss([state.entry.id], { version: 1, kind: "home" })
          }
        >
          <LocalNotice
            source={h.session.channelLifecycle}
            label="Duplicate visibility error"
          />
          <LocalNotice
            source={other.session.channelLifecycle}
            label="Unrelated source error"
          />
        </BuzzDoctor>
      </ToastProvider>
    );
  }
  render(<Host />);
  const toast = await screen.findByRole("dialog", {
    name: "Buzz is having issues",
  });
  expect(screen.queryByText("Duplicate visibility error")).toBeNull();
  expect(screen.getByText("Unrelated source error")).toBeVisible();
  fireEvent.click(within(toast).getByRole("button", { name: "View issues" }));
  const dialog = await screen.findByRole("dialog", { name: "Buzz Doctor" });
  expect(dialog).toHaveAttribute("data-navigation-visit");
  expect(within(dialog).getByText("Visibility needs permission")).toBeVisible();
  expect(
    within(dialog).getByRole("button", { name: "Retry hidden conversations" }),
  ).toBeVisible();
  await act(async () => navigation.back());
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Buzz Doctor" })).toBeNull(),
  );
  await act(async () => navigation.forward());
  expect(
    await screen.findByRole("dialog", { name: "Buzz Doctor" }),
  ).toBeVisible();
  h.failures.clear();
  fireEvent.click(
    screen.getByRole("button", { name: "Retry hidden conversations" }),
  );
  expect(
    await screen.findByText(
      "Everything is working again. No issues need attention.",
    ),
  ).toBeVisible();
  expect(screen.getByRole("dialog", { name: "Buzz Doctor" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "Retry all" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Close Buzz Doctor" }));
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Buzz Doctor" })).toBeNull(),
  );
  await act(async () => navigation.forward());
  expect(screen.queryByRole("dialog", { name: "Buzz Doctor" })).toBeNull();
});
