import { randomUUID } from "node:crypto";
import { type MailboxOutboxSender, stripMailboxPrivateHeaders } from "@millionsend/core";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { JudgeVerdict } from "../../../packages/core/src/abuse-judge/types.js";
import {
  assertMailboxDispatchContent,
  copyMailboxDispatchInput,
  withMailboxDispatchContent,
} from "../src/mailbox-dispatch-content.js";
import { authorizeWorkerDispatch, installWorkerMailboxSchema } from "./worker-dispatch-fixture.js";

const clean: JudgeVerdict = {
  score: 0,
  verdict: "clean",
  categories: [],
  reasons: [],
  impersonatedBrand: null,
  language: "en",
};
let database: Awaited<ReturnType<typeof createTestDb>>;
let semanticTeamId: string;
const semanticMailboxId = randomUUID();
beforeAll(async () => {
  database = await createTestDb();
  await installWorkerMailboxSchema(database.db);
  semanticTeamId = await createTeam(database.db, randomUUID());
});
afterAll(async () => {
  await database?.close();
});
async function fixture(raw?: string) {
  const input: Parameters<MailboxOutboxSender["send"]>[0] = {
    idempotencyKey: "key",
    outboxId: "outbox",
    attemptId: "attempt",
    teamId: semanticTeamId,
    mailboxId: semanticMailboxId,
    from: "sender@example.invalid",
    to: ["one@example.invalid"],
    cc: ["copy@example.invalid"],
    bcc: ["hidden@example.invalid"],
    raw: Buffer.from(
      raw ??
        "From: Synthetic <sender@example.invalid>\r\nTo: one@example.invalid\r\nCc: copy@example.invalid\r\nBcc: hidden@example.invalid\r\nReply-To: reply@example.invalid\r\nSubject: Synthetic\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nHello\r\n",
    ),
  };
  const db = database.db;
  await authorizeWorkerDispatch(db, input);
  const judge = {
    provider: "openai" as const,
    model: "synthetic",
    judge: vi.fn(async (_block: string, _opts: { signal: AbortSignal }) => clean),
  };
  return { input, db, judge };
}
it.each([
  "raw",
  "From",
  "Reply-To",
  "To",
  "Cc",
  "Bcc",
  "from-envelope",
  "to-envelope",
  "cc-envelope",
  "bcc-envelope",
  "team",
  "attempt",
  "idempotencyKey",
  "wire",
])("approval refuses %s mutation before provider", async (kind) => {
  const { input, db, judge } = await fixture();
  const original = Buffer.from(input.raw);
  const send = vi.fn();
  await expect(
    withMailboxDispatchContent(db, input, judge, true, async () => {
      const child = copyMailboxDispatchInput(input, true);
      let raw = Buffer.from(child.raw);
      if (kind === "raw") input.raw = Buffer.concat([input.raw, Buffer.from("changed")]);
      else if (["From", "Reply-To", "To", "Cc", "Bcc"].includes(kind))
        input.raw = Buffer.from(
          input.raw
            .toString()
            .replace(new RegExp(`^${kind}:.*$`, "m"), `${kind}: other@example.invalid\r`),
        );
      else if (kind === "wire") raw = Buffer.concat([raw, Buffer.from("changed")]);
      else if (kind === "team") input.teamId = "other-team";
      else if (kind === "attempt") input.attemptId = "new-attempt";
      else if (kind === "idempotencyKey") input.idempotencyKey = "new-key";
      else if (kind === "from-envelope") input.from = "other@example.invalid";
      else
        input[kind === "to-envelope" ? "to" : kind === "cc-envelope" ? "cc" : "bcc"] = [
          "other@example.invalid",
        ];
      assertMailboxDispatchContent(child, raw, true);
      send();
    }),
  ).rejects.toMatchObject({ reason: "semantic_content_review" });
  expect(send).not.toHaveBeenCalled();
  expect(judge.judge).toHaveBeenCalledTimes(1);
  expect(original.toString()).toContain("Hello");
});

/** MIME multipart/mixed montado a mao: cada parte e o que o teste quiser. */
function mixed(parts: { headers: string; body: string }[], boundary = "mix"): string {
  const body = parts
    .map((part) => `--${boundary}\r\n${part.headers}\r\n\r\n${part.body}\r\n`)
    .join("");
  return `From: sender@example.invalid\r\nSubject: Synthetic\r\nContent-Type: multipart/mixed; boundary=${boundary}\r\n\r\n${body}--${boundary}--\r\n`;
}
const textPart = { headers: "Content-Type: text/plain; charset=utf-8", body: "Hello" };
function attachmentPart(headers: string, body = "JVBERi0xLjQK") {
  return { headers, body };
}

