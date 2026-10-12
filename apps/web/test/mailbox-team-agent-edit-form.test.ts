import { describe, expect, it } from "vitest";
import { localMinute, teamAgentKeyChanges } from "../src/lib/mailbox-team-agent-edit";

const expires = new Date(Date.UTC(2026, 10, 10, 16, 25, 42));
const key = {
  label: "Sage",
  scopes: ["read", "draft"],
  expiresAt: expires,
  mailboxes: [
    { mailboxId: "a", isDefault: true, revoked: false },
    { mailboxId: "b", isDefault: false, revoked: false },
    // Removed earlier: not part of the live set.
    { mailboxId: "c", isDefault: false, revoked: true },
  ],
};
const untouched = {
  label: "Sage",
  mailboxIds: ["b", "a"],
  scopes: ["draft", "read"] as ("read" | "draft" | "send")[],
  defaultMailboxId: "a",
  expiry: localMinute(expires),
};

describe("Editar credencial de agente: what is sent", () => {
  it("sends nothing when the form is as the server has it (order and seconds aside)", () => {
    expect(teamAgentKeyChanges(key, untouched)).toEqual({});
    expect(teamAgentKeyChanges(key, { ...untouched, label: "  Sage " })).toEqual({});
  });

  it("sends only the fields that changed", () => {
    expect(teamAgentKeyChanges(key, { ...untouched, label: "Sage 2" })).toEqual({
      label: "Sage 2",
    });
    expect(teamAgentKeyChanges(key, { ...untouched, scopes: ["read", "draft", "send"] })).toEqual({
      scopes: ["read", "draft", "send"],
    });
    expect(teamAgentKeyChanges(key, { ...untouched, mailboxIds: ["a", "b", "c"] })).toEqual({
      mailboxIds: ["a", "b", "c"],
    });
  });

  it("sends the full mailbox set and a cleared default when the default box is removed", () => {
    expect(
      teamAgentKeyChanges(key, { ...untouched, mailboxIds: ["b"], defaultMailboxId: "" }),
    ).toEqual({ mailboxIds: ["b"], defaultMailboxId: null });
  });

  it("clears or sets the expiry", () => {
    expect(teamAgentKeyChanges(key, { ...untouched, expiry: "" })).toEqual({ expiresAt: null });
    const next = teamAgentKeyChanges(key, { ...untouched, expiry: "2027-01-01T09:30" });
    expect(next.expiresAt).toEqual(new Date("2027-01-01T09:30"));
    expect(teamAgentKeyChanges({ ...key, expiresAt: null }, { ...untouched, expiry: "" })).toEqual(
      {},
    );
  });
});
