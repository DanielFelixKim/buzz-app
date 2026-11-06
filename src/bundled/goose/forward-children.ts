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
  let revoked = false;
  return (update: Record<string, unknown>, prompting: boolean) => {
    if (!prompting || revoked) return;
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
    register(call, child).then(
      (registered) => {
        if (registered.type === "registered") return;
        if (registered.reason === "generation_revoked") revoked = true;
        failed(registered.reason);
      },
      (error: unknown) => failed(String(error)),
    );
  };
}
