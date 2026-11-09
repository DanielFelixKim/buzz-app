import type { ReactNode } from "react";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import styles from "./ManagementRow.module.css";

/** A management row; the action owner supplies any live feedback. */
export function ManagementRow({
  icon,
  title,
  detail,
  status,
  statusTone,
  actions,
  revealActions = false,
  onOpen,
  openLabel,
  alignIcon = "center",
}: {
  icon: ReactNode;
  title: ReactNode;
  detail?: ReactNode;
  status?: ReactNode;
  statusTone?: "warning" | undefined;
  actions?: ReactNode;
  revealActions?: boolean;
  onOpen?: (() => void) | undefined;
  openLabel?: string | undefined;
  alignIcon?: "center" | "start";
}) {
  const artwork = (
    <span className={styles.icon} aria-hidden="true">
      {icon}
    </span>
  );
  const content = (
    <span className={styles.content}>
      <span className="text-label">{title}</span>
      {(detail || status) && (
        <span className="text-body-sm text-subtle">
          {detail}
          {detail && status && <span aria-hidden="true"> · </span>}
          {status && (
            <span
              className={statusTone === "warning" ? "text-warning" : undefined}
            >
              {status}
            </span>
          )}
        </span>
      )}
    </span>
  );
  return (
    <div
      className={styles.row}
      data-reveal-actions={revealActions || undefined}
      data-align-icon={alignIcon}
    >
      {onOpen ? (
        <div className={styles.primary}>
          <NavigationItem
            multiline
            icon={artwork}
            label={content}
            aria-label={openLabel}
            onClick={(event) => {
              // The public key remains selectable without navigating away.
              if (
                event.target instanceof Element &&
                event.target.closest("[data-agent-key]")
              )
                return;
              onOpen();
            }}
          />
        </div>
      ) : (
        <>
          {artwork}
          {content}
        </>
      )}
      {actions && <div className={styles.actions}>{actions}</div>}
    </div>
  );
}
