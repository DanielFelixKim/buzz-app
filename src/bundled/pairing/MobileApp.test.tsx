// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { MobileSettings, mobileAppStores } from "./MobileApp";
import type { ClientSnapshot } from "../../features/communities/service";
import type { SessionSnapshot } from "../../features/federated-identity/service";
import type {
  PairingNative,
  PairingStatus,
} from "../../features/pairing/client";

vi.mock("@tauri-apps/api/core", async (actual) => ({
  ...(await actual<typeof import("@tauri-apps/api/core")>()),
  invoke: vi.fn(),
}));

beforeEach(() => {
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.mocked(invoke).mockReset();
});

const stores = [
  { name: "the App Store", url: "https://apps.example.com/ios" },
  { name: "Google Play", url: "https://apps.example.com/android" },
];

function session(status: SessionSnapshot["status"]) {
  let state = {
    status,
    email: "you@example.com",
  } as SessionSnapshot;
  const listeners = new Set<() => void>();
  return {
    snapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    publish(next: Partial<SessionSnapshot>) {
      state = { ...state, ...next };
      for (const listener of listeners) listener();
    },
  };
}

function pairing() {
  const native = {
    account: vi.fn(async () => "a".repeat(64)),
    start: vi.fn(async () => {}),
    status: vi.fn(async (): Promise<PairingStatus> => ({ phase: "idle" })),
    cancel: vi.fn(async (): Promise<PairingStatus> => ({ phase: "cancelled" })),
    confirm: vi.fn(async () => {}),
    deny: vi.fn(async () => {}),
  } satisfies PairingNative;
  const snapshot: ClientSnapshot = {
    status: "ready",
    relayAvailable: true,
    viewer: "a".repeat(64),
    selected: "wss://relay.example",
    profile: { name: "", picture: "" },
    memberships: [],
    sync: { known: [], outbox: [] },
  };
  return {
    native,
    props: {
      communities: { snapshot: () => snapshot, subscribe: () => () => {} },
      active: () => true,
    },
  };
}

it("signed in with Builderlab, says to get the app and sign in there, with each store's link and QR code, and never pairs", async () => {
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command !== "qr_code") throw new Error(`Unexpected ${command}`);
    return `<svg data-value="${(args as { value: string }).value}"/>`;
  });
  const { native, props } = pairing();
  render(
    <MobileSettings
      {...props}
      federatedIdentity={session("signed-in")}
      stores={stores}
    />,
  );
  expect(
    screen.getByRole("heading", { name: "Get Buzz on your phone" }),
  ).toBeTruthy();
  expect(
    screen.getByText(
      "Install Buzz on your phone, then sign in with Builderlab as you@example.com.",
    ),
  ).toBeTruthy();
  expect(
    screen
      .getByRole("link", { name: "Get it on the App Store" })
      .getAttribute("href"),
  ).toBe("https://apps.example.com/ios");
  expect(
    screen
      .getByRole("link", { name: "Get it on Google Play" })
      .getAttribute("href"),
  ).toBe("https://apps.example.com/android");
  const ios = await screen.findByAltText(
    "Scan with your phone to get Buzz from the App Store",
  );
  expect(decodeURIComponent(ios.getAttribute("src") ?? "")).toContain(
    'data-value="https://apps.example.com/ios"',
  );
  expect(
    await screen.findByAltText(
      "Scan with your phone to get Buzz from Google Play",
    ),
  ).toBeTruthy();
  expect(screen.queryByText(/pair/i)).toBeNull();
  expect(native.account).not.toHaveBeenCalled();
  expect(native.start).not.toHaveBeenCalled();
});

it("without store links, gives the same instructions without links", () => {
  const { props } = pairing();
  render(
    <MobileSettings
      {...props}
      federatedIdentity={session("signed-in")}
      stores={[]}
    />,
  );
  expect(
    screen.getByText(
      "Install Buzz on your phone from its app store, then sign in with Builderlab as you@example.com.",
    ),
  ).toBeTruthy();
  expect(screen.queryByRole("link")).toBeNull();
  expect(invoke).not.toHaveBeenCalled();
});

it("keeps a store's link when its QR code can't be drawn", async () => {
  vi.mocked(invoke).mockRejectedValue(new Error("no renderer"));
  const { props } = pairing();
  render(
    <MobileSettings
      {...props}
      federatedIdentity={session("signed-in")}
      stores={stores.slice(0, 1)}
    />,
  );
  await act(async () => {});
  expect(invoke).toHaveBeenCalledWith("qr_code", {
    value: "https://apps.example.com/ios",
  });
  expect(
    screen.getByRole("link", { name: "Get it on the App Store" }),
  ).toBeTruthy();
  expect(screen.queryByRole("img")).toBeNull();
});

it.each([
  ["signed out of Builderlab", session("signed-out")],
  ["in a build without Builderlab", undefined],
])("pairs the phone when %s", (_, federatedIdentity) => {
  const { native, props } = pairing();
  render(
    <MobileSettings
      {...props}
      native={native}
      available={false}
      federatedIdentity={federatedIdentity}
      stores={stores}
    />,
  );
  expect(screen.getByRole("heading", { name: "Pair mobile" })).toBeTruthy();
  expect(screen.queryByRole("link")).toBeNull();
});

it("switches to pairing when the Builderlab session ends", () => {
  const { native, props } = pairing();
  const federated = session("signed-in");
  render(
    <MobileSettings
      {...props}
      native={native}
      available={false}
      federatedIdentity={federated}
      stores={[]}
    />,
  );
  expect(
    screen.getByRole("heading", { name: "Get Buzz on your phone" }),
  ).toBeTruthy();
  act(() => federated.publish({ status: "reauthentication-required" }));
  expect(screen.getByRole("heading", { name: "Pair mobile" })).toBeTruthy();
});

it("lists only the store links the build sets", () => {
  vi.stubEnv("VITE_BUZZ_MOBILE_APP_IOS_URL", "");
  vi.stubEnv("VITE_BUZZ_MOBILE_APP_ANDROID_URL", "https://apps.example.com/a");
  expect(mobileAppStores()).toEqual([
    { name: "Google Play", url: "https://apps.example.com/a" },
  ]);
});
