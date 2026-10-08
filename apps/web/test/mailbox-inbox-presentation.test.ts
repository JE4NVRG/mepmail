import { describe, expect, it } from "vitest";
import {
  mailboxContentBlocked,
  mailboxListDate,
  mailboxMessageActions,
  mailboxOutboundPresentation,
  mailboxPreview,
  mailboxPrimaryParticipant,
  mailboxSendApproval,
} from "../src/lib/mailbox-inbox-presentation";

describe("mailbox list preview", () => {
  it("drops the link and image targets HTML-only mail carries as text", () => {
    expect(
      mailboxPreview(
        "Amazon [https://m.media-amazon.com/images/G/01/hero.png]\n\nYour AWS Activate application\n<https://aws.amazon.com/activate> was updated",
      ),
    ).toBe("Amazon Your AWS Activate application was updated");
    expect(
      mailboxPreview("Claude [https://claude.ai/images/email/logo.png] Seu link seguro está aqui"),
    ).toBe("Claude Seu link seguro está aqui");
  });

  it("drops bare URLs, mailto and cid targets, and invisible preheader padding", () => {
    expect(
      mailboxPreview(
        "Oi\u200c \u034f\u200b Jean, veja https://example.invalid/a?b=1 [mailto:a@b.invalid] [cid:logo]",
      ),
    ).toBe("Oi Jean, veja");
  });

  it("keeps bracketed words that are not targets and cuts on characters, not code units", () => {
    expect(mailboxPreview("[Ação] pedido #12 confirmado")).toBe("[Ação] pedido #12 confirmado");
    expect(mailboxPreview(`${"🙂".repeat(5)}abc`, 3)).toBe("🙂🙂🙂");
    expect(mailboxPreview("   \n\t  ")).toBe("");
  });
});

describe("mailbox list date", () => {
  const now = new Date(2026, 9, 8, 15, 30);
  it("shows the time today and 'yesterday' the day before", () => {
    expect(mailboxListDate(new Date(2026, 9, 8, 9, 5), now, "pt-BR")).toBe("09:05");
    expect(mailboxListDate(new Date(2026, 9, 7, 23, 59), now, "pt-BR")).toBe("Ontem");
    expect(mailboxListDate(new Date(2026, 9, 7, 8, 0), now, "en")).toBe("Yesterday");
  });

  it("shows the weekday within the week, day and month this year, a full date before", () => {
    expect(mailboxListDate(new Date(2026, 9, 5, 10, 0), now, "en")).toBe("Mon");
    expect(mailboxListDate(new Date(2026, 8, 20, 10, 0), now, "pt-BR")).toBe("20 de set.");
    expect(mailboxListDate(new Date(2026, 8, 20, 10, 0), now, "en")).toBe("Sep 20");
    expect(mailboxListDate(new Date(2025, 11, 31, 10, 0), now, "pt-BR")).toBe("31/12/2025");
  });

  it("shows day and month for a date ahead of the clock", () => {
    expect(mailboxListDate(new Date(2026, 9, 9, 10, 0), now, "en")).toBe("Oct 9");
  });
});

const received = {
  kind: "inbox" as const,
  deliveryFolder: "inbox" as const,
  blocked: false,
  inboundAssessment: null,
  from: "sender@example.invalid",
  fromName: "Sender",
  to: ["agent@example.invalid"],
};
const assessed = (decision: "inbox" | "spam" | "quarantine", virus = "PASS") => ({
  decision,
  verdicts: { virus },
});

