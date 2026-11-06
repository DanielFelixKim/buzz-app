// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { useWorkStops } from "./use-work-stops";
import type { WorkStop } from "./work-stop";

afterEach(cleanup);

it.each(["indicator", "viewer"])(
  "reports a rejected Stop after its %s retires",
  async (removed) => {
    let reject!: (error: Error) => void;
    const control: WorkStop = {
      key: "request",
      lifecycle: true,
      interrupt: () =>
        new Promise<void>((_resolve, fail) => {
          reject = fail;
        }),
    };
    function Indicator() {
      const { stop } = useWorkStops([control]);
      return (
        <button type="button" onClick={() => void stop(control, "Agent")}>
          Stop
        </button>
      );
    }
    const content = (pending: boolean) => (
      <ToastProvider>
        {pending || removed === "indicator" ? (
          <ToastProvider>{pending ? <Indicator /> : null}</ToastProvider>
        ) : null}
      </ToastProvider>
    );
    const view = render(content(true));
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    view.rerender(content(false));
    await act(async () => reject(new Error("Connection lost")));
    expect(
      await screen.findByRole("dialog", {
        name: "Couldn’t stop Agent. Connection lost",
      }),
    ).toBeVisible();
  },
);
