import type { PluginModule } from "../../plugins/api";
import { nativeBuilderlab } from "../builderlab/session";
import { bundledFederatedIdentity } from "../builderlab/oauth/first-run";
import { MobileSettings } from "./MobileApp";
import { DeviceMobileIcon } from "../../shared/design-system/icons";
// A Builderlab build also offers the mobile app's own sign-in. It reads that
// session and the account's backup status as the Builderlab plugin's bundled
// installation, as Settings' Identity page does; see MobileSettings.
const builderlab = nativeBuilderlab();
export const inject = [
  "settingsCards",
  "communityReader",
  ...(builderlab ? ["federatedIdentity"] : []),
];
export const apply: PluginModule["apply"] = (ctx) => {
  const communities = ctx.communityReader;
  const federatedIdentity = builderlab
    ? bundledFederatedIdentity(ctx)
    : undefined;
  ctx.settingsCards.register({
    id: "mobile",
    title: builderlab ? "Mobile app" : "Pair mobile",
    icon: DeviceMobileIcon,
    // Pairing needs a community address, not a selected community.
    personal: true,
    component: ({ active }) => (
      <MobileSettings
        communities={communities}
        active={active}
        federatedIdentity={federatedIdentity}
      />
    ),
  });
};
