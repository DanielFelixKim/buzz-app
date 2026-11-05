import { relayOrigin } from "../../communities/destination.ts";
import { isBuzzUuid } from "./contract.ts";

/** The public deployment descriptor `BUZZ_WORKFORCE_GATEWAY`: the approved
 * Workforce gateway origin and the exact corporate communities whose local
 * agent memberships route through it. It names no credential. Compiled into
 * the frontend; native compiles only the gateway origin, as `buzz.agents`'s
 * network grant. Empty means Workforce routing is off everywhere. */
export type WorkforceDescriptor = Readonly<{
  version: 1;
  gateway: string;
  communities: readonly Readonly<{ id: string; origin: string }>[];
}>;

const COMMUNITY_LIMIT = 16;

/** The descriptor in `raw`, canonicalized, or null when `raw` is empty.
 * Throws on anything else, without echoing the value. */
export function parseWorkforceDescriptor(
  raw: string,
): WorkforceDescriptor | null {
  if (!raw.trim()) return null;
  const fail = (why: string): never => {
    throw new Error(`BUZZ_WORKFORCE_GATEWAY is invalid: ${why}.`);
  };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    fail("it isn't JSON");
  }
  if (!plain(value) || keys(value) !== "communities,gateway,version")
    return fail("expected exactly version, gateway and communities");
  if (value.version !== 1) fail("version must be 1");
  const gateway = typeof value.gateway === "string" ? value.gateway : "";
  const url = URL.canParse(gateway) ? new URL(gateway) : null;
  if (url?.protocol !== "https:" || url.origin !== gateway)
    fail("gateway must be an https:// origin with no path or credentials");
  const listed = value.communities;
  if (
    !Array.isArray(listed) ||
    listed.length === 0 ||
    listed.length > COMMUNITY_LIMIT
  )
    return fail(`communities must list 1 to ${COMMUNITY_LIMIT} communities`);
  const communities = listed.map((community) => {
    if (!plain(community) || keys(community) !== "id,origin")
      return fail("each community needs exactly id and origin");
    if (!isBuzzUuid(community.id))
      fail("a community id isn't a canonical NIP-11 UUID");
    let origin = "";
    try {
      origin = relayOrigin(String(community.origin));
    } catch {
      fail("a community origin isn't a secure community origin");
    }
    return Object.freeze({ id: community.id as string, origin });
  });
  const unique = (values: string[]) => new Set(values).size === values.length;
  if (
    !unique(communities.map(({ id }) => id)) ||
    !unique(communities.map(({ origin }) => origin))
  )
    fail("community ids and origins must be unique");
  return Object.freeze({
    version: 1,
    gateway,
    communities: Object.freeze(communities),
  });
}

/** This build's descriptor. Vite validated it, so it parses. */
export function workforceDescriptor(): WorkforceDescriptor | null {
  return parseWorkforceDescriptor(
    import.meta.env.VITE_BUZZ_WORKFORCE_GATEWAY ?? "",
  );
}

const plain = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const keys = (value: Record<string, unknown>) =>
  Object.keys(value).sort().join();
