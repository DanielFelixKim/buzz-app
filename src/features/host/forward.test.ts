// @vitest-environment node
import { invoke } from "@tauri-apps/api/core";
import { beforeEach, expect, it, vi } from "vitest";
import {
  closeForward,
  openForward,
  pushForwardAdmission,
  sealForward,
  type ForwardEvent,
} from "./forward";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class {
    constructor(public onmessage: (event: unknown) => void) {}
  },
}));

const owner = { id: "buzz.agents", revision: "abc" };

beforeEach(() => {
  vi.mocked(invoke).mockReset();
});

// The argument names are the native commands' (camelCase over IPC).
it("pushes admission under the owner's grant", async () => {
  vi.mocked(invoke).mockResolvedValueOnce({ type: "applied", revoked: 1 });
  await expect(
    pushForwardAdmission(owner, "route-a", 2, true),
  ).resolves.toEqual({ type: "applied", revoked: 1 });
  expect(invoke).toHaveBeenCalledWith("plugin_host_forward_admission", {
    id: "buzz.agents",
    revision: "abc",
    route: "route-a",
    routeRevision: 2,
    admits: true,
  });
});

it("opens a generation and delivers its events", async () => {
  vi.mocked(invoke).mockResolvedValueOnce({
    type: "opened",
    id: 7,
    url: "http://127.0.0.1:1/h",
  });
  const events: ForwardEvent[] = [];
  const opened = await openForward(owner, {
    route: "route-a",
    routeRevision: 2,
    harness: "claude",
    session: "s-1",
    inference: { "x-a": "1" },
    discovery: {},
    onEvent: (event) => events.push(event),
  });
  expect(opened).toEqual({
    type: "opened",
    id: 7,
    url: "http://127.0.0.1:1/h",
  });
  const [command, args] = vi.mocked(invoke).mock.calls[0] as [
    string,
    Record<string, unknown>,
  ];
  expect(command).toBe("plugin_host_forward_open");
  const { onEvent, ...rest } = args;
  expect(rest).toEqual({
    id: "buzz.agents",
    revision: "abc",
    route: "route-a",
    routeRevision: 2,
    harness: "claude",
    session: "s-1",
    inference: { "x-a": "1" },
    discovery: {},
  });
  (onEvent as { onmessage: (event: unknown) => void }).onmessage({
    type: "closed",
  });
  expect(events).toEqual([{ type: "closed" }]);
});

it("seals and closes by generation", async () => {
  vi.mocked(invoke).mockResolvedValue(undefined);
  await sealForward(owner, 7);
  await closeForward(owner, 7);
  expect(invoke).toHaveBeenNthCalledWith(1, "plugin_host_forward_seal", {
    id: "buzz.agents",
    generation: 7,
  });
  expect(invoke).toHaveBeenNthCalledWith(2, "plugin_host_forward_close", {
    id: "buzz.agents",
    generation: 7,
  });
});
