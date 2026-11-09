// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { npubEncode } from "nostr-tools/nip19";
import { ToastProvider } from "../shared/design-system/ui/Toast";
import {
  type BackupStatus,
  createBackupStatus,
} from "../features/identity/backup";
import { BACKUP_FAILURES } from "../features/identity/backup-failure";
import { backupOfferedFor } from "../features/identity/builderlab-account";
import type { Identity } from "../features/identity/service";
import type {
  FederatedIdentity,
  SessionSnapshot,
} from "../features/federated-identity/service";
import { CHANNEL_ACTIVITY_KINDS } from "../features/relay/channel-activity";
import { IdentitySettings, keyActivity } from "./IdentitySettings";
import { FOLLOW_MS, SETTLED_MS } from "./landing";
import { federatedFixture } from "../features/federated-identity/testing";

vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  Channel: class {
    constructor(public onmessage: (status: unknown) => void) {}
  },
}));

const viewer = "ab".repeat(32);
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

type Send = NonNullable<Parameters<typeof createBackupStatus>[0]>;
type Progress<S = BackupStatus> = S extends unknown
  ? Omit<S, "seq" | "pass" | "builderlab">
  : never;
const at = (seq: number, progress: Progress, builderlab = true) =>
  ({ seq, pass: seq, builderlab, ...progress }) as BackupStatus;

/** The real status store over a native side that answers `initial` and records its watcher. */
function backupHost(initial: BackupStatus) {
  const watchers: { onmessage: (status: BackupStatus) => void }[] = [];
  const send = vi.fn(
    async (
      command: string,
      args?: Record<string, unknown>,
    ): Promise<unknown> => {
      if (command === "nsec_backup_watch") {
        watchers.push(args?.onEvent as (typeof watchers)[number]);
        return undefined;
      }
      if (command === "nsec_backup_state") return initial;
      throw new Error(`Unexpected command: ${command}`);
    },
  );
  const store = createBackupStatus(send as Send);
  const setBackupChoice = vi.fn(async (pubkey: string, automatic: boolean) => ({
    available: true,
    pubkey,
    automatic,
  }));
  return {
    identity: {
      exportKey: vi.fn(),
      backup: store,
      setBackupChoice,
    } as unknown as Identity,
    setBackupChoice,
    push: (status: BackupStatus) =>
      act(() => watchers.at(-1)?.onmessage(status)),
    /** Settles once the row's own offer check has: it started first on the same store. */
    settled: () => act(() => backupOfferedFor(store)),
  };
}

const renderBackup = (initial: BackupStatus) => {
  const host = backupHost(initial);
  render(<IdentitySettings viewer={viewer} identity={host.identity} />);
  return host;
};
const backupRow = () => screen.queryByText("Identity sync");
/** The row's live feedback and indicator, of which at most one has text. */
const status = () =>
  screen
    .getAllByRole("status")
    .find((region) => region.textContent) as HTMLElement;
const description = () =>
  screen.getByText(
    "Save your identity key with your Builderlab account so you can log in more easily on another device.",
  );
it("shows exact public identity formats and copies either value", async () => {
  const writeText = vi.fn(async () => {});
  const user = userEvent.setup();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  render(<IdentitySettings viewer={viewer} />, {
    wrapper: ToastProvider,
  });

  expect(screen.getByText(viewer, { exact: true })).toHaveTextContent(viewer);
  expect(
    screen.getByText(npubEncode(viewer), { exact: true }),
  ).toHaveTextContent(npubEncode(viewer));

  await user.click(screen.getByRole("button", { name: "Copy public key" }));
  expect(writeText).toHaveBeenLastCalledWith(viewer);
  expect(screen.getByText("Public key copied.")).toBeVisible();

  await user.click(screen.getByRole("button", { name: "Copy nostr address" }));
  expect(writeText).toHaveBeenLastCalledWith(npubEncode(viewer));
  expect(screen.getByText("Nostr address copied.")).toBeVisible();
});

it("keeps copy feedback bound to the latest identity action", async () => {
  let finishPublicKey: (() => void) | undefined;
  const publicKeyWrite = new Promise<void>((resolve) => {
    finishPublicKey = resolve;
  });
  const writeText = vi
    .fn()
    .mockReturnValueOnce(publicKeyWrite)
    .mockResolvedValueOnce(undefined);
  const user = userEvent.setup();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  render(<IdentitySettings viewer={viewer} />, {
    wrapper: ToastProvider,
  });

  await user.click(screen.getByRole("button", { name: "Copy public key" }));
  await user.click(screen.getByRole("button", { name: "Copy nostr address" }));
  expect(screen.getByText("Nostr address copied.")).toBeVisible();

  finishPublicKey?.();
  await publicKeyWrite;
  expect(screen.getByText("Nostr address copied.")).toBeVisible();
  expect(screen.queryByText("Public key copied.")).not.toBeInTheDocument();
});

it("keeps the identity selectable and explains manual recovery when copy fails", async () => {
  const user = userEvent.setup();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: vi.fn(async () => Promise.reject(new Error("denied"))),
    },
  });
  render(<IdentitySettings viewer={viewer} />, {
    wrapper: ToastProvider,
  });

  const publicKey = screen.getByText(viewer, { exact: true });
  await user.click(screen.getByRole("button", { name: "Copy public key" }));
  expect(screen.getByText(/Select it and copy manually\./)).toBeVisible();

  // Native text selection is exercised in both browser engines.
  expect(publicKey.tagName).toBe("CODE");
  expect(publicKey).toHaveTextContent(viewer);
  expect(
    screen.queryByRole("textbox", { name: "Public key (hex)" }),
  ).toBeNull();
});

