import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { Context } from "@deepseek-ai/cordis";
import type { PanelProps } from "../../features/panels/service";
import { usePanelTabTitle } from "../../features/panels/PanelWorkspace";
import type { ChannelSummary, PinRecord } from "../../features/relay/contracts";
import type { RelaySession } from "../../features/relay/session";
import { readChannelPins } from "../../features/relay/pins";
import { buzzLinkTarget } from "../../features/navigation/buzz-links";
import { MessageLink } from "../../features/conversation/MessageLink";
import type {
  ContributionReader,
  LinkRenderer,
} from "../../features/conversation/contracts";
import { useChannelIdentityNames } from "../../features/identity-names/react";
import { useReferenceDirectory } from "../../features/messages/ReferenceText";
import { PinIcon, PinnedOffIcon } from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { LoadingRegion } from "../../shared/design-system/ui/LoadingRegion";
import styles from "./PinnedMessages.module.css";

function eligible(channel: ChannelSummary, session: RelaySession) {
  return (
    !channel.cached &&
    channel.channelType !== "dm" &&
    !!channel.members?.includes(session.viewer ?? "")
  );
}

// One element keeps the tab identity stable across renders.
const tabIcon = <PinIcon size="1rem" />;

export function registerPinned(ctx: Context) {
  function Panel({ channelContext }: PanelProps) {
    usePanelTabTitle("Pinned", tabIcon);
    const state = useSyncExternalStore(ctx.relay.subscribe, ctx.relay.snapshot);
    if (
      !channelContext ||
      state.status !== "ready" ||
      state.scope !== channelContext.scope
    )
      return (
        <p role="status">
          Pinned messages are unavailable while the connection recovers.
        </p>
      );
    const { origin, viewer } = state;
    const openLink = (url: string) => {
      const target =
        origin &&
        viewer &&
        buzzLinkTarget(url, { viewer, communityOrigin: origin });
      if (!target) return false;
      void ctx.navigation.open(target);
      return true;
    };
    return (
      <PinnedMessages
        key={`${state.scope}:${state.generation}:${channelContext.channelId}`}
        session={state.session}
        scope={state.scope}
        channelId={channelContext.channelId}
        links={ctx.conversation.links}
        openLink={openLink}
      />
    );
  }
  ctx.panels.register({
    id: "pinned",
    title: "Pinned",
    matches: () => false,
    channelMenu: { label: "View pinned", eligible },
    component: Panel,
  });
}

/** One row per pinned message, ordered by its first pin, newest first. */
function byMessage(pins: readonly PinRecord[]) {
  const groups = new Map<string, PinRecord[]>();
  for (const pin of pins) {
    const group = groups.get(pin.messageId) ?? [];
    group.push(pin);
    groups.set(pin.messageId, group);
  }
  const first = (group: PinRecord[]) =>
    Math.min(...group.map((pin) => pin.pinnedAt));
  return [...groups.values()]
    .map((group) => group.sort((a, b) => a.pinnedAt - b.pinnedAt))
    .sort((a, b) => first(b) - first(a));
}

