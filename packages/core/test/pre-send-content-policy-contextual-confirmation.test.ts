import { expect, it } from "vitest";
import { evaluatePreSendContent } from "../src/pre-send-content-policy.js";

// A nominal informational preface must not suppress an independent account/navigation request.
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
  {
    id: "P1 frozen PT access text",
    input: {
      from: "Orbit <support@orbit.invalid>",
      subject: "Gmail",
      text: "Confirmação interna. Acesse sua conta em https://evil.example/access",
    },
    expected: "hold",
  },
  {
    id: "P1 frozen PT access HTML",
    input: {
      from: "Orbit <support@orbit.invalid>",
      subject: "Gmail",
      html: '<p>Confirmação interna.</p><p>Acesse sua conta em <a href="https://evil.example/access">portal</a></p>',
    },
    expected: "hold",
  },
  {
    id: "P1 frozen EN access text",
    input: {
      from: "Orbit <support@orbit.invalid>",
      subject: "Gmail",
      text: "Confirmação interna. Access your account at https://evil.example/access",
    },
    expected: "hold",
  },
  {
    id: "P1 frozen EN access HTML",
    input: {
      from: "Orbit <support@orbit.invalid>",
      subject: "Gmail",
      html: '<p>Confirmação interna.</p><p>Access your account at <a href="https://evil.example/access">portal</a></p>',
    },
    expected: "hold",
  },
  {
    id: "P1 frozen PT visit text",
    input: {
      from: "Orbit <support@orbit.invalid>",
      subject: "Gmail",
      text: "Confirmação interna. Visite o portal da sua conta em https://evil.example/access",
    },
    expected: "hold",
  },
  {
    id: "P1 frozen PT visit HTML",
    input: {
      from: "Orbit <support@orbit.invalid>",
      subject: "Gmail",
      html: '<p>Confirmação interna.</p><p>Visite o portal da sua conta em <a href="https://evil.example/access">portal</a></p>',
    },
    expected: "hold",
  },
  {
    id: "Critic exact benign canary",
    input: {
      from: "Suporte MepMail <suporte@mepmail.dev>",
      subject: "Re: Elozi internal receive check 20261106-GMAIL-02",
      text: "Confirmação interna da integração Elozi 0.72.5. Rascunho de validação para a própria conta, sem atendimento de terceiros. ELOZI-NATIVE-0725-20261106-01.\nSuporte MepMail https://mepmail.dev\nStop all Azure-delivered messages from this team (including service messages): Unsubscribe https://optout.synthetic.invalid/unsubscribe",
    },
    expected: "allow",
  },
  {
    id: "Critic verify across sentences",
    input: {
      from: "Orbit <support@orbit.invalid>",
      subject: "Gmail",
      text: "Confirmação interna. Verify your account https://evil.example",
    },
    expected: "hold",
  },
  {
    id: "Critic protected ownership",
    input: {
      from: "Orbit <support@orbit.invalid>",
      subject: "Gmail",
      text: "Confirmação interna. Access your Google account https://evil.example",
    },
    expected: "hold",
  },
  {
    id: "Critic credential request",
    input: {
      from: "Orbit <support@orbit.invalid>",
      subject: "Gmail",
      text: "Confirmação interna. Enter your password https://evil.example",
    },
    expected: "hold",
  },
  {
    id: "Critic OTP request",
    input: {
      from: "Orbit <support@orbit.invalid>",
      subject: "Gmail",
      text: "Confirmação interna. Supply your OTP https://evil.example",
    },
    expected: "hold",
  },
  {
    id: "Critic pressure",
    input: {
      from: "Orbit <support@orbit.invalid>",
      subject: "Gmail",
      text: "Confirmação interna. Urgent. Access your account https://evil.example",
    },
    expected: "hold",
  },
  {
    id: "Critic colon binding",
    input: {
      from: "Orbit <support@orbit.invalid>",
      subject: "QA",
      text: "Gmail: Confirmação interna. Sua conta https://evil.example",
    },
    expected: "hold",
  },
  {
    id: "Critic generic confirmation",
    input: {
      from: "Orbit <support@orbit.invalid>",
      subject: "Gmail",
      text: "Account confirmation. Access your account https://evil.example",
    },
    expected: "hold",
  },
  {
    id: "Critic mixed links",
    input: {
      from: "Orbit <support@orbit.invalid>",
      subject: "Gmail",
      html: '<p>Confirmação interna. Verify your account</p><a href="https://accounts.google.com">Official</a><a href="https://accounts.google.com.evil.example">Other</a>',
    },
    expected: "hold",
  },
  {
    id: "Critic entity verify",
    input: {
      from: "Orbit <support@orbit.invalid>",
      subject: "Gmail",
      html: '<p>Confirmação interna. Ver&#105;fy your account</p><a href="https&#58;//evil.example">Access</a>',
    },
    expected: "hold",
  },
  {
    id: "Critic unicode verify",
    input: {
      from: "Orbit <support@orbit.invalid>",
      subject: "Ｇｍａｉｌ",
      text: "Confirmação interna. Verify your account https://evil.example",
    },
    expected: "hold",
  },
  {
    id: "Critic fake footer",
    input: {
      from: "Orbit <support@orbit.invalid>",
      subject: "Gmail",
      text: "Confirmação interna. Verify your account https://evil.example Unsubscribe MepMail",
      approvalKind: "human",
      system: true,
      reviewed: true,
    },
    expected: "hold",
  },
  {
    id: "Critic split nominal account",
    input: {
      from: "Orbit <support@orbit.invalid>",
      subject: "Gmail",
      text: "Internal confirmation of your account. https://evil.example",
    },
    expected: "hold",
  },
  {
    id: "Critic own service informational",
    input: {
      from: "Orbit <support@orbit.invalid>",
      subject: "Gmail receive check",
      text: "Confirmação interna da integração Orbit. A conta do serviço Orbit está em validação interna. https://orbit.invalid",
    },
    expected: "allow",
  },
  {
    id: "P1 structural Explore your account text",
    input: {
      from: "Orbit <support@orbit.invalid>",
      subject: "Gmail",
      text: "Confirmação interna. Explore your account https://evil.example/access",
    },
    expected: "hold",
  },
  {
    id: "P1 structural Explore your account html",
    input: {
      from: "Orbit <support@orbit.invalid>",
      subject: "Gmail",
      html: '<p>Confirmação interna.</p><p><a href="https://evil.example/access">Explore your account</a></p>',
    },
    expected: "hold",
  },
  {
    id: "P1 structural Navegue até sua conta text",
    input: {
      from: "Orbit <support@orbit.invalid>",
      subject: "Gmail",
      text: "Confirmação interna. Navegue até sua conta https://evil.example/access",
    },
    expected: "hold",
  },
  {
    id: "P1 structural Navegue até sua conta html",
    input: {
      from: "Orbit <support@orbit.invalid>",
      subject: "Gmail",
      html: '<p>Confirmação interna.</p><p><a href="https://evil.example/access">Navegue até sua conta</a></p>',
    },
    expected: "hold",
  },
  {
    id: "P1 structural Your account text",
    input: {
      from: "Orbit <support@orbit.invalid>",
      subject: "Gmail",
      text: "Confirmação interna. Your account https://evil.example/access",
    },
    expected: "hold",
  },
  {
    id: "P1 structural Your account html",
    input: {
      from: "Orbit <support@orbit.invalid>",
      subject: "Gmail",
      html: '<p>Confirmação interna.</p><p><a href="https://evil.example/access">Your account</a></p>',
    },
    expected: "hold",
  },
  {
    id: "P1 structural Sua conta text",
    input: {
      from: "Orbit <support@orbit.invalid>",
      subject: "Gmail",
      text: "Confirmação interna. Sua conta https://evil.example/access",
    },
    expected: "hold",
  },
  {
    id: "P1 structural Sua conta html",
    input: {
      from: "Orbit <support@orbit.invalid>",
      subject: "Gmail",
      html: '<p>Confirmação interna.</p><p><a href="https://evil.example/access">Sua conta</a></p>',
    },
    expected: "hold",
  },
  {
    id: "P1 structural Teleport your account text",
    input: {
      from: "Orbit <support@orbit.invalid>",
      subject: "Gmail",
      text: "Confirmação interna. Teleport your account https://evil.example/access",
    },
    expected: "hold",
  },
  {
    id: "P1 structural Teleport your account html",
    input: {
      from: "Orbit <support@orbit.invalid>",
      subject: "Gmail",
      html: '<p>Confirmação interna.</p><p><a href="https://evil.example/access">Teleport your account</a></p>',
    },
    expected: "hold",
  },
  {
    id: "P1 canary appended text",
    input: {
      from: "Suporte MepMail <suporte@mepmail.dev>",
      subject: "Re: Elozi internal receive check 20261106-GMAIL-02",
      text: "Confirmação interna da integração Elozi 0.72.5. Rascunho de validação para a própria conta, sem atendimento de terceiros. ELOZI-NATIVE-0725-20261106-01.\nSuporte MepMail https://mepmail.dev\nStop all Azure-delivered messages from this team (including service messages): Unsubscribe https://optout.synthetic.invalid/unsubscribe\n\nNavegue até sua conta https://evil.example/access",
    },
    expected: "hold",
  },
  {
    id: "P1 canary appended html",
    input: {
      from: "Suporte MepMail <suporte@mepmail.dev>",
      subject: "Re: Elozi internal receive check 20261106-GMAIL-02",
      html: '<p>Confirmação interna da integração Elozi 0.72.5. Rascunho de validação para a própria conta, sem atendimento de terceiros. ELOZI-NATIVE-0725-20261106-01.</p><p>Suporte MepMail https://mepmail.dev</p><p>Stop all Azure-delivered messages from this team (including service messages): Unsubscribe https://optout.synthetic.invalid/unsubscribe</p><a href="https://mepmail.dev">Suporte MepMail</a><p><a href="https://evil.example/access">Portal da sua conta</a></p>',
    },
    expected: "hold",
  },
  {
    id: "P1 cross field",
    input: {
      from: "Orbit <support@orbit.invalid>",
      subject: "Gmail — your account",
      text: "Confirmação interna. https://evil.example/access",
    },
    expected: "hold",
  },
  {
    id: "P1 cross multipart",
    input: {
      from: "Orbit <support@orbit.invalid>",
      subject: "Gmail",
      text: "Confirmação interna da integração Elozi 0.72.5. Rascunho de validação para a própria conta, sem atendimento de terceiros. ELOZI-NATIVE-0725-20261106-01.\nSuporte MepMail https://mepmail.dev\nStop all Azure-delivered messages from this team (including service messages): Unsubscribe https://optout.synthetic.invalid/unsubscribe",
      html: '<p><a href="https://evil.example/access">Your account</a></p>',
    },
    expected: "hold",
  },
  {
    id: "P1 appended no punctuation",
    input: {
      from: "Orbit <support@orbit.invalid>",
      subject: "Gmail",
      text: "Confirmação interna. Rascunho de validação para a própria conta Teleport your account https://evil.example/access",
    },
    expected: "hold",
  },
  {
    id: "PARENT PT-access-after-informational-account-clause",
    input: {
      from: "Suporte MepMail <suporte@mepmail.dev>",
      subject: "Re: Elozi internal receive check 20261106-GMAIL-02",
      text: "Confirmação interna da integração Elozi 0.72.5. Rascunho de validação para a própria conta, sem atendimento de terceiros. ELOZI-NATIVE-0725-20261106-01.\nSuporte MepMail https://mepmail.dev\nStop all Azure-delivered messages from this team (including service messages): Unsubscribe https://optout.synthetic.invalid/unsubscribe\n\nAcesse o portal em https://evil.example/access",
    },
    expected: "hold",
  },
  {
    id: "PARENT EN-access-after-informational-account-clause",
    input: {
      from: "Suporte MepMail <suporte@mepmail.dev>",
      subject: "Re: Elozi internal receive check 20261106-GMAIL-02",
      text: "Confirmação interna da integração Elozi 0.72.5. Rascunho de validação para a própria conta, sem atendimento de terceiros. ELOZI-NATIVE-0725-20261106-01.\nSuporte MepMail https://mepmail.dev\nStop all Azure-delivered messages from this team (including service messages): Unsubscribe https://optout.synthetic.invalid/unsubscribe\n\nAccess the portal at https://evil.example/access",
    },
    expected: "hold",
  },
  {
    id: "PARENT PT-visit-after-informational-account-clause",
    input: {
      from: "Suporte MepMail <suporte@mepmail.dev>",
      subject: "Re: Elozi internal receive check 20261106-GMAIL-02",
      text: "Confirmação interna da integração Elozi 0.72.5. Rascunho de validação para a própria conta, sem atendimento de terceiros. ELOZI-NATIVE-0725-20261106-01.\nSuporte MepMail https://mepmail.dev\nStop all Azure-delivered messages from this team (including service messages): Unsubscribe https://optout.synthetic.invalid/unsubscribe\n\nVisite o portal em https://evil.example/access",
    },
    expected: "hold",
  },
  {
    id: "PARENT PT-access-HTML-after-informational-account-clause",
    input: {
      from: "Suporte MepMail <suporte@mepmail.dev>",
      subject: "Re: Elozi internal receive check 20261106-GMAIL-02",
      html: '<p>Confirmação interna da integração Elozi 0.72.5. Rascunho de validação para a própria conta, sem atendimento de terceiros. ELOZI-NATIVE-0725-20261106-01.</p><p>Suporte MepMail https://mepmail.dev</p><p>Stop all Azure-delivered messages from this team (including service messages): Unsubscribe https://optout.synthetic.invalid/unsubscribe</p><a href="https://mepmail.dev">Suporte MepMail</a><p>Acesse o portal em <a href="https://evil.example/access">portal</a></p>',
    },
    expected: "hold",
  },
  {
    id: "PARENT unknown-verb-resource-PT",
    input: {
      from: "Suporte MepMail <suporte@mepmail.dev>",
      subject: "Re: Elozi internal receive check 20261106-GMAIL-02",
      text: "Confirmação interna da integração Elozi 0.72.5. Rascunho de validação para a própria conta, sem atendimento de terceiros. ELOZI-NATIVE-0725-20261106-01.\nSuporte MepMail https://mepmail.dev\nStop all Azure-delivered messages from this team (including service messages): Unsubscribe https://optout.synthetic.invalid/unsubscribe\n\nDirija-se ao portal em https://evil.example",
    },
    expected: "hold",
  },
  {
    id: "PARENT unknown-verb-resource-EN",
    input: {
      from: "Suporte MepMail <suporte@mepmail.dev>",
      subject: "Re: Elozi internal receive check 20261106-GMAIL-02",
      text: "Confirmação interna da integração Elozi 0.72.5. Rascunho de validação para a própria conta, sem atendimento de terceiros. ELOZI-NATIVE-0725-20261106-01.\nSuporte MepMail https://mepmail.dev\nStop all Azure-delivered messages from this team (including service messages): Unsubscribe https://optout.synthetic.invalid/unsubscribe\n\nProceed to the dashboard at https://evil.example",
    },
    expected: "hold",
  },
] as const;

for (const c of cases) {
  it(c.id, () => expect(evaluatePreSendContent(c.input).action).toBe(c.expected));
}
