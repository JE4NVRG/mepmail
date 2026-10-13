import {
  DeleteSuppressedDestinationCommand,
  GetSuppressedDestinationCommand,
} from "@aws-sdk/client-sesv2";
import { describe, expect, it } from "vitest";
import { removeSesBounceSuppression, type SesSuppressionClient } from "../src/suppression.js";

// SES's account-level list is shared by every team: only a BOUNCE entry is ever lifted.
function fake(get: () => unknown, del: () => unknown = () => ({})) {
  const calls: string[] = [];
  const client: SesSuppressionClient = {
    async send(command) {
      if (command instanceof GetSuppressedDestinationCommand) {
        calls.push(`get:${command.input.EmailAddress}`);
        return get();
      }
      if (command instanceof DeleteSuppressedDestinationCommand) {
        calls.push(`delete:${command.input.EmailAddress}`);
        return del();
      }
      throw new Error("unexpected command");
    },
  };
  return { client, calls };
}
const named = (name: string) => () => {
  throw Object.assign(new Error(name), { name });
};

describe("removeSesBounceSuppression", () => {
  it("lifts a bounce", async () => {
    const f = fake(() => ({ SuppressedDestination: { Reason: "BOUNCE" } }));
    expect(await removeSesBounceSuppression(f.client, "a@example.invalid")).toBe("removed");
    expect(f.calls).toEqual(["get:a@example.invalid", "delete:a@example.invalid"]);
  });

  it("never lifts a complaint", async () => {
    const f = fake(() => ({ SuppressedDestination: { Reason: "COMPLAINT" } }));
    expect(await removeSesBounceSuppression(f.client, "a@example.invalid")).toBe("kept_complaint");
    expect(f.calls).toEqual(["get:a@example.invalid"]);
  });

  it("reports an address that is not listed, missing permissions and an unreachable SES", async () => {
    expect(
      await removeSesBounceSuppression(
        fake(named("NotFoundException")).client,
        "a@example.invalid",
      ),
    ).toBe("not_listed");
    expect(
      await removeSesBounceSuppression(
        fake(named("AccessDeniedException")).client,
        "a@example.invalid",
      ),
    ).toBe("denied");
    expect(
      await removeSesBounceSuppression(
        fake(
          () => ({ SuppressedDestination: { Reason: "BOUNCE" } }),
          named("AccessDeniedException"),
        ).client,
        "a@example.invalid",
      ),
    ).toBe("denied");
    expect(
      await removeSesBounceSuppression(fake(named("TimeoutError")).client, "a@example.invalid"),
    ).toBe("unavailable");
  });
});
