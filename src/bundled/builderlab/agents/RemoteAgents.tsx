import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { RobotIcon } from "../../../shared/design-system/icons";
import { Button } from "../../../shared/design-system/ui/Button";
import { EmptyState } from "../../../shared/design-system/ui/EmptyState";
import { InlineHeader } from "../../../shared/design-system/ui/Header";
import { writeClipboardText } from "../../../shared/clipboard";
import { ManagementRow } from "../ManagementRow";
import { ManagementSection } from "../ManagementSection";
import agentsHero from "../assets/agents-hero.png";
import type { OverviewObserver } from "../overview";
import { managementDate } from "../management-date";
import type { BuilderlabSession } from "../session";
import type { AgentClient, RemoteAgent } from "./client";

export function RemoteAgents({
  client,
  session,
  active,
  onOverview,
  showHeading = true,
  openAgents,
}: {
  client: AgentClient;
  session: BuilderlabSession;
  active(): boolean;
  onOverview?: OverviewObserver | undefined;
  showHeading?: boolean;
  openAgents?: (() => void) | undefined;
}) {
  const login = useSyncExternalStore(session.subscribe, session.snapshot);
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
      <AgentSection>
        {showHeading ? (
          <InlineHeader
            title="Remote agents"
            subtitle="Unavailable for this account"
          />
        ) : (
          <p className="text-body-sm text-secondary">
            Unavailable for this account
          </p>
        )}
      </AgentSection>
    );
  return login.status === "signed-in" ? (
    <AgentList
      key={login.account?.subject}
      client={client}
      active={active}
      onOverview={onOverview}
      showHeading={showHeading}
      openAgents={openAgents}
    />
  ) : (
    <AgentSection count="—">
      <p className="text-body-sm text-secondary">
        Sign in to view your remote agents.
      </p>
    </AgentSection>
  );
}

function AgentList({
  client,
  active,
  onOverview,
  showHeading,
  openAgents,
}: {
  client: AgentClient;
  active(): boolean;
  onOverview?: OverviewObserver | undefined;
  showHeading: boolean;
  openAgents?: (() => void) | undefined;
}) {
  const [agents, setAgents] = useState<readonly RemoteAgent[]>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const activeRef = useRef(active);
  activeRef.current = active;
  const refresh = useRef(() => {});
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
  useEffect(() => {
    let request: AbortController | undefined;
    let loaded = false;
    setLoading(true);
    setAgents(undefined);
    setError(undefined);
    const load = (quiet: boolean) => {
      if (request || !activeRef.current()) return;
      const controller = new AbortController();
      request = controller;
      const current = () => !controller.signal.aborted && activeRef.current();
      if (!quiet) setError(undefined);
      if (!loaded) setLoading(true);
      void client
        .list(controller.signal)
        .then(
          (rows) => {
            if (current()) {
              loaded = true;
              setAgents(rows);
              setError(undefined);
              setLoading(false);
            }
          },
          (reason) => {
            if (current()) {
              if (!quiet || !loaded)
                setError(
                  reason instanceof Error
                    ? reason.message
                    : "Could not load agents.",
                );
              setLoading(false);
            }
          },
        )
        .finally(() => {
          request = undefined;
        });
    };
    refresh.current = () => load(false);
    const focus = () => load(true);
    load(false);
    window.addEventListener("focus", focus);
    return () => {
      request?.abort();
      refresh.current = () => {};
      window.removeEventListener("focus", focus);
    };
  }, [client]);
  return (
    <section
      data-buzz-ui=""
      className="flex flex-col gap-3"
      aria-label="Remote agents"
    >
      {showHeading && <InlineHeader title="Remote agents" />}
      <AgentSection count={loading ? "…" : (agents?.length ?? "—")}>
        {loading && (
          <p role="status" className="text-body-sm text-secondary">
            Loading agents…
          </p>
        )}
        {error && (
          <div role="alert">
            <EmptyState
              icon={<RobotIcon />}
              title="Couldn’t load agents"
              description={error}
              action={
                <Button variant="subtle" onClick={() => refresh.current()}>
                  Try again
                </Button>
              }
            />
          </div>
        )}
        {agents?.length === 0 && (
          <EmptyState
            icon={<RobotIcon />}
            title="No agents yet"
            description="Create agents in the Agents tab. They’ll show up here."
            action={
              openAgents && (
                <Button
                  variant="prominent"
                  onClick={() => {
                    if (active()) openAgents();
                  }}
                >
                  Open Agents
                </Button>
              )
            }
            level={4}
          />
        )}
        {agents && agents.length > 0 && (
          <ul className="m-0 list-none p-0" aria-label="Your remote agents">
            {agents.map((agent) => (
              <AgentRow key={agent.id} agent={agent} active={active} />
            ))}
          </ul>
        )}
      </AgentSection>
    </section>
  );
}

function AgentSection({
  count,
  children,
}: {
  count?: ReactNode;
  children: ReactNode;
}) {
  return (
    <ManagementSection
      hero={agentsHero}
      facts={count === undefined ? [] : [{ label: "Agents", value: count }]}
    >
      {children}
    </ManagementSection>
  );
}

function AgentRow({
  agent,
  active,
}: {
  agent: RemoteAgent;
  active(): boolean;
}) {
  const [copied, setCopied] = useState<"copied" | "failed">();
  const state = agentState(agent);
  const created = managementDate(agent.createdAt);
  const copy = async () => {
    if (!active()) return;
    try {
      await writeClipboardText(agent.pubkey);
      setCopied("copied");
    } catch {
      setCopied("failed");
    }
  };
  return (
    <li>
      <ManagementRow
        icon={<RobotIcon size={20} />}
        title={agent.name}
        detail={
          <>
            {[agent.modelId, state, created ? `Created ${created}` : undefined]
              .filter(Boolean)
              .join(" · ")}
            <span className="block select-all break-all text-mono">
              {agent.pubkey}
            </span>
          </>
        }
        status={
          copied ? (
            <span role="status">
              {copied === "copied" ? "Key copied" : "Couldn’t copy the key"}
            </span>
          ) : undefined
        }
        statusTone={copied === "failed" ? "warning" : undefined}
        revealActions
        actions={
          <Button
            variant="subtle"
            size="sm"
            aria-label={`Copy ${agent.name}’s key`}
            onClick={() => void copy()}
          >
            Copy key
          </Button>
        }
      />
    </li>
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