it("clears a revealed key when leaving identity settings and starts masked on return", async () => {
  const exportKey = vi.fn().mockResolvedValue("nsec-public-test-fixture");
  const identity = {
    exportKey,
    backup: backupHost(at(1, { status: "idle" })).identity.backup,
  } as unknown as Identity;
  const user = userEvent.setup();
  const view = render(<IdentitySettings viewer={viewer} identity={identity} />);
  expect(exportKey).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Reveal private key" }));
  expect(screen.getByLabelText("Private key (nsec)")).toHaveValue(
    "nsec-public-test-fixture",
  );
  view.rerender(<div />);
  expect(screen.queryByLabelText("Private key (nsec)")).toBeNull();
  view.rerender(<IdentitySettings viewer={viewer} identity={identity} />);
  expect(screen.getByLabelText("Private key (nsec)")).toHaveValue(
    "••••••••••••••••",
  );
  expect(exportKey).toHaveBeenCalledTimes(1);
});

// Methods that need their receiver, like the real service's class methods.
function bound(service: FederatedIdentity): FederatedIdentity {
  const self: FederatedIdentity = {
    apiAvailable: service.apiAvailable,
    request: service.request,
    snapshot: service.snapshot,
    subscribe: service.subscribe,
    signIn() {
      expect(this).toBe(self);
      return service.signIn();
    },
    cancelSignIn() {
      expect(this).toBe(self);
      return service.cancelSignIn();
    },
    signOut() {
      expect(this).toBe(self);
      return service.signOut();
    },
  };
  return self;
}

it("shows the organization account and signs out of it once", async () => {
  const h = federatedFixture();
  h.publish({ status: "signed-in", email: "a@example.com" });
  render(
    <IdentitySettings viewer={viewer} federatedIdentity={bound(h.service)} />,
    {
      wrapper: ToastProvider,
    },
  );
  expect(screen.getByText("Signed in as a@example.com")).toBeVisible();
  expect(screen.getByText(/builderlab\.example login/)).toBeVisible();
  await userEvent.click(
    screen.getByRole("button", { name: "Sign out of organization" }),
  );
  expect(h.service.signOut).toHaveBeenCalledTimes(1);
  expect(await screen.findByRole("button", { name: "Sign in" })).toBeVisible();
});

it("shows when the organization sign-in ends", () => {
  const h = federatedFixture();
  const expiresAt = "2026-11-08T19:00:00Z";
  h.publish({ status: "signed-in", email: "a@example.com", expiresAt });
  render(<IdentitySettings viewer={viewer} federatedIdentity={h.service} />, {
    wrapper: ToastProvider,
  });
  const expires = new Date(expiresAt).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  const subtitle = screen.getByText(/^Expires at /);
  expect(subtitle).toHaveTextContent(`Expires at ${expires}Lets you`);
  expect(subtitle.querySelector("br")).not.toBeNull();
});

it("signs in to the organization once when signed out", async () => {
  const h = federatedFixture();
  render(
    <IdentitySettings viewer={viewer} federatedIdentity={bound(h.service)} />,
    {
      wrapper: ToastProvider,
    },
  );
  await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
  expect(h.service.signIn).toHaveBeenCalledTimes(1);
});

it("hides organization sign-in without an authority", () => {
  const h = federatedFixture();
  h.publish({ status: "unconfigured", authority: null });
  render(<IdentitySettings viewer={viewer} federatedIdentity={h.service} />, {
    wrapper: ToastProvider,
  });
  expect(screen.queryByText("Organization sign-in")).not.toBeInTheDocument();
});

it("keeps a failed organization sign-out visible when storage refuses", async () => {
  const h = federatedFixture();
  h.publish({ status: "signed-in", email: "a@example.com" });
  vi.mocked(h.service.signOut).mockImplementationOnce(async () => {
    h.publish({ status: "unavailable", failure: "storage-busy" });
    return h.service.snapshot();
  });
  render(
    <IdentitySettings viewer={viewer} federatedIdentity={bound(h.service)} />,
    {
      wrapper: ToastProvider,
    },
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Sign out of organization" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Secure storage is busy",
  );
});

