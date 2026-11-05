import { describe, expect, it } from "vitest";
import { admit, INITIAL_ADMISSION } from "./admission";
import {
  bindingAdmits,
  composeWorkforceHeaders,
  inferenceBundle,
} from "./contract";
import {
  ADMISSION_VECTORS,
  ADMITS_VECTORS,
  COMPOSE_REFUSED,
  COMPOSE_VECTORS,
  INFERENCE_VECTORS,
  VECTOR_BINDING,
} from "./vectors";

describe("shared Workforce vectors", () => {
  it.each(INFERENCE_VECTORS)("inference bundle: $name", ({ turn, headers }) => {
    const bundle = inferenceBundle(VECTOR_BINDING, turn);
    expect(bundle.ok && Object.entries(bundle.value)).toEqual(
      Object.entries(headers),
    );
  });

  it.each(COMPOSE_VECTORS)("compose: $name", (vector) => {
    expect(composeWorkforceHeaders(vector.assembled, vector.bundle)).toEqual(
      vector.composed,
    );
  });

  it.each(INFERENCE_VECTORS)(
    "compose accepts every inference bundle: $name",
    ({ headers }) => {
      expect(composeWorkforceHeaders({}, headers)).toEqual(headers);
    },
  );

  it.each(COMPOSE_REFUSED)("compose refuses bundle %o", (bundle) => {
    expect(() => composeWorkforceHeaders({}, bundle)).toThrow(
      "only set the contract's context headers",
    );
  });

  it.each(ADMITS_VECTORS)("binding admits: $name", ({ route, result }) => {
    const { message, ...rest } = bindingAdmits(route, VECTOR_BINDING) as {
      message?: string;
    };
    expect(rest).toEqual(result);
    expect(typeof message === "string" || result.ok).toBe(true);
  });

  it.each(ADMISSION_VECTORS)("native admission: $name", ({ steps }) => {
    let state = INITIAL_ADMISSION;
    for (const { input, output } of steps) {
      const next = admit(state, input);
      expect({ input, output: next.output }).toEqual({ input, output });
      state = next.state;
    }
  });
});
