import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import { policyRelay } from "../browser/policy-relay.mjs";

test("outbound ephemeral fanout drops without subscribers while inbound injection stays strict", () => {
  const report = { unexpected: [] };
  const relay = policyRelay({ report });
  const event = { kind: 20002, content: "", tags: [["h", "alpha"]] };
  assert.doesNotThrow(() =>
    relay.publish("primary", event, { requireSubscriber: false }),
  );
  assert.throws(
    () => relay.publish("primary", event),
    /explicit production channel REQ/,
  );
  const socket = relay.socket("wss://primary.test");
  socket.routes.set("typing", [{ kinds: [20002], "#h": ["alpha"] }]);
  relay.publish("primary", event, { requireSubscriber: false });
  assert.deepEqual(report.wireFrames, [["EVENT", "typing", event]]);
  socket.close();
  assert.doesNotThrow(() =>
    relay.publish("primary", event, { requireSubscriber: false }),
  );
  assert.throws(
    () => relay.publish("primary", event),
    /explicit production channel REQ/,
  );
  assert.equal(report.wireFrames.length, 1);
});

test("an unread window read is answered at a lone window's split limit below 20, and refused at that limit beside another window", async () => {
  const report = { unexpected: [], queries: [] };
  const key = generateSecretKey();
  const relay = policyRelay({
    viewer: getPublicKey(key),
    answer: () => [],
    report,
  });
  const window = (channel, limit) => ({
    kinds: [9, 40002, 40008],
    "#h": [channel],
    since: 1000,
    include_aux: true,
    limit,
  });
  const read = (filters) => {
    const url = "https://primary.test/query";
    const body = JSON.stringify(filters);
    const auth = finalizeEvent(
      {
        kind: 27235,
        created_at: 0,
        content: "",
        tags: [
          ["u", url],
          ["payload", createHash("sha256").update(body).digest("hex")],
        ],
      },
      key,
    );
    const token = Buffer.from(JSON.stringify(auth)).toString("base64");
    return relay.fetch(url, {
      body,
      headers: { Authorization: `Nostr ${token}` },
    });
  };
  // The reader halves a lone window's limit while its page comes back over
  // the byte budget: 24 → 12 → 6 → 3 → 1.
  for (const limit of [12, 1, 20, 100])
    assert.deepEqual(await (await read([window("alpha", limit)])).json(), []);
  assert.deepEqual(
    await (await read([window("alpha", 20), window("beta", 100)])).json(),
    [],
  );
  for (const filters of [
    [window("alpha", 12), window("beta", 12)],
    [window("alpha", 0)],
    [window("alpha", 101)],
  ])
    await assert.rejects(read(filters), /limit|expect/i);
  assert.equal(report.unexpected.length, 3);
});
