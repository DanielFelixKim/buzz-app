import { useRef, useState } from "react";
import type { CatchUpSource } from "./catch-up-context";
import { useBestieAsks } from "./BestieAsks";
import { useAgentChoices } from "../../features/agents/use-choices";
import { useSavedAgentState } from "../../features/solo/default-agent";
import { useRelayConnection, useRowProfiles } from "../../features/relay/react";
import { useChannelIdentityNames } from "../../features/identity-names/react";
import { messagePreviewText } from "../../features/conversation/message-preview-text";
import { Button } from "../../shared/design-system/ui/Button";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Field } from "../../shared/design-system/ui/Field";
import { Textarea } from "../../shared/design-system/ui/Textarea";
import {
  PopoverRoot,
  PopoverPopup,
  PopoverTitle,
  PopoverClose,
} from "../../shared/design-system/ui/Popover";
import { XIcon } from "../../shared/design-system/icons";
import { CatchUpAvatar } from "./CatchUpAvatar";
import styles from "./BestieHome.module.css";

export function AskBestiePopover({
  source,
  anchor,
  close,
}: {
  source: CatchUpSource;
  anchor: HTMLElement | null;
  close(): void;
}) {
  const asks = useBestieAsks();
  const { session, scope, status } = useRelayConnection(source.host.relay);
  const saved = useSavedAgentState(session, session.scope);
  const choices = useAgentChoices(session, true, true);
  const agent = choices.selectable.find((item) => item.pubkey === saved.agent);
  const name = agent?.managedName ?? agent?.name ?? "Bestie";
  const [question, setQuestion] = useState("");
  const [error, setError] = useState<string>();
  const accepted = useRef(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const connected =
    status === "ready" &&
    session === source.session &&
    scope === source.session.scope;
  const isThread =
    !!source.message.threadRootId || source.message.replyCount > 0;
  const noun = isThread ? "thread" : "post";
  const channel = session.channels.get?.(source.message.channelId);
  const profiles = useRowProfiles(session.profiles, [source.message]);
  const resolve = useChannelIdentityNames(session, source.message.channelId);
  const author = resolve(
    source.message.authorId,
    profiles.get(source.message.authorId)?.name ?? "Message author",
  );
  const finalFocus = () => {
    if (anchor?.isConnected)
      return (
        anchor.querySelector<HTMLElement>(
          '[aria-label="More message actions"]',
        ) ?? anchor
      );
    return (
      document.querySelector<HTMLElement>("[data-bestie-home-trigger]") ?? false
    );
  };
  return (
    <PopoverRoot
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <PopoverPopup
        anchor={anchor}
        side="top"
        align="end"
        size="wide"
        initialFocus={input}
        finalFocus={finalFocus}
      >
        <div className={styles.askHeading}>
          <div className="flex min-w-0 items-center gap-2">
            <CatchUpAvatar session={session} />
            <PopoverTitle>Ask {name}</PopoverTitle>
          </div>
          <PopoverClose
            render={
              <IconButton
                aria-label="Close Ask Bestie"
                size="toolbar"
                icon={<XIcon />}
              />
            }
          />
        </div>
        <div className={styles.snapshot}>
          <p className="m-0 text-label-sm">
            {author} · {channel?.name ?? "Original conversation"}
          </p>
          <p className={styles.excerpt}>
            {messagePreviewText(source.message.content) || "Original context"}
          </p>
          <p className="m-0 text-caption text-secondary">
            This {noun} will be linked in your ask.
          </p>
        </div>
        <form
          className={styles.askForm}
          onSubmit={(event) => {
            event.preventDefault();
            if (!asks || !agent || !connected || accepted.current) return;
            try {
              asks.submit(source, question, { pubkey: agent.pubkey, name });
              accepted.current = true;
              close();
            } catch (reason) {
              setError(
                reason instanceof Error
                  ? reason.message
                  : "Could not queue this ask.",
              );
            }
          }}
        >
          <Field label="What would you like to know?">
            <Textarea
              ref={input}
              rows={3}
              maxLength={4000}
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              placeholder={`Ask a question about this ${noun}…`}
            />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button
              size="xs"
              variant="outline"
              onClick={() => {
                setQuestion(
                  `Catch me up on this ${noun}. Summarize what’s happening, decisions, blockers, and the next step.`,
                );
                input.current?.focus();
              }}
            >
              Catch me up
            </Button>
            <Button
              size="xs"
              variant="outline"
              onClick={() => {
                setQuestion(
                  `What’s the next step in this ${noun}, and who owns it?`,
                );
                input.current?.focus();
              }}
            >
              Find the next step
            </Button>
          </div>
          {(error ||
            saved.error ||
            !connected ||
            (!choices.pending && saved.read && !agent)) && (
            <p role="alert" className="m-0 text-body-sm text-danger">
              {error ??
                saved.error ??
                (!connected
                  ? "Reconnect before sending this ask."
                  : "Choose a Bestie before sending an ask.")}
            </p>
          )}
          <div className={styles.askFooter}>
            <span className="text-caption text-secondary">
              Keep browsing. Find the answer in Bestie.
            </span>
            <Button
              type="submit"
              variant="prominent"
              size="sm"
              disabled={
                !question.trim() ||
                !agent ||
                !connected ||
                !saved.read ||
                !!saved.error
              }
            >
              Send
            </Button>
          </div>
        </form>
      </PopoverPopup>
    </PopoverRoot>
  );
}
