import type { BuilderlabViewerSession } from "../../../features/browser/api";
import type { Host } from "../../../features/host/service";
import {
  accountStorage,
  type BuilderlabRequest,
  type Credential as Owner,
  type LoginSnapshot,
} from "../session";
import {
  CLEANUP_FAILED,
  oauthTarget,
  type Credential,
  type SavedSignIn,
} from "./browser";

const SIGN_OUT_FAILED = "Couldn’t finish signing out of Builderlab. Try again.";

/** One plugin lifetime owns the reusable credential; UI snapshots never contain it. */
export function createOAuthSession(
  acquire: (signal: AbortSignal) => Promise<Credential>,
  release?: (credential: Credential) => void | Promise<void>,
  /** Carries `request`; without it, requests are refused. */
  host?: Pick<Host, "request">,
  /** With it, the session follows the shared saved sign-in: creation
   * restores it, each sign-in is saved there, and sign-out deletes it. */
  saved?: SavedSignIn,
) {
  let credential: Credential | undefined;
  let attempt: AbortController | undefined;
  // The shared sign-in's generation the attempt started at, and its own
  // sign-in once accepted there.
  let started = 0;
  let claimed: Credential | undefined;
  let viewer: BuilderlabViewerSession | undefined;
  let viewerLifetime: AbortController | undefined;
  let disposed = false;
  let state: LoginSnapshot = { status: "signed-out" };
  const listeners = new Set<() => void>();
  const publish = (next: LoginSnapshot) => {
    state = next;
    for (const listener of listeners) listener();
  };
  const revoke = async (owner: Credential) => {
    await release?.(owner);
  };
  const signedOut = (): LoginSnapshot =>
    saved?.failed()
      ? { status: "signed-out", error: CLEANUP_FAILED }
      : { status: "signed-out" };
  const adopt = (next: Credential, storage: string) => {
    credential = next;
    viewerLifetime = new AbortController();
    viewer = { credential: next.value, storage, signal: viewerLifetime.signal };
    publish({ status: "signed-in", account: next.account });
  };
  const reset = (revoke = false, announce = true) => {
    attempt?.abort();
    attempt = undefined;
    viewerLifetime?.abort();
    viewerLifetime = undefined;
    viewer = undefined;
    const previous = credential;
    credential = undefined;
    if (previous && revoke)
      if (saved) saved.current() === previous && saved.retire();
      else void Promise.resolve(release?.(previous)).catch(() => {});
    if (announce) publish(signedOut());
  };
  /** Signs in with `obtain`; a restore is pending without a browser step and
   * leaves the session signed out, without an error, when nothing is saved. */
  const run = async (
    obtain: (signal: AbortSignal) => Promise<Credential | undefined>,
    restoring: boolean,
  ) => {
    const current = new AbortController();
    attempt = current;
    started = saved?.generation() ?? 0;
    claimed = undefined;
    publish(
      restoring ? { status: "pending", checking: true } : { status: "pending" },
    );
    try {
      const result = await obtain(current.signal);
      const storage = result && (await accountStorage(result.account.subject));
      if (result && saved && !restoring) {
        claimed = result;
        await saved.accept(result, revoke, current.signal, started);
      }
      current.signal.throwIfAborted();
      if (attempt !== current || disposed) return;
      if (!result || !storage) {
        publish(signedOut());
        return;
      }
      adopt(result, storage);
    } catch (error) {
      if (attempt !== current || disposed) return;
      publish({
        status: "signed-out",
        error:
          error instanceof Error ? error.message : "Sign-in failed. Try again.",
      });
    } finally {
      if (attempt === current) attempt = undefined;
    }
  };
  // Follows the shared sign-in when Welcome replaces it or NIP-FI retires it,
  // ending a pending attempt that no longer owns it.
  const follow = async () => {
    const next = saved?.current();
    if (disposed) return;
    if (attempt) {
      if (started === saved?.generation() || (next && next === claimed)) return;
      reset(false, false);
    }
    if (next === credential) {
      if (!next) publish(signedOut());
      return;
    }
    reset(false, !next);
    if (!next) return;
    const storage = await accountStorage(next.account.subject);
    if (!disposed && !attempt && !credential && saved?.current() === next)
      adopt(next, storage);
  };
  const unwatch = saved?.subscribe(() => void follow());
  if (saved && host) {
    const restoring = host;
    void run((signal) => saved.restore(restoring, signal), true);
  }
  return {
    snapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    credential() {
      if (!credential) throw new Error("Sign in to Builderlab first.");
      return credential;
    },
    async request(owner: Owner, input: BuilderlabRequest) {
      if (!host) throw new Error("Builderlab requests are unavailable.");
      // A retired or replaced sign-in sends nothing, even from a running call.
      if (owner !== credential)
        throw new DOMException("Builderlab session changed.", "AbortError");
      return host.request({
        url: `${oauthTarget()}${input.path}`,
        ...(input.method ? { method: input.method } : {}),
        headers: {
          ...input.headers,
          "X-BB-Session-Credential": (owner as Credential).value,
        },
        ...(input.body !== undefined ? { body: input.body } : {}),
      });
    },
    /** The credential is over; a stale one leaves a newer sign-in alone. */
    expired(owner: Owner) {
      if (owner === credential) reset(true);
    },
    viewerSession() {
      if (!viewer) throw new Error("Sign in to Builderlab first.");
      return viewer;
    },
    /** Creation joins Settings' login without owning or canceling that attempt. */
    async ensureSignedIn(signal: AbortSignal): Promise<void> {
      signal.throwIfAborted();
      if (disposed) throw new Error("Builderlab session is closed.");
      if (credential) return;
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          listeners.delete(changed);
          signal.removeEventListener("abort", abort);
        };
        const abort = () => {
          cleanup();
          reject(signal.reason);
        };
        const changed = () => {
          if (state.status === "pending") return;
          cleanup();
          if (credential) resolve();
          else reject(new Error(state.error ?? "Sign-in canceled."));
        };
        listeners.add(changed);
        signal.addEventListener("abort", abort, { once: true });
        void this.signIn();
      });
    },
    cancel: () => reset(),
    abandon: () => reset(),
    /** Deletes the saved sign-in first; until that succeeds the sign-out is
     * unfinished, still signed in with an error, and signing out tries again. */
    signOut() {
      if (!saved) return reset(true);
      const previous = credential;
      attempt?.abort();
      attempt = undefined;
      return saved.signOut().then(
        () => {
          if (!disposed && !credential) publish(signedOut());
        },
        () => {
          if (!disposed && previous && credential === previous)
            publish({
              status: "signed-in",
              account: previous.account,
              error: SIGN_OUT_FAILED,
            });
        },
      );
    },
    /** NIP-FI took over: stop using this sign-in now and retire it. */
    retire: () => (saved ? saved.retire() : reset(true)),
    /** Removing a retired sign-in keeps failing; shown where it's active. */
    cleanupFailed: () => saved?.failed() === true,
    /** The shared sign-in's generation: see `SavedSignIn.generation`. */
    generation: () => saved?.generation() ?? 0,
    async signIn() {
      if (disposed || attempt) return;
      reset(!saved, false);
      await run(acquire, false);
    },
    dispose() {
      disposed = true;
      unwatch?.();
      reset();
      listeners.clear();
    },
  };
}
export type OAuthSession = ReturnType<typeof createOAuthSession>;
