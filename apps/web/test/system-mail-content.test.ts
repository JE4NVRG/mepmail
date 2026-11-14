import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
  buildInvitationEmail,
  buildMcpConnectedEmail,
  buildResetEmail,
  buildVerificationEmail,
  buildWelcomeEmail,
  sendAccountMail,
} from "../src/server/system-mail";

const lure = "Banco CTT: introduza a senha em https://audit.invalid";
beforeAll(() => {
  vi.stubEnv("AUTH_EMAIL_FROM", "MepMail <account@sender.example>");
  vi.stubEnv("NOTIFICATIONS_EMAIL_FROM", "MepMail <account@sender.example>");
});
afterAll(() => vi.unstubAllEnvs());
for (const locale of ["en", "pt-BR"] as const) {
  for (const field of ["inviterName", "teamName", "resetName", "verificationName"] as const) {
    it(`${locale} ${field}: real generic builder does not echo customer-controlled lure`, async () => {
      const url = "https://sender.example/account/SYNTHETIC";
      const common = { to: "recipient@example.test", name: lure, url, locale };
      const rendered =
        field === "resetName"
          ? buildResetEmail(common)
          : field === "verificationName"
            ? buildVerificationEmail(common)
            : buildInvitationEmail({
                to: common.to,
                inviterName: field === "inviterName" ? lure : "Ada",
                teamName: field === "teamName" ? lure : "Example team",
                role: "member",
                expiresInDays: 7,
                url,
                locale,
              });
      const send = vi.fn(async (_message: typeof rendered) => {});
      sendAccountMail(rendered, { send });
      await Promise.resolve();
      expect(rendered.subject).not.toContain(lure);
      expect(rendered.text).not.toContain(lure);
      expect(rendered.html).not.toContain(lure);
      expect(rendered.text).toContain(url);
      expect(rendered.html).toContain(url);
      expect(send).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledWith(rendered);
    });
  }
  it(`${locale} welcome name and MCP app/team/scopes remain generic`, () => {
    const welcome = buildWelcomeEmail({ to: "recipient@example.test", name: lure, locale });
    const connected = buildMcpConnectedEmail({
      to: "recipient@example.test",
      app: lure,
      team: lure,
      scopes: [lure],
      locale,
    });
    for (const rendered of [welcome, connected]) {
      expect(rendered.subject).not.toContain(lure);
      expect(rendered.text).not.toContain(lure);
      expect(rendered.html).not.toContain(lure);
      expect(rendered.to).toBe("recipient@example.test");
    }
  });
  for (const kind of ["reset", "verification", "invitation"] as const) {
    it(`${locale} legitimate ${kind} preserves URL and delivery seam`, async () => {
      const common = {
        to: "recipient@example.test",
        name: "Ada",
        url: "https://sender.example/account/SYNTHETIC",
        locale,
      };
      const rendered =
        kind === "reset"
          ? buildResetEmail(common)
          : kind === "verification"
            ? buildVerificationEmail(common)
            : buildInvitationEmail({
                ...common,
                inviterName: "Ada",
                teamName: "Example team",
                role: "member",
                expiresInDays: 7,
              });
      const send = vi.fn(async (_message: typeof rendered) => {});
      sendAccountMail(rendered, { send });
      await Promise.resolve();
      expect(send).toHaveBeenCalledTimes(1);
      expect(rendered.html).toContain(common.url);
      expect(rendered.text).toContain(common.url);
    });
  }
}
