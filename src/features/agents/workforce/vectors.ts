// Shared reference vectors. Adapters that carry their own copy of the
// contract's pure functions (Pi's host, which loads raw; native admission in
// Rust) run these and must agree with the TypeScript here, which runs them
// in vectors.test.ts. Values match the contract's message, timer and
// standalone reference fixtures.

import type { AdmissionInput, AdmissionOutput } from "./admission";
import type {
  TurnContext,
  WorkforceBinding,
  WorkforceIdentity,
} from "./contract";

const SESSION = "11111111-1111-4111-8111-111111111111";
export const VECTOR_IDENTITY: WorkforceIdentity = Object.freeze({
  community_id: "22222222-2222-4222-8222-222222222222",
  human_pubkey: "a".repeat(64),
  agent_pubkey: "b".repeat(64),
});
export const VECTOR_BINDING: WorkforceBinding = Object.freeze({
  v: 1,
  client_session_id: SESSION,
  identity: VECTOR_IDENTITY,
});
const IDENTITY_HEADERS = {
  "x-workforce-launcher-client": "buzz",
  "x-workforce-launcher-session": SESSION,
  "x-workforce-buzz-human-pubkey": "a".repeat(64),
  "x-workforce-buzz-agent-pubkey": "b".repeat(64),
  "x-workforce-buzz-community-id": "22222222-2222-4222-8222-222222222222",
};

/** `inferenceBundle(VECTOR_BINDING, turn)` gives `headers`, in this order. */
export const INFERENCE_VECTORS: readonly Readonly<{
  name: string;
  turn: TurnContext;
  headers: Readonly<Record<string, string>>;
}>[] = [
  {
    name: "message",
    turn: {
      channel_id: "33333333-3333-4333-8333-333333333333",
      message_id: "c".repeat(64),
      thread_id: "d".repeat(64),
    },
    headers: {
      ...IDENTITY_HEADERS,
      "x-workforce-buzz-channel-id": "33333333-3333-4333-8333-333333333333",
      "x-workforce-buzz-message-id": "c".repeat(64),
      "x-workforce-buzz-thread-id": "d".repeat(64),
    },
  },
  {
    name: "timer",
    turn: {
      channel_id: "33333333-3333-4333-8333-333333333333",
      message_id: null,
      thread_id: "d".repeat(64),
    },
    headers: {
      ...IDENTITY_HEADERS,
      "x-workforce-buzz-channel-id": "33333333-3333-4333-8333-333333333333",
      "x-workforce-buzz-thread-id": "d".repeat(64),
    },
  },
  {
    name: "standalone",
    turn: {
      channel_id: null,
      message_id: null,
      thread_id: null,
    },
    headers: {
      ...IDENTITY_HEADERS,
    },
  },
];

/** `composeWorkforceHeaders(assembled, bundle)` gives `composed`. */
export const COMPOSE_VECTORS: readonly Readonly<{
  name: string;
  assembled: Readonly<Record<string, string>>;
  bundle: Readonly<Record<string, string>>;
  composed: Readonly<Record<string, string>>;
}>[] = [
  {
    name: "other headers pass through and the bundle is added",
    assembled: {
      Authorization: "Bearer x",
      "content-type": "application/json",
    },
    bundle: { "x-workforce-launcher-client": "buzz" },
    composed: {
      Authorization: "Bearer x",
      "content-type": "application/json",
      "x-workforce-launcher-client": "buzz",
    },
  },
  {
    name: "reserved headers are dropped in any case, even ones the bundle omits",
    assembled: {
      "X-Workforce-Launcher-Session": "stale",
      "x-workforce-buzz-message-id": "stale",
      "X-WORKFORCE-BUZZ-THREAD-ID": "stale",
      "x-workforce-launcher-client": "other",
    },
    bundle: { "x-workforce-launcher-client": "buzz" },
    composed: { "x-workforce-launcher-client": "buzz" },
  },
  {
    name: "a discovery subset composes, with null headers left out",
    assembled: { "x-workforce-buzz-purpose": "stale" },
    bundle: {
      "x-workforce-launcher-client": "buzz",
      "x-workforce-buzz-human-pubkey": "a".repeat(64),
      "x-workforce-buzz-agent-pubkey": "b".repeat(64),
      "x-workforce-buzz-community-id": "22222222-2222-4222-8222-222222222222",
    },
    composed: {
      "x-workforce-launcher-client": "buzz",
      "x-workforce-buzz-human-pubkey": "a".repeat(64),
      "x-workforce-buzz-agent-pubkey": "b".repeat(64),
      "x-workforce-buzz-community-id": "22222222-2222-4222-8222-222222222222",
    },
  },
  {
    name: "unreserved x-workforce headers are not Buzz's to remove",
    assembled: {
      "x-workforce-request-id": "keep",
      "x-workforce-launcher": "keep",
      "x-workforce-buzz": "keep",
    },
    bundle: {},
    composed: {
      "x-workforce-request-id": "keep",
      "x-workforce-launcher": "keep",
      "x-workforce-buzz": "keep",
    },
  },
];
/** Bundles `composeWorkforceHeaders` must refuse. */
export const COMPOSE_REFUSED: readonly Readonly<Record<string, string>>[] = [
  { authorization: "Bearer x" },
  { "X-Workforce-Launcher-Client": "buzz" },
  // Retired context headers, and any other name under the reserved prefix.
  { "x-workforce-buzz-purpose": "inference" },
  { "x-workforce-buzz-trigger-kind": "message" },
  { "x-workforce-buzz-trigger-id": "c".repeat(64) },
  { "x-workforce-buzz-trigger-author-pubkey": "e".repeat(64) },
  { "x-workforce-buzz-message-created-at": "1793821398" },
  { "x-workforce-buzz-unknown": "x" },
];

