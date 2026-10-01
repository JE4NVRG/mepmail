import { randomBytes } from "node:crypto";
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
}
