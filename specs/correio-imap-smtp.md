# Correio em clientes de e-mail: IMAP, SMTP e senhas de app

Pedido do Jean (2026-10-11): usar as caixas do Correio no Outlook, no Apple Mail, no Thunderbird e no app do Gmail no celular. A ordem que ele escolheu: Excluir caixa → **este** → cache offline do desktop → painel de agentes.

## O que a pessoa vê

1. Correio → caixa → "Usar em outro app de e-mail".
2. O dono da caixa cria uma **senha de app**, com um nome (ex.: "Outlook do notebook"). A senha aparece **uma vez**: 16 letras em 4 grupos.
3. Configuração mostrada junto:

| | Servidor | Porta | Segurança |
|---|---|---|---|
| IMAP (receber) | `imap.mepmail.dev` | 993 | SSL/TLS |
| SMTP (enviar) | `smtp.mepmail.dev` | 465 (SSL/TLS) ou 587 (STARTTLS) | |
| Usuário | o endereço da caixa | | |
| Senha | a senha de app | | |

4. A lista de senhas mostra nome, criação, último uso e **Revogar**. Revogar derruba as sessões abertas no próximo comando.

## Quem pode

- Só o **dono** de uma caixa de **pessoa**, com assento licenciado e Correio ativo. As caixas de agente seguem com chave de agente/MCP.
- A senha entra **como o dono**. Tudo o que o cliente faz passa pelas mesmas funções do core que a web usa (`withMailboxContentAccess`, `saveMailboxDraft`, `queueMailboxDraft`…). Os ACLs, as cotas, o limite de envio e o bloqueio de envio duplicado valem iguais.
- Até 10 senhas ativas por caixa.
- Uma senha deixa de valer se a pessoa deixa de ser dona/membro, se a caixa é suspensa ou excluída, ou se a senha é revogada.

## Senha de app

- 16 letras minúsculas sem ambiguidade, de um alfabeto de 22 (≈71 bits). Espaços são ignorados no login.
- O banco guarda só `sha256(pepper ‖ senha)`. A busca é pelo hash: a entropia alta dispensa um hash lento, como nas chaves de API. Além disso, o banco guarda os últimos 4 caracteres como dica.
- Tentativas erradas: no máximo 10 por IP e 20 por endereço a cada 15 min, por processo. A resposta é a mesma para "endereço não existe" e "senha errada".

## SMTP de envio (`apps/smtp`, novo listener)

- Portas 465 (TLS implícito) e 587 (STARTTLS). AUTH PLAIN/LOGIN com endereço + senha de app.
- `MAIL FROM` precisa ser o endereço da caixa ou um apelido dela.
- O MIME recebido vira um rascunho (`saveMailboxDraft`, com os destinatários do envelope que faltam no cabeçalho entrando como Cco) e é enviado por `queueMailboxDraft` como envio humano do dono. A cópia fica em Enviados, como na web.
- Limites de hoje: MIME até 1 MiB e até 20 destinatários. Acima disso, 552/452 com mensagem clara.

## IMAP (`apps/imap`, novo serviço)

- Base: o `imap-core` do WildDuck 1.46.1 (EUPL-1.2), copiado para `apps/imap/vendor/imap-core` com o aviso de licença. A EUPL-1.2 lista a AGPLv3 como compatível. O protocolo, o parser, o BODYSTRUCTURE/ENVELOPE (indexer) e o IDLE vêm de lá. Os handlers (`onAuth`, `onList`, `onOpen`, `onFetch`, `onSearch`, `onStore`, `onCopy`/`onMove`, `onExpunge`, `onAppend`, `onIdle*`) são nossos, sobre o core.
- Pastas: Caixa de entrada, Enviados, Rascunhos, Arquivo, Spam, Lixeira (SPECIAL-USE) e as pastas do usuário. Favoritos aparece como `\Flagged`, não como pasta.
- UIDs: tabela `mailbox_imap_uids(mailbox_id, folder_key, uid, item_id)` + `mailbox_imap_folders(mailbox_id, folder_key, uidvalidity, uidnext)`.
  - A mensagem ganha UID ao aparecer na pasta (SELECT/NOOP/IDLE).
  - Quando sai da pasta, a linha é apagada e o cliente recebe EXPUNGE.
  - Se voltar, ganha UID novo. Os UIDs nunca descem nem se repetem.
- Flags:
  - `\Seen` ↔ `seenAt`;
  - `\Flagged` ↔ `starredAt`;
  - `\Deleted` + EXPUNGE → Lixeira (nunca apaga de vez);
  - `\Draft` nos rascunhos.
- Escrita:
  - MOVE/COPY entre pastas = arquivar, mover para pasta, lixeira;
  - APPEND em Rascunhos = salvar rascunho;
  - APPEND em Enviados com Message-ID já existente = aceita sem duplicar (clientes que gravam a cópia depois do SMTP);
  - APPEND na Caixa de entrada/Arquivo = importação, como no importador IMAP.
- IDLE: o mesmo NOTIFY do Postgres que alimenta o push da web.

## Infra (pedir OK do Jean antes)

- DNS na Cloudflare, **sem proxy** (nuvem cinza): `imap.mepmail.dev` e `smtp.mepmail.dev` → IP da VPS.
- Certificado Let's Encrypt para os dois nomes, renovado como o do relay atual (`/home/jean/millionsend/certs`).
- ufw: abrir 993/tcp, 465/tcp e 587/tcp, com comentário, como já foi feito com a 2587.
- Containers `imap` e `smtp` no compose. A flag `MAILBOX_CLIENT_ACCESS_OPEN` só mostra a tela quando os servidores estiverem no ar.

## Fases

1. Senhas de app: migração 0032 + core + router + tela (atrás da flag).
2. SMTP de envio + testes com nodemailer contra PGlite.
3. IMAP: imap-core + handlers + testes com imapflow contra PGlite.
4. Infra + release + conferência com o Outlook/Thunderbird do Jean.
