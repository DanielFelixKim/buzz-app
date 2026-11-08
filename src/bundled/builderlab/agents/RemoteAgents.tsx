import type { OverviewObserver } from "../overview";
import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
} from "react";
import {
  ArrowsClockwiseIcon,
  RobotIcon,
} from "../../../shared/design-system/icons";
import { Button } from "../../../shared/design-system/ui/Button";
import { EmptyState } from "../../../shared/design-system/ui/EmptyState";
import { InlineHeader } from "../../../shared/design-system/ui/Header";
import { SettingsGroup } from "../../../shared/design-system/ui/SettingsGroup";
import type { BuilderlabSession } from "../session";
import type { AgentClient, RemoteAgent } from "./client";

export function RemoteAgents({
  client,
  session,
  active,
  onOverview,
  showHeading = true,
}: {
  client: AgentClient;
  session: BuilderlabSession;
  active(): boolean;
  onOverview?: OverviewObserver | undefined;
  showHeading?: boolean;
}) {
  const login = useSyncExternalStore(session.subscribe, session.snapshot);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const focus = () => {
      if (active() && session.snapshot().status === "signed-in")
        setRevision((value) => value + 1);
    };
    window.addEventListener("focus", focus);
    return () => window.removeEventListener("focus", focus);
  }, [active, session]);
  useLayoutEffect(() => {
    if (
      active() &&
      (login.status !== "signed-in" || !login.account?.canUseRemoteAgents)
    )
      onOverview?.({
        kind: login.status === "signed-in" ? "unavailable" : "empty",
      });
  }, [active, onOverview, login.status, login.account?.canUseRemoteAgents]);
  if (login.status === "signed-in" && !login.account?.canUseRemoteAgents)
    return (
      <section className="mt-section-gap" aria-label="Remote agents">
        {showHeading && (
          <InlineHeader
            title="Remote agents"
            subtitle="Unavailable for this account"
          />
        )}
      </section>
    );
  return login.status === "signed-in" ? (
    <AgentList
      key={`${login.account?.subject}:${revision}`}
      client={client}
      onOverview={onOverview}
      showHeading={showHeading}
      active={active}
      refresh={() => {
        if (active()) setRevision((value) => value + 1);
      }}
    />
  ) : null;
}

function AgentList({
  client,
  active,
  refresh,
  onOverview,
  showHeading,
}: {
  client: AgentClient;
  active(): boolean;
  refresh(): void;
  onOverview?: OverviewObserver | undefined;
  showHeading: boolean;
}) {
  const [agents, setAgents] = useState<readonly RemoteAgent[]>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  useLayoutEffect(() => {
    if (!active() || !onOverview) return;
    onOverview(
      loading
        ? { kind: "pending" }
        : agents
          ? agents.length
            ? {
                kind: "filled",
                items: agents.map((agent) => ({
                  key: agent.id,
                  label: agent.name,
                  ...(agentState(agent) === "Needs setup"
                    ? { note: "Needs setup" }
                    : {}),
                })),
              }
            : { kind: "empty" }
          : { kind: "failed" },
    );
  }, [active, onOverview, agents, loading]);
  const isActive = useEffectEvent(active);
  useEffect(() => {
    const controller = new AbortController();
    const current = () => !controller.signal.aborted && isActive();
    setLoading(true);
    setAgents(undefined);
    setError(undefined);
    void client.list(controller.signal).then(
      (rows) => {
        if (current()) {
          setAgents(rows);
          setLoading(false);
        }
      },
      (reason) => {
        if (current()) {
          setError(
            reason instanceof Error ? reason.message : "Could not load agents.",
          );
          setLoading(false);
        }
      },
    );
    return () => controller.abort();
  }, [client]);
  return (
    <section
      data-buzz-ui=""
      className="mt-section-gap flex flex-col gap-3"
      aria-label="Remote agents"
    >
      {showHeading ? (
        <InlineHeader
          title="Remote agents"
          subtitle="Create, edit and delete agents in the Agents tab."
          actions={
            <Button
              variant="ghost"
              size="sm"
              loading={loading}
              onClick={refresh}
            >
              <ArrowsClockwiseIcon aria-hidden="true" />{" "}
              {error ? "Retry" : "Refresh agents"}
            </Button>
          }
        />
      ) : (
        <Button variant="ghost" size="sm" loading={loading} onClick={refresh}>
          {error ? "Retry" : "Refresh agents"}
        </Button>
      )}
      {loading && (
        <p role="status" className="text-body-sm text-secondary">
          Loading remote agents…
        </p>
      )}
      {error && (
        <p role="alert" className="text-body-sm text-danger">
          {error}
        </p>
      )}
      {agents?.length === 0 && (
        <EmptyState
          icon={<RobotIcon />}
          title="No remote agents yet."
          description="Your Builderlab account’s agents will appear here."
          level={4}
        />
      )}
      {agents && agents.length > 0 && (
        <SettingsGroup>
          <ul className="m-0 list-none p-0">
            {agents.map((agent) => (
              <li
                key={agent.id}
                className="flex min-w-0 flex-col gap-1 border-b border-line py-4"
              >
                <p className="m-0 text-label">
                  {agent.name} · {agent.status}
                </p>
                <span className="break-all text-mono text-muted">
                  {agent.pubkey}
                </span>
              </li>
            ))}
          </ul>
        </SettingsGroup>
      )}
    </section>
  );
}

function agentState(agent: RemoteAgent) {
  return agent.status === "Revoked"
    ? "Revoked"
    : agent.status === "Unknown"
      ? "Unknown"
      : agent.status === "Active" && agent.modelSelectionStatus === "valid"
        ? "Active"
        : "Needs setup";
}
