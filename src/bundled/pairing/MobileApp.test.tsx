// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
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
  // No native QR renderer unless a test supplies one.
  vi.mocked(invoke).mockRejectedValue(new Error("no renderer"));
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

const viewer = "a".repeat(64);
type Reply = { status: number; body: string } | Promise<never>;
const status = (current: string | null, backups: string[]): Reply => ({
  status: 200,
  body: JSON.stringify({
    current_nostr_pubkey: current,
    backup_nostr_pubkeys: backups,
  }),
});
const restorable = () => status(viewer, [viewer]);

function session(
  state: SessionSnapshot["status"],
  reply: () => Reply | Promise<Reply> = restorable,
) {
  let snapshot = {
    status: state,
    email: "you@example.com",
    revision: "r1",
    authority: { apiBasePath: "/api/goose/" },
  } as SessionSnapshot;
  const listeners = new Set<() => void>();
  return {
    snapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    request: vi.fn(async () => (await reply()) as never),
    publish(next: Partial<SessionSnapshot>) {
      snapshot = { ...snapshot, ...next };
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
    viewer,
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

const GET_THE_APP = { name: "Get Buzz on your phone" };
const PAIR = { name: "Pair mobile" };

function renderCard(
  federatedIdentity: ReturnType<typeof session> | undefined,
  cardStores: readonly { name: string; url: string }[] = stores,
) {
  const { native, props } = pairing();
  render(
    <MobileSettings
      {...props}
      native={native}
      available={false}
      federatedIdentity={federatedIdentity}
      stores={cardStores}
    />,
  );
  return native;
}

it("when this key is the account's backed-up key, says to get the app and sign in there, with each store's link and QR code, and never pairs", async () => {
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command !== "qr_code") throw new Error(`Unexpected ${command}`);
    return `<svg data-value="${(args as { value: string }).value}"/>`;
  });
  const federated = session("signed-in");
  const native = renderCard(federated);
  expect(await screen.findByRole("heading", GET_THE_APP)).toBeTruthy();
  expect(federated.request).toHaveBeenCalledExactlyOnceWith({
    path: "/api/goose/v1/buzz/nsec-backups/status",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
    timeoutMs: 10_000,
  });
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

it("while the account is read, shows neither view, so pairing never mounts", async () => {
  let answer!: (reply: Reply) => void;
  const federated = session(
    "signed-in",
    () => new Promise<Reply>((resolve) => (answer = resolve)),
  );
  renderCard(federated);
  await waitFor(() => expect(federated.request).toHaveBeenCalledOnce());
  expect(screen.queryByRole("heading", PAIR)).toBeNull();
  expect(screen.queryByRole("heading", GET_THE_APP)).toBeNull();
  await act(async () => answer(restorable()));
  expect(screen.getByRole("heading", GET_THE_APP)).toBeTruthy();
  expect(screen.queryByRole("heading", PAIR)).toBeNull();
});

it.each([
  ["no backup", () => status(viewer, [])],
  ["no key linked", () => status(null, [viewer])],
  [
    "a different key linked",
    () => status("b".repeat(64), [viewer, "b".repeat(64)]),
  ],
  [
    "this key backed up but another linked",
    () => status("b".repeat(64), [viewer]),
  ],
  ["a refused read", () => ({ status: 403, body: "{}" })],
  ["an unreadable reply", () => ({ status: 200, body: "not json" })],
  ["a failed read", () => Promise.reject(new Error("timed out"))],
])("pairs the phone with %s", async (_, reply) => {
  const federated = session("signed-in", reply as () => Reply);
  renderCard(federated);
  expect(await screen.findByRole("heading", PAIR)).toBeTruthy();
  expect(screen.queryByRole("heading", GET_THE_APP)).toBeNull();
});

it("without store links, gives the same instructions without links", async () => {
  renderCard(session("signed-in"), []);
  expect(
    await screen.findByText(
      "Install Buzz on your phone from its app store, then sign in with Builderlab as you@example.com.",
    ),
  ).toBeTruthy();
  expect(screen.queryByRole("link")).toBeNull();
  expect(invoke).not.toHaveBeenCalledWith("qr_code", expect.anything());
});

it("keeps a store's link when its QR code can't be drawn", async () => {
  renderCard(session("signed-in"), stores.slice(0, 1));
  expect(
    await screen.findByRole("link", { name: "Get it on the App Store" }),
  ).toBeTruthy();
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("qr_code", {
      value: "https://apps.example.com/ios",
    }),
  );
  expect(screen.queryByRole("img")).toBeNull();
});

it.each([
  ["signed out of Builderlab", () => session("signed-out")],
  ["in a build without Builderlab", () => undefined],
])("pairs the phone without reading the account when %s", (_, make) => {
  const federated = make();
  renderCard(federated);
  expect(screen.getByRole("heading", PAIR)).toBeTruthy();
  expect(screen.queryByRole("link")).toBeNull();
  if (federated) expect(federated.request).not.toHaveBeenCalled();
});

it("switches to pairing when the Builderlab session ends", async () => {
  const federated = session("signed-in");
  renderCard(federated, []);
  expect(await screen.findByRole("heading", GET_THE_APP)).toBeTruthy();
  act(() => federated.publish({ status: "reauthentication-required" }));
  expect(screen.getByRole("heading", PAIR)).toBeTruthy();
});

it("lists only the store links the build sets", () => {
  vi.stubEnv("VITE_BUZZ_MOBILE_APP_IOS_URL", "");
  vi.stubEnv("VITE_BUZZ_MOBILE_APP_ANDROID_URL", "https://apps.example.com/a");
  expect(mobileAppStores()).toEqual([
    { name: "Google Play", url: "https://apps.example.com/a" },
  ]);
});