it("places organization sign-in below signing out of Buzz", () => {
  const h = federatedFixture();
  const { identity } = backupHost(at(1, { status: "idle" }));
  render(
    <IdentitySettings
      viewer={viewer}
      identity={identity}
      federatedIdentity={bound(h.service)}
    />,
    { wrapper: ToastProvider },
  );
  const signOut = screen.getByRole("button", { name: "Sign out of Buzz" });
  const organization = screen.getByText("Organization sign-in");
  expect(
    signOut.compareDocumentPosition(organization) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
});

it.each([
  [{ status: "complete" }, "Synced with Builderlab"],
  [{ status: "running" }, "Syncing…"],
  [
    { status: "waiting", reason: "no_session" },
    "Sign in to Builderlab to sync your identity.",
  ],
  [
    { status: "waiting", reason: "not_linked" },
    BACKUP_FAILURES.not_linked.message,
  ],
  // First run offers no Try again for it, but a new sign-in clears it.
  [
    { status: "failed", kind: "signed_out" },
    "Your Builderlab sign-in is no longer valid, so your key wasn’t backed up. Buzz tries again when you next sign in to Builderlab.",
  ],
  // Settings has no Try again, so a retryable failure names what will retry.
  ...(["busy", "unreachable", "unconfirmed", "storage"] as const).map(
    (kind) =>
      [
        { status: "failed", kind },
        `${BACKUP_FAILURES[kind].cause} Buzz tries again when you next sign in to Builderlab.`,
      ] as const,
  ),
] as const)(
  "reads the uploader's %o status as one sentence beside the fixed description",
  async (progress, sentence) => {
    vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://builderlab.example");
    await renderBackup(at(1, progress)).settled();
    expect(backupRow()).toBeVisible();
    expect(description()).toBeVisible();
    expect(status().textContent).toBe(sentence);
  },
);

const sync = { name: "Sync with Builderlab" };
const prompt = () =>
  screen.getByRole("alertdialog", {
    name: "Sync your identity with Builderlab?",
  });

it("while backup waits for consent, Sync with Builderlab opens the backup prompt and saves its answer", async () => {
  vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://builderlab.example");
  const host = renderBackup(at(1, { status: "waiting", reason: "no_consent" }));
  await host.settled();
  const user = userEvent.setup();
  // Missing consent says nothing about whether the account holds a copy.
  expect(description()).toBeVisible();
  for (const region of screen.getAllByRole("status"))
    expect(region).toBeEmptyDOMElement();
  await user.click(screen.getByRole("button", sync));
  const open = prompt();
  // Closing saves nothing, and the surviving action takes focus back.
  await user.keyboard("{Escape}");
  await waitFor(() => expect(open).not.toBeInTheDocument());
  expect(host.setBackupChoice).not.toHaveBeenCalled();
  await waitFor(() => expect(screen.getByRole("button", sync)).toHaveFocus());
  await user.click(screen.getByRole("button", sync));
  await user.click(within(prompt()).getByRole("button", sync));
  expect(host.setBackupChoice).toHaveBeenCalledExactlyOnceWith(viewer, true);
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  // The saved choice wakes the uploader, and the action goes with the wait.
  host.push(at(2, { status: "running" }));
  expect(screen.queryByRole("button", sync)).toBeNull();
});

it("closes the prompt when the consent wait settles without its answer", async () => {
  vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://builderlab.example");
  const host = renderBackup(at(1, { status: "waiting", reason: "no_consent" }));
  await host.settled();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", sync));
  const open = prompt();
  // Every pass runs before admission, even one that waits for consent again.
  host.push(at(2, { status: "running" }));
  host.push(at(3, { status: "waiting", reason: "no_consent" }));
  expect(open).toBeVisible();
  // A hosted membership saved consent elsewhere, and its pass backed up.
  host.push(at(4, { status: "running" }));
  host.push(at(5, { status: "complete" }));
  await waitFor(() => expect(open).not.toBeInTheDocument());
  expect(host.setBackupChoice).not.toHaveBeenCalled();
  await waitFor(() =>
    expect(description().closest("[tabindex]")).toHaveFocus(),
  );
});

// Native publishes `running` before it answers, but the two reach the page
// on different channels, so either can arrive first.
it.each([
  ["after the save is answered", false],
  ["before the save is answered", true],
] as const)(
  "Sync leaves focus on the row's description when the consent wait ends %s",
  async (_, waitEndsFirst) => {
    vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://builderlab.example");
    const host = renderBackup(
      at(1, { status: "waiting", reason: "no_consent" }),
    );
    await host.settled();
    let answer = () => {};
    host.setBackupChoice.mockImplementationOnce(
      (pubkey, automatic) =>
        new Promise((resolve) => {
          answer = () => resolve({ available: true, pubkey, automatic });
        }),
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", sync));
    await user.click(within(prompt()).getByRole("button", sync));
    expect(host.setBackupChoice).toHaveBeenCalledExactlyOnceWith(viewer, true);
    if (waitEndsFirst) host.push(at(2, { status: "running" }));
    await act(async () => answer());
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    if (!waitEndsFirst) host.push(at(2, { status: "running" }));
    expect(screen.queryByRole("button", sync)).toBeNull();
    expect(status()).toHaveTextContent("Syncing…");
    await waitFor(() =>
      expect(description().closest("[tabindex]")).toHaveFocus(),
    );
  },
);

it("hides the backup row wherever first run would not offer backup", async () => {
  vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://builderlab.example");
  // This build's uploader has no Builderlab source.
  await renderBackup(at(1, { status: "complete" }, false)).settled();
  expect(backupRow()).toBeNull();
  cleanup();
  // A build with no portal of its own never hands a credential over.
  vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "");
  await renderBackup(at(1, { status: "complete" })).settled();
  expect(backupRow()).toBeNull();
  // The public identity is unaffected.
  expect(screen.getByText(viewer, { exact: true })).toBeVisible();
});

it("follows the status store as it publishes a higher seq", async () => {
  vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://builderlab.example");
  const host = renderBackup(at(1, { status: "idle" }));
  await host.settled();
  expect(status()).toHaveTextContent(
    "Buzz hasn’t checked whether your identity is synced since it opened.",
  );
  host.push(at(2, { status: "running" }));
  expect(status()).toHaveTextContent("Syncing…");
  host.push(at(3, { status: "failed", kind: "busy" }));
  const busy = /^Another backup of this key is in progress\. Buzz tries/;
  expect(status()).toHaveTextContent(busy);
  // A late, lower seq is not newer news.
  host.push(at(2, { status: "complete" }));
  expect(status()).toHaveTextContent(busy);
  host.push(at(4, { status: "complete" }));
  expect(status()).toHaveTextContent("Synced with Builderlab");
  // Read-only: no consent, retry or other control beside the status.
  const row = status().closest(".buzz-preference-row") as HTMLElement;
  expect(within(row).queryByRole("button")).toBeNull();
  expect(within(row).queryByRole("switch")).toBeNull();
});

/** bb-acme first, then bb-public, each with its own session. */
function twoServers() {
  const block = federatedFixture("block", "will@acme.example");
  const pub = federatedFixture("public", "will@example.com");
  block.publish({
    authority: {
      id: "bb-acme",
      identityOrigin: "https://acme.builderlab.xyz",
      apiBasePath: "/api/goose/",
      signIn: "at-launch",
      organization: "Acme",
      communityHosts: ["buzz.acme.builderlab.xyz"],
    },
  });
  pub.publish({
    authority: {
      id: "bb-public",
      identityOrigin: "https://app.builderlab.xyz",
      apiBasePath: "/api/goose/",
      signIn: "on-demand",
      organization: null,
      communityHosts: ["*.communities.buzz.xyz", "communities.buzz.xyz"],
    },
  });
  const root: FederatedIdentity = {
    ...block.service,
    forServer: (id) => (id === "bb-acme" ? block.service : pub.service),
  };
  const servers = async () => [
    block.service.snapshot(),
    pub.service.snapshot(),
  ];
  return { block, pub, root, servers };
}
const memberships = [
  { id: "wss://buzz.acme.builderlab.xyz", name: "Acme" },
  { id: "wss://will.communities.buzz.xyz", name: "will" },
  { id: "wss://kalvin.communities.buzz.xyz", name: "kalvin" },
  { id: "wss://buzz.homelab.example", name: "homelab" },
];

it("lists each signed-in server and signs out of one without touching the other", async () => {
  const { block, pub, root, servers } = twoServers();
  block.publish({ status: "signed-in", email: "will@acme.example" });
  pub.publish({ status: "signed-in", email: "will@example.com" });
  render(
    <IdentitySettings
      viewer={viewer}
      federatedIdentity={root}
      memberships={memberships}
      servers={servers}
    />,
    { wrapper: ToastProvider },
  );
  expect(await screen.findByText("Acme (acme.builderlab.xyz)")).toBeVisible();
  expect(screen.getByText("app.builderlab.xyz")).toBeVisible();
  expect(screen.getByText(/Used by: Acme$/)).toBeVisible();
  expect(screen.getByText(/Used by: will, kalvin$/)).toBeVisible();
  // A self-hosted relay has no sign-in server.
  expect(screen.queryByText(/homelab/)).not.toBeInTheDocument();
  await userEvent.click(
    screen.getByRole("button", { name: "Sign out of app.builderlab.xyz" }),
  );
  expect(pub.service.signOut).toHaveBeenCalledOnce();
  expect(block.service.signOut).not.toHaveBeenCalled();
  expect(block.service.snapshot().status).toBe("signed-in");
  expect(screen.queryByText("app.builderlab.xyz")).not.toBeInTheDocument();
  expect(screen.getByText("Acme (acme.builderlab.xyz)")).toBeVisible();
});

it("keeps the first server's sign-in row when no server is signed in", async () => {
  const { root, servers } = twoServers();
  render(
    <IdentitySettings
      viewer={viewer}
      federatedIdentity={root}
      servers={servers}
    />,
    { wrapper: ToastProvider },
  );
  expect(await screen.findByText("Not signed in")).toBeVisible();
  expect(screen.getByText(/acme\.builderlab\.xyz login/)).toBeVisible();
  expect(screen.getByRole("button", { name: "Sign in" })).toBeVisible();
});

it("keeps the first server's sign-in row, named, beside a signed-in server", async () => {
  const { block, pub, root, servers } = twoServers();
  block.publish({
    status: "reauthentication-required",
    failure: "reauthentication-required",
  });
  pub.publish({ status: "signed-in", email: "will@example.com" });
  render(
    <IdentitySettings
      viewer={viewer}
      federatedIdentity={root}
      memberships={memberships}
      servers={servers}
    />,
    { wrapper: ToastProvider },
  );
  expect(await screen.findByText("Acme (acme.builderlab.xyz)")).toBeVisible();
  expect(screen.getByText(/^Not signed in/)).toBeVisible();
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Your sign-in has expired. Sign in again to continue.",
  );
  expect(
    screen.getByRole("button", { name: "Sign out of app.builderlab.xyz" }),
  ).toBeVisible();
  expect(screen.getAllByText("Organization sign-in")).toHaveLength(1);
  await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
  expect(block.service.signIn).toHaveBeenCalledOnce();
  expect(pub.service.signIn).not.toHaveBeenCalled();
  expect(pub.service.signOut).not.toHaveBeenCalled();
});

