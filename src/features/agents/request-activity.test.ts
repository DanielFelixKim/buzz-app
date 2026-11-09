import { expect, it, vi } from "vitest";
import { requestActivity } from "./request-activity";

const agent = "a".repeat(64);
const trigger = "b".repeat(64);
const record = (index: number, events: unknown[]) =>
  Object.freeze({
    id: index.toString(16).padStart(64, "0"),
    agent,
    receivedAt: 1800000000000 + index,
    kind: "batch",
    plaintext: JSON.stringify({ kind: "batch", payload: { events } }),
  });
const event = (kind: string, turnId: string, seq: number, payload = {}) => ({
  kind,
  turnId,
  seq,
  channelId: "c",
  timestamp: new Date(1800000000000).toISOString(),
  payload,
});

it("parses only newly appended records when the records array changes", () => {
  const first = [
    record(1, [
      event("turn_started", "t", 1, { triggeringEventIds: [trigger] }),
      event("step", "t", 2),
    ]),
    record(2, [event("step", "t", 3), event("step", "other", 1)]),
  ];
  requestActivity(first, agent, "c", trigger);
  const parse = vi.spyOn(JSON, "parse");
  try {
    const added = record(3, [event("turn_completed", "t", 4)]);
    const next = [...first, added];
    const result = requestActivity(next, agent, "c", trigger);
    // One envelope parse plus one parse for its single projected child.
    expect(parse).toHaveBeenCalledTimes(2);
    parse.mockClear();
    const fresh = requestActivity(structuredClone(next), agent, "c", trigger);
    expect(parse.mock.calls.length).toBeGreaterThan(2 * next.length);
    expect(result).toEqual(fresh);
    expect(result.records.map(({ id }) => id)).toEqual([
      `${first[0]?.id}:0`,
      `${first[0]?.id}:1`,
      `${first[1]?.id}:0`,
      `${added.id}:0`,
    ]);
    expect(result.terminal.get("t")).toBe("ended");
  } finally {
    parse.mockRestore();
  }
});

it("gives a steered message the records of the turn it joined, from that turn's start", () => {
  const steered = "d".repeat(64);
  const records = [
    record(1, [
      event("turn_started", "t", 1, { triggeringEventIds: [trigger] }),
      event("step", "t", 2),
    ]),
    record(2, [
      event("turn_steered", "t", 3, { triggeringEventIds: [steered] }),
      event("step", "t", 4),
      event("turn_completed", "t", 5, { outcome: "completed" }),
    ]),
  ];
  const result = requestActivity(records, agent, "c", steered);
  expect([...result.turnIds]).toEqual(["t"]);
  expect(result.uncertain).toBe(false);
  expect(result.records).toHaveLength(5);
  expect(result.terminal.get("t")).toBe("ended");
  // Both messages select the turn once.
  const both = requestActivity(records, agent, "c", [trigger, steered]);
  expect(both.records).toHaveLength(5);
  // Without its start, the steer anchors the turn's records.
  const partial = requestActivity(records.slice(1), agent, "c", steered);
  expect(partial.records).toHaveLength(3);
  expect(partial.terminal.get("t")).toBe("ended");
});
