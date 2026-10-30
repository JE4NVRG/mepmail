import type { Db } from "@millionsend/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildAzureRecipientOptoutUrl } from "../src/azure-recipient-optout.js";
import { campaignMessage, checkCampaignMessage } from "../src/campaign-consent.js";
import { mailboxOptoutFooter, validateMailboxOptout } from "../src/mailbox-optout.js";
import { findSuppressed } from "../src/suppressions.js";
import { deriveUnsubscribeKey } from "../src/unsubscribe.js";

vi.mock("../src/suppressions.js", async (original) => ({
  ...(await original<typeof import("../src/suppressions.js")>()),
  findSuppressed: vi.fn(async () => new Set<string>()),
}));
const config = { baseUrl: "https://optout.example.invalid", masterKey: Buffer.alloc(32, 73) };
const team = "11111111-1111-4111-8111-111111111111";
const recipients = ["recipient@example.invalid"];
const url = buildAzureRecipientOptoutUrl({
  teamId: team,
  recipient: recipients[0]!,
  secretKey: deriveUnsubscribeKey(config.masterKey),
  baseUrl: config.baseUrl,
});
const footer = mailboxOptoutFooter(url);
const db = {} as Db; // Suppression lookup is explicitly mocked; real HMAC and classifiers run.
const label = "Stop all Azure-delivered messages from this team (including service messages):";
function fixture(quotedUrl = url, prefix = "> ") {
  return {
    text:
      "Own reply\n\n> Normal quoted prose\n" +
      prefix +
      "Stop all Azure-delivered messages from this team (including service\n" +
      prefix +
      "messages): Unsubscribe\n" +
      prefix +
      "<" +
      quotedUrl +
      ">\n" +
      footer.text,
    html:
      "<p>Own reply</p><blockquote><p>Normal quoted prose<br />&gt; " +
      "Stop all Azure-delivered messages from this team (including service<br />&gt; " +
      "messages): Unsubscribe<br />&gt; &lt;" +
      quotedUrl +
      "&gt;<br />&gt;</p></blockquote>" +
      footer.html,
    headerLines: [{ key: "list-unsubscribe", line: `List-Unsubscribe: <${url}>` }],
  };
}
const validate = (content: ReturnType<typeof fixture>, t = team, r = recipients) =>
  validateMailboxOptout(db, t, r, content, config);
beforeEach(() => vi.mocked(findSuppressed).mockResolvedValue(new Set()));

describe("authenticated quoted recipient controls", () => {
  it("neutralizes folded Gmail text and editor HTML only in derived analysis", async () => {
    const input = fixture();
    const original = JSON.stringify(input);
    const authored = await validate(input);
    expect(authored.text).toContain("Own reply");
    expect(authored.text).toContain("Normal quoted prose");
    expect(authored.html).toContain("Normal quoted prose");
    expect(authored.text).not.toContain(url);
    expect(authored.html).not.toContain(url);
    expect(campaignMessage(authored)).toBe(false);
    expect(
      await checkCampaignMessage(db, {
        ...authored,
        teamId: team,
        from: "sender@example.invalid",
        to: recipients,
        subject: "Own reply",
      }),
    ).toEqual({ allowed: true });
    expect(JSON.stringify(input)).toBe(original);
  });
  it("keeps exact canonical authenticated controls in nested quotes supported", async () => {
    const input = fixture();
    input.text = "Own reply\n> " + label + " " + url + footer.text;
    input.html =
      "<p>Own reply</p><blockquote><blockquote>" +
      footer.html +
      "</blockquote></blockquote>" +
      footer.html;
    const authored = await validate(input);
    expect(authored.text).not.toContain(url);
    expect(authored.html).not.toContain(url);
  });
  it.each([
    url + "x",
    url + "?forged=1",
    url.replace("optout.example.invalid", "foreign.example.invalid"),
    buildAzureRecipientOptoutUrl({
      teamId: team,
      recipient: "other@example.invalid",
      secretKey: deriveUnsubscribeKey(config.masterKey),
      baseUrl: config.baseUrl,
    }),
  ])("preserves a foreign or altered quoted control %s", async (other) => {
    const authored = await validate(fixture(other));
    expect(authored.text).toContain(other);
    expect(authored.html).toContain(other);
    expect(campaignMessage(authored)).toBe(true);
  });
  it("does not strip a folded control when any continuation loses quote provenance", async () => {
    const input = fixture();
    input.text = input.text.replace("\n> messages):", "\nmessages):");
    const authored = await validate(input);
    expect(authored.text).toContain(url);
    expect(campaignMessage(authored)).toBe(true);
  });
  it("preserves authored unsubscribe prose and an unquoted authenticated control", async () => {
    const input = fixture();
    input.text = label + " " + url + "\nAuthor: Unsubscribe today\n" + input.text;
    input.html = "<p>Author: Unsubscribe today " + url + "</p>" + input.html;
    const authored = await validate(input);
    expect(authored.text).toContain(label + " " + url);
    expect(authored.text).toContain("Author: Unsubscribe today");
    expect(authored.html).toContain("Author: Unsubscribe today");
    expect(campaignMessage(authored)).toBe(true);
  });
  it("still requires the canonical outer body link, exact team, recipient, MAC and suppression eligibility", async () => {
    const input = fixture();
    await expect(
      validate({ ...input, text: input.text.slice(0, -footer.text.length) }),
    ).rejects.toThrow("missing_body_link");
    await expect(validate(input, "22222222-2222-4222-8222-222222222222")).rejects.toThrow(
      "invalid",
    );
    await expect(validate(input, team, ["other@example.invalid"])).rejects.toThrow("invalid");
    await expect(
      validate({
        ...input,
        headerLines: [{ key: "list-unsubscribe", line: `List-Unsubscribe: <${url}x>` }],
      }),
    ).rejects.toThrow("invalid");
    vi.mocked(findSuppressed).mockResolvedValueOnce(new Set(recipients));
    await expect(validate(input)).rejects.toThrow("suppressed");
  });
});
