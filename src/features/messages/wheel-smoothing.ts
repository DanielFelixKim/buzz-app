import { useLayoutEffect, type RefObject } from "react";
import { macWebKit } from "./mac-webkit";
import { smoothWheelPreference } from "./smooth-wheel-preference";

// Mac WebKit applies each mouse-wheel notch as one instant jump; Chromium
// animates it. With Smooth mouse-wheel scrolling on, the channel timeline
// glides each notch instead and leaves trackpad input to WebKit.
//
// Mouse vs trackpad: WebKit on macOS reports a mouse notch as a 16.16
// fixed-point line count times 40px, so its deltaY is fractional
// (4.000244140625 is 6554/65536 x 40). Trackpad deltas are whole pixels.
// Line and page delta modes are always a wheel.

export const LINE_PX = 40;
export const GLIDE_MS = 140;

type WheelInput = Pick<WheelEvent, "deltaMode" | "deltaX" | "deltaY">;

export function isMouseWheel(event: WheelInput) {
  if (event.deltaMode !== 0) return true;
  return !Number.isInteger(event.deltaY) || !Number.isInteger(event.deltaX);
}

export function toPixels(event: WheelInput, element: Element) {
  if (event.deltaMode === 1) return event.deltaY * LINE_PX;
  if (event.deltaMode === 2) return event.deltaY * element.clientHeight;
  return event.deltaY;
}

/** A dialog or open popover rendered within message DOM (an expanded
 * equation, a hover card) is outside the timeline's native scroll chain. */
function insideOverlay(target: Element) {
  if (target.closest('dialog, [role="dialog"], [aria-modal="true"]'))
    return true;
  for (
    let node = target.closest("[popover]");
    node;
    node = node.parentElement?.closest("[popover]") ?? null
  )
    if (node.matches(":popover-open")) return true;
  return false;
}

/** A scrollable element between the target and the scroller scrolls itself. */
function insideNestedScroller(target: Element, scroller: Element) {
  for (
    let node: Element | null = target;
    node && node !== scroller;
    node = node.parentElement
  ) {
    if (node.scrollHeight <= node.clientHeight + 1) continue;
    const overflow = getComputedStyle(node).overflowY;
    if (overflow === "auto" || overflow === "scroll") return true;
  }
  return false;
}

type Glide = {
  /** Where the glide has got to, as a float so sub-pixel steps add up. */
  position: number;
  /** The scrollTop read back after the last write, to spot corrections. */
  written: number;
  remaining: number;
  last: number;
  frame: number;
  /** The timeline's reader intent after this glide's latest notch. */
  intent: number | undefined;
};

const smoothers = new WeakMap<Element, (event: WheelEvent) => boolean>();

/**
 * Glides mouse-wheel notches over `scroller` until the returned cleanup.
 * Glide writes are not reader intent: the wheel still reaches the timeline's
 * own handlers, which release bottom follow, load older history and retire
 * held anchors and retained navigation. Any newer `intent()` than the glide's
 * own notches (other reader input, a send, Jump to latest or a reveal) ends it.
 */
export function smoothWheel(scroller: HTMLElement, intent: () => number) {
  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  let glide: Glide | undefined;
  const stop = () => {
    if (glide) cancelAnimationFrame(glide.frame);
    glide = undefined;
  };
  const step = (now: number) => {
    const current = glide;
    if (!current) return;
    // The notch's own handler bumps intent after it is queued; adopt that.
    if (
      reducedMotion?.matches ||
      (current.intent !== undefined && current.intent !== intent())
    ) {
      glide = undefined;
      return;
    }
    current.intent = intent();
    const dt = Math.min(64, current.last ? now - current.last : 16);
    current.last = now;
    // Carry the timeline's own corrections (Virtua's, scroll-correction.ts)
    // instead of undoing them.
    const drift = scroller.scrollTop - current.written;
    if (Math.abs(drift) >= 1) current.position += drift;
    const fraction = 1 - Math.exp(-dt / (GLIDE_MS / 3));
    // The last step takes the sub-pixel rest, so a glide covers the distance.
    const move =
      Math.abs(current.remaining * (1 - fraction)) < 0.5
        ? current.remaining
        : current.remaining * fraction;
    current.position += move;
    current.remaining -= move;
    scroller.scrollTop = current.position;
    current.written = scroller.scrollTop;
    const max = scroller.scrollHeight - scroller.clientHeight;
    if (
      (current.position <= 0 && current.remaining < 0) ||
      (current.position >= max && current.remaining > 0) ||
      Math.abs(current.remaining) < 0.5
    ) {
      glide = undefined;
      return;
    }
    current.frame = requestAnimationFrame(step);
  };
  /** Glides `event` when it is a mouse notch the scroller can move for. */
  const take = (event: WheelEvent) => {
    if (
      !event.cancelable ||
      !isMouseWheel(event) ||
      reducedMotion?.matches ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      event.altKey ||
      !event.deltaY ||
      Math.abs(event.deltaX) > Math.abs(event.deltaY)
    )
      return false;
    const delta = toPixels(event, scroller);
    const top = scroller.scrollTop;
    const max = scroller.scrollHeight - scroller.clientHeight;
    // At an edge, the wheel keeps its native behavior.
    if (delta < 0 ? top <= 0 : top >= max - 1) return false;
    event.preventDefault();
    if (glide && Math.sign(delta) !== Math.sign(glide.remaining)) stop();
    glide ??= {
      position: top,
      written: top,
      remaining: 0,
      last: 0,
      frame: requestAnimationFrame(step),
      intent: undefined,
    };
    glide.remaining += delta;
    glide.intent = undefined;
    return true;
  };
  const wheel = (event: WheelEvent) => {
    if (
      event.defaultPrevented ||
      !(event.target instanceof Element) ||
      insideOverlay(event.target) ||
      insideNestedScroller(event.target, scroller)
    )
      return;
    take(event);
  };
  smoothers.set(scroller, take);
  scroller.addEventListener("wheel", wheel, { passive: false });
  return () => {
    scroller.removeEventListener("wheel", wheel);
    if (smoothers.get(scroller) === take) smoothers.delete(scroller);
    stop();
  };
}

/**
 * For top-layer controls inside `scroller`, which are outside its native
 * scroll chain: glides `event` as a wheel over the scroller itself would.
 * False when the caller should scroll for it.
 */
export function forwardWheel(scroller: Element, event: WheelEvent) {
  return smoothers.get(scroller)?.(event) ?? false;
}

/** Smooths mouse wheels over `scroller` on Mac WebKit while the setting is on.
 * Off, no wheel listener blocks WebKit's threaded scrolling. */
export function useWheelSmoothing(
  scroller: RefObject<HTMLElement | null>,
  intent: RefObject<number>,
) {
  const enabled = smoothWheelPreference.usePreference();
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!enabled || !element || !macWebKit()) return;
    return smoothWheel(element, () => intent.current);
  }, [enabled, scroller, intent]);
}
