import { useCallback, useEffect, useRef } from "react";
import { Button, type ButtonProps } from "../../shared/design-system/ui/Button";

/** Feedback belongs to the action that was pressed, after its read settles. */
export function DoctorRetryButton({
  retry,
  failure,
  ...props
}: Pick<
  ButtonProps,
  "children" | "disabled" | "loading" | "aria-label" | "size"
> & { retry(): Promise<boolean>; failure?: number | undefined }) {
  const button = useRef<HTMLButtonElement>(null);
  const animation = useRef<Animation | undefined>(undefined);
  useEffect(() => () => animation.current?.cancel(), []);
  const failed = useCallback(() => {
    const control = button.current;
    if (
      !control ||
      typeof control.animate !== "function" ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    )
      return;
    const style = getComputedStyle(control);
    animation.current?.cancel();
    animation.current = control.animate(
      [
        "0",
        "calc(-1 * var(--space-1))",
        "var(--space-1)",
        "calc(-1 * var(--space-half))",
        "var(--space-half)",
        "0",
      ].map((x) => ({ transform: `translateX(${x})` })),
      {
        duration:
          Number.parseFloat(style.getPropertyValue("--duration-settle")) || 220,
        easing: style.getPropertyValue("--easing-state").trim() || "ease-out",
      },
    );
  }, []);
  const previous = useRef(failure);
  useEffect(() => {
    if (failure && failure !== previous.current) failed();
    previous.current = failure;
  }, [failure, failed]);
  return (
    <Button
      {...props}
      ref={button}
      onClick={() => {
        animation.current?.cancel();
        void retry().then((remains) => {
          if (remains && failure === undefined) failed();
        }, failed);
      }}
    />
  );
}
