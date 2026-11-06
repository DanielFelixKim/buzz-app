import type { ForwardChildRegistered } from "../../features/host/forward";

/** goose's native delegate tool, as its `tool_call` titles it (goose 1.57.0). */
const DELEGATE = "delegate";

export type ForwardChildren = Readonly<{
  /** `registerForwardChild` bound to this generation's owner and id. */
  register: (call: string, child: string) => Promise<ForwardChildRegistered>;
  /** Shows why a child could not be registered on the turn. */
  failed: (reason: string) => void;
}>;

/** Registers the children goose delegates during one forwarded prompt, as
 * an `AcpSession.observe` of the generation's parent session. One per
 * generation, so the delegate calls it trusts are this prompt's. Only a live
 * `delegate` call announced earlier in the prompt registers: goose strips
 * `subagentSessionId` from every other tool's result (goose 1.57.0
 * `lease.rs`), and replayed or out-of-prompt updates are ignored. */
export function forwardChildren({ register, failed }: ForwardChildren) {
  const delegates = new Set<string>();
  let stopped = false;
  // The turn's failure signal, called once per failure and never again from
  // its own error. A reporter that throws stops registration too, so every
  // later child's inference is refused (`child_unregistered`) instead of
  // running unseen.
  const report = (reason: string) => {
    try {
      failed(reason);
    } catch (error) {
      stopped = true;
      console.error("A goose child registration failure went unreported", {
        reason,
        error,
      });
    }
  };
  return (update: Record<string, unknown>, prompting: boolean) => {
    if (!prompting || stopped) return;
    const call = update.toolCallId;
    if (typeof call !== "string") return;
    if (update.sessionUpdate === "tool_call") {
      if (update.title === DELEGATE) delegates.add(call);
      return;
    }
    const meta = update._meta as { goose?: { subagentSessionId?: unknown } };
    const child = meta?.goose?.subagentSessionId;
    if (
      update.sessionUpdate !== "tool_call_update" ||
      update.status !== "completed" ||
      typeof child !== "string" ||
      !delegates.has(call)
    )
      return;
    // Nothing escapes the update: a throw, rejection or bad result fails
    // the turn visibly instead.
    let registering: Promise<ForwardChildRegistered>;
    try {
      registering = register(call, child);
    } catch (error) {
      report(String(error));
      return;
    }
    registering.then(
      (registered) => {
        if (registered.type === "registered") return;
        if (registered.reason === "generation_revoked") stopped = true;
        report(registered.reason);
      },
      (error) => report(String(error)),
    );
  };
}