it("names the first server's failed restore beside a signed-in server, without controls", async () => {
  const { block, pub, root, servers } = twoServers();
  block.publish({ status: "unavailable", failure: "storage-denied" });
  pub.publish({ status: "signed-in", email: "will@example.com" });
  render(
    <IdentitySettings
      viewer={viewer}
      federatedIdentity={root}
      memberships={memberships}
      servers={servers}
    />,
    { wrapper: ToastProvider },
  );
  expect(await screen.findByText("Acme (acme.builderlab.xyz)")).toBeVisible();
  expect(screen.getByRole("alert")).toHaveTextContent(
    /^Sign-in could not access secure storage\./,
  );
  expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
});

it.each([false, true])(
  "keeps Organization sign-in focused through each replacement while it holds focus, in view again until the user scrolls (scrolled: %s)",
  async (scrolled) => {
    const { block, root } = twoServers();
    block.publish({ status: "signed-in", email: "will@acme.example" });
    let list!: (servers: readonly SessionSnapshot[]) => void;
    const servers = () =>
      new Promise<readonly SessionSnapshot[]>((resolve) => {
        list = resolve;
      });
    // Settings' scrollport. The first landing stops short, 48px down, while
    // the list below the heading is still loading; once it has, the heading
    // reaches the top at 127px.
    const port = document.body.appendChild(document.createElement("div"));
    port.style.overflowY = "auto";
    let top = 0;
    Object.defineProperty(port, "scrollTop", {
      configurable: true,
      get: () => top,
      set: (value: number) => {
        top = value;
      },
    });
    const scrollIntoView = vi.fn(() => {
      top = scrollIntoView.mock.calls.length === 1 ? 48 : 127;
    });
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const heading = () =>
      screen.getByRole("heading", { name: "Organization sign-in" });
    try {
      render(
        <IdentitySettings
          viewer={viewer}
          federatedIdentity={root}
          memberships={memberships}
          servers={servers}
          landing="visit"
        />,
        {
          container: port.appendChild(document.createElement("div")),
          wrapper: ToastProvider,
        },
      );
      const first = heading();
      expect(first).toHaveFocus();
      // Instant, so the place it reads back afterwards is where it stopped.
      expect(scrollIntoView).toHaveBeenCalledExactlyOnceWith({
        block: "start",
        behavior: "instant",
      });
      expect(top).toBe(48);
      expect(
        screen.getByRole("button", { name: "Sign out of organization" }),
      ).toBeVisible();
      // The user pages up from the heading, which scrolls the port.
      if (scrolled) {
        fireEvent.keyDown(first, { key: "PageUp" });
        port.scrollTop = 20;
      }
      // The listed servers replace the section while it holds the landing.
      await act(async () => list([block.service.snapshot()]));
      const listed = heading();
      expect(listed).not.toBe(first);
      expect(listed).toHaveFocus();
      expect(focus.mock.contexts.at(-1)).toBe(listed);
      expect(focus).toHaveBeenLastCalledWith({ preventScroll: true });
      // Untouched, the landing finishes at the top; a user who scrolled keeps
      // their place.
      expect(scrollIntoView.mock.contexts).toEqual(
        scrolled ? [first] : [first, listed],
      );
      expect(top).toBe(scrolled ? 20 : 127);
      // The server's session ending in the background replaces the section
      // again while it still holds the landing. A user who scrolled once
      // keeps their place for the rest of the visit.
      act(() => {
        block.publish({ status: "signed-out", email: null });
      });
      expect(screen.getByText("Not signed in")).toBeVisible();
      const ended = heading();
      expect(ended).not.toBe(listed);
      expect(ended).toHaveFocus();
      expect(focus.mock.contexts.at(-1)).toBe(ended);
      expect(focus).toHaveBeenLastCalledWith({ preventScroll: true });
      expect(scrollIntoView.mock.contexts).toEqual(
        scrolled ? [first] : [first, listed, ended],
      );
      expect(top).toBe(scrolled ? 20 : 127);
      // Once the user moves on, a replacement leaves focus where it went.
      await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
      expect(
        await screen.findByRole("button", {
          name: "Sign out of acme.builderlab.xyz",
        }),
      ).toBeVisible();
      expect(heading()).not.toBe(ended);
      expect(heading()).not.toHaveFocus();
      expect(scrollIntoView).toHaveBeenCalledTimes(scrolled ? 1 : 3);
    } finally {
      focus.mockRestore();
      Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
      cleanup();
      port.remove();
    }
  },
);