type AdmitsRoute =
  | Readonly<{ kind: "external"; revision: number }>
  | Readonly<{
      kind: "eligible";
      identity: WorkforceIdentity;
      revision: number;
    }>
  | Readonly<{
      kind: "blocked";
      reason: string;
      message: string;
      revision: number;
    }>;
/** `bindingAdmits(route, VECTOR_BINDING)` gives `result` (message aside). */
export const ADMITS_VECTORS: readonly Readonly<{
  name: string;
  route: AdmitsRoute;
  result: Readonly<{ ok: boolean; reason?: string; revision: number }>;
}>[] = [
  {
    name: "eligible with the same identity",
    route: { kind: "eligible", identity: VECTOR_IDENTITY, revision: 4 },
    result: { ok: true, revision: 4 },
  },
  {
    name: "eligible with another agent",
    route: {
      kind: "eligible",
      identity: { ...VECTOR_IDENTITY, agent_pubkey: "f".repeat(64) },
      revision: 5,
    },
    result: { ok: false, reason: "binding_changed", revision: 5 },
  },
  {
    name: "eligible in another community",
    route: {
      kind: "eligible",
      identity: {
        ...VECTOR_IDENTITY,
        community_id: "44444444-4444-4444-8444-444444444444",
      },
      revision: 5,
    },
    result: { ok: false, reason: "binding_changed", revision: 5 },
  },
  {
    name: "pending readiness keeps its reason",
    route: {
      kind: "blocked",
      reason: "readiness_pending",
      message: "",
      revision: 6,
    },
    result: { ok: false, reason: "readiness_pending", revision: 6 },
  },
  {
    name: "auth failure keeps its reason",
    route: { kind: "blocked", reason: "auth", message: "", revision: 7 },
    result: { ok: false, reason: "auth", revision: 7 },
  },
  {
    name: "external never admits a Workforce binding",
    route: { kind: "external", revision: 8 },
    result: { ok: false, reason: "binding_changed", revision: 8 },
  },
];

/** Steps through `admit` from INITIAL_ADMISSION, one native scope per
 * vector unless a step closes it. Each step's output must match. */
