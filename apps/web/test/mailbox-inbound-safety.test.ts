import { describe, expect, it } from "vitest";
import {
  assessMailboxReceipt,
  type MailboxInboundAssessment,
  validateMailboxInboundAssessment,
} from "../../../packages/core/src/mailbox-inbound-safety.js";

const cleanReceipt = (overrides: Record<string, unknown> = {}) => ({
  virusVerdict: { status: "PASS" },
  spamVerdict: { status: "PASS" },
  spfVerdict: { status: "PASS" },
  dkimVerdict: { status: "PASS" },
  dmarcVerdict: { status: "PASS" },
  dmarcPolicy: "none",
  ...overrides,
});

describe("trusted receipt safety classification", () => {
  it.each<{
    name: string;
    receipt: Record<string, unknown>;
    decision: MailboxInboundAssessment["decision"];
    reasons: MailboxInboundAssessment["reasons"];
  }>([
    { name: "completed clean scans", receipt: cleanReceipt(), decision: "inbox", reasons: [] },
    {
      name: "spam detected",
      receipt: cleanReceipt({ spamVerdict: { status: "FAIL" } }),
      decision: "spam",
      reasons: ["spam"],
    },
    {
      name: "inconclusive spam",
      receipt: cleanReceipt({ spamVerdict: { status: "GRAY" } }),
      decision: "spam",
      reasons: ["spam_uncertain"],
    },
    {
      name: "spam scan unavailable",
      receipt: cleanReceipt({ spamVerdict: { status: "PROCESSING_FAILED" } }),
      decision: "spam",
      reasons: ["spam_unchecked"],
    },
    {
      name: "missing spam scan",
      receipt: cleanReceipt({ spamVerdict: undefined }),
      decision: "spam",
      reasons: ["spam_unchecked"],
    },
    {
      name: "DMARC quarantine policy",
      receipt: cleanReceipt({ dmarcVerdict: { status: "FAIL" }, dmarcPolicy: "quarantine" }),
      decision: "spam",
      reasons: ["sender_policy"],
    },
    {
      name: "DMARC reject policy",
      receipt: cleanReceipt({ dmarcVerdict: { status: "FAIL" }, dmarcPolicy: "reject" }),
      decision: "spam",
      reasons: ["sender_policy"],
    },
    {
      name: "DMARC failure without requested action",
      receipt: cleanReceipt({ dmarcVerdict: { status: "FAIL" }, dmarcPolicy: "none" }),
      decision: "inbox",
      reasons: [],
    },
    {
      name: "isolated SPF failure",
      receipt: cleanReceipt({ spfVerdict: { status: "FAIL" } }),
      decision: "inbox",
      reasons: [],
    },
    {
      name: "isolated DKIM failure",
      receipt: cleanReceipt({ dkimVerdict: { status: "FAIL" } }),
      decision: "inbox",
      reasons: [],
    },
    {
      name: "both SPF and DKIM failure",
      receipt: cleanReceipt({ spfVerdict: { status: "FAIL" }, dkimVerdict: { status: "FAIL" } }),
      decision: "spam",
      reasons: ["sender_authentication"],
    },
    {
      name: "all findings with virus priority",
      receipt: cleanReceipt({
        virusVerdict: { status: "FAIL" },
        spamVerdict: { status: "FAIL" },
        spfVerdict: { status: "FAIL" },
        dkimVerdict: { status: "FAIL" },
        dmarcVerdict: { status: "FAIL" },
        dmarcPolicy: "reject",
      }),
      decision: "quarantine",
      reasons: ["virus", "spam", "sender_policy", "sender_authentication"],
    },
  ])("classifies $name", ({ receipt, decision, reasons }) => {
    const assessment = assessMailboxReceipt(receipt);
    expect(assessment).toMatchObject({ version: 1, decision, reasons });
    expect(validateMailboxInboundAssessment(assessment)).toEqual(assessment);
  });

  it.each(["GRAY", "PROCESSING_FAILED", "UNKNOWN", undefined, "pass", 1, null, []])(
    "quarantines unavailable or malformed virus result %j",
    (status) => {
      const result = assessMailboxReceipt(cleanReceipt({ virusVerdict: { status } }));
      expect(result.decision).toBe("quarantine");
      expect(result.reasons).toEqual(["virus_unchecked"]);
    },
  );

  it.each([null, undefined, [], "PASS", 1])("fails closed for malformed receipt %j", (receipt) => {
    expect(assessMailboxReceipt(receipt)).toEqual({
      version: 1,
      decision: "quarantine",
      verdicts: {
        virus: "UNKNOWN",
        spam: "UNKNOWN",
        spf: "UNKNOWN",
        dkim: "UNKNOWN",
        dmarc: "UNKNOWN",
      },
      dmarcPolicy: null,
      reasons: ["virus_unchecked", "spam_unchecked"],
    });
  });

  it("does not accept MIME headers, caller decisions or inherited verdicts as scan evidence", () => {
    const receipt = cleanReceipt({
      virusVerdict: undefined,
      decision: "inbox",
      headers: [{ name: "X-SES-Virus-Verdict", value: "PASS" }],
      commonHeaders: { "X-SES-Spam-Verdict": "PASS" },
      raw: "X-SES-Virus-Verdict: PASS\r\nX-SES-Spam-Verdict: PASS\r\n",
    });
    expect(assessMailboxReceipt(receipt).decision).toBe("quarantine");
    expect(assessMailboxReceipt(Object.create(cleanReceipt())).verdicts.virus).toBe("UNKNOWN");
    expect(
      assessMailboxReceipt(cleanReceipt({ virusVerdict: Object.create({ status: "PASS" }) }))
        .verdicts.virus,
    ).toBe("UNKNOWN");
  });

  it("captures scalar verdicts and normalizes malformed policy without retaining caller objects", () => {
    const receipt = cleanReceipt({ dmarcPolicy: { status: "REJECT" } });
    const assessment = assessMailboxReceipt(receipt);
    receipt.virusVerdict.status = "FAIL";
    expect(assessment.verdicts.virus).toBe("PASS");
    expect(assessment.dmarcPolicy).toBeNull();
    const captured = validateMailboxInboundAssessment(assessment);
    assessment.verdicts.virus = "FAIL";
    assessment.reasons.push("virus");
    expect(captured.verdicts.virus).toBe("PASS");
    expect(captured.reasons).toEqual([]);
  });
});