it("entrega anexo valido: o gate deixa passar e o judge ve nome e tipo", async () => {
  const { input, db, judge } = await fixture(
    mixed([
      textPart,
      attachmentPart(
        'Content-Type: application/pdf\r\nContent-Disposition: attachment; filename="nota.pdf"\r\nContent-Transfer-Encoding: base64',
      ),
    ]),
  );
  const send = vi.fn();
  await withMailboxDispatchContent(db, input, judge, true, async () => send());
  expect(send).toHaveBeenCalledTimes(1);
  expect(judge.judge).toHaveBeenCalledTimes(1);
  expect(judge.judge.mock.calls[0]![0]).toContain("nota.pdf");
  expect(judge.judge.mock.calls[0]![0]).toContain("application/pdf");
});

it.each([
  [
    "nome malicioso",
    'Content-Type: application/pdf\r\nContent-Disposition: attachment; filename="../../../etc/passwd.pdf"\r\nContent-Transfer-Encoding: base64',
    "attachment_name_blocked",
  ],
  [
    "executavel disfarcado",
    'Content-Type: application/pdf\r\nContent-Disposition: attachment; filename="nota.pdf.exe"\r\nContent-Transfer-Encoding: base64',
    "attachment_name_blocked",
  ],
  [
    "content-type falso",
    'Content-Type: application/x-msdownload\r\nContent-Disposition: attachment; filename="nota.pdf"\r\nContent-Transfer-Encoding: base64',
    "attachment_type_blocked",
  ],
] as const)("recusa %s com motivo proprio", async (_label, headers, reason) => {
  const { input, db, judge } = await fixture(mixed([textPart, attachmentPart(headers)]));
  const send = vi.fn();
  await expect(
    withMailboxDispatchContent(db, input, judge, true, async () => send()),
  ).rejects.toMatchObject({ reason });
  expect(send).not.toHaveBeenCalled();
  expect(judge.judge).not.toHaveBeenCalled();
});

it("recusa boundary quebrado sem adivinhar as partes", async () => {
  const raw = mixed([
    textPart,
    attachmentPart(
      'Content-Type: application/pdf\r\nContent-Disposition: attachment; filename="nota.pdf"',
    ),
  ]).replace("--mix--", "--outro--");
  const { input, db, judge } = await fixture(raw);
  const send = vi.fn();
  await expect(
    withMailboxDispatchContent(db, input, judge, true, async () => send()),
  ).rejects.toMatchObject({ reason: "attachment_structure_invalid" });
  expect(send).not.toHaveBeenCalled();
});

it("recusa anexo aninhado: anexo que e um multipart", async () => {
  const nested = ["--inner\r\nContent-Type: text/plain\r\n\r\nHello\r\n--inner--\r\n"].join("");
  const { input, db, judge } = await fixture(
    mixed([
      textPart,
      {
        headers:
          'Content-Type: multipart/mixed; boundary=inner\r\nContent-Disposition: attachment; filename="pacote.txt"',
        body: nested,
      },
    ]),
  );
  const send = vi.fn();
  await expect(
    withMailboxDispatchContent(db, input, judge, true, async () => send()),
  ).rejects.toMatchObject({ reason: "attachment_structure_invalid" });
  expect(send).not.toHaveBeenCalled();
});

