import { useEffect, useRef, type PointerEvent } from "react";

/** Holding prose selects a reply; selection, scrolling and embedded controls win. */
export function useMessageReplyHold(
  id: string,
  reply: (() => void) | undefined,
) {
  const latest = useRef(reply);
  latest.current = reply;
  const hold = useRef<
    | {
        id: string;
        x: number;
        y: number;
        pointerId: number;
        cancel(): void;
      }
    | undefined
  >(undefined);
  const cancel = () => hold.current?.cancel();
  const enabled = !!reply;
  useEffect(() => {
    if (!enabled || hold.current?.id !== id) hold.current?.cancel();
    return () => hold.current?.cancel();
  }, [id, enabled]);
  return {
    onPointerDown(event: PointerEvent<HTMLDivElement>) {
      const target = event.target as Element;
      if (
        !latest.current ||
        hold.current ||
        event.button !== 0 ||
        event.isPrimary === false ||
        event.defaultPrevented ||
        target.closest(
          "a, button, input, textarea, select, summary, audio, video, [role='button'], [role='link'], [role='menuitem'], [contenteditable='true']",
        ) ||
        !target.ownerDocument.getSelection()?.isCollapsed
      )
        return;
      const doc = target.ownerDocument;
      const win = doc.defaultView;
      const clear = () => {
        clearTimeout(timer);
        doc.removeEventListener("scroll", clear, true);
        win?.removeEventListener("blur", clear);
        hold.current = undefined;
      };
      const timer = setTimeout(() => {
        clear();
        if (target.isConnected && doc.getSelection()?.isCollapsed)
          latest.current?.();
      }, 100);
      hold.current = {
        id,
        x: event.clientX,
        y: event.clientY,
        pointerId: event.pointerId,
        cancel: clear,
      };
      doc.addEventListener("scroll", clear, true);
      win?.addEventListener("blur", clear);
    },
    onPointerMove(event: PointerEvent<HTMLDivElement>) {
      const pending = hold.current;
      if (
        pending &&
        event.pointerId === pending.pointerId &&
        Math.hypot(event.clientX - pending.x, event.clientY - pending.y) > 5
      )
        cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onPointerLeave: cancel,
    onContextMenu: cancel,
  };
}
