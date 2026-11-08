import {
  type ComponentProps,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";
import type { FederatedIdentity } from "../../features/federated-identity/service";
import { QrCode, renderQrCode } from "../../shared/QrCode";
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
 * The mobile card. Signed in with Builderlab, the phone signs in with the
 * same account, so the card only says where to get the app; any other
 * identity pairs the phone with this one.
 */
export function MobileSettings({
  federatedIdentity,
  stores = mobileAppStores(),
  ...pairing
}: ComponentProps<typeof PairingSettings> & {
  /** Builderlab's sign-in session; absent in builds without one. */
  federatedIdentity?:
    | Pick<FederatedIdentity, "snapshot" | "subscribe">
    | undefined;
  stores?: readonly Store[];
}) {
  const session = useSyncExternalStore(
    federatedIdentity?.subscribe ?? noSubscription,
    () => federatedIdentity?.snapshot(),
  );
  if (session?.status !== "signed-in") return <PairingSettings {...pairing} />;
  return <GetTheApp email={session.email} stores={stores} />;
}

const noSubscription = () => () => {};

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
            <StoreCode key={store.url} store={store} />
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
