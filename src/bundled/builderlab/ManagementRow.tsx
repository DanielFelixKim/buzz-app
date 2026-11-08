import type { ReactNode } from "react";
import styles from "./ManagementRow.module.css";

/** The Console's ListRow composition, using desktop roles and action owners. */
export function ManagementRow({
  icon,
  title,
  detail,
  status,
  statusTone,
  actions,
  revealActions = false,
}: {
  icon: ReactNode;
  title: ReactNode;
  detail?: ReactNode;
  status?: ReactNode;
  statusTone?: "warning" | undefined;
  actions?: ReactNode;
  revealActions?: boolean;
}) {
  return (
    <div
      className={styles.row}
      data-reveal-actions={revealActions || undefined}
    >
      <span className={styles.icon} aria-hidden="true">
        {icon}
      </span>
      <div className={styles.content}>
        <div className="text-label">{title}</div>
        {(detail || status) && (
          <div className="text-body-sm text-subtle">
            {detail}
            {detail && status && <span aria-hidden="true"> · </span>}
            {status && (
              <span
                role="status"
                className={
                  statusTone === "warning" ? "text-warning" : undefined
                }
              >
                {status}
              </span>
            )}
          </div>
        )}
      </div>
      {actions && <div className={styles.actions}>{actions}</div>}
    </div>
  );
}
