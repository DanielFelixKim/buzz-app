// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { HostRequest, HostResponse } from "../../../features/host/service";
import { deferred, createTestSession } from "../test-helpers";
import { createAgentClient } from "./client";
import { RemoteAgents } from "./RemoteAgents";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("reports an empty signed-out overview without starting a list request", async () => {
  const h = await fixture();
  h.session.signOut();
  const held = deferred<HostResponse>();
  h.request.mockReturnValue(held.promise);
  const overview = vi.fn();
  render(<RemoteAgents {...h} active={() => true} onOverview={overview} />);
  expect(overview).toHaveBeenLastCalledWith({ kind: "empty" });
  expect(h.request).not.toHaveBeenCalled();
  await act(async () => held.resolve(response([], 401)));
  expect(overview).toHaveBeenCalledTimes(1);
  expect(overview).toHaveBeenLastCalledWith({ kind: "empty" });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
const row = {
  agent_id: "one",
  agent_name: "Helper",
  agent_pubkey: "ab".repeat(32),
  status: 2,
  model_selection_status: 1,
};
const response = (agents: unknown[], status = 200): HostResponse => ({
  status,
  headers: {},
  body: JSON.stringify({ status: 1, agents }),
});
async function fixture(canUseRemoteAgents = true) {
  vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://builderlab.example");
  const session = createTestSession(
    async () => ({
      revision: "secret",
      account: {
        subject: "user",
        email: "a@example.com",
        canUseRemoteAgents,
        canUseBuilderlabDecisions: false,
      },
    }),
    undefined,
    { request: (input) => request(input) },
  );
  await session.signIn();
  const request = vi.fn(async (_input: HostRequest) => response([row]));
  const client = createAgentClient(session);
  return { session, client, request };
}
it("omits the agent summary when remote agents are unavailable", async () => {
  const h = await fixture(false);
  const overview = vi.fn();
  render(<RemoteAgents {...h} active={() => true} onOverview={overview} />);
  expect(screen.getByText("Unavailable for this account")).toBeVisible();
  expect(
    screen.queryByText("Agents", { selector: "dt" }),
  ).not.toBeInTheDocument();
  expect(overview).toHaveBeenLastCalledWith({ kind: "unavailable" });
  expect(h.request).not.toHaveBeenCalled();
});
it("loads automatically, refreshes and hides account data on sign-out", async () => {
  const h = await fixture();
  const overview = vi.fn();
  const openAgents = vi.fn();
  render(
    <RemoteAgents
      {...h}
      active={() => true}
      onOverview={overview}
      openAgents={openAgents}
    />,
  );
  expect(overview).toHaveBeenLastCalledWith({ kind: "pending" });
  expect(await screen.findByText("Helper")).toBeInTheDocument();
  expect(screen.getByText("Agents", { selector: "dt" })).toBeVisible();
  expect(overview).toHaveBeenLastCalledWith({
    kind: "filled",
    items: [{ key: "one", label: "Helper" }],
  });
  expect(h.request).toHaveBeenCalledTimes(1);
  expect(screen.getByText("Active")).toBeInTheDocument();
  expect(screen.getByText(row.agent_pubkey)).toHaveClass("select-all");
  expect(
    screen.getByRole("button", { name: "Copy Helper’s key" }),
  ).toBeEnabled();
  expect(document.body).not.toHaveTextContent("secret");
  const held = deferred<HostResponse>();
  h.request.mockReturnValueOnce(held.promise);
  const copy = screen.getByRole("button", { name: "Copy Helper’s key" });
  copy.focus();
  act(() => window.dispatchEvent(new Event("focus")));
  expect(copy).toHaveFocus();
  expect(screen.queryByText("Loading agents…")).not.toBeInTheDocument();
  expect(overview).toHaveBeenLastCalledWith({
    kind: "filled",
    items: [{ key: "one", label: "Helper" }],
  });
  await act(async () => held.resolve(response([row])));
  expect(copy).toHaveFocus();
  h.request.mockResolvedValueOnce(response([]));
  act(() => window.dispatchEvent(new Event("focus")));
  expect(await screen.findByText("No agents yet")).toBeInTheDocument();
  expect(overview).toHaveBeenLastCalledWith({ kind: "empty" });
  await userEvent.click(screen.getByRole("button", { name: "Open Agents" }));
  expect(openAgents).toHaveBeenCalledTimes(1);
  act(() => h.session.signOut());
  expect(
    screen.queryByRole("region", { name: "Remote agents" }),
  ).not.toBeInTheDocument();
});
it("shows a held loading state and retries a failed read", async () => {
  const h = await fixture();
  const held = deferred<HostResponse>();
  h.request.mockReturnValueOnce(held.promise);
  render(<RemoteAgents {...h} active={() => true} />);
  expect(screen.getByRole("status")).toHaveTextContent("Loading agents");
  expect(
    screen.queryByRole("button", { name: "Refresh agents" }),
  ).not.toBeInTheDocument();
  await act(async () => held.resolve(response([], 400)));
  expect(
    screen.getByRole("heading", { name: "Couldn’t load agents" }),
  ).toBeVisible();
  expect(screen.getByRole("alert")).toHaveTextContent("HTTP 400");
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByText("Helper")).toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
it.each(["sign-out", "unmount"])(
  "ignores held reads after %s",
  async (action) => {
    const h = await fixture();
    const held = deferred<HostResponse>();
    h.request.mockReturnValue(held.promise);
    const mounted = render(<RemoteAgents {...h} active={() => true} />);
    if (action === "sign-out") act(() => h.session.signOut());
    else mounted.unmount();
    await act(async () => held.resolve(response([row])));
    expect(screen.queryByText("Helper")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  },
);

it("copies the agent key and exposes a recoverable clipboard failure", async () => {
  const h = await fixture();
  const writeText = vi
    .fn()
    .mockRejectedValueOnce(new Error("denied"))
    .mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  render(<RemoteAgents {...h} active={() => true} />);
  const copy = await screen.findByRole("button", { name: "Copy Helper’s key" });
  await userEvent.click(copy);
  expect(await screen.findByRole("status")).toHaveTextContent(
    "Couldn’t copy the key",
  );
  expect(screen.getByText(row.agent_pubkey)).toBeVisible();
  await userEvent.click(copy);
  expect(screen.getByRole("status")).toHaveTextContent("Key copied");
  expect(writeText).toHaveBeenLastCalledWith(row.agent_pubkey);
  const held = deferred<HostResponse>();
  h.request.mockReturnValueOnce(held.promise);
  copy.focus();
  act(() => window.dispatchEvent(new Event("focus")));
  await act(async () => held.resolve(response([], 400)));
  await waitFor(() => expect(copy).toHaveFocus());
  expect(screen.getByRole("status")).toHaveTextContent("Key copied");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it.each([
  [2, 1, "Active"],
  [2, 2, "Needs setup"],
  [2, undefined, "Needs setup"],
  [1, 1, "Needs setup"],
  [3, 1, "Revoked"],
  [0, 1, "Unknown"],
])(
  "shows readiness for agent %s and model %s",
  async (status, model, label) => {
    const h = await fixture();
    h.request.mockResolvedValue(
      response([
        {
          ...row,
          status,
          model_selection_status: model,
          created_at: "2026-07-15T12:00:00Z",
        },
      ]),
    );
    render(<RemoteAgents {...h} active={() => true} />);
    expect(
      await screen.findByText(new RegExp(`^${label} · Created .*2026`)),
    ).toBeVisible();
  },
);