/** Settings' scrollport as a real-browser probe measured it: 649px tall, with
 * the Organization sign-in heading 646px into 743px of content and its
 * section the rest. Landing scrolls as near the heading's top as the content
 * allows. Change `layout` as loading would; the landing notices it only on
 * `resize` or `scroll`. */
const SECTION = '[aria-labelledby="organization-sign-in-title"]';
const signInHeading = () =>
  screen.getByRole("heading", { name: "Organization sign-in" });
function probedScrollport() {
  const port = document.body.appendChild(document.createElement("div"));
  port.style.overflowY = "auto";
  const layout = { top: 0, height: 743 };
  Object.defineProperties(port, {
    scrollTop: {
      configurable: true,
      get: () => layout.top,
      set: (top: number) => {
        layout.top = top;
      },
    },
    scrollHeight: { configurable: true, get: () => layout.height },
    clientHeight: { configurable: true, get: () => 649 },
  });
  const box = (top: number, height: number) =>
    ({
      x: 0,
      y: top,
      top,
      bottom: top + height,
      left: 0,
      right: 0,
      width: 0,
      height,
      toJSON() {},
    }) as DOMRect;
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    function (this: Element) {
      if (this.id === "organization-sign-in-title")
        return box(646 - layout.top, 24);
      if (this.getAttribute("aria-labelledby") === "organization-sign-in-title")
        return box(646 - layout.top, layout.height - 646);
      return box(0, 0);
    },
  );
  const scrollIntoView = vi.fn(() => {
    layout.top = Math.min(646, layout.height - 649);
  });
  HTMLElement.prototype.scrollIntoView = scrollIntoView;
  /** Each live observer, with what it observes. */
  const observers = new Map<
    object,
    { callback: ResizeObserverCallback; nodes: Set<Element> }
  >();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        observers.set(this, { callback, nodes: new Set() });
      }
      observe(node: Element) {
        observers.get(this)?.nodes.add(node);
      }
      unobserve(node: Element) {
        observers.get(this)?.nodes.delete(node);
      }
      disconnect() {
        observers.delete(this);
      }
    },
  );
  return {
    port,
    layout,
    scrollIntoView,
    /** Whether the whole section shows, its bottom at or above the port's. */
    shown: () => layout.height - layout.top <= 649,
    /** Everything a live observer watches. */
    observed: () => [...observers.values()].flatMap(({ nodes }) => [...nodes]),
    observing: () => observers.size,
    /** The section changed height, and with it every content-sized ancestor
     * below the port: what observes any of them hears of it. */
    resize: () =>
      act(() => {
        const section = port.querySelector(SECTION);
        for (const [observer, { callback, nodes }] of [...observers])
          if (
            section &&
            [...nodes].some(
              (node) =>
                node !== port && port.contains(node) && node.contains(section),
            )
          )
            callback([], observer as ResizeObserver);
      }),
    scroll: () =>
      act(() => {
        port.dispatchEvent(new Event("scroll"));
      }),
    restore() {
      Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
      vi.unstubAllGlobals();
      cleanup();
      port.remove();
    },
  };
}

function landedSignIn(servers: () => Promise<readonly SessionSnapshot[]>) {
  const { block, root } = twoServers();
  block.publish({ status: "signed-in", email: "will@acme.example" });
  const scroll = probedScrollport();
  const container = scroll.port.appendChild(document.createElement("div"));
  const { unmount } = render(
    <IdentitySettings
      viewer={viewer}
      federatedIdentity={root}
      memberships={memberships}
      servers={servers}
      landing="visit"
    />,
    { container, wrapper: ToastProvider },
  );
  return { block, scroll, container, unmount };
}

it("lands again when the server list replaces Organization sign-in after a clamp moved the scrollport, though the user did nothing", async () => {
  let list!: (servers: readonly SessionSnapshot[]) => void;
  const { block, scroll } = landedSignIn(
    () =>
      new Promise((resolve) => {
        list = resolve;
      }),
  );
  try {
    expect(scroll.layout.top).toBe(94);
    // The content shrank for a moment, clamping scrollTop, then grew past
    // where it was.
    scroll.layout.height = 776;
    scroll.layout.top = 48;
    await act(async () => list([block.service.snapshot()]));
    expect(signInHeading()).toHaveFocus();
    expect(scroll.scrollIntoView).toHaveBeenCalledTimes(2);
    expect(scroll.layout.top).toBe(127);
    expect(scroll.shown()).toBe(true);
  } finally {
    scroll.restore();
  }
});

