import {
  createContext,
  useContext,
  useMemo,
  useEffect,
  useRef,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { PreferenceRow } from "../../shared/design-system/ui/PreferenceRow";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import { ToastNotice } from "../../shared/design-system/ui/Toast";
import type { Navigation } from "../navigation/controller";
import type { NavigationScope } from "../navigation/targets";
import { createDoctor, type DoctorIssueId } from "./doctor";
import type { RelayData } from "./service";
import { DoctorRetryButton } from "./DoctorRetryButton";

const Context = createContext<ReadonlySet<object> | null>(null);
export function useDoctorHosted() {
  return useContext(Context) !== null;
}

/** Hide a source's duplicate notice only when Doctor represents that issue. */
export function useDoctorIssue(source: object) {
  return useContext(Context)?.has(source) ?? false;
}

const retryLabels: Record<DoctorIssueId, string> = {
  connection: "Retry connection",
  live: "Retry live updates",
  catalog: "Retry templates",
  workspaces: "Retry workspaces",
  sidebar: "Retry sidebar preferences",
  visibility: "Retry hidden conversations",
  agents: "Retry agents",
};

function DoctorActions({
  retry,
  show,
  busy,
  viewButton,
  focusTarget,
}: {
  retry(): Promise<boolean>;
  show(): void;
  busy: boolean;
  viewButton: RefObject<HTMLButtonElement | null>;
  focusTarget: (() => HTMLElement | undefined) | undefined;
}) {
  const focused = useRef(false);
  const target = useRef(focusTarget);
  target.current = focusTarget;
  useEffect(
    () => () => {
      if (!focused.current) return;
      // The portal clears after its source unmounts. Restore only lost focus;
      // another control or an open dialog keeps the person's current focus.
      queueMicrotask(() => {
        if (document.activeElement === document.body)
          target.current?.()?.focus({ preventScroll: true });
      });
    },
    [],
  );
  return (
    <span
      style={{ display: "contents" }}
      onFocusCapture={() => {
        focused.current = true;
      }}
      onBlurCapture={(event) => {
        if (event.relatedTarget)
          focused.current = event.currentTarget.contains(event.relatedTarget);
      }}
    >
      <DoctorRetryButton
        size="sm"
        aria-label="Retry"
        loading={busy}
        disabled={busy}
        retry={retry}
      >
        Retry
      </DoctorRetryButton>
      <Button ref={viewButton} size="sm" onClick={show}>
        View issues
      </Button>
    </span>
  );
}

export function BuzzDoctor({
  relay,
  navigation,
  open,
  onClose,
  children,
  focusTarget,
  scope,
}: {
  relay: RelayData;
  navigation: Navigation;
  open: boolean;
  onClose(): void;
  children: ReactNode;
  focusTarget?: (() => HTMLElement | undefined) | undefined;
  scope?: NavigationScope | null;
}) {
  const viewer = scope?.viewer,
    origin = scope?.communityOrigin;
  const destination = useSyncExternalStore(
    navigation.subscribe,
    navigation.snapshot,
  );
  const doctor = useMemo(
    () => createDoctor(relay, viewer, origin),
    [relay, viewer, origin],
  );
  const viewButton = useRef<HTMLButtonElement>(null);
  const state = useSyncExternalStore(
    doctor.subscribe,
    doctor.snapshot,
    doctor.snapshot,
  );
  const context = useMemo(() => {
    const session = state.session;
    const owners: Record<DoctorIssueId, object> = {
      connection: relay,
      live: session.live,
      catalog: session.channelKit,
      workspaces: session.soloPreferences,
      sidebar: session.sidebarPreferences,
      visibility: session.channelLifecycle,
      agents: session.agentChoices,
    };
    return new Set(state.issues.map((issue) => owners[issue.id]));
  }, [state, relay]);
  const show = () => {
    void navigation.open({
      version: 1,
      kind: "doctor",
      scope: scope ?? null,
    });
  };
  const retry = async (issue?: (typeof state.issues)[number]) => {
    const before = doctor.snapshot();
    if (before.busy) return false;
    const selected = issue ? [issue.id] : before.issues.map((item) => item.id);
    if (!issue) await doctor.retry();
    else await doctor.retry(issue.id);
    const after = doctor.snapshot();
    const remaining =
      before.session === after.session
        ? after.issues.filter(
            (item) => selected.includes(item.id) && !item.busy,
          )
        : [];
    return remaining.length > 0;
  };
  return (
    <Context value={context}>
      {children}
      {!open &&
        destination.entry.target.kind !== "settings" &&
        state.issues.some((issue) => !issue.quiet) && (
          <ToastNotice
            title="Buzz is having issues"
            tone="warning"
            navigation={{ label: "Open Buzz Doctor", open: show }}
          >
            <DoctorActions
              retry={() => retry()}
              show={show}
              busy={state.busy}
              viewButton={viewButton}
              focusTarget={focusTarget}
            />
          </ToastNotice>
        )}
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next) onClose();
        }}
        title="Buzz Doctor"
        height="stable"
        finalFocus={() => viewButton.current ?? focusTarget?.() ?? true}
        visit
        closeLabel="Close Buzz Doctor"
        description={
          state.issues.length
            ? "Review issues and retry affected reads."
            : state.checking
              ? "Checking your community connection…"
              : "Everything is working again. No issues need attention."
        }
        actions={
          state.issues.length ? (
            <DoctorRetryButton
              loading={state.retryingAll}
              disabled={state.busy}
              retry={() => retry()}
            >
              Retry all
            </DoctorRetryButton>
          ) : undefined
        }
      >
        {state.issues.length > 0 && (
          <div style={{ containerType: "inline-size" }}>
            <SettingsGroup>
              {state.issues.map((issue) => (
                <PreferenceRow
                  key={issue.id}
                  title={issue.title}
                  subtitle={issue.details.join(" ")}
                  trailing={
                    <DoctorRetryButton
                      size="sm"
                      failure={issue.failure ?? 0}
                      loading={issue.busy}
                      disabled={state.busy || issue.busy}
                      aria-label={retryLabels[issue.id]}
                      retry={() => retry(issue)}
                    >
                      Retry
                    </DoctorRetryButton>
                  }
                />
              ))}
            </SettingsGroup>
          </div>
        )}
      </Dialog>
    </Context>
  );
}
