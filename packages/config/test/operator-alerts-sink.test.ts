import { expect, it } from "vitest";
import { type Env, OPERATOR_ALERTS_SINKS, operatorAlertsSink } from "../src/env.js";

// Only the field the policy reads; the zod schema is not under test.
const withEnv = (overrides: Record<string, unknown>) =>
  ({ OPERATOR_ALERTS_SINK: undefined, ...overrides }) as unknown as Env;

/**
 * The regression this file exists for: OPERATOR_ALERTS_SINK=audit must be an
 * explicit opt-in. An instance that never sets it — and a process under
 * SKIP_ENV_VALIDATION, where the proxy hands the raw string through with no
 * zod default — keeps e-mailing every operator alert exactly as before.
 */
it("e-mails by default, and for any value that is not audit", () => {
  expect(operatorAlertsSink(withEnv({}))).toBe("email");
  expect(operatorAlertsSink(withEnv({ OPERATOR_ALERTS_SINK: undefined }))).toBe("email");
  expect(operatorAlertsSink(withEnv({ OPERATOR_ALERTS_SINK: "" }))).toBe("email");
  // A typo silences nothing: it keeps the historic route instead of dropping alerts.
  expect(operatorAlertsSink(withEnv({ OPERATOR_ALERTS_SINK: "telegram" }))).toBe("email");
});

it("reads audit however the operator spelled the spaces around it", () => {
  expect(operatorAlertsSink(withEnv({ OPERATOR_ALERTS_SINK: "audit" }))).toBe("audit");
  expect(operatorAlertsSink(withEnv({ OPERATOR_ALERTS_SINK: " audit " }))).toBe("audit");
  // The schema's enum is the authority on spelling; a validated process never
  // gets here with another casing, and a raw one keeps the historic route.
  expect(operatorAlertsSink(withEnv({ OPERATOR_ALERTS_SINK: "Audit" }))).toBe("email");
});

// The schema's enum and the helper's accepted values must not drift apart.
it("offers exactly the two sinks the schema validates", () => {
  expect(OPERATOR_ALERTS_SINKS).toEqual(["email", "audit"]);
});
