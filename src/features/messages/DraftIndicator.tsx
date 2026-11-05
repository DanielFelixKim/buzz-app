import { PencilSimpleIcon } from "../../shared/design-system/icons";

export function DraftIndicator({ count }: { count: number }) {
  if (!count) return null;
  const label = count === 1 ? "1 draft" : `${count} drafts`;
  return (
    <span
      className="inline-flex shrink-0 text-subtle"
      data-draft-indicator=""
      aria-hidden="true"
      title={label}
    >
      <PencilSimpleIcon size={14} aria-hidden="true" />
    </span>
  );
}