it.each([
  ["a clamp it notices resizing", 48, "resize"],
  ["a clamp it notices scrolling", 48, "scroll"],
  ["the section growing below the heading", 94, "resize"],
] as const)(
  "follows the layout after landing Organization sign-in, with no replacement, and lands again after %s",
  async (_, top, notice) => {
    const { scroll } = landedSignIn(() => new Promise(() => {}));
    try {
      expect(scroll.layout.top).toBe(94);
      expect(scroll.shown()).toBe(true);
      scroll.layout.height = 776;
      scroll.layout.top = top;
      expect(scroll.shown()).toBe(false);
      await scroll[notice]();
      expect(scroll.scrollIntoView).toHaveBeenCalledTimes(2);
      expect(scroll.layout.top).toBe(127);
      expect(scroll.shown()).toBe(true);
      expect(signInHeading()).toHaveFocus();
      // Where the landing put it, another notice leaves it.
      await scroll.resize();
      await scroll.scroll();
      expect(scroll.scrollIntoView).toHaveBeenCalledTimes(2);
    } finally {
      scroll.restore();
    }
  },
);

it("lands Organization sign-in no more once the user scrolls, though a replacement takes the focus back", async () => {
  let list!: (servers: readonly SessionSnapshot[]) => void;
  const { block, scroll } = landedSignIn(
    () =>
      new Promise((resolve) => {
        list = resolve;
      }),
  );
  try {
    expect(scroll.layout.top).toBe(94);
    fireEvent.wheel(scroll.port, { deltaY: -46 });
    scroll.layout.top = 48;
    scroll.layout.height = 776;
    await scroll.resize();
    await scroll.scroll();
    await act(async () => list([block.service.snapshot()]));
    expect(signInHeading()).toHaveFocus();
    await scroll.resize();
    expect(scroll.scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scroll.layout.top).toBe(48);
  } finally {
    scroll.restore();
  }
});

it("lands Organization sign-in in full through the probed journey: a clamp to the end, then growth", async () => {
  const { scroll } = landedSignIn(() => new Promise(() => {}));
  try {
    expect(scroll.layout.top).toBe(94);
    // The content shrinks to 697px, clamping scrollTop to its end.
    scroll.layout.height = 697;
    scroll.layout.top = 48;
    await scroll.scroll();
    expect(scroll.layout.top).toBe(48);
    expect(scroll.shown()).toBe(true);
    // Then it grows to 776px, the heading where the clamp left it.
    scroll.layout.height = 776;
    await scroll.resize();
    expect(scroll.layout.top).toBe(127);
    expect(scroll.shown()).toBe(true);
    expect(signInHeading()).toHaveFocus();
  } finally {
    scroll.restore();
  }
});

it("follows the layout no more once focus moves on from Organization sign-in", async () => {
  const { scroll } = landedSignIn(() => new Promise(() => {}));
  try {
    expect(scroll.observing()).toBe(1);
    const signOut = screen.getByRole("button", {
      name: "Sign out of organization",
    });
    await act(async () => signOut.focus());
    expect(scroll.observing()).toBe(0);
    scroll.layout.height = 776;
    scroll.layout.top = 48;
    await scroll.resize();
    await scroll.scroll();
    expect(scroll.scrollIntoView).toHaveBeenCalledTimes(1);
    expect(signOut).toHaveFocus();
  } finally {
    scroll.restore();
  }
});

it("lands Organization sign-in no more once it goes with focus and the user moves on before it returns", async () => {
  const { block, scroll } = landedSignIn(() => new Promise(() => {}));
  try {
    expect(signInHeading()).toHaveFocus();
    // Unconfigured, the session shows no section at all.
    await act(async () => {
      block.publish({ status: "unconfigured" });
    });
    expect(
      screen.queryByRole("heading", { name: "Organization sign-in" }),
    ).toBeNull();
    const copy = screen.getByRole("button", { name: "Copy public key" });
    act(() => copy.focus());
    await act(async () => {
      block.publish({ status: "signed-in" });
    });
    expect(signInHeading()).toBeVisible();
    expect(copy).toHaveFocus();
    expect(scroll.scrollIntoView).toHaveBeenCalledTimes(1);
  } finally {
    scroll.restore();
  }
});

it("watches only what resizes inside the scrollport, and lets go when Identity unmounts", () => {
  const { scroll, container, unmount } = landedSignIn(
    () => new Promise(() => {}),
  );
  try {
    const observed = scroll.observed();
    expect(observed).toContain(
      screen.getByRole("region", { name: "Organization sign-in" }),
    );
    expect(observed).toContain(container);
    expect(observed).not.toContain(scroll.port);
    unmount();
    expect(scroll.observing()).toBe(0);
  } finally {
    scroll.restore();
  }
});

it("follows the layout until it holds still for SETTLED_MS, then lands Organization sign-in no more", async () => {
  vi.useFakeTimers();
  const { scroll } = landedSignIn(() => new Promise(() => {}));
  try {
    act(() => vi.advanceTimersByTime(SETTLED_MS - 1));
    expect(scroll.observing()).toBe(1);
    act(() => vi.advanceTimersByTime(1));
    expect(scroll.observing()).toBe(0);
    scroll.layout.height = 776;
    await scroll.resize();
    await scroll.scroll();
    expect(scroll.scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scroll.layout.top).toBe(94);
    expect(signInHeading()).toHaveFocus();
  } finally {
    scroll.restore();
    vi.useRealTimers();
  }
});

