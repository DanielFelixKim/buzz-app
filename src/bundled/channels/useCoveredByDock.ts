import { useLayoutEffect, useState, type RefObject } from "react";

const live = (element: HTMLElement) =>
  !element.closest("[hidden], [inert]") && element.getClientRects().length > 0;

/**
 * Focus the board's dock where a typed key does nothing: a visible panel's own
 * landing, as PanelCard's when it opened, else the selected tab. Never a
 * button, which Space or Enter would press.
 */
export function focusDock(board: Element | null | undefined) {
  const find = (selector: string) =>
    Array.from(
      board?.querySelectorAll<HTMLElement>(
        `:scope > [data-panel-dock] ${selector}`,
      ) ?? [],
    ).find(live);
  (
    find('> * > [tabindex="-1"][aria-label]') ??
    find('[role="tab"][aria-selected="true"]')
  )?.focus({ preventScroll: true });
}

/**
 * Whether the board's open dock floats over `content`, as a card or at full
 * width. A media and a container query decide that, so CSS stays the only
 * owner of the breakpoints: this reads the dock's computed position.
 */
export function useCoveredByDock(
  board: RefObject<HTMLElement | null>,
  content: RefObject<HTMLElement | null>,
  open: boolean,
) {
  const [overlay, setOverlay] = useState(false);
  useLayoutEffect(() => {
    const element = board.current;
    if (!open || !element) return;
    const dock = element.querySelector<HTMLElement>(
      ":scope > [data-panel-dock]",
    );
    const measure = () => {
      const covering = !!dock && getComputedStyle(dock).position === "absolute";
      // Inert content would drop focus to the page, so hand it to the dock
      // first, as narrow Settings hands it to its details.
      if (covering && content.current?.contains(document.activeElement))
        focusDock(element);
      setOverlay(covering);
    };
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
  }, [board, content, open]);
  // Derived while rendering, so closing the dock uncovers in the same commit.
  return open && overlay;
}
