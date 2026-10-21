import type { SignupAttribution } from "@millionsend/core";
import { type Db, schema } from "@millionsend/db";
import { createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { notifySignupAlert, signupAlertMessage } from "@/server/signup-alert";

const attribution = (over: Partial<SignupAttribution> = {}): SignupAttribution => ({
  source: "facebook",
  medium: "group",
  campaign: "beta-livia-202609",
  content: "react-brasil",
  term: null,
  referrer: null,
  landingPath: "/",
  ...over,
});

let db: Db;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  vi.stubEnv("OPERATOR_ALERTS_SINK", undefined);
  vi.stubEnv("SIGNUP_ALERT_EMAIL", "alertas@example.com");
  vi.stubEnv("NOTIFICATIONS_EMAIL_FROM", "MepMail <notices@example.com>");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await close();
});

const operatorAlerts = () =>
  db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "operator.alert"));

describe("notifySignupAlert under OPERATOR_ALERTS_SINK", () => {
  it("e-mails the alerts box and writes no operator.alert row while the sink is unset", async () => {
    const send = vi.fn(async () => {});
    vi.stubGlobal("fetch", vi.fn());
    notifySignupAlert(
      { email: "ada@example.com", name: "Ada" },
      attribution(),
      "pt-BR",
      { send },
      db,
    );
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(await operatorAlerts()).toHaveLength(0);
  });

  it("records one operator.alert row with the mail's subject and body when the sink is audit", async () => {
    vi.stubEnv("OPERATOR_ALERTS_SINK", "audit");
    const send = vi.fn(async () => {});
    vi.stubGlobal("fetch", vi.fn());
    notifySignupAlert(
      { email: "ada@example.com", name: "Ada" },
      attribution(),
      "pt-BR",
      { send },
      db,
    );
    await vi.waitFor(async () => expect(await operatorAlerts()).toHaveLength(1));
    // The e-mail is what the sink replaces; it never reaches the mailer.
    expect(send).not.toHaveBeenCalled();
    const [row] = await operatorAlerts();
    expect(row).toMatchObject({
      actorId: "system",
      teamId: null,
      data: {
        kind: "signup.alert",
        subject: "MepMail: novo cadastro ada@example.com",
        text: signupAlertMessage({
          email: "ada@example.com",
          name: "Ada",
          attribution: attribution(),
          locale: "pt-BR",
        }),
        // The signup alert carries no link, so the row carries none either.
        url: "",
      },
    });
  });

  it("keeps the Telegram post on its own route when the sink is audit", async () => {
    vi.stubEnv("OPERATOR_ALERTS_SINK", "audit");
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "123456:TEST-TOKEN-VALUE-000000000000000000000");
    vi.stubEnv("TELEGRAM_CHAT_ID", "-1003838851729");
    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const send = vi.fn(async () => {});
    notifySignupAlert(
      { email: "ada@example.com", name: "Ada" },
      attribution(),
      "pt-BR",
      { send },
      db,
    );
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    await vi.waitFor(async () => expect(await operatorAlerts()).toHaveLength(1));
    expect(send).not.toHaveBeenCalled();
  });
});