it("follows a layout that never holds still for FOLLOW_MS at most", async () => {
  vi.useFakeTimers();
  const { scroll } = landedSignIn(() => new Promise(() => {}));
  // Grows or shrinks the content, clamping scrollTop to it, and notices.
  const change = async () => {
    scroll.layout.height = scroll.layout.height === 743 ? 776 : 743;
    scroll.layout.top = Math.min(scroll.layout.top, scroll.layout.height - 649);
    await scroll.resize();
  };
  try {
    // Each change lands again and restarts the wait for the layout to settle.
    let elapsed = 0;
    let lands = 1;
    while (elapsed + SETTLED_MS - 1 < FOLLOW_MS) {
      act(() => vi.advanceTimersByTime(SETTLED_MS - 1));
      elapsed += SETTLED_MS - 1;
      await change();
      expect(scroll.scrollIntoView).toHaveBeenCalledTimes(++lands);
      expect(scroll.shown()).toBe(true);
    }
    expect(lands).toBeGreaterThan(2);
    act(() => vi.advanceTimersByTime(FOLLOW_MS - elapsed));
    expect(scroll.observing()).toBe(0);
    await change();
    expect(scroll.scrollIntoView).toHaveBeenCalledTimes(lands);
    expect(signInHeading()).toHaveFocus();
  } finally {
    scroll.restore();
    vi.useRealTimers();
  }
});

it("keeps a per-server sign-out that native couldn't finish visible, named, with Try again", async () => {
  const { block, pub, root, servers } = twoServers();
  block.publish({ status: "signed-in", email: "will@acme.example" });
  pub.publish({ status: "signed-in", email: "will@example.com" });
  // Native resolves a storage failure as an unavailable snapshot.
  vi.mocked(pub.service.signOut).mockImplementation(async () => {
    pub.publish({
      status: "unavailable",
      failure: "storage-denied",
      cleanup: true,
    });
    return pub.service.snapshot();
  });
  render(
    <IdentitySettings
      viewer={viewer}
      federatedIdentity={root}
      memberships={memberships}
      servers={servers}
    />,
    { wrapper: ToastProvider },
  );
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole("button", {
      name: "Sign out of app.builderlab.xyz",
    }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Couldn’t sign out of app.builderlab.xyz. Sign-in could not access secure storage.",
  );
  // Its row is gone, the other server's stays.
  expect(screen.getByText("Acme (acme.builderlab.xyz)")).toBeVisible();
  expect(block.service.snapshot().status).toBe("signed-in");
  vi.mocked(pub.service.signOut).mockImplementation(async () => {
    pub.publish({ status: "signed-out", failure: null, cleanup: false });
    return pub.service.snapshot();
  });
  await user.click(screen.getByRole("button", { name: "Try again" }));
  expect(pub.service.signOut).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(block.service.signOut).not.toHaveBeenCalled();
});

it("restores an unfinished per-server sign-out's Try again when Settings opens again", async () => {
  const { block, pub, root, servers } = twoServers();
  block.publish({ status: "signed-in", email: "will@acme.example" });
  pub.publish({ status: "signed-in", email: "will@example.com" });
  vi.mocked(pub.service.signOut).mockImplementation(async () => {
    pub.publish({
      status: "unavailable",
      failure: "storage-denied",
      cleanup: true,
    });
    return pub.service.snapshot();
  });
  const settings = () => (
    <IdentitySettings
      viewer={viewer}
      federatedIdentity={root}
      memberships={memberships}
      servers={servers}
    />
  );
  const first = render(settings(), { wrapper: ToastProvider });
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole("button", {
      name: "Sign out of app.builderlab.xyz",
    }),
  );
  expect(await screen.findByRole("alert")).toBeVisible();
  // Closing Settings and opening it again, as a reload does.
  first.unmount();
  render(settings(), { wrapper: ToastProvider });
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Couldn’t sign out of app.builderlab.xyz. Sign-in could not access secure storage.",
  );
  expect(screen.getByText("Acme (acme.builderlab.xyz)")).toBeVisible();
  vi.mocked(pub.service.signOut).mockImplementation(async () => {
    pub.publish({ status: "signed-out", failure: null, cleanup: false });
    return pub.service.snapshot();
  });
  await user.click(screen.getByRole("button", { name: "Try again" }));
  expect(pub.service.signOut).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("alert")).toBeNull();
});

// A failed restore keeps a stored session that may still be valid.
it("offers no sign-out retry for a server whose restore failed", async () => {
  const { block, pub, root, servers } = twoServers();
  block.publish({ status: "signed-in", email: "will@acme.example" });
  pub.publish({ status: "unavailable", failure: "network-unavailable" });
  render(
    <IdentitySettings
      viewer={viewer}
      federatedIdentity={root}
      memberships={memberships}
      servers={servers}
    />,
    { wrapper: ToastProvider },
  );
  expect(await screen.findByText("Acme (acme.builderlab.xyz)")).toBeVisible();
  expect(screen.queryByText(/Couldn’t sign out/)).toBeNull();
  expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  expect(pub.service.signOut).not.toHaveBeenCalled();
});

it("shows the first server's failed restore as its own recovery text", async () => {
  const { block, root, servers } = twoServers();
  block.publish({ status: "unavailable", failure: "network-unavailable" });
  const listed = vi.fn(servers);
  render(
    <IdentitySettings
      viewer={viewer}
      federatedIdentity={root}
      servers={listed}
    />,
    { wrapper: ToastProvider },
  );
  // Settings reads each server's session only once the list arrives.
  await waitFor(() => expect(listed).toHaveBeenCalledOnce());
  await act(async () => {
    await listed.mock.results[0]?.value;
  });
  expect(screen.getByRole("alert")).toHaveTextContent(
    /^Sign-in did not finish\. Try again\.$/,
  );
  // Neither a sign-out retry nor a sign-in while the record is unchecked.
  expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
  expect(block.service.signOut).not.toHaveBeenCalled();
});

