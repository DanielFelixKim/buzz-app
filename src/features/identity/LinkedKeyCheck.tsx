import {
  type ReactNode,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { launchVisible, subscribeLaunch } from "../../app/launch";
import { AlertDialog } from "../../shared/design-system/ui/AlertDialog";
import { Button } from "../../shared/design-system/ui/Button";
import {
  legacyImportPending,
  subscribeLegacyImport,
} from "../communities/legacy-communities";
import type {
  FederatedIdentity,
  SessionSnapshot,
} from "../federated-identity/service";
import { federatedBuilderlabAccount } from "./builderlab-account";
import type { Identity } from "./service";

type Session = Pick<FederatedIdentity, "snapshot" | "subscribe" | "request">;

const noSession = () => () => {};
const noSnapshot = (): SessionSnapshot | undefined => undefined;

/** The build's Builderlab session, or `undefined` for a build without one. */
export const useSession = (
  federated: Pick<FederatedIdentity, "snapshot" | "subscribe"> | undefined,
) =>
  useSyncExternalStore(
    federated?.subscribe ?? noSession,
    federated?.snapshot ?? noSnapshot,
  );

/**
 * Checks, with the app already open, that the Builderlab account signed in
 * here is linked to this device's key. Launch never waits on it: once the
 * saved session is signed in, it reads the account's linked key, the read
 * Settings makes, and asks only when that is another key. No linked key, a
 * refused or absent session, or a failed read leaves the app as it is.
 * Replace is setup's own replace step, which signs this key out and restarts
 * into the account's Welcome back. Not now keeps the key and asks again at
 * the next launch. While it asks, `children` (the backup prompt) waits.
 */
export function LinkedKeyCheck({
  federated,
  identity,
  viewer,
  onReplace,
  children,
}: {
  /** The build's Builderlab session; without one there is nothing to check. */
  federated?: Session | undefined;
  identity: Identity;
  /** The key on this device. */
  viewer: string;
  onReplace: () => void;
  children?: ReactNode;
}) {
  const session = useSession(federated);
  const revision =
    session?.status === "signed-in" && session.authority
      ? session.revision
      : undefined;
  const launching = useSyncExternalStore(subscribeLaunch, launchVisible);
  const importing = useSyncExternalStore(
    subscribeLegacyImport,
    legacyImportPending,
  );
  // The mismatch found, for the session and key it was read with.
  const [found, setFound] = useState<{
    revision: string;
    viewer: string;
    backedUp: boolean;
  }>();
  const dismissed = useRef(false);
  useEffect(() => {
    if (!federated || !revision || dismissed.current) return;
    let current = true;
    // A build that can't make the account (no Builderlab URL) has nothing to check.
    Promise.resolve()
      .then(() =>
        federatedBuilderlabAccount(
          { revision },
          federated,
          identity,
        ).linkedKey(),
      )
      .then(async (linked) => {
        if (!current || !linked || linked === viewer) return;
        const backedUp = await identity.backedUp(viewer).catch(() => false);
        if (current) setFound({ revision, viewer, backedUp });
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [federated, identity, viewer, revision]);
  if (
    !found ||
    found.revision !== revision ||
    found.viewer !== viewer ||
    launching ||
    importing
  )
    return children;
  const dismiss = () => {
    dismissed.current = true;
    setFound(undefined);
  };
  return (
    <AlertDialog
      title="Your account uses a different key"
      description={`${session?.email ?? "Your Builderlab account"} is linked to a different key than the one on this computer. Replace it to use your account’s key: Buzz restarts and signs you in again. ${
        found.backedUp
          ? "This key was backed up in Builderlab: sign in to its account to restore it."
          : "This key may not be backed up."
      }`}
      onClose={dismiss}
      actions={
        <>
          <Button onClick={dismiss}>Not now</Button>
          <Button variant="destructive" onClick={onReplace}>
            Replace
          </Button>
        </>
      }
    />
  );
}
