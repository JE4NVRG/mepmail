import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  MailboxPilot,
  type MailboxActor,
  type PilotMailbox,
} from "../../../packages/core/src/mailbox-pilot.js";
import { EnvKeyring } from "../../../packages/core/src/crypto/keyring.js";
import { mailboxPilotMime } from "../src/mailbox-pilot-mime.js";

export const human: MailboxActor = { teamId: "pilot-team", principalId: "pilot-human" };
export const agent: MailboxActor = { teamId: "pilot-team", principalId: "pilot-agent" };
export const mailboxes: PilotMailbox[] = [
  {
    id: "personal",
    address: "jean@piloto.test",
    label: "Pessoal",
    kind: "person",
    grants: { "pilot-human": ["read", "draft", "send", "manage"] },
  },
  {
    id: "agent",
    address: "luna@piloto.test",
    label: "Luna",
    kind: "agent",
    grants: {
      "pilot-human": ["read", "draft", "send", "manage"],
      "pilot-agent": ["read", "draft"],
    },
  },
];
export const attachmentBytes = Buffer.from(
  "Domínio: piloto.test\nCaixas: Jean e Luna\nConteúdo sintético para a prova de anexos.\n",
  "utf8",
);
export function keyring() {
  return EnvKeyring.fromBase64(randomBytes(32).toString("base64"));
}
export async function openPilot(file: string, key = keyring()) {
  return MailboxPilot.open(file, human.teamId, key, mailboxPilotMime, mailboxes);
}
export async function fixtureMime(
  subject = "Contrato do seu novo domínio",
  to = "jean@piloto.test",
) {
  return mailboxPilotMime.compose({
    from: "cliente@exemplo.test",
    to,
    subject,
    text: "Olá Jean,\n\nSeu novo domínio está pronto. Em anexo está o resumo das caixas pessoal e do agente.\n\nPode confirmar os dados?\n\nAbraço,\nMarina",
    messageId: `<${subject.startsWith("Suporte") ? "agent" : "personal"}@exemplo.test>`,
    inReplyTo: "",
    references: [],
    attachments: [
      { filename: "resumo-do-dominio.txt", contentType: "text/plain", content: attachmentBytes },
    ],
  });
}
export async function seedPilot(service: MailboxPilot) {
  if (!(await service.list(human, "personal")).length)
    await service.receive({
      sourceId: "fixture-personal-v1",
      recipients: ["jean@piloto.test"],
      raw: await fixtureMime(),
    });
  if (!(await service.list(human, "agent")).length)
    await service.receive({
      sourceId: "fixture-agent-v1",
      recipients: ["luna@piloto.test"],
      raw: await fixtureMime("Suporte ao domínio piloto", "jean@piloto.test"),
    });
  if (
    !(await service.list(human, "personal")).some(
      (row) => row.subject === "Seu MepMail, agora com imagens",
    )
  )
    await service.receive({
      sourceId: "fixture-media-v1",
      recipients: ["jean@piloto.test"],
      raw: await fixtureImageMime(),
    });
}
export async function fixtureImageMime() {
  const logo = await readFile(new URL("../../web/public/email/wordmark-bone.png", import.meta.url));
  const gallery = await readFile(
    new URL("../../web/public/product/templates-hero.webp", import.meta.url),
  );
  return mailboxPilotMime.compose({
    from: "equipe@exemplo.test",
    to: "jean@piloto.test",
    subject: "Seu MepMail, agora com imagens",
    text: "Olá Jean,\n\nTodas as suas caixas em um só lugar, com a identidade do MepMail.\n\nA logo está incorporada à mensagem e a galeria segue como anexo. Toque em uma imagem para ampliar ou baixe o arquivo original.\n\nEsta é uma mensagem de demonstração do piloto local.",
    messageId: "<media@exemplo.test>",
    inReplyTo: "",
    references: [],
    attachments: [
      {
        filename: "mepmail.png",
        contentType: "image/png",
        content: logo,
        cid: "mepmail@piloto.test",
        disposition: "inline",
      },
      { filename: "templates.webp", contentType: "image/webp", content: gallery },
    ],
  });
}
