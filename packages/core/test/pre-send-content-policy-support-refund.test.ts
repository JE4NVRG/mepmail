import { expect, it as test } from "vitest";
import { evaluatePreSendContent } from "../src/pre-send-content-policy.js";

const cases = [
  [
    "support plain",
    "Refund confirmation",
    {
      text: "We use Microsoft as an email delivery supplier. Your MepMail account and data remain intact. Your payment has been refunded. Contact MepMail support if you need help. https://mepmail.dev",
    },
    "allow",
  ],
  [
    "support html",
    "Refund confirmation",
    {
      html: '<p>We use Micro<span>soft</span> as an email delivery supplier.</p><p>Your MepMail account and data remain intact.</p><p>Your payment has been refunded.</p><a href="https://mepmail.dev">Contact MepMail support</a>',
    },
    "allow",
  ],
  [
    "Microsoft original lure",
    "Notice",
    {
      html: '<p>Microsoft: verify your account and update payment</p><a href="https://outside.example/login">Continue</a>',
    },
    "hold",
  ],
  [
    "Google original lure",
    "Notice",
    {
      html: '<p>Google: verify your account and update payment</p><a href="https://outside.example/login">Continue</a>',
    },
    "hold",
  ],
  [
    "PayPal original lure",
    "Notice",
    {
      html: '<p>PayPal: verify your account and update payment</p><a href="https://outside.example/login">Continue</a>',
    },
    "hold",
  ],
  [
    "Apple original lure",
    "Notice",
    {
      html: '<p>Apple: verify your account and update payment</p><a href="https://outside.example/login">Continue</a>',
    },
    "hold",
  ],
  [
    "Spotify original lure",
    "Notice",
    {
      html: '<p>Spotify: verify your account and update payment</p><a href="https://outside.example/login">Continue</a>',
    },
    "hold",
  ],
  [
    "Netflix original lure",
    "Notice",
    {
      html: '<p>Netflix: verify your account and update payment</p><a href="https://outside.example/login">Continue</a>',
    },
    "hold",
  ],
  [
    "Nubank original lure",
    "Notice",
    {
      html: '<p>Nubank: verify your account and update payment</p><a href="https://outside.example/login">Continue</a>',
    },
    "hold",
  ],
  [
    "Banco do Brasil original lure",
    "Notice",
    {
      html: '<p>Banco do Brasil: verify your account and update payment</p><a href="https://outside.example/login">Continue</a>',
    },
    "hold",
  ],
  [
    "Bank of America original lure",
    "Notice",
    {
      html: '<p>Bank of America: verify your account and update payment</p><a href="https://outside.example/login">Continue</a>',
    },
    "hold",
  ],
  [
    "PаyPal original lure",
    "Notice",
    {
      html: '<p>PаyPal: verify your account and update payment</p><a href="https://outside.example/login">Continue</a>',
    },
    "hold",
  ],
  [
    "Ａｐｐｌｅ original lure",
    "Notice",
    {
      html: '<p>Ａｐｐｌｅ: verify your account and update payment</p><a href="https://outside.example/login">Continue</a>',
    },
    "hold",
  ],
  [
    "Spoti​fy original lure",
    "Notice",
    {
      html: '<p>Spoti​fy: verify your account and update payment</p><a href="https://outside.example/login">Continue</a>',
    },
    "hold",
  ],
  [
    "Microsoft preface",
    "Refund confirmation",
    {
      text: "We use Microsoft as an email delivery supplier.\nVerify your Microsoft account and password at https://outside.example/login",
    },
    "hold",
  ],
  [
    "Microsoft multiline",
    "Refund confirmation",
    {
      text: "We use Microsoft.\nMicrosoft\naccount\nVerify your password\nhttps://outside.example/login",
    },
    "hold",
  ],
  [
    "Microsoft payment",
    "Refund confirmation",
    {
      text: "We use Microsoft. Your Microsoft payment failed. Update your card: https://outside.example/pay",
    },
    "hold",
  ],
  [
    "Microsoft hidden-label",
    "Refund confirmation",
    {
      html: '<p>We use Microsoft as a supplier.</p><p>Verify your Microsoft account.</p><a href="https://outside.example/login">https://microsoft.com/login</a>',
    },
    "hold",
  ],
  [
    "Microsoft nominal-body",
    "Refund confirmation",
    { text: "We use Microsoft. Account confirmation: https://outside.example/login" },
    "hold",
  ],
  [
    "Microsoft nominal subject",
    "Microsoft account confirmation",
    { text: "Continue: https://outside.example/login" },
    "hold",
  ],
  [
    "Google preface",
    "Refund confirmation",
    {
      text: "We use Google as an email delivery supplier.\nVerify your Google account and password at https://outside.example/login",
    },
    "hold",
  ],
  [
    "Google multiline",
    "Refund confirmation",
    {
      text: "We use Google.\nGoogle\naccount\nVerify your password\nhttps://outside.example/login",
    },
    "hold",
  ],
  [
    "Google payment",
    "Refund confirmation",
    {
      text: "We use Google. Your Google payment failed. Update your card: https://outside.example/pay",
    },
    "hold",
  ],
  [
    "Google hidden-label",
    "Refund confirmation",
    {
      html: '<p>We use Google as a supplier.</p><p>Verify your Google account.</p><a href="https://outside.example/login">https://google.com/login</a>',
    },
    "hold",
  ],
  [
    "Google nominal-body",
    "Refund confirmation",
    { text: "We use Google. Account confirmation: https://outside.example/login" },
    "hold",
  ],
  [
    "Google nominal subject",
    "Google account confirmation",
    { text: "Continue: https://outside.example/login" },
    "hold",
  ],
  [
    "PayPal preface",
    "Refund confirmation",
    {
      text: "We use PayPal as an email delivery supplier.\nVerify your PayPal account and password at https://outside.example/login",
    },
    "hold",
  ],
  [
    "PayPal multiline",
    "Refund confirmation",
    {
      text: "We use PayPal.\nPayPal\naccount\nVerify your password\nhttps://outside.example/login",
    },
    "hold",
  ],
  [
    "PayPal payment",
    "Refund confirmation",
    {
      text: "We use PayPal. Your PayPal payment failed. Update your card: https://outside.example/pay",
    },
    "hold",
  ],
  [
    "PayPal hidden-label",
    "Refund confirmation",
    {
      html: '<p>We use PayPal as a supplier.</p><p>Verify your PayPal account.</p><a href="https://outside.example/login">https://paypal.com/login</a>',
    },
    "hold",
  ],
  [
    "PayPal nominal-body",
    "Refund confirmation",
    { text: "We use PayPal. Account confirmation: https://outside.example/login" },
    "hold",
  ],
  [
    "PayPal nominal subject",
    "PayPal account confirmation",
    { text: "Continue: https://outside.example/login" },
    "hold",
  ],
  [
    "aligned link",
    "Notice",
    { text: "Microsoft verify your account at https://microsoft.com/account" },
    "allow",
  ],
  [
    "subdomain spoof",
    "Notice",
    { text: "Microsoft verify your account at https://microsoft.com.outside.example/account" },
    "hold",
  ],
  [
    "own password reset",
    "MepMail password reset",
    { text: "Reset your password at https://mepmail.dev/reset" },
    "allow",
  ],
  ["benign mention", "News", { text: "Microsoft product news https://news.example" }, "allow"],
  [
    "body confirms account",
    "Refund confirmation",
    { text: "We use Microsoft. Confirm your account: https://outside.example" },
    "hold",
  ],
  [
    "subject action",
    "Verify account",
    { text: "We use Microsoft. Your account https://outside.example" },
    "hold",
  ],
  [
    "confirmation required",
    "Confirmation required",
    { text: "Your Microsoft account requires immediate action: https://outside.example/login" },
    "hold",
  ],
  [
    "payment required",
    "Microsoft payment required",
    { text: "Your Microsoft account requires payment: https://outside.example/billing" },
    "hold",
  ],
  [
    "HTML payment required",
    "Notice",
    {
      html: '<p>Microsoft account: payment required</p><a href="https://outside.example/billing">Continue</a>',
    },
    "hold",
  ],
  [
    "Microsoft demand payment required",
    "Notice",
    {
      text: "We use Microsoft as a delivery supplier.\nYour Microsoft account: payment required. https://outside.example/billing",
    },
    "hold",
  ],
  [
    "Microsoft demand payment due",
    "Notice",
    {
      text: "We use Microsoft as a delivery supplier.\nYour Microsoft account: payment due. https://outside.example/billing",
    },
    "hold",
  ],
  [
    "Microsoft demand payment overdue",
    "Notice",
    {
      text: "We use Microsoft as a delivery supplier.\nYour Microsoft account: payment overdue. https://outside.example/billing",
    },
    "hold",
  ],
  [
    "Microsoft demand payment is required",
    "Notice",
    {
      text: "We use Microsoft as a delivery supplier.\nYour Microsoft account: payment is required. https://outside.example/billing",
    },
    "hold",
  ],
  [
    "Microsoft demand payment is due",
    "Notice",
    {
      text: "We use Microsoft as a delivery supplier.\nYour Microsoft account: payment is due. https://outside.example/billing",
    },
    "hold",
  ],
  [
    "Microsoft demand requires payment",
    "Notice",
    {
      text: "We use Microsoft as a delivery supplier.\nYour Microsoft account: requires payment. https://outside.example/billing",
    },
    "hold",
  ],
  [
    "Microsoft demand require a payment",
    "Notice",
    {
      text: "We use Microsoft as a delivery supplier.\nYour Microsoft account: require a payment. https://outside.example/billing",
    },
    "hold",
  ],
  [
    "Microsoft pressure Urgent refund confirmation",
    "Urgent refund confirmation",
    {
      text: "We use Microsoft as a delivery supplier. Your Microsoft account https://outside.example/login",
    },
    "hold",
  ],
  [
    "Microsoft pressure Refund confirmation required",
    "Refund confirmation required",
    {
      text: "We use Microsoft as a delivery supplier. Your Microsoft account https://outside.example/login",
    },
    "hold",
  ],
  [
    "Microsoft pressure Refund confirmation due",
    "Refund confirmation due",
    {
      text: "We use Microsoft as a delivery supplier. Your Microsoft account https://outside.example/login",
    },
    "hold",
  ],
  [
    "Microsoft pressure Immediate order confirmation",
    "Immediate order confirmation",
    {
      text: "We use Microsoft as a delivery supplier. Your Microsoft account https://outside.example/login",
    },
    "hold",
  ],
  [
    "Microsoft pressure Confirmation required",
    "Confirmation required",
    {
      text: "We use Microsoft as a delivery supplier. Your Microsoft account https://outside.example/login",
    },
    "hold",
  ],
  [
    "Microsoft receipt title with body pressure",
    "Refund confirmation",
    {
      text: "We use Microsoft. Your Microsoft account requires immediate action: https://outside.example/login",
    },
    "hold",
  ],
  [
    "Microsoft HTML prefaced demand",
    "Refund confirmation",
    {
      html: '<p>We use Microsoft as a supplier.</p><p>Microsoft account: payment due</p><a href="https://outside.example/billing">Continue</a>',
    },
    "hold",
  ],
  [
    "Google demand payment required",
    "Notice",
    {
      text: "We use Google as a delivery supplier.\nYour Google account: payment required. https://outside.example/billing",
    },
    "hold",
  ],
  [
    "Google demand payment due",
    "Notice",
    {
      text: "We use Google as a delivery supplier.\nYour Google account: payment due. https://outside.example/billing",
    },
    "hold",
  ],
  [
    "Google demand payment overdue",
    "Notice",
    {
      text: "We use Google as a delivery supplier.\nYour Google account: payment overdue. https://outside.example/billing",
    },
    "hold",
  ],
  [
    "Google demand payment is required",
    "Notice",
    {
      text: "We use Google as a delivery supplier.\nYour Google account: payment is required. https://outside.example/billing",
    },
    "hold",
  ],
  [
    "Google demand payment is due",
    "Notice",
    {
      text: "We use Google as a delivery supplier.\nYour Google account: payment is due. https://outside.example/billing",
    },
    "hold",
  ],
  [
    "Google demand requires payment",
    "Notice",
    {
      text: "We use Google as a delivery supplier.\nYour Google account: requires payment. https://outside.example/billing",
    },
    "hold",
  ],
  [
    "Google demand require a payment",
    "Notice",
    {
      text: "We use Google as a delivery supplier.\nYour Google account: require a payment. https://outside.example/billing",
    },
    "hold",
  ],
  [
    "Google pressure Urgent refund confirmation",
    "Urgent refund confirmation",
    {
      text: "We use Google as a delivery supplier. Your Google account https://outside.example/login",
    },
    "hold",
  ],
  [
    "Google pressure Refund confirmation required",
    "Refund confirmation required",
    {
      text: "We use Google as a delivery supplier. Your Google account https://outside.example/login",
    },
    "hold",
  ],
  [
    "Google pressure Refund confirmation due",
    "Refund confirmation due",
    {
      text: "We use Google as a delivery supplier. Your Google account https://outside.example/login",
    },
    "hold",
  ],
  [
    "Google pressure Immediate order confirmation",
    "Immediate order confirmation",
    {
      text: "We use Google as a delivery supplier. Your Google account https://outside.example/login",
    },
    "hold",
  ],
  [
    "Google pressure Confirmation required",
    "Confirmation required",
    {
      text: "We use Google as a delivery supplier. Your Google account https://outside.example/login",
    },
    "hold",
  ],
  [
    "Google receipt title with body pressure",
    "Refund confirmation",
    {
      text: "We use Google. Your Google account requires immediate action: https://outside.example/login",
    },
    "hold",
  ],
  [
    "Google HTML prefaced demand",
    "Refund confirmation",
    {
      html: '<p>We use Google as a supplier.</p><p>Google account: payment due</p><a href="https://outside.example/billing">Continue</a>',
    },
    "hold",
  ],
  [
    "PayPal demand payment required",
    "Notice",
    {
      text: "We use PayPal as a delivery supplier.\nYour PayPal account: payment required. https://outside.example/billing",
    },
    "hold",
  ],
  [
    "PayPal demand payment due",
    "Notice",
    {
      text: "We use PayPal as a delivery supplier.\nYour PayPal account: payment due. https://outside.example/billing",
    },
    "hold",
  ],
  [
    "PayPal demand payment overdue",
    "Notice",
    {
      text: "We use PayPal as a delivery supplier.\nYour PayPal account: payment overdue. https://outside.example/billing",
    },
    "hold",
  ],
  [
    "PayPal demand payment is required",
    "Notice",
    {
      text: "We use PayPal as a delivery supplier.\nYour PayPal account: payment is required. https://outside.example/billing",
    },
    "hold",
  ],
  [
    "PayPal demand payment is due",
    "Notice",
    {
      text: "We use PayPal as a delivery supplier.\nYour PayPal account: payment is due. https://outside.example/billing",
    },
    "hold",
  ],
  [
    "PayPal demand requires payment",
    "Notice",
    {
      text: "We use PayPal as a delivery supplier.\nYour PayPal account: requires payment. https://outside.example/billing",
    },
    "hold",
  ],
  [
    "PayPal demand require a payment",
    "Notice",
    {
      text: "We use PayPal as a delivery supplier.\nYour PayPal account: require a payment. https://outside.example/billing",
    },
    "hold",
  ],
  [
    "PayPal pressure Urgent refund confirmation",
    "Urgent refund confirmation",
    {
      text: "We use PayPal as a delivery supplier. Your PayPal account https://outside.example/login",
    },
    "hold",
  ],
  [
    "PayPal pressure Refund confirmation required",
    "Refund confirmation required",
    {
      text: "We use PayPal as a delivery supplier. Your PayPal account https://outside.example/login",
    },
    "hold",
  ],
  [
    "PayPal pressure Refund confirmation due",
    "Refund confirmation due",
    {
      text: "We use PayPal as a delivery supplier. Your PayPal account https://outside.example/login",
    },
    "hold",
  ],
  [
    "PayPal pressure Immediate order confirmation",
    "Immediate order confirmation",
    {
      text: "We use PayPal as a delivery supplier. Your PayPal account https://outside.example/login",
    },
    "hold",
  ],
  [
    "PayPal pressure Confirmation required",
    "Confirmation required",
    {
      text: "We use PayPal as a delivery supplier. Your PayPal account https://outside.example/login",
    },
    "hold",
  ],
  [
    "PayPal receipt title with body pressure",
    "Refund confirmation",
    {
      text: "We use PayPal. Your PayPal account requires immediate action: https://outside.example/login",
    },
    "hold",
  ],
  [
    "PayPal HTML prefaced demand",
    "Refund confirmation",
    {
      html: '<p>We use PayPal as a supplier.</p><p>PayPal account: payment due</p><a href="https://outside.example/billing">Continue</a>',
    },
    "hold",
  ],
  [
    "legitimate Refund confirmation",
    "Refund confirmation",
    {
      text: "We use Microsoft as an email delivery supplier. Your payment has been refunded. Your MepMail account remains intact. https://mepmail.dev",
    },
    "allow",
  ],
  [
    "legitimate Order confirmation",
    "Order confirmation",
    {
      text: "We use Microsoft as an email delivery supplier. Your payment has been refunded. Your MepMail account remains intact. https://mepmail.dev",
    },
    "allow",
  ],
  [
    "legitimate Receipt confirmation",
    "Receipt confirmation",
    {
      text: "We use Microsoft as an email delivery supplier. Your payment has been refunded. Your MepMail account remains intact. https://mepmail.dev",
    },
    "allow",
  ],
  [
    "neutral payment refunded",
    "Notice",
    { text: "Microsoft payment refunded. https://outside.example/receipt" },
    "allow",
  ],
] as const;
for (const [name, subject, body, expected] of cases) {
  test(name, () => {
    const verdict = evaluatePreSendContent({
      from: "MepMail Support <suporte@mepmail.dev>",
      subject,
      ...body,
    });
    expect(verdict.action).toBe(expected);
    if (verdict.action === "hold") expect(verdict.code).toBe("brand_account_link_mismatch");
  });
}
