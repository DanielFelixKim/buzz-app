// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { RelaySession } from "../../features/relay/session";
import { useInboxDrafts } from "./view";
afterEach(cleanup);
it("shares Inbox's current view with navigation, retains it on remount, and isolates sessions", () => {
  const session = {} as RelaySession;
  const inbox = renderHook(() => useInboxDrafts(session));
  const navigation = renderHook(() => useInboxDrafts(session));
  const otherSession = {} as RelaySession;
  const other = renderHook(() => useInboxDrafts(otherSession));
  act(() => inbox.result.current[1](true));
  expect(navigation.result.current[0]).toBe(true);
  expect(other.result.current[0]).toBe(false);
  inbox.unmount();
  const restored = renderHook(() => useInboxDrafts(session));
  expect(restored.result.current[0]).toBe(true);
  act(() => navigation.result.current[1](false));
  expect(restored.result.current[0]).toBe(false);
});
