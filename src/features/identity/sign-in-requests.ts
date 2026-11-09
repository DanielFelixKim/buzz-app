// "Open Buzz" from the account pages (`buzz://sign-in`, sent after email
// verification) asks first-run to sign in again. The browser keeps the account
// session, so that sign-in finishes without a password. A request that arrives
// before Welcome listens, such as the link that launched the app, waits briefly;
// one that arrives after Welcome is gone is dropped by expiry rather than
// starting a sign-in after a later sign-out.

const FRESH_MS = 2 * 60_000;

// A restart Buzz starts itself (first-run sign-in replacing this device's key)
// asks the next launch to sign in the same way, through this note, and names
// the key the account it replaced the key for is linked to.
const AFTER_RESTART = "buzz.sign-in-after-restart.v1";
const EXPECTED = "buzz.sign-in-after-restart.expected.v1";
// Signing out may wait on paired tools and agents before the restart.
const RESTART_MS = 5 * 60_000;

let requested: number | undefined;
// The linked key the restart note just taken expects, until taken itself.
let expected: string | undefined;
const listeners = new Set<() => void>();

/** Whether `url` is the sign-in link, and only that: no path, query or fragment. */
export function isSignInLink(url: string): boolean {
  return /^buzz:\/\/sign-in\/?$/i.test(url);
}

export function requestSignIn(now = Date.now()): void {
  requested = now;
  for (const listener of [...listeners]) listener();
}

/** Consumes a fresh request, or a restart's note; true when one was waiting. */
export function takeSignInRequest(now = Date.now()): boolean {
  const fresh = requested !== undefined && now - requested <= FRESH_MS;
  requested = undefined;
  return takeRestartNote(now) || fresh;
}

/**
 * The key the account must be linked to for the sign-in `takeSignInRequest`
 * just started, when a restart replacing this device's key asked for it.
 * Taken once.
 */
export function takeExpectedKey(): string | undefined {
  const key = expected;
  expected = undefined;
  return key;
}

/**
 * Asks the launch after this restart to sign in again, to the account linked
 * to `linked`. The returned function withdraws the request, for a restart
 * that didn't happen.
 */
export function requestSignInAfterRestart(
  linked?: string,
  now = Date.now(),
): () => void {
  try {
    localStorage.setItem(AFTER_RESTART, String(now));
    if (linked) localStorage.setItem(EXPECTED, linked);
    else localStorage.removeItem(EXPECTED);
  } catch {
    // Storage refused: the landing shows Sign in instead.
  }
  return () => {
    try {
      localStorage.removeItem(AFTER_RESTART);
      localStorage.removeItem(EXPECTED);
    } catch {
      // Nothing saved to withdraw.
    }
  };
}

/**
 * Whether a restart asked for this sign-in recently enough to still mean it:
 * the note is taken by the first landing that can act on it, and used once.
 */
function takeRestartNote(now: number): boolean {
  expected = undefined;
  try {
    const noted = Number(localStorage.getItem(AFTER_RESTART));
    const linked = localStorage.getItem(EXPECTED);
    localStorage.removeItem(AFTER_RESTART);
    localStorage.removeItem(EXPECTED);
    const fresh = noted > 0 && now - noted <= RESTART_MS;
    if (fresh && linked) expected = linked;
    return fresh;
  } catch {
    return false;
  }
}

export function onSignInRequest(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
