import { useEffect, useState } from "react";
import type { MessageComposerProps } from "../../features/messages/MessageComposer";
import {
  ConversationComposer,
  ConversationTimeline,
  useConversation,
} from "../../features/conversation/Conversation";
import { useChannelWindow } from "../../features/relay/react";
import { MessageEditScope } from "../../features/messages/MessageEditScope";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import { ChatCircleIcon } from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import styles from "./Inbox.module.css";

/** One selected conversation window and the same scoped composer used in Channels.
 * It preserves the canonical window and composer without owning a new reader. */
export function ChannelPreview({
  channelName,
  onDraftSaved,
  label = "Conversation preview",
  autoFocus = false,
}: {
  /** The conversation's preview label, such as a DM's participants. */
  channelName: string;
  onDraftSaved?: () => void;
  label?: string;
  /** Focus the composer when it mounts, as a user-triggered handoff. */
  autoFocus?: MessageComposerProps["autoFocus"];
}) {
  const { session, channelId } = useConversation();
  const window = useChannelWindow(session.channels, channelId);
  const [sentId, setSentId] = useState<string>();
  const channel = session.channels.get?.(channelId);
  // Saved drafts open the current head without mutating canonical scroll intent.
  useEffect(() => {
    session.channels.refresh?.(channelId);
  }, [session, channelId]);
  // Cache clear can leave the selected window idle without remounting it.
  useEffect(() => {
    if (window.status === "idle") session.channels.ensure(channelId);
  }, [session, channelId, window.status]);
  return (
    <MessageEditScope>
      <section
        className={styles.previewFrame}
        aria-label={label}
        data-reading-surface=""
      >
        <div className={styles.previewHistory}>
          {window.rows.length > 0 && (
            <ConversationTimeline
              window={window}
              transient
              revealMessageId={sentId}
            />
          )}
          {(window.status === "error" || window.error) && (
            <p className={styles.notice} role="alert">
              {window.error ?? "Could not load conversation."}
            </p>
          )}
          {(window.status === "error" || window.error) && (
            <div className={styles.notice}>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => session.channels.refresh?.(channelId)}
              >
                Retry conversation
              </Button>
            </div>
          )}
          {window.status === "ready" &&
            !window.error &&
            !window.rows.length && (
              <div className={styles.empty} role="status">
                <EmptyState
                  icon={<ChatCircleIcon />}
                  title="No messages yet."
                  description="Start the conversation below."
                />
              </div>
            )}
          {(window.status === "idle" || window.status === "loading") &&
            !window.error &&
            !window.rows.length && (
              <p className={styles.notice} role="status">
                Loading conversation…
              </p>
            )}
        </div>
        <ConversationComposer
          channelName={channelName}
          label={
            channel?.channelType === "dm"
              ? `Message ${channelName}`
              : `Message #${channelName}`
          }
          onSend={setSentId}
          onDraftSaved={onDraftSaved}
          autoFocus={autoFocus}
        />
      </section>
    </MessageEditScope>
  );
}