describe("mailbox recipient result presentation", () => {
  const summary = {
    totalRecipients: 3,
    delivered: 1,
    delayed: 0,
    hardBounce: 0,
    complaint: 0,
    softBounce: 0,
    rejected: 0,
    renderingFailed: 0,
    unconfirmed: 2,
  };

  it("shows a partial recipient result without declaring the entire send delivered", () => {
    expect(mailboxOutboundPresentation(summary)).toEqual({
      total: 3,
      hasConfirmed: true,
      partial: true,
      rows: [
        { key: "delivered", count: 1 },
        { key: "unconfirmed", count: 2 },
      ],
    });
  });

  it("keeps service acceptance with no later facts unconfirmed", () => {
    expect(mailboxOutboundPresentation({ ...summary, delivered: 0, unconfirmed: 3 })).toEqual({
      total: 3,
      hasConfirmed: false,
      partial: false,
      rows: [{ key: "unconfirmed", count: 3 }],
    });
    expect(mailboxOutboundPresentation(null)).toBeNull();
    expect(mailboxOutboundPresentation(undefined)).toBeNull();
  });

  it("preserves mixed negative and positive states without adding absent events", () => {
    expect(
      mailboxOutboundPresentation({ ...summary, hardBounce: 1, complaint: 1, unconfirmed: 0 }),
    ).toEqual({
      total: 3,
      hasConfirmed: true,
      partial: false,
      rows: [
        { key: "delivered", count: 1 },
        { key: "hardBounce", count: 1 },
        { key: "complaint", count: 1 },
      ],
    });
  });

  it("does not invent a valid recipient picture from inconsistent or malformed counts", () => {
    for (const invalid of [
      { ...summary, unconfirmed: 3 },
      { ...summary, complaint: -1 },
      { ...summary, delayed: 0.5 },
      { ...summary, delivered: Number.NaN },
      { ...summary, totalRecipients: 0 },
      { ...summary, totalRecipients: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      expect(mailboxOutboundPresentation(invalid)).toBeNull();
    }
  });

  it("represents provider rejection, rendering failure and soft bounce separately", () => {
    const providerFailures = {
      ...summary,
      delivered: 0,
      rejected: 1,
      renderingFailed: 1,
      softBounce: 1,
      unconfirmed: 0,
    };
    expect(mailboxOutboundPresentation(providerFailures)?.rows).toEqual([
      { key: "softBounce", count: 1 },
      { key: "rejected", count: 1 },
      { key: "renderingFailed", count: 1 },
    ]);
  });
});

describe("mailbox inbox presentation safety", () => {
  it("keeps quarantine content closed when any authoritative safety signal blocks it", () => {
    for (const item of [
      { ...received, blocked: true },
      { ...received, deliveryFolder: "quarantine" as const },
      { ...received, inboundAssessment: assessed("quarantine") },
    ]) {
      expect(mailboxContentBlocked(item)).toBe(true);
      expect(mailboxPrimaryParticipant(item)).toBeNull();
      expect(mailboxMessageActions(item, true, true)).toEqual({
        canRespond: false,
        canMoveToInbox: false,
        canMoveToSpam: false,
        canMoveToTrash: true,
        canRestore: false,
      });
    }
  });

  it("requires the owner to move Spam and prevents replies before restoration", () => {
    const spam = {
      ...received,
      deliveryFolder: "spam" as const,
      inboundAssessment: assessed("spam"),
    };
    expect(mailboxMessageActions(spam, true, false)).toEqual({
      canRespond: false,
      canMoveToInbox: false,
      canMoveToSpam: false,
      canMoveToTrash: false,
      canRestore: false,
    });
    expect(mailboxMessageActions(spam, true, true)).toEqual({
      canRespond: false,
      canMoveToInbox: true,
      canMoveToSpam: false,
      canMoveToTrash: true,
      canRestore: false,
    });
  });

  it("restores response controls after an owner override while retaining the original assessment", () => {
    const restored = { ...received, inboundAssessment: assessed("spam") };
    expect(mailboxMessageActions(restored, true, true).canRespond).toBe(true);
    expect(mailboxMessageActions(restored, false, true).canRespond).toBe(false);
  });

  it("does not offer owner moves for an unconfirmed virus verdict", () => {
    for (const virus of ["FAIL", "GRAY", "PROCESSING_FAILED", "UNKNOWN"]) {
      const item = {
        ...received,
        deliveryFolder: "spam" as const,
        inboundAssessment: assessed("spam", virus),
      };
      expect(mailboxMessageActions(item, true, true).canMoveToInbox).toBe(false);
    }
  });

  it("allows explicit owner classification of legacy received mail but never Sent or Drafts", () => {
    expect(mailboxMessageActions(received, false, true).canMoveToSpam).toBe(true);
    for (const kind of ["draft", "sent"] as const) {
      expect(mailboxMessageActions({ ...received, kind }, true, true).canMoveToSpam).toBe(false);
    }
  });

  it.each(["inbox", "draft", "sent"] as const)(
    "blocks replies, forwarding and classification of trashed %s despite stale readable metadata",
    (kind) => {
      const trashed = { ...received, kind, trashedAt: new Date("2026-10-05T12:00:00Z") };
      expect(mailboxContentBlocked(trashed)).toBe(false);
      expect(mailboxMessageActions(trashed, true, true)).toEqual({
        canRespond: false,
        canMoveToInbox: false,
        canMoveToSpam: false,
        canMoveToTrash: false,
        canRestore: true,
      });
    },
  );

  it("offers Trash and Restore only to the owner, independently of delegated drafting permission", () => {
    for (const canDraft of [false, true]) {
      expect(mailboxMessageActions(received, canDraft, false)).toMatchObject({
        canMoveToTrash: false,
        canRestore: false,
      });
      expect(mailboxMessageActions(received, canDraft, true)).toMatchObject({
        canMoveToTrash: true,
        canRestore: false,
      });
      const trashed = { ...received, trashedAt: new Date("2026-10-05T12:00:00Z") };
      expect(mailboxMessageActions(trashed, canDraft, false)).toMatchObject({
        canRespond: false,
        canMoveToTrash: false,
        canRestore: false,
      });
      expect(mailboxMessageActions(trashed, canDraft, true)).toMatchObject({
        canRespond: false,
        canMoveToTrash: false,
        canRestore: true,
      });
    }
  });

  it("keeps omitted legacy trash metadata equivalent to an explicitly untrashed item", () => {
    for (const canDraft of [false, true]) {
      for (const isOwner of [false, true]) {
        expect(mailboxMessageActions(received, canDraft, isOwner)).toEqual(
          mailboxMessageActions({ ...received, trashedAt: null }, canDraft, isOwner),
        );
      }
    }
  });

  it("restores safe message actions only after the trash marker is cleared", () => {
    const trashed = { ...received, trashedAt: new Date("2026-10-05T12:00:00Z") };
    const restored = { ...trashed, trashedAt: null };
    expect(mailboxMessageActions(trashed, true, true).canRestore).toBe(true);
    expect(mailboxMessageActions(restored, true, true)).toMatchObject({
      canRespond: true,
      canMoveToSpam: true,
      canMoveToTrash: true,
      canRestore: false,
    });
    expect(mailboxMessageActions(restored, false, true).canRespond).toBe(false);
  });

  it("restoring a trashed Spam item does not move it to Inbox or permit replying", () => {
    const spam = {
      ...received,
      deliveryFolder: "spam" as const,
      inboundAssessment: assessed("spam"),
      trashedAt: new Date("2026-10-05T12:00:00Z"),
    };
    expect(mailboxMessageActions(spam, true, true)).toMatchObject({
      canRespond: false,
      canMoveToInbox: false,
      canRestore: true,
    });
    expect(mailboxMessageActions({ ...spam, trashedAt: null }, true, true)).toMatchObject({
      canRespond: false,
      canMoveToInbox: true,
      canRestore: false,
    });
  });

  it("owner metadata restoration never releases quarantined content or unsafe classification", () => {
    for (const unsafe of [
      { ...received, blocked: true },
      { ...received, deliveryFolder: "quarantine" as const },
      { ...received, inboundAssessment: assessed("quarantine") },
    ]) {
      const trashed = { ...unsafe, trashedAt: new Date("2026-10-05T12:00:00Z") };
      expect(mailboxMessageActions(trashed, true, true).canRestore).toBe(true);
      expect(mailboxMessageActions(trashed, true, false).canRestore).toBe(false);
      for (const item of [trashed, { ...trashed, trashedAt: null }]) {
        expect(mailboxContentBlocked(item)).toBe(true);
        expect(mailboxPrimaryParticipant(item)).toBeNull();
        expect(mailboxMessageActions(item, true, true)).toMatchObject({
          canRespond: false,
          canMoveToInbox: false,
          canMoveToSpam: false,
        });
      }
    }
  });

  it("highlights recipients in Sent and Drafts instead of the mailbox sender", () => {
    for (const kind of ["sent", "draft"] as const) {
      expect(
        mailboxPrimaryParticipant({
          ...received,
          kind,
          to: ["one@example.invalid", "two@example.invalid"],
        }),
      ).toBe("one@example.invalid, two@example.invalid");
      expect(mailboxPrimaryParticipant({ ...received, kind, to: [] })).toBeNull();
    }
    expect(mailboxPrimaryParticipant(received)).toBe("Sender");
  });

  it("does not infer agent approval from the address, folder or a missing provenance DTO", () => {
    expect(mailboxSendApproval(null)).toBeNull();
    expect(mailboxSendApproval({ kind: "human", label: "Agent mailbox" })).toEqual({
      key: "approval.human",
    });
    expect(mailboxSendApproval({ kind: "agent", label: "Support agent" })).toEqual({
      key: "approval.agent",
      label: "Support agent",
    });
    expect(mailboxSendApproval({ kind: "agent", label: "  " })).toEqual({
      key: "approval.agentUnnamed",
    });
  });
});
