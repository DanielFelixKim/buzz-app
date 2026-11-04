import type { FoundCommunity } from "../communities/find-community.ts";
import { coversCommunity } from "../federated-identity/community-hosts.ts";
import {
  signInServers,
  type SessionSnapshot,
} from "../federated-identity/service.ts";

/**
 * Whether a community URL given before setup is covered by this build's
 * Builderlab, its first sign-in server, so first run signs in for it at once
 * rather than asking. Native's compiled server list decides, by the same
 * rules native attaches tokens with; a build without one treats every
 * community as unhosted.
 */
export async function hostedByThisBuilderlab(
  found: Pick<FoundCommunity, "url">,
  servers: () => Promise<readonly SessionSnapshot[]> = signInServers,
): Promise<boolean> {
  const hosts = (await servers().catch(() => []))[0]?.authority?.communityHosts;
  return hosts !== undefined && coversCommunity(hosts, found.url);
}
