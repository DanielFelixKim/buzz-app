import { useState, useSyncExternalStore } from "react";
import type { FederatedIdentity, SessionSnapshot } from "./service";
import type { Membership } from "../communities/service";
import { communityDestination } from "../communities/destination";
import { coveredCommunities, serverName } from "./community-servers";
import { Button } from "../../shared/design-system/ui/Button";

export function recoveryMessage(code: string) {
  if (code === "storage-busy")
    return "Secure storage is busy. Close another Buzz instance and try again.";
  if (code.startsWith("storage-"))
    return "Sign-in could not access secure storage. Check your system’s credential permissions and try again.";
  if (code === "sign-in-canceled")
    return "Sign-in was canceled. Sign in when you’re ready.";
  if (code === "reauthentication-required")
    return "Your sign-in has expired. Sign in again to continue.";
  return "Sign-in did not finish. Try again.";
}

/** Issuer refusals native keeps for the session revision (`refused()` in
 * assertion.rs) until the app restarts; signing in or retrying repeats them. */
const ISSUER_REFUSALS = new Set([
  "adapter-refused",
  "grant-refused",
  "invalid-assertion",
  "invalid-proof",
  "invalid-response",
  "response-too-large",
]);

/** Explicit recovery from native protected-community admission; never automatic login. */
export function CommunitySignIn({
  identity,
  error,
  retry,
  relay,
  memberships = [],
}: {
  identity?: FederatedIdentity | undefined;
  error?: string | undefined;
  retry: () => void;
  /** The refusing community, so a switch names the others it affects. */
  relay?: string | undefined;
  memberships?: readonly Membership[] | undefined;
}) {
  if (!identity) return null;
  return (
    <Action
      identity={identity}
      error={error}
      retry={retry}
      relay={relay}
      memberships={memberships}
    />
  );
}
function Action({
  identity,
  error,
  retry,
  relay,
  memberships,
}: {
  identity: FederatedIdentity;
  error?: string | undefined;
  retry: () => void;
  relay?: string | undefined;
  memberships: readonly Membership[];
}) {
  const state = useSyncExternalStore(
    identity.subscribe,
    identity.snapshot,
    identity.snapshot,
  );
  const [failure, setFailure] = useState("");
  const refusal = error || state.failure || "";
  const mismatch = /binding[-_]mismatch/.test(refusal);
  if (mismatch || /authorization[-_]denied/.test(refusal)) {
    // Without a server session to switch, only the refusal can be explained.
    if (state.status !== "signed-in" || !state.authority)
      return (
        <p role="alert" className="text-body-sm text-danger">
          {mismatch
            ? "This account is linked to a different Buzz identity. Keep this key until you have reviewed the identity link."
            : "Your account does not have access to this community. Contact its administrator."}
        </p>
      );
    return (
      <SwitchAccount
        identity={identity}
        state={state}
        authority={state.authority}
        mismatch={mismatch}
        others={othersAffected(state.authority, relay, memberships)}
        retry={retry}
      />
    );
  }
  if (ISSUER_REFUSALS.has(refusal))
    return (
      <p role="alert" className="text-body-sm text-danger">
        Buzz couldn’t confirm your organization sign-in for this community.
        Restart Buzz to try again. If it keeps happening, contact your
        administrator.
      </p>
    );
  if (
    !error ||
    !/Federated sign-in is required|reauthentication-required|Federated authorization (changed|expired)/.test(
      error,
    ) ||
    !state.authority
  )
    return null;
  if (state.status === "signed-in") return null;
  return (
    <>
      <Button
        onClick={() => {
          setFailure("");
          const operation =
            state.status === "signing-in"
              ? identity.cancelSignIn()
              : identity.signIn().then((next) => {
                  if (next.status === "signed-in") retry();
                });
          void operation.catch((error: unknown) =>
            setFailure(
              error instanceof Error ? error.message : "Sign-in unavailable",
            ),
          );
        }}
      >
        {state.status === "signing-in" ? "Cancel sign-in" : "Sign in"}
      </Button>
      {(failure || state.failure) && (
        <p role="alert" className="text-body-sm text-danger">
          {recoveryMessage(failure || state.failure || "")}
        </p>
      )}
    </>
  );
}

/** The other joined communities a switch on this server also signs out of. */
function othersAffected(
  authority: NonNullable<SessionSnapshot["authority"]>,
  relay: string | undefined,
  memberships: readonly Membership[],
) {
  const self = relay && communityDestination(relay).url;
  return coveredCommunities(
    authority.communityHosts,
    memberships.filter(
      (membership) => communityDestination(membership.id).url !== self,
    ),
  );
}

/** A community refused the signed-in account: sign out of its server only
 * and sign in again, then retry. Other servers' sessions are untouched. */
function SwitchAccount({
  identity,
  state,
  authority,
  mismatch,
  others,
  retry,
}: {
  identity: FederatedIdentity;
  state: SessionSnapshot;
  authority: NonNullable<SessionSnapshot["authority"]>;
  mismatch: boolean;
  others: readonly string[];
  retry: () => void;
}) {
  const [failure, setFailure] = useState("");
  const [busy, setBusy] = useState(false);
  const server = serverName(authority);
  const account = state.email ?? "your organization account";
  return (
    <>
      <p role="alert" className="text-body-sm text-danger">
        {mismatch
          ? `Your ${server} account (signed in as ${account}) is linked to a different Buzz identity. Keep this key until you have reviewed the link at ${new URL(authority.identityOrigin).host}, or switch to another ${server} account.`
          : `This community didn’t accept your ${server} account (signed in as ${account}).`}
      </p>
      {others.length > 0 && (
        <p className="text-body-sm">
          Switching accounts also affects: {others.join(", ")}.
        </p>
      )}
      <Button
        disabled={busy}
        onClick={() => {
          setFailure("");
          setBusy(true);
          void identity
            .signOut()
            .then(() => identity.signIn())
            .then((next) => {
              if (next.status === "signed-in") retry();
            })
            .catch((error: unknown) =>
              setFailure(
                error instanceof Error ? error.message : "Sign-in unavailable",
              ),
            )
            .finally(() => setBusy(false));
        }}
      >
        Switch account
      </Button>
      {failure && (
        <p role="alert" className="text-body-sm text-danger">
          {recoveryMessage(failure)}
        </p>
      )}
    </>
  );
}
