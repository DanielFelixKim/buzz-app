import {
  type ComponentProps,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";
import type { FederatedIdentity } from "../../features/federated-identity/service";
import { QrCode, renderQrCode } from "../../shared/QrCode";
import { LoadingRegion } from "../../shared/design-system/ui/LoadingRegion";
import { PairingSettings } from "./PairingSettings";

/** The build's mobile app listings (`BUZZ_MOBILE_APP_IOS_URL`,
 * `BUZZ_MOBILE_APP_ANDROID_URL`); a store the build doesn't set is left out. */
export const mobileAppStores = () =>
  [
    {
      name: "the App Store",
      url: import.meta.env.VITE_BUZZ_MOBILE_APP_IOS_URL,
    },
    {
      name: "Google Play",
      url: import.meta.env.VITE_BUZZ_MOBILE_APP_ANDROID_URL,
    },
  ].filter((store): store is Store => !!store.url);

type Store = { name: string; url: string };

/**
 * The mobile card. A phone signed in with Builderlab restores the account's
 * bound, backed-up key, so where that key is this device's the card only says
 * where to get the app. Every other case pairs the phone with this identity.
 */
export function MobileSettings({
  federatedIdentity,
  stores = mobileAppStores(),
  ...pairing
}: ComponentProps<typeof PairingSettings> & {
  /** Builderlab's sign-in session, called as the Builderlab plugin
   * (`bundledFederatedIdentity`); absent in builds without one. */
  federatedIdentity?:
    | Pick<FederatedIdentity, "snapshot" | "subscribe" | "request">
    | undefined;
  stores?: readonly Store[];
}) {
  const session = useSyncExternalStore(
    federatedIdentity?.subscribe ?? noSubscription,
    () => federatedIdentity?.snapshot(),
  );
  const viewer = useSyncExternalStore(
    pairing.communities.subscribe,
    pairing.communities.snapshot,
  ).viewer;
  const signedIn =
    session?.status === "signed-in" && session.authority ? session : undefined;
  const check = signedIn && viewer ? `${signedIn.revision}:${viewer}` : "";
  const [restores, setRestores] = useState<{ check: string; ok: boolean }>();
  useEffect(() => {
    if (!check || !viewer || !federatedIdentity || !signedIn?.authority) return;
    let current = true;
    restoresThisKey(federatedIdentity, signedIn.authority.apiBasePath, viewer)
      .catch(() => false)
      .then((ok) => current && setRestores({ check, ok }));
    return () => {
      current = false;
    };
  }, [check, federatedIdentity, signedIn?.authority, viewer]);
  if (!check) return <PairingSettings {...pairing} />;
  const answer = restores?.check === check ? restores.ok : undefined;
  // Pairing starts a session as it mounts, so it waits for the answer.
  if (answer === undefined)
    return (
      <LoadingRegion
        pending
        label="Checking your Builderlab account…"
        statusVisibility="screen-reader"
      >
        {null}
      </LoadingRegion>
    );
  return answer ? (
    <GetTheApp email={signedIn?.email ?? null} stores={stores} />
  ) : (
    <PairingSettings {...pairing} />
  );
}

const noSubscription = () => () => {};

/** Whether the account's current key is `viewer` and is backed up: one
 * `nsec-backups/status` read. Any other answer, or none in time, is no. */
async function restoresThisKey(
  federated: Pick<FederatedIdentity, "request">,
  apiBasePath: string,
  viewer: string,
) {
  const response = await federated.request({
    path: `${apiBasePath}v1/buzz/nsec-backups/status`,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
    timeoutMs: 10_000,
  });
  if (response.status < 200 || response.status >= 300) return false;
  const reply: unknown = JSON.parse(response.body);
  if (!reply || typeof reply !== "object") return false;
  const { current_nostr_pubkey: current, backup_nostr_pubkeys: backups } =
    reply as Record<string, unknown>;
  const key = viewer.toLowerCase();
  return (
    typeof current === "string" &&
    current.toLowerCase() === key &&
    Array.isArray(backups) &&
    backups.some(
      (backup) => typeof backup === "string" && backup.toLowerCase() === key,
    )
  );
}

function GetTheApp({
  email,
  stores,
}: {
  email: string | null;
  stores: readonly Store[];
}) {
  return (
    <section aria-labelledby="mobile-app-title" className="min-w-0">
      <h2 id="mobile-app-title" className="mt-0 mb-2 text-label">
        Get Buzz on your phone
      </h2>
      <p className="mt-0 mb-6 text-body-sm text-muted">
        {`Install Buzz on your phone${stores.length ? "" : " from its app store"}, then sign in with Builderlab${email ? ` as ${email}` : ""}.`}
      </p>
      {stores.length > 0 && (
        <ul className="m-0 flex list-none flex-wrap gap-6 p-0">
          {stores.map((store) => (
            <StoreCode key={store.name} store={store} />
          ))}
        </ul>
      )}
    </section>
  );
}

/** A store's QR code to scan with the phone, and its link. Without the
 * native renderer (the browser host) only the link shows. */
function StoreCode({ store }: { store: Store }) {
  const [svg, setSvg] = useState<string>();
  useEffect(() => {
    let current = true;
    renderQrCode(store.url).then(
      (next) => current && setSvg(next),
      () => {},
    );
    return () => {
      current = false;
    };
  }, [store.url]);
  return (
    <li className="flex w-60 max-w-full flex-col items-center gap-3">
      {svg && (
        <QrCode
          svg={svg}
          alt={`Scan with your phone to get Buzz from ${store.name}`}
        />
      )}
      <a
        className="text-body-sm text-link underline"
        href={store.url}
        target="_blank"
        rel="noreferrer"
      >
        {`Get it on ${store.name}`}
      </a>
    </li>
  );
}
