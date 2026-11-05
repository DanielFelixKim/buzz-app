import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { LockIcon } from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import { recoveryMessage } from "./CommunitySignIn";
import { LOCKED_SIGN_IN } from "./lock";
import type { FederatedIdentity } from "./service";

/** Takes the place of an organization community's pages while its saved
 * history is locked. Keyed by community, so selecting one is a new visit:
 * with `LOCKED_SIGN_IN` at `selection`, that visit opens the browser
 * sign-in once; a cancel or failure leaves the button to the person. */
export function LockedCommunity({ identity }: { identity: FederatedIdentity }) {
  const state = useSyncExternalStore(
    identity.subscribe,
    identity.snapshot,
    identity.snapshot,
  );
  const [failure, setFailure] = useState("");
  const run = (operation: () => Promise<unknown>) => {
    setFailure("");
    void operation().catch((error: unknown) =>
      setFailure(error instanceof Error ? error.message : "sign-in-failed"),
    );
  };
  const ended =
    state.status === "signed-out" ||
    state.status === "reauthentication-required";
  const started = useRef(false);
  useEffect(() => {
    if (LOCKED_SIGN_IN !== "selection" || started.current || !ended) return;
    started.current = true;
    void identity.signIn().catch(() => {});
  }, [ended, identity]);

  const organization = state.authority?.organization;
  const signingIn = state.status === "signing-in";
  const checking = state.status === "restoring";
  const offline =
    state.status === "unavailable" &&
    (state.failure === "network-unavailable" ||
      state.failure === "network-timeout");
  const unavailable = state.status === "unavailable";
  const description = checking
    ? "Checking your sign-in…"
    : signingIn
      ? "Finish signing in in your browser. This community opens as soon as you’re done."
      : offline
        ? "Your sign-in has ended. Connect to the internet to sign in again."
        : unavailable
          ? recoveryMessage(state.failure ?? "")
          : `Your ${organization ? `${organization} ` : ""}sign-in has ended. Sign in again to see this community.`;
  return (
    <section aria-label="Sign in to continue" className="page-status">
      <EmptyState
        icon={<LockIcon />}
        title="Sign in to continue"
        description={
          <>
            {description}
            {failure && (
              <span role="alert" className="block text-danger">
                {recoveryMessage(failure)}
              </span>
            )}
          </>
        }
        action={
          signingIn ? (
            <Button onClick={() => run(() => identity.cancelSignIn())}>
              Cancel
            </Button>
          ) : (
            <Button
              variant="prominent"
              loading={checking}
              onClick={() => run(() => identity.signIn())}
            >
              {unavailable || checking
                ? "Try again"
                : organization
                  ? `Sign in with ${organization}`
                  : "Sign in"}
            </Button>
          )
        }
      />
    </section>
  );
}