export function PinnedMessages({
  session,
  scope,
  channelId,
  links,
  openLink,
}: {
  session: RelaySession;
  scope: string;
  channelId: string;
  links: ContributionReader<LinkRenderer> | undefined;
  openLink(url: string): boolean;
}) {
  const [pins, setPins] = useState<readonly PinRecord[]>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState("");
  // Live pins and unpins of loaded messages change this key; re-read then so
  // the list follows the timeline without a second live subscription.
  const livePins = useSyncExternalStore(
    (listener) => session.channels.subscribeWindow(channelId, listener),
    () =>
      session.channels
        .window(channelId)
        .rows.flatMap((row) => row.pinnedBy?.map((pin) => pin.id) ?? [])
        .join(","),
  );
  const [attempt, setAttempt] = useState(0);
  const pending = useRef<readonly PinRecord[]>([]);
  useEffect(() => {
    void livePins;
    void attempt;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    readChannelPins(session, channelId, controller.signal).then(
      (result) => {
        if (controller.signal.aborted) return;
        // A read can finish before the relay applies a pending unpin.
        const hidden = new Set(pending.current.map((pin) => pin.id));
        setPins(result.filter((pin) => !hidden.has(pin.id)));
        setLoading(false);
      },
      () => {
        if (controller.signal.aborted) return;
        setError("Could not load pins.");
        setLoading(false);
      },
    );
    return () => controller.abort();
  }, [session, channelId, livePins, attempt]);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  const groups = useMemo(() => byMessage(pins ?? []), [pins]);
  const pinners = useMemo(
    () => [...new Set((pins ?? []).map((pin) => pin.pinnedBy))],
    [pins],
  );
  useEffect(() => {
    if (pinners.length)
      void session.profiles.ensure(pinners, "background").catch(() => {});
  }, [session, pinners]);
  const resolveName = useChannelIdentityNames(session, channelId);
  const directory = useReferenceDirectory(session);
  const name = (pubkey: string) =>
    resolveName(
      pubkey,
      directory.profiles.get(pubkey)?.name ?? `${pubkey.slice(0, 10)}…`,
    );
  // Unpins hidden before the relay confirms them, each with its own deletion
  // operation. A pin below the loaded history changes no window row, so a
  // refusal is observed here, not re-read. Matching the operation, not the
  // pin, keeps an earlier failed attempt from settling a retry.
  const [unpinning, setUnpinning] = useState<
    readonly { pin: PinRecord; operation: string }[]
  >([]);
  pending.current = unpinning.map(({ pin }) => pin);
  useEffect(() => {
    const outbox = session.outbox;
    if (!outbox || !unpinning.length) return;
    const settle = () => {
      const deliveries = new Map(
        outbox.snapshot().map((item) => [item.event.id, item.delivery]),
      );
      const failed = unpinning.filter(
        ({ operation }) => deliveries.get(operation) === "failed",
      );
      const settled = unpinning.filter(
        ({ operation }) => deliveries.get(operation) !== "sending",
      );
      if (!settled.length) return;
      if (failed.length) {
        setPins(
          (current) => current && [...current, ...failed.map(({ pin }) => pin)],
        );
        setNotice("Could not unpin the message. Try again.");
      }
      setUnpinning((current) =>
        current.filter((entry) => !settled.includes(entry)),
      );
    };
    settle();
    return outbox.subscribe(settle);
  }, [session, unpinning]);
  const unpin = (own: readonly PinRecord[]) => {
    setNotice("");
    const started: { pin: PinRecord; operation: string }[] = [];
    try {
      for (const pin of own)
        started.push({ pin, operation: session.messages.remove([pin.id]) });
    } catch (cause) {
      setNotice(
        cause instanceof Error ? cause.message : "Could not unpin the message.",
      );
    }
    if (!started.length) return;
    setPins((current) =>
      current?.filter((pin) => !started.some((entry) => entry.pin === pin)),
    );
    setUnpinning((current) => [...current, ...started]);
  };
  const feedback = error ? (
    <p role="alert" className={styles.feedback}>
      {error}{" "}
      <Button size="sm" variant="ghost" onClick={retry}>
        Retry
      </Button>
    </p>
  ) : notice ? (
    <p role="alert" className={styles.feedback}>
      {notice}
    </p>
  ) : undefined;
  return (
    <div className={styles.pinned}>
      <LoadingRegion
        pending={loading && !pins}
        label="Loading pinned messages"
        feedback={feedback}
      >
        {pins && !groups.length && !error && (
          <EmptyState
            icon={<PinIcon />}
            title="No pinned messages"
            description="Pin a message from its menu to keep it here for everyone in the channel."
            frame="none"
          />
        )}
        {groups.length > 0 && (
          <ul className={styles.list} aria-label="Pinned messages">
            {groups.map((group) => {
              const [first] = group;
              if (!first) return null;
              const own = group.filter(
                (pin) => pin.pinnedBy === session.viewer,
              );
              return (
                <li key={first.messageId} className={styles.row}>
                  <div className={styles.summary}>
                    <MessageLink
                      url={`buzz://message?${new URLSearchParams({ channel: channelId, id: first.messageId })}`}
                      registry={links}
                      session={session}
                      scope={scope}
                      onOpenLink={openLink}
                    />
                    <span className={styles.pinner}>
                      Pinned by {name(first.pinnedBy)}
                    </span>
                  </div>
                  {own.length > 0 && session.outbox?.supports(5) && (
                    <IconButton
                      hint="familiar"
                      size="sm"
                      aria-label="Unpin message"
                      title="Unpin message"
                      icon={<PinnedOffIcon />}
                      onClick={() => unpin(own)}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </LoadingRegion>
    </div>
  );
}
