import { describe, expect, it } from "vitest";
import { parseWorkforceDescriptor } from "./descriptor";

const ID = "22222222-2222-4222-8222-222222222222";
const valid = (patch: Record<string, unknown> = {}) =>
  JSON.stringify({
    version: 1,
    gateway: "https://gateway.example",
    communities: [{ id: ID, origin: "wss://block.example/" }],
    ...patch,
  });

describe("parseWorkforceDescriptor", () => {
  it("is off when empty", () => {
    expect(parseWorkforceDescriptor("")).toBeNull();
    expect(parseWorkforceDescriptor("  ")).toBeNull();
  });

  it("canonicalizes community origins the way memberships name them", () => {
    expect(parseWorkforceDescriptor(valid())).toEqual({
      version: 1,
      gateway: "https://gateway.example",
      communities: [{ id: ID, origin: "https://block.example" }],
    });
  });

  it.each([
    ["not JSON", "{"],
    ["an extra key", valid({ token: "x" })],
    ["another version", valid({ version: 2 })],
    ["an http gateway", valid({ gateway: "http://gateway.example" })],
    ["a gateway path", valid({ gateway: "https://gateway.example/v1" })],
    [
      "a gateway trailing slash",
      valid({ gateway: "https://gateway.example/" }),
    ],
    ["gateway credentials", valid({ gateway: "https://u:p@gateway.example" })],
    ["no communities", valid({ communities: [] })],
    [
      "a non-UUID community",
      valid({ communities: [{ id: "block", origin: "wss://block.example" }] }),
    ],
    [
      "the nil UUID",
      valid({
        communities: [
          {
            id: "00000000-0000-0000-0000-000000000000",
            origin: "wss://block.example",
          },
        ],
      }),
    ],
    [
      "an origin with a path",
      valid({ communities: [{ id: ID, origin: "wss://block.example/x" }] }),
    ],
    [
      "an extra community key",
      valid({
        communities: [{ id: ID, origin: "wss://block.example", secret: "x" }],
      }),
    ],
    [
      "a duplicate origin",
      valid({
        communities: [
          { id: ID, origin: "wss://block.example" },
          {
            id: "44444444-4444-4444-8444-444444444444",
            origin: "https://block.example",
          },
        ],
      }),
    ],
    [
      "a duplicate id",
      valid({
        communities: [
          { id: ID, origin: "wss://block.example" },
          { id: ID, origin: "wss://other.example" },
        ],
      }),
    ],
  ])("rejects %s without echoing it", (_name, raw) => {
    expect(() => parseWorkforceDescriptor(raw)).toThrow(
      /^BUZZ_WORKFORCE_GATEWAY is invalid: /,
    );
    try {
      parseWorkforceDescriptor(raw);
    } catch (error) {
      expect(String(error)).not.toContain("u:p");
      expect(String(error)).not.toContain("secret");
    }
  });
});
