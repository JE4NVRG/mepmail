-- Um respostas legítimas (Jean 2026-11-26): o guard de prospecção fria classifica o
-- remetente (parcerias@, partnerships@ …) e o assunto, sem saber se a mensagem responde
-- a um contato RECEBIDO na mesma caixa. Uma resposta real de parcerias@ ficava retida
-- como cold_outreach, um stop de política que aprovar o conteúdo não libera.
--
-- O vínculo é decidido no servidor, no momento da admissão, a partir de dois fatos que o
-- cliente não escreve: o In-Reply-To dos bytes selados do rascunho e o item recebido
-- (kind 'inbox', deliveryFolder 'inbox', mesma caixa) cujo message_key casa com esse
-- Message-ID. Só quando o vínculo existe E todo destinatário pertence à conversa
-- (From/Cc da mensagem recebida, sem o próprio endereço) a mensagem deixa de ser
-- tratada como prospecção não solicitada. Falso vínculo não vira exceção: sem item
-- correspondente ou com destinatário fora da conversa, a coluna fica nula e a política
-- antiga continua valendo.
--
-- Sem FK para mailbox_items de propósito: a coluna é testemunho durável da decisão já
-- tomada, não autorização para ler outra linha, e um FK impediria apagar (purga) uma
-- mensagem recebida que já foi respondida.
ALTER TABLE "mailbox_outbox" ADD COLUMN "reply_source_item_id" uuid;
--> statement-breakpoint
-- Uma única resposta viva por mensagem recebida. Um envio que falhou de vez sai do
-- índice (status 'failed'), então corrigir e reenviar continua possível; aceito,
-- enviando, desconhecido ou na fila contam como a resposta daquela mensagem.
CREATE UNIQUE INDEX "mailbox_outbox_reply_source_idx" ON "mailbox_outbox" ("mailbox_id","reply_source_item_id") WHERE "reply_source_item_id" IS NOT NULL AND "status" <> 'failed';
--> statement-breakpoint
-- Resolver o vínculo é uma leitura por chave, não uma varredura da caixa.
CREATE INDEX "mailbox_items_message_key_idx" ON "mailbox_items" ("mailbox_id","message_key") WHERE "message_key" IS NOT NULL;
