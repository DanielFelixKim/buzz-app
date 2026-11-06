import { useLayoutEffect, useState, type RefObject } from "react";

/**
 * Whether the board's open dock floats over its conversation, as a card or at
 * full width. A media and a container query decide that, so CSS stays the only
 * owner of the breakpoints: this reads the dock's computed position.
 */
export function useCoveredByDock(
  board: RefObject<HTMLElement | null>,
  open: boolean,
) {
  const [overlay, setOverlay] = useState(false);
  useLayoutEffect(() => {
    const element = board.current;
    if (!open || !element) return;
    const dock = element.querySelector<HTMLElement>(
      ":scope > [data-panel-dock]",
    );
    const measure = () =>
      setOverlay(!!dock && getComputedStyle(dock).position === "absolute");
    measure();
    // Either query flips with the board's or the dock's size.
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    if (dock) observer.observe(dock);
    return () => {
      observer.disconnect();
      // A reopened dock never covers from a stale width.
      setOverlay(false);
    };
  }, [board, open]);
  // Derived while rendering, so closing the dock uncovers in the same commit.
  return open && overlay;
}