it("shows only the account's linked backed-up key with its last activity, read-only", async () => {
  vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://builderlab.example");
  const other = "cd".repeat(32);
  const host = backupHost(at(1, { status: "complete" }));
  const fi = federatedFixture();
  fi.publish({ status: "signed-in", email: "a@example.com" });
  const answer = (body: object) => ({
    status: 200,
    headers: {},
    body: JSON.stringify(body),
  });
  fi.request.mockImplementation(async ({ path }) =>
    path.endsWith("/nostr-identities/current")
      ? answer({ identity: { pubkey_hex: viewer } })
      : answer({
          current_nostr_pubkey: viewer,
          backup_nostr_pubkeys: [viewer, other],
        }),
  );
  const lastActive = vi.fn(async () => Date.now() / 1000 - 7200);
  render(
    <IdentitySettings
      viewer={viewer}
      identity={host.identity}
      builderlabIdentity={fi.service}
      lastActive={lastActive}
    />,
    { wrapper: ToastProvider },
  );
  expect(
    await screen.findByText("Backed-up key · This device · Linked"),
  ).toBeVisible();
  expect(await screen.findByText(/Last active 2 hours ago$/)).toBeVisible();
  // Another key's backup is left out, and its activity never read.
  expect(screen.queryByText(npubEncode(other))).toBeNull();
  expect(lastActive).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("radio")).toBeNull();
  // Reads only: nothing that could unlink a key.
  expect(fi.request.mock.calls.map(([{ path }]) => path)).toEqual([
    expect.stringMatching(/\/nostr-identities\/current$/),
    expect.stringMatching(/\/nsec-backups\/status$/),
  ]);
});

it("shows no backed-up key when the account has none", async () => {
  vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://builderlab.example");
  const host = backupHost(at(1, { status: "complete" }));
  const fi = federatedFixture();
  fi.publish({ status: "signed-in", email: "a@example.com" });
  fi.request.mockImplementation(async ({ path }) => ({
    status: 200,
    headers: {},
    body: JSON.stringify(
      path.endsWith("/nostr-identities/current")
        ? { identity: { pubkey_hex: viewer } }
        : { current_nostr_pubkey: viewer, backup_nostr_pubkeys: [] },
    ),
  }));
  render(
    <IdentitySettings
      viewer={viewer}
      identity={host.identity}
      builderlabIdentity={fi.service}
    />,
    { wrapper: ToastProvider },
  );
  await waitFor(() => expect(fi.request).toHaveBeenCalledTimes(2));
  await act(async () => {});
  expect(screen.queryByText(/^Backed-up key/)).toBeNull();
  expect(screen.queryByText("Checking your backup…")).toBeNull();
});

it.each([
  ["no events", [], undefined],
  ["its newest event", [{ id: "a", kind: 9, created_at: 900 }], 900],
] as const)(
  "reads a key's last activity from a relay with %s",
  async (_label, events, activity) => {
    const read = vi.fn(async () => events);
    const session = { read } as unknown as Parameters<typeof keyActivity>[0];
    await expect(keyActivity(session, viewer)).resolves.toEqual(activity);
    expect(read).toHaveBeenCalledWith(
      [{ kinds: [...CHANNEL_ACTIVITY_KINDS], authors: [viewer], limit: 1 }],
      { priority: "background" },
    );
  },
);

it("reports a relay that isn't connected as an unchecked read, not as no activity", async () => {
  await expect(keyActivity(undefined, viewer)).rejects.toThrow(
    "The relay isn’t connected",
  );
});

it("shows the linked key once a backup that finishes after the read adds it", async () => {
  vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://builderlab.example");
  const host = backupHost(at(1, { status: "running" }));
  const fi = federatedFixture();
  fi.publish({ status: "signed-in", email: "a@example.com" });
  let backups: string[] = [];
  fi.request.mockImplementation(async ({ path }) => ({
    status: 200,
    headers: {},
    body: JSON.stringify(
      path.endsWith("/nostr-identities/current")
        ? { identity: { pubkey_hex: viewer } }
        : { current_nostr_pubkey: viewer, backup_nostr_pubkeys: backups },
    ),
  }));
  render(
    <IdentitySettings
      viewer={viewer}
      identity={host.identity}
      builderlabIdentity={fi.service}
    />,
    { wrapper: ToastProvider },
  );
  await waitFor(() => expect(fi.request).toHaveBeenCalledTimes(2));
  await act(async () => {});
  expect(screen.queryByText(/^Backed-up key/)).toBeNull();
  backups = [viewer];
  host.push(at(2, { status: "complete" }));
  await waitFor(() => expect(fi.request).toHaveBeenCalledTimes(4));
  expect(
    await screen.findByText("Backed-up key · This device · Linked"),
  ).toBeVisible();
});

it("reads activity again when the relay connection changes", async () => {
  vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://builderlab.example");
  const host = backupHost(at(1, { status: "complete" }));
  const fi = federatedFixture();
  fi.publish({ status: "signed-in", email: "a@example.com" });
  fi.request.mockImplementation(async ({ path }) => ({
    status: 200,
    headers: {},
    body: JSON.stringify(
      path.endsWith("/nostr-identities/current")
        ? { identity: { pubkey_hex: viewer } }
        : { current_nostr_pubkey: viewer, backup_nostr_pubkeys: [viewer] },
    ),
  }));
  const settings = (lastActive: (pubkey: string) => Promise<number>) => (
    <IdentitySettings
      viewer={viewer}
      identity={host.identity}
      builderlabIdentity={fi.service}
      lastActive={lastActive}
    />
  );
  const { rerender } = render(
    settings(async () => {
      throw new Error("The relay isn’t connected");
    }),
    { wrapper: ToastProvider },
  );
  expect(await screen.findByText(/Couldn’t check activity$/)).toBeVisible();
  // Settings hands over a new reader when the connection becomes ready.
  rerender(settings(async () => Date.now() / 1000 - 7200));
  expect(await screen.findByText(/Last active 2 hours ago$/)).toBeVisible();
  // The account isn't read again for it.
  expect(fi.request).toHaveBeenCalledTimes(2);
});