it("serialized/copied objects and stale attempts have no approval; fresh retry requalifies", async () => {
  const { input, db, judge } = await fixture();
  let prior: Parameters<MailboxOutboxSender["send"]>[0] = input;
  await withMailboxDispatchContent(db, input, judge, true, async () => {
    prior = copyMailboxDispatchInput(input, true);
    assertMailboxDispatchContent(prior, prior.raw, true);
    const copied = { ...prior, semanticApproved: true, contentQualified: "clean" };
    expect(() => assertMailboxDispatchContent(copied, copied.raw, true)).toThrow();
  });
  expect(() => assertMailboxDispatchContent(prior, prior.raw, true)).toThrow();
  await withMailboxDispatchContent(db, input, judge, true, async () =>
    assertMailboxDispatchContent(input, stripMailboxPrivateHeaders(input.raw), true),
  );
  expect(judge.judge).toHaveBeenCalledTimes(2);
});
it("equivalent alternatives and nested routers reuse only this dispatch approval", async () => {
  const { input, db, judge } = await fixture(
    "From: sender@example.invalid\r\nSubject: Synthetic\r\nContent-Type: multipart/alternative; boundary=fixture\r\n\r\n--fixture\r\nContent-Type: text/plain\r\n\r\nHello\r\n--fixture\r\nContent-Type: text/html\r\n\r\n<p>Hello</p>\r\n--fixture--\r\n",
  );
  await withMailboxDispatchContent(db, input, judge, true, async () => {
    const copy = copyMailboxDispatchInput(input);
    await withMailboxDispatchContent(db, copy, undefined, undefined, async () =>
      assertMailboxDispatchContent(copy, stripMailboxPrivateHeaders(copy.raw)),
    );
  });
  expect(judge.judge).toHaveBeenCalledTimes(1);
});
it.each([
  [
    '"AtlasBank Password Reset Instructions" <reply@example.invalid>',
    true,
    "AtlasBank Password Reset Instructions",
  ],
  ["=?UTF-8?B?QXRsYXNCYW5rIFNlY3VyaXR5?= <reply@example.invalid>", true, "AtlasBank Security"],
  ["Synthetic Group: reply@example.invalid;", false, ""],
  ["=?utf-8?B?%%%?= <reply@example.invalid>", false, ""],
  ["<>", false, ""],
])("Reply-To complete identity or fail-closed: %s", async (reply, supported, display) => {
  const { input, db, judge } = await fixture();
  input.raw = Buffer.from(
    input.raw.toString().replace("Reply-To: reply@example.invalid", `Reply-To: ${reply}`),
  );
  const sending = withMailboxDispatchContent(db, input, judge, true, async () =>
    assertMailboxDispatchContent(input, stripMailboxPrivateHeaders(input.raw), true),
  );
  if (!supported) {
    await expect(sending).rejects.toMatchObject({ reason: "semantic_content_review" });
    expect(judge.judge).not.toHaveBeenCalled();
    return;
  }
  await sending;
  const block = judge.judge.mock.calls[0]![0];
  expect(block).toContain(display);
  expect(block).toContain("reply@example.invalid");
  expect(block).not.toContain("Bcc:");
  expect(block).not.toContain("hidden@example.invalid");
});
it("mutation during qualification fails closed", async () => {
  const { input, db, judge } = await fixture();
  const send = vi.fn();
  judge.judge.mockImplementation(async () => {
    input.bcc.push("other@example.invalid");
    return clean;
  });
  await expect(
    withMailboxDispatchContent(db, input, judge, true, async () => send()),
  ).rejects.toMatchObject({ reason: "semantic_content_review" });
  expect(send).not.toHaveBeenCalled();
});
it("undefined Cloud selection cannot exempt; explicit OSS remains valid", async () => {
  const { input, db } = await fixture();
  const send = vi.fn(async () => "ok");
  await expect(
    withMailboxDispatchContent(db, input, undefined, undefined, send),
  ).rejects.toMatchObject({ reason: "semantic_content_review" });
  expect(send).not.toHaveBeenCalled();
  expect(await withMailboxDispatchContent(db, input, undefined, false, send)).toBe("ok");
  expect(send).toHaveBeenCalledTimes(1);
});
it.each([
  // A parte solta com disposition de anexo agora e nomeada: nao e revisao de texto.
  [
    "Content-Type: application/octet-stream\r\nContent-Disposition: attachment; filename=synthetic.txt\r\n\r\nsynthetic",
    "attachment_not_supported",
  ],
  [
    "Content-Type: text/plain\r\nContent-Type: text/html\r\n\r\nHello",
    "attachment_structure_invalid",
  ],
  ["Content-Type: text/plain; charset=iso-8859-1\r\n\r\nHello", "semantic_content_review"],
  [
    "Content-Type: text/plain\r\nContent-Transfer-Encoding: base64\r\n\r\n%%%bad",
    "semantic_content_review",
  ],
  [
    "Content-Type: text/plain\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n=XX",
    "semantic_content_review",
  ],
  [
    "Content-Type: multipart/alternative; boundary=x\r\n\r\n--x\r\nContent-Type: text/plain\r\n\r\nHello\r\n--x--\r\n",
    "semantic_content_review",
  ],
])("unsupported/malformed MIME has no partial allow: %s", async (part, reason) => {
  const { input, db, judge } = await fixture(
    "From: sender@example.invalid\r\nSubject: Synthetic\r\n" + part,
  );
  const send = vi.fn();
  const original = Buffer.from(input.raw);
  await expect(
    withMailboxDispatchContent(db, input, judge, true, async () => send()),
  ).rejects.toMatchObject({ reason });
  expect(send).not.toHaveBeenCalled();
  expect(judge.judge).not.toHaveBeenCalled();
  expect(input.raw).toEqual(original);
});
it("a hanging judge hits the existing deadline and cannot authorize a late result", async () => {
  const { input, db, judge } = await fixture();
  let resolve: ((verdict: JudgeVerdict) => void) | undefined;
  const send = vi.fn();
  judge.judge.mockImplementation(
    () =>
      new Promise<JudgeVerdict>((r) => {
        resolve = r;
      }),
  );
  const started = performance.now();
  await expect(
    withMailboxDispatchContent(db, input, judge, true, async () => send()),
  ).rejects.toMatchObject({ reason: "semantic_content_review" });
  expect(performance.now() - started).toBeGreaterThanOrEqual(19000);
  resolve!(clean);
  await Promise.resolve();
  expect(send).not.toHaveBeenCalled();
  expect(() =>
    assertMailboxDispatchContent(input, stripMailboxPrivateHeaders(input.raw), true),
  ).toThrow();
}, 30000);
