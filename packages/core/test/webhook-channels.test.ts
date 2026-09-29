import { expect, it } from "vitest";
import { detectWebhookChannel, formatChannelPayload } from "../src/webhook-channels.js";
import type { WebhookPayload } from "../src/webhooks.js";

const payload: WebhookPayload = {
  type: "email.delivered",
  created_at: "2026-09-29T02:00:00.000Z",
  data: {
    email_id: "abc-123",
    from: "account@je4ndev.com",
    to: ["user@example.com"],
    subject: "Welcome aboard",
  },
};

it("detects the well-known chat endpoints", () => {
  expect(detectWebhookChannel("https://hooks.slack.com/services/T/B/X")).toBe("slack");
  expect(detectWebhookChannel("https://hooks.slack.com.evil.test/x")).toBeNull();
  expect(detectWebhookChannel("https://discord.com/api/webhooks/123/xyz")).toBe("discord");
  expect(detectWebhookChannel("https://discordapp.com/api/webhooks/123/xyz")).toBe("discord");
  expect(detectWebhookChannel("https://discord.com/oauth2/authorize")).toBeNull();
  expect(detectWebhookChannel("https://api.telegram.org/bot123:ABC/sendMessage?chat_id=42")).toBe(
    "telegram",
  );
  expect(detectWebhookChannel("https://api.telegram.org/bot123:ABC/getUpdates")).toBeNull();
  expect(detectWebhookChannel("https://example.com/hooks")).toBeNull();
  expect(detectWebhookChannel("not a url")).toBeNull();
});

it("formats a Slack body with the shared text fields", () => {
  const body = formatChannelPayload("https://hooks.slack.com/services/T/B/X", payload);
  expect(body).not.toBeNull();
  const text = String(body?.text ?? "");
  expect(text).toContain("email.delivered");
  expect(text).toContain("Subject: Welcome aboard");
  expect(text).toContain("To: user@example.com");
  expect(text).toContain("From: account@je4ndev.com");
  expect(text).toContain("2026-09-29T02:00:00.000Z");
  expect(body?.chat_id).toBeUndefined();
});

it("formats a Discord body with markdown", () => {
  const body = formatChannelPayload("https://discord.com/api/webhooks/123/xyz", payload);
  const content = String(body?.content ?? "");
  expect(content).toContain("**MepMail · email.delivered**");
  expect(content).toContain("> Subject: Welcome aboard");
});

it("formats a Telegram body and requires the chat id", () => {
  const body = formatChannelPayload(
    "https://api.telegram.org/bot123:ABC/sendMessage?chat_id=42",
    payload,
  );
  expect(body?.chat_id).toBe("42");
  expect(body?.disable_web_page_preview).toBe(true);
  expect(String(body?.text ?? "")).toContain("Subject: Welcome aboard");
  // No chat_id in the stored URL → raw JSON keeps working (null).
  expect(
    formatChannelPayload("https://api.telegram.org/bot123:ABC/sendMessage", payload),
  ).toBeNull();
});

it("keeps the raw envelope for unknown endpoints and tolerates non-array to", () => {
  expect(formatChannelPayload("https://example.com/hooks", payload)).toBeNull();
  const single: WebhookPayload = {
    ...payload,
    data: { ...payload.data, to: "solo@example.com" },
  };
  const body = formatChannelPayload("https://hooks.slack.com/services/T/B/X", single);
  expect(String(body?.text ?? "")).toContain("To: solo@example.com");
});