export const ADMISSION_VECTORS: readonly Readonly<{
  name: string;
  steps: readonly Readonly<{
    input: AdmissionInput;
    output: AdmissionOutput;
  }>[];
}>[] = [
  {
    name: "pending then ready opens at the ready revision only",
    steps: [
      {
        input: { type: "push", revision: 1, admits: false },
        output: { type: "applied", revoked: [] },
      },
      {
        input: { type: "open", handle: "g1", revision: 1 },
        output: { type: "refused", current: 1, admits: false },
      },
      {
        input: { type: "push", revision: 2, admits: true },
        output: { type: "applied", revoked: [] },
      },
      {
        input: { type: "open", handle: "g1", revision: 1 },
        output: { type: "refused", current: 2, admits: true },
      },
      {
        input: { type: "open", handle: "g1", revision: 2 },
        output: { type: "opened", current: 2 },
      },
      {
        input: { type: "request", handle: "g1" },
        output: { type: "admitted", revision: 2 },
      },
    ],
  },
  {
    // The page discards a probe that settles after the revision moved, so
    // nothing is pushed for it; the route stays at the newer pending one.
    name: "a stale probe success pushes nothing and opens nothing",
    steps: [
      {
        input: { type: "push", revision: 1, admits: false },
        output: { type: "applied", revoked: [] },
      },
      {
        input: { type: "push", revision: 2, admits: false },
        output: { type: "applied", revoked: [] },
      },
      {
        input: { type: "open", handle: "g1", revision: 2 },
        output: { type: "refused", current: 2, admits: false },
      },
      {
        input: { type: "request", handle: "g1" },
        output: { type: "rejected" },
      },
    ],
  },
  {
    name: "reordered pushes: ready before the pending it followed",
    steps: [
      {
        input: { type: "push", revision: 2, admits: true },
        output: { type: "applied", revoked: [] },
      },
      {
        input: { type: "push", revision: 1, admits: false },
        output: { type: "stale" },
      },
      {
        input: { type: "open", handle: "g1", revision: 2 },
        output: { type: "opened", current: 2 },
      },
      {
        input: { type: "push", revision: 2, admits: false },
        output: { type: "stale" },
      },
      {
        input: { type: "request", handle: "g1" },
        output: { type: "admitted", revision: 2 },
      },
    ],
  },
  {
    name: "a higher revision terminally revokes, and a later ready never reopens",
    steps: [
      {
        input: { type: "push", revision: 2, admits: true },
        output: { type: "applied", revoked: [] },
      },
      {
        input: { type: "open", handle: "g1", revision: 2 },
        output: { type: "opened", current: 2 },
      },
      {
        input: { type: "push", revision: 3, admits: false },
        output: { type: "applied", revoked: ["g1"] },
      },
      {
        input: { type: "request", handle: "g1" },
        output: { type: "rejected" },
      },
      {
        input: { type: "push", revision: 4, admits: true },
        output: { type: "applied", revoked: [] },
      },
      {
        input: { type: "request", handle: "g1" },
        output: { type: "rejected" },
      },
      {
        input: { type: "open", handle: "g2", revision: 4 },
        output: { type: "opened", current: 4 },
      },
      {
        input: { type: "request", handle: "g2" },
        output: { type: "admitted", revision: 4 },
      },
    ],
  },
  {
    name: "a ready revision revokes generations opened under older ones",
    steps: [
      {
        input: { type: "push", revision: 2, admits: true },
        output: { type: "applied", revoked: [] },
      },
      {
        input: { type: "open", handle: "g1", revision: 2 },
        output: { type: "opened", current: 2 },
      },
      {
        input: { type: "push", revision: 4, admits: true },
        output: { type: "applied", revoked: ["g1"] },
      },
      {
        input: { type: "request", handle: "g1" },
        output: { type: "rejected" },
      },
    ],
  },
  {
    // A reloaded page is a new native scope: its routes count from 1 again.
    name: "page reload revokes the old scope's generations",
    steps: [
      {
        input: { type: "push", revision: 2, admits: true },
        output: { type: "applied", revoked: [] },
      },
      {
        input: { type: "open", handle: "g1", revision: 2 },
        output: { type: "opened", current: 2 },
      },
      {
        input: { type: "close_scope" },
        output: { type: "closed", revoked: ["g1"] },
      },
      {
        input: { type: "request", handle: "g1" },
        output: { type: "rejected" },
      },
      {
        input: { type: "push", revision: 1, admits: false },
        output: { type: "applied", revoked: [] },
      },
      {
        input: { type: "push", revision: 2, admits: true },
        output: { type: "applied", revoked: [] },
      },
      {
        input: { type: "request", handle: "g1" },
        output: { type: "rejected" },
      },
      {
        input: { type: "open", handle: "g2", revision: 2 },
        output: { type: "opened", current: 2 },
      },
    ],
  },
  {
    name: "a handle opens once",
    steps: [
      {
        input: { type: "push", revision: 1, admits: true },
        output: { type: "applied", revoked: [] },
      },
      {
        input: { type: "open", handle: "g1", revision: 1 },
        output: { type: "opened", current: 1 },
      },
      {
        input: { type: "open", handle: "g1", revision: 1 },
        output: { type: "refused", current: 1, admits: true },
      },
    ],
  },
];
