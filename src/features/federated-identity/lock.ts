import { invoke } from "@tauri-apps/api/core";
import type { RelayGate } from "../relay/service";
import type { FederatedIdentity, SessionSnapshot } from "./service";

/** What a locked organization community does when someone selects it:
 * `selection` opens the browser sign-in once by itself; `button` waits for
 * its Sign in button. */
export const LOCKED_SIGN_IN: "selection" | "button" = "selection";

/** Whether the organization session lets Buzz show an organization
 * community's saved history now: signed in, or offline with a saved session
 * that has not ended. Anything else, including the startup check, waits. */
export function admits(state: SessionSnapshot, now = Date.now()) {
  if (state.status === "signed-in") return true;
  return (
    state.status === "unavailable" &&
    (state.failure === "network-unavailable" ||
      state.failure === "network-timeout") &&
    !!state.expiresAt &&
    Date.parse(state.expiresAt) > now
  );
}

/** One gate per community origin. Only native knows the build's
 * organization hosts, so a build without native identity protects none. */
export function relayGates(
  identity: FederatedIdentity,
): (origin: string) => RelayGate | undefined {
  if (!identity.apiAvailable) return () => undefined;
  // A re-check (native passes through `restoring` whenever it verifies the
  // saved session again) keeps the last verdict, so a community open offline
  // doesn't lock and reload on every reconnect attempt.
  let verdict = admits(identity.snapshot());
  const current = () => {
    const state = identity.snapshot();
    if (state.status !== "restoring") verdict = admits(state);
    return verdict;
  };
  return (origin) => ({
    // Native also refuses an unsigned organization connection, so an IPC
    // failure here only loses the cache gate, never the relay's own refusal.
    protects: invoke<boolean>("federated_identity_protects", {
      relay: origin,
    }).then(
      (protects) => protects === true,
      () => false,
    ),
    admits: current,
    subscribe(listener) {
      // Offline reading ends with the saved session, even with no event.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const arm = () => {
        clearTimeout(timer);
        const state = identity.snapshot();
        if (state.status !== "unavailable" || !state.expiresAt) return;
        const left = Date.parse(state.expiresAt) - Date.now();
        // Timers cap near 24.8 days: a long wait wakes early and re-arms.
        if (left > 0)
          timer = setTimeout(
            () => {
              arm();
              listener();
            },
            Math.min(left, 2 ** 31 - 1),
          );
      };
      arm();
      const unsubscribe = identity.subscribe(() => {
        arm();
        listener();
      });
      return () => {
        clearTimeout(timer);
        unsubscribe();
      };
    },
  });
}
