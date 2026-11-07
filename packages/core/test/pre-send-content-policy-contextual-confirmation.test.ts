import { expect, it } from "vitest";
import { evaluatePreSendContent } from "../src/pre-send-content-policy.js";

// Internal confirmation is a noun only in an unbound, non-sensitive clause.
const cases = [
  {
    id: "L1 canary text",
    input: {
      from: "Suporte MepMail <suporte@mepmail.dev>",
      subject: "Re: Elozi internal receive check 20261106-GMAIL-02",
      text: "Confirmação interna da integração Elozi 0.72.5. Rascunho de validação para a própria conta, sem atendimento de terceiros. ELOZI-NATIVE-0725-20261106-01.\nSuporte MepMail https://mepmail.dev\nStop all Azure-delivered messages from this team (including service messages): Unsubscribe https://optout.synthetic.invalid/unsubscribe",
    },
    expected: "allow",
  },
  {
    id: "L1 canary html",
    input: {
      from: "Suporte MepMail <suporte@mepmail.dev>",
      subject: "Re: Elozi internal receive check 20261106-GMAIL-02",
      html: '<p>Confirmação interna da integração Elozi 0.72.5. Rascunho de validação para a própria conta, sem atendimento de terceiros. ELOZI-NATIVE-0725-20261106-01.</p><p>Suporte MepMail https://mepmail.dev</p><p>Stop all Azure-delivered messages from this team (including service messages): Unsubscribe https://optout.synthetic.invalid/unsubscribe</p><a href="https://mepmail.dev">Suporte MepMail</a>',
    },
    expected: "allow",
  },
  {
    id: "L1 canary multipart",
    input: {
      from: "Suporte MepMail <suporte@mepmail.dev>",
      subject: "Re: Elozi internal receive check 20261106-GMAIL-02",
      text: "Confirmação interna da integração Elozi 0.72.5. Rascunho de validação para a própria conta, sem atendimento de terceiros. ELOZI-NATIVE-0725-20261106-01.\nSuporte MepMail https://mepmail.dev\nStop all Azure-delivered messages from this team (including service messages): Unsubscribe https://optout.synthetic.invalid/unsubscribe",
      html: '<p>Confirmação interna da integração Elozi 0.72.5. Rascunho de validação para a própria conta, sem atendimento de terceiros. ELOZI-NATIVE-0725-20261106-01.</p><p>Suporte MepMail https://mepmail.dev</p><p>Stop all Azure-delivered messages from this team (including service messages): Unsubscribe https://optout.synthetic.invalid/unsubscribe</p><a href="https://mepmail.dev">Suporte MepMail</a>',
    },
    expected: "allow",
  },
  {
    id: "L2 no footer classifier-only",
    input: {
      from: "Suporte MepMail <suporte@mepmail.dev>",
      subject: "Re: Elozi internal receive check 20261106-GMAIL-02",
      text: "Confirmação interna da integração Elozi 0.72.5. Rascunho de validação para a própria conta, sem atendimento de terceiros. ELOZI-NATIVE-0725-20261106-01.\nSuporte MepMail https://mepmail.dev",
    },
    expected: "allow",
  },
  {
    id: "L3 unrelated Orbit",
    input: {
      from: "Orbit Support <support@orbit.example>",
      subject: "Gmail receive integration check",
      text: "Confirmação interna da integração Orbit. Rascunho de validação para a própria conta. OWN-37. https://orbit.example",
    },
    expected: "allow",
  },
  {
    id: "L3 unrelated ServiceNova",
    input: {
      from: "ServiceNova Support <support@nova.invalid>",
      subject: "Gmail receive integration check",
      text: "Confirmação interna da integração ServiceNova. Rascunho de validação para a própria conta. NOT-AN-ELOZI-MARKER. https://nova.invalid",
    },
    expected: "allow",
  },
  {
    id: "L4 no Gmail",
    input: {
      from: "Suporte MepMail <suporte@mepmail.dev>",
      subject: "Receive integration check",
      text: "Confirmação interna da integração Elozi 0.72.5. Rascunho de validação para a própria conta, sem atendimento de terceiros. ELOZI-NATIVE-0725-20261106-01.\nSuporte MepMail https://mepmail.dev\nStop all Azure-delivered messages from this team (including service messages): Unsubscribe https://optout.synthetic.invalid/unsubscribe",
    },
    expected: "allow",
  },
  {
    id: "L4 no action account",
    input: {
      from: "Suporte MepMail <suporte@mepmail.dev>",
      subject: "Re: Elozi internal receive check 20261106-GMAIL-02",
      text: "Integration test. https://mepmail.dev",
    },
    expected: "allow",
  },
  {
    id: "L5 explicit own-service nominal confirmation",
    input: {
      from: "Orbit <support@orbit.invalid>",
      subject: "Gmail receive check",
      text: "Confirmação interna da integração Orbit. A conta do serviço Orbit está em validação interna. Gmail is the receiving provider. https://orbit.invalid",
    },
    expected: "allow",
  },
  {
    id: "N1 Gmail: verify your account",
    input: {
      from: "Suporte MepMail <suporte@mepmail.dev>",
      subject: "Re: Elozi internal receive check 20261106-GMAIL-02",
      text: "Confirmação interna da integração Elozi 0.72.5. Rascunho de validação para a própria conta, sem atendimento de terceiros. ELOZI-NATIVE-0725-20261106-01.\nSuporte MepMail https://mepmail.dev\nStop all Azure-delivered messages from this team (including service messages): Unsubscribe https://optout.synthetic.invalid/unsubscribe\nGmail: verify your account https://evil.example/login",
    },
    expected: "hold",
  },
  {
    id: "N1 Gmail: verify your account and update payment",
    input: {
      from: "Suporte MepMail <suporte@mepmail.dev>",
      subject: "Re: Elozi internal receive check 20261106-GMAIL-02",
      text: "Confirmação interna da integração Elozi 0.72.5. Rascunho de validação para a própria conta, sem atendimento de terceiros. ELOZI-NATIVE-0725-20261106-01.\nSuporte MepMail https://mepmail.dev\nStop all Azure-delivered messages from this team (including service messages): Unsubscribe https://optout.synthetic.invalid/unsubscribe\nGmail: verify your account and update payment https://evil.example/login",
    },
    expected: "hold",
  },
  {
    id: "N1 Gmail. Verify your account",
    input: {
      from: "Suporte MepMail <suporte@mepmail.dev>",
      subject: "Re: Elozi internal receive check 20261106-GMAIL-02",
      text: "Confirmação interna da integração Elozi 0.72.5. Rascunho de validação para a própria conta, sem atendimento de terceiros. ELOZI-NATIVE-0725-20261106-01.\nSuporte MepMail https://mepmail.dev\nStop all Azure-delivered messages from this team (including service messages): Unsubscribe https://optout.synthetic.invalid/unsubscribe\nGmail. Verify your account https://evil.example/login",
    },
    expected: "hold",
  },
  {
    id: "N1 We use Google. Account confirmation",
    input: {
      from: "Suporte MepMail <suporte@mepmail.dev>",
      subject: "Re: Elozi internal receive check 20261106-GMAIL-02",
      text: "Confirmação interna da integração Elozi 0.72.5. Rascunho de validação para a própria conta, sem atendimento de terceiros. ELOZI-NATIVE-0725-20261106-01.\nSuporte MepMail https://mepmail.dev\nStop all Azure-delivered messages from this team (including service messages): Unsubscribe https://optout.synthetic.invalid/unsubscribe\nWe use Google. Account confirmation https://evil.example/login",
    },
    expected: "hold",
  },
  {
    id: "N2 protected CTA subject",
    input: {
      from: "Suporte MepMail <suporte@mepmail.dev>",
      subject: "Confirm your Google account",
      text: "Confirmação interna da integração Elozi 0.72.5. Rascunho de validação para a própria conta, sem atendimento de terceiros. ELOZI-NATIVE-0725-20261106-01.\nSuporte MepMail https://mepmail.dev\nStop all Azure-delivered messages from this team (including service messages): Unsubscribe https://optout.synthetic.invalid/unsubscribe",
    },
    expected: "hold",
  },
  {
    id: "N2 protected CTA sentence",
    input: {
      from: "Suporte MepMail <suporte@mepmail.dev>",
      subject: "Re: Elozi internal receive check 20261106-GMAIL-02",
      text: "Confirmação interna da integração Elozi 0.72.5. Rascunho de validação para a própria conta, sem atendimento de terceiros. ELOZI-NATIVE-0725-20261106-01.\nSuporte MepMail https://mepmail.dev\nStop all Azure-delivered messages from this team (including service messages): Unsubscribe https://optout.synthetic.invalid/unsubscribe. Confirm your Google account https://evil.example/login",
    },
    expected: "hold",
  },
  {
    id: "N2 protected CTA paragraph",
    input: {
      from: "Suporte MepMail <suporte@mepmail.dev>",
      subject: "Re: Elozi internal receive check 20261106-GMAIL-02",
      text: "Confirmação interna da integração Elozi 0.72.5. Rascunho de validação para a própria conta, sem atendimento de terceiros. ELOZI-NATIVE-0725-20261106-01.\nSuporte MepMail https://mepmail.dev\nStop all Azure-delivered messages from this team (including service messages): Unsubscribe https://optout.synthetic.invalid/unsubscribe\n\nConfirm your Google account https://evil.example/login",
    },
    expected: "hold",
  },
  {
    id: "N2 protected CTA html",
    input: {
      from: "Suporte MepMail <suporte@mepmail.dev>",
      subject: "Re: Elozi internal receive check 20261106-GMAIL-02",
      text: "Confirmação interna da integração Elozi 0.72.5. Rascunho de validação para a própria conta, sem atendimento de terceiros. ELOZI-NATIVE-0725-20261106-01.\nSuporte MepMail https://mepmail.dev\nStop all Azure-delivered messages from this team (including service messages): Unsubscribe https://optout.synthetic.invalid/unsubscribe",
      html: '<p>Confirm your Google account</p><a href="https://evil.example/login">Continue</a>',
    },
    expected: "hold",
  },
  {
    id: "N3 Enter your Gmail password",
    input: {
      from: "Suporte MepMail <suporte@mepmail.dev>",
      subject: "Re: Elozi internal receive check 20261106-GMAIL-02",
      text: "Confirmação interna da integração Elozi 0.72.5. Rascunho de validação para a própria conta, sem atendimento de terceiros. ELOZI-NATIVE-0725-20261106-01.\nSuporte MepMail https://mepmail.dev\nStop all Azure-delivered messages from this team (including service messages): Unsubscribe https://optout.synthetic.invalid/unsubscribe\nEnter your Gmail password https://evil.example/login",
    },
    expected: "hold",
  },
  {
    id: "N3 Provide the verification code",
    input: {
      from: "Suporte MepMail <suporte@mepmail.dev>",
      subject: "Re: Elozi internal receive check 20261106-GMAIL-02",
      text: "Confirmação interna da integração Elozi 0.72.5. Rascunho de validação para a própria conta, sem atendimento de terceiros. ELOZI-NATIVE-0725-20261106-01.\nSuporte MepMail https://mepmail.dev\nStop all Azure-delivered messages from this team (including service messages): Unsubscribe https://optout.synthetic.invalid/unsubscribe\nProvide the verification code https://evil.example/login",
    },
    expected: "hold",
  },
  {
    id: "N3 Supply your OTP",
    input: {
      from: "Suporte MepMail <suporte@mepmail.dev>",
      subject: "Re: Elozi internal receive check 20261106-GMAIL-02",
      text: "Confirmação interna da integração Elozi 0.72.5. Rascunho de validação para a própria conta, sem atendimento de terceiros. ELOZI-NATIVE-0725-20261106-01.\nSuporte MepMail https://mepmail.dev\nStop all Azure-delivered messages from this team (including service messages): Unsubscribe https://optout.synthetic.invalid/unsubscribe\nSupply your OTP https://evil.example/login",
    },
    expected: "hold",
  },
  {
    id: "N3 Type your security code",
    input: {
      from: "Suporte MepMail <suporte@mepmail.dev>",
      subject: "Re: Elozi internal receive check 20261106-GMAIL-02",
      text: "Confirmação interna da integração Elozi 0.72.5. Rascunho de validação para a própria conta, sem atendimento de terceiros. ELOZI-NATIVE-0725-20261106-01.\nSuporte MepMail https://mepmail.dev\nStop all Azure-delivered messages from this team (including service messages): Unsubscribe https://optout.synthetic.invalid/unsubscribe\nType your security code https://evil.example/login",
    },
    expected: "hold",
  },
  {
    id: "N3 Send your one-time code",
    input: {
      from: "Suporte MepMail <suporte@mepmail.dev>",
      subject: "Re: Elozi internal receive check 20261106-GMAIL-02",
      text: "Confirmação interna da integração Elozi 0.72.5. Rascunho de validação para a própria conta, sem atendimento de terceiros. ELOZI-NATIVE-0725-20261106-01.\nSuporte MepMail https://mepmail.dev\nStop all Azure-delivered messages from this team (including service messages): Unsubscribe https://optout.synthetic.invalid/unsubscribe\nSend your one-time code https://evil.example/login",
    },
    expected: "hold",
  },
  {
    id: "N3 Use your credentials",
    input: {
      from: "Suporte MepMail <suporte@mepmail.dev>",
      subject: "Re: Elozi internal receive check 20261106-GMAIL-02",
      text: "Confirmação interna da integração Elozi 0.72.5. Rascunho de validação para a própria conta, sem atendimento de terceiros. ELOZI-NATIVE-0725-20261106-01.\nSuporte MepMail https://mepmail.dev\nStop all Azure-delivered messages from this team (including service messages): Unsubscribe https://optout.synthetic.invalid/unsubscribe\nUse your credentials https://evil.example/login",
    },
    expected: "hold",
  },
  {
    id: "N4 mixed destinations evil.example",
    input: {
      from: "Suporte MepMail <suporte@mepmail.dev>",
      subject: "Re: Elozi internal receive check 20261106-GMAIL-02",
      text: "Confirmação interna da integração Elozi 0.72.5. Rascunho de validação para a própria conta, sem atendimento de terceiros. ELOZI-NATIVE-0725-20261106-01.\nSuporte MepMail https://mepmail.dev\nStop all Azure-delivered messages from this team (including service messages): Unsubscribe https://optout.synthetic.invalid/unsubscribe",
      html: '<p>Gmail: verify your account</p><a href="https://accounts.google.com">Account</a><a href="https://evil.example/login">Continue</a>',
    },
    expected: "hold",
  },
  {
    id: "N4 mixed destinations accounts.google.com.evil.example",
    input: {
      from: "Suporte MepMail <suporte@mepmail.dev>",
      subject: "Re: Elozi internal receive check 20261106-GMAIL-02",
      text: "Confirmação interna da integração Elozi 0.72.5. Rascunho de validação para a própria conta, sem atendimento de terceiros. ELOZI-NATIVE-0725-20261106-01.\nSuporte MepMail https://mepmail.dev\nStop all Azure-delivered messages from this team (including service messages): Unsubscribe https://optout.synthetic.invalid/unsubscribe",
      html: '<p>Gmail: verify your account</p><a href="https://accounts.google.com">Account</a><a href="https://accounts.google.com.evil.example/login">Continue</a>',
    },
    expected: "hold",
  },
  {
    id: "N4 mixed destinations evilgoogle.com",
    input: {
      from: "Suporte MepMail <suporte@mepmail.dev>",
      subject: "Re: Elozi internal receive check 20261106-GMAIL-02",
      text: "Confirmação interna da integração Elozi 0.72.5. Rascunho de validação para a própria conta, sem atendimento de terceiros. ELOZI-NATIVE-0725-20261106-01.\nSuporte MepMail https://mepmail.dev\nStop all Azure-delivered messages from this team (including service messages): Unsubscribe https://optout.synthetic.invalid/unsubscribe",
      html: '<p>Gmail: verify your account</p><a href="https://accounts.google.com">Account</a><a href="https://evilgoogle.com/login">Continue</a>',
    },
    expected: "hold",
  },
  {
    id: "N5 folding Gm<span>ail</span>",
    input: {
      from: "Suporte MepMail <suporte@mepmail.dev>",
      subject: "Re: Elozi internal receive check 20261106-GMAIL-02",
      text: "Confirmação interna da integração Elozi 0.72.5. Rascunho de validação para a própria conta, sem atendimento de terceiros. ELOZI-NATIVE-0725-20261106-01.\nSuporte MepMail https://mepmail.dev\nStop all Azure-delivered messages from this team (including service messages): Unsubscribe https://optout.synthetic.invalid/unsubscribe",
      html: '<p>Gm<span>ail</span>: verify your account</p><a href="https&#58;//evil.example/login">Confirm</a>',
    },
    expected: "hold",
  },
  {
    id: "N5 folding Gm&#97;il",
    input: {
      from: "Suporte MepMail <suporte@mepmail.dev>",
      subject: "Re: Elozi internal receive check 20261106-GMAIL-02",
      text: "Confirmação interna da integração Elozi 0.72.5. Rascunho de validação para a própria conta, sem atendimento de terceiros. ELOZI-NATIVE-0725-20261106-01.\nSuporte MepMail https://mepmail.dev\nStop all Azure-delivered messages from this team (including service messages): Unsubscribe https://optout.synthetic.invalid/unsubscribe",
      html: '<p>Gm&#97;il: verify your account</p><a href="https&#58;//evil.example/login">Confirm</a>',
    },
    expected: "hold",
  },
  {
    id: "N5 folding Gm​ail",
    input: {
      from: "Suporte MepMail <suporte@mepmail.dev>",
      subject: "Re: Elozi internal receive check 20261106-GMAIL-02",
      text: "Confirmação interna da integração Elozi 0.72.5. Rascunho de validação para a própria conta, sem atendimento de terceiros. ELOZI-NATIVE-0725-20261106-01.\nSuporte MepMail https://mepmail.dev\nStop all Azure-delivered messages from this team (including service messages): Unsubscribe https://optout.synthetic.invalid/unsubscribe",
      html: '<p>Gm​ail: verify your account</p><a href="https&#58;//evil.example/login">Confirm</a>',
    },
    expected: "hold",
  },
  {
    id: "N5 folding Ｇｍａｉｌ",
    input: {
      from: "Suporte MepMail <suporte@mepmail.dev>",
      subject: "Re: Elozi internal receive check 20261106-GMAIL-02",
      text: "Confirmação interna da integração Elozi 0.72.5. Rascunho de validação para a própria conta, sem atendimento de terceiros. ELOZI-NATIVE-0725-20261106-01.\nSuporte MepMail https://mepmail.dev\nStop all Azure-delivered messages from this team (including service messages): Unsubscribe https://optout.synthetic.invalid/unsubscribe",
      html: '<p>Ｇｍａｉｌ: verify your account</p><a href="https&#58;//evil.example/login">Confirm</a>',
    },
    expected: "hold",
  },
  {
    id: "N5 folding Gmаil",
    input: {
      from: "Suporte MepMail <suporte@mepmail.dev>",
      subject: "Re: Elozi internal receive check 20261106-GMAIL-02",
      text: "Confirmação interna da integração Elozi 0.72.5. Rascunho de validação para a própria conta, sem atendimento de terceiros. ELOZI-NATIVE-0725-20261106-01.\nSuporte MepMail https://mepmail.dev\nStop all Azure-delivered messages from this team (including service messages): Unsubscribe https://optout.synthetic.invalid/unsubscribe",
      html: '<p>Gmаil: verify your account</p><a href="https&#58;//evil.example/login">Confirm</a>',
    },
    expected: "hold",
  },
  {
    id: "N6 fake footer no exemption",
    input: {
      from: "Suporte MepMail <suporte@mepmail.dev>",
      subject: "Re: Elozi internal receive check 20261106-GMAIL-02",
      text: "Confirmação interna da integração Elozi 0.72.5. Rascunho de validação para a própria conta, sem atendimento de terceiros. ELOZI-NATIVE-0725-20261106-01.\nSuporte MepMail https://mepmail.dev\nStop all Azure-delivered messages from this team (including service messages): Unsubscribe https://optout.synthetic.invalid/unsubscribe",
      html: '<p>Gmail: verify your account</p><a href="https://evil.example/login">Unsubscribe MepMail</a>',
    },
    expected: "hold",
  },
  {
    id: "N7 flags {'approvalKind': 'human'}",
    input: {
      from: "Suporte MepMail <suporte@mepmail.dev>",
      subject: "Re: Elozi internal receive check 20261106-GMAIL-02",
      text: "Confirmação interna da integração Elozi 0.72.5. Rascunho de validação para a própria conta, sem atendimento de terceiros. ELOZI-NATIVE-0725-20261106-01.\nSuporte MepMail https://mepmail.dev\nStop all Azure-delivered messages from this team (including service messages): Unsubscribe https://optout.synthetic.invalid/unsubscribe Gmail: verify your account https://evil.example/login",
      approvalKind: "human",
    },
    expected: "hold",
  },
  {
    id: "N7 flags {'marketing': False, 'system': True}",
    input: {
      from: "Suporte MepMail <suporte@mepmail.dev>",
      subject: "Re: Elozi internal receive check 20261106-GMAIL-02",
      text: "Confirmação interna da integração Elozi 0.72.5. Rascunho de validação para a própria conta, sem atendimento de terceiros. ELOZI-NATIVE-0725-20261106-01.\nSuporte MepMail https://mepmail.dev\nStop all Azure-delivered messages from this team (including service messages): Unsubscribe https://optout.synthetic.invalid/unsubscribe Gmail: verify your account https://evil.example/login",
      marketing: false,
      system: true,
    },
    expected: "hold",
  },
  {
    id: "N7 flags {'reviewed': True}",
    input: {
      from: "Suporte MepMail <suporte@mepmail.dev>",
      subject: "Re: Elozi internal receive check 20261106-GMAIL-02",
      text: "Confirmação interna da integração Elozi 0.72.5. Rascunho de validação para a própria conta, sem atendimento de terceiros. ELOZI-NATIVE-0725-20261106-01.\nSuporte MepMail https://mepmail.dev\nStop all Azure-delivered messages from this team (including service messages): Unsubscribe https://optout.synthetic.invalid/unsubscribe Gmail: verify your account https://evil.example/login",
      reviewed: true,
    },
    expected: "hold",
  },
  {
    id: "N8 conservative nominal Gmail. Confirmation. Your account https://evil.example",
    input: {
      from: "Suporte MepMail <suporte@mepmail.dev>",
      subject: "Re: Elozi internal receive check 20261106-GMAIL-02",
      text: "Gmail. Confirmation. Your account https://evil.example",
    },
    expected: "hold",
  },
  {
    id: "N8 conservative nominal Gmail. Confirmation of your account https://evil.example",
    input: {
      from: "Suporte MepMail <suporte@mepmail.dev>",
      subject: "Re: Elozi internal receive check 20261106-GMAIL-02",
      text: "Gmail. Confirmation of your account https://evil.example",
    },
    expected: "hold",
  },
  {
    id: "N8 conservative nominal Gmail. Internal confirmation of your account https://evil.example",
    input: {
      from: "Suporte MepMail <suporte@mepmail.dev>",
      subject: "Re: Elozi internal receive check 20261106-GMAIL-02",
      text: "Gmail. Internal confirmation of your account https://evil.example",
    },
    expected: "hold",
  },
  {
    id: "N8 conservative nominal Google account. Confirmação interna https://evil.example",
    input: {
      from: "Suporte MepMail <suporte@mepmail.dev>",
      subject: "Re: Elozi internal receive check 20261106-GMAIL-02",
      text: "Google account. Confirmação interna https://evil.example",
    },
    expected: "hold",
  },
  {
    id: "N8 conservative nominal Gmail: Confirmação interna da integração. Sua conta https://evil.example",
    input: {
      from: "Suporte MepMail <suporte@mepmail.dev>",
      subject: "Re: Elozi internal receive check 20261106-GMAIL-02",
      text: "Gmail: Confirmação interna da integração. Sua conta https://evil.example",
    },
    expected: "hold",
  },
] as const;

for (const { id, input, expected } of cases) {
  it(id, () => {
    expect(evaluatePreSendContent(input).action).toBe(expected);
  });
}