describe("assessment validation at the persistence boundary", () => {
  const unsafe = () => assessMailboxReceipt(cleanReceipt({ virusVerdict: { status: "FAIL" } }));

  it.each([
    { version: 2 },
    { decision: "inbox" },
    { decision: "spam" },
    { reasons: [] },
    { reasons: ["virus", "virus"] },
    { reasons: ["unknown_reason"] },
    { reasons: Array(1) },
    { dmarcPolicy: "REJECT" },
    { extra: "field" },
  ])("rejects inconsistent or unsupported assessment %j", (change) => {
    expect(() => validateMailboxInboundAssessment({ ...unsafe(), ...change })).toThrow(
      "Invalid mailbox inbound assessment",
    );
  });

  it("rejects incomplete, unnormalized and extended verdict records", () => {
    const assessment = unsafe();
    for (const verdicts of [
      undefined,
      {},
      { ...assessment.verdicts, virus: "pass" },
      { ...assessment.verdicts, virus: { status: "PASS" } },
      { ...assessment.verdicts, injected: "PASS" },
    ])
      expect(() => validateMailboxInboundAssessment({ ...assessment, verdicts })).toThrow(
        "Invalid mailbox inbound assessment",
      );
    for (const value of [null, undefined, [], { ...assessment, dmarcPolicy: undefined }])
      expect(() => validateMailboxInboundAssessment(value)).toThrow(
        "Invalid mailbox inbound assessment",
      );
  });

  it("requires the complete, canonical reason order without allowing a safety downgrade", () => {
    const assessment = assessMailboxReceipt(
      cleanReceipt({
        spamVerdict: { status: "FAIL" },
        spfVerdict: { status: "FAIL" },
        dkimVerdict: { status: "FAIL" },
      }),
    );
    expect(() =>
      validateMailboxInboundAssessment({
        ...assessment,
        reasons: [...assessment.reasons].reverse(),
      }),
    ).toThrow("Invalid mailbox inbound assessment");
    expect(() => validateMailboxInboundAssessment({ ...assessment, decision: "inbox" })).toThrow(
      "Invalid mailbox inbound assessment",
    );
  });
});
