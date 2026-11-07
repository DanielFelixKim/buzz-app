import type { ComponentProps, ReactNode } from "react";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { TypingDots } from "../../shared/design-system/ui/TypingDots";
import { MessageReplyIcon } from "../../shared/design-system/icons/index";
import styles from "./ConversationRow.module.css";

/** PROTOTYPE: one row for every conversation list (Solo, Team, Threads,
 * Mentions, DMs). The place always leads; the avatar always says who.
 *
 *   [who]  parent › place             time
 *          Sender: latest message     state
 */
export function ConversationRow({
  avatar,
  place,
  placeIcon,
  parent,
  time,
  sender,
  preview,
  state = "read",
  ...props
}: {
  /** Who: the agent in Solo, the latest poster in Team, the person in DMs. */
  avatar: ReactNode;
  /** Where: the channel, chat, thread or person. Always the title. */
  place: ReactNode;
  /** Optional glyph for places a name alone can't describe (threads, private). */
  placeIcon?: ReactNode | undefined;
  /** Where the place lives, such as a thread's channel; shown first, quieter,
   * as a breadcrumb: #channel › first message. */
  parent?: ReactNode | undefined;
  time: ReactNode;
  /** The latest message's author, shown before the preview. */
  sender?: ReactNode | undefined;
  preview: ReactNode;
  state?: "read" | "unread" | "working" | undefined;
} & Omit<
  ComponentProps<typeof NavigationItem>,
  "icon" | "label" | "trailing" | "multiline"
>) {
  return (
    <NavigationItem
      {...props}
      multiline
      data-conversation-row=""
      data-state={state}
      label={
        <span className={styles.row}>
          <span className={styles.avatar}>{avatar}</span>
          <span className={styles.lines}>
            <span className={styles.line}>
              <span className={styles.title}>
                {placeIcon && (
                  <span className={styles.placeIcon}>{placeIcon}</span>
                )}
                {parent && (
                  <>
                    <span className={styles.parentIcon}>
                      <MessageReplyIcon size={14} aria-hidden="true" />
                    </span>
                    <span className={styles.parent}>{parent}</span>
                    <span className={styles.separator} aria-hidden="true">
                      ›
                    </span>
                  </>
                )}
                <span className={styles.place}>{place}</span>
              </span>
              <span className={styles.time}>{time}</span>
            </span>
            <span className={styles.line}>
              <span className={styles.preview}>
                {sender && <span className={styles.sender}>{sender}: </span>}
                {preview}
              </span>
              <span className={styles.state}>
                {state === "unread" && (
                  <span
                    className={styles.unreadDot}
                    role="img"
                    aria-label="Unread"
                  />
                )}
                {state === "working" && <TypingDots size="small" />}
              </span>
            </span>
          </span>
        </span>
      }
    />
  );
}
