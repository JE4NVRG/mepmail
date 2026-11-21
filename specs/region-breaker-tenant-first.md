# Pausa de reputação: quem para, quem não para, e como voltar

Duas pausas diferentes vivem no mesmo caminho. Antes desta mudança uma reclamação
confirmada parava a **região**; agora ela para o **time** que reclamou, e a região
só para quando a taxa que restaria continua acima da linha.

## Quem para em cada caso

| Sinal | Antes | Agora |
|---|---|---|
| 1 reclamação (`BREAKER_COMPLAINT_RATE = 0`, piso 1 envio) | região `us-east-1` inteira | o time que reclamou (review hold, motivo `reputation`) |
| 2% de bounce duro com 100+ envios | região inteira | o time (ou times) que produziram os bounces |
| Taxa da região ainda acima depois de tirar esses times | — | região inteira |

## O que cada pausa bloqueia, no código

**Pausa de região** (`region_breakers.paused`) — só broadcast:

- `apps/api/src/app.ts` (`regionPause` antes de criar o broadcast) → `403 broadcasts_paused`, com o texto explícito "Transactional email is unaffected".
- `apps/worker/src/handlers/send-broadcast.ts` → o fan-out é adiado.
- `apps/web/src/server/routers/broadcasts.ts` → o console recusa com a mesma mensagem.

`/emails` (transacional), SMTP e correio **não** consultam `regionPause`. É decisão
de projeto, não esquecimento: a região para para proteger a reputação da conta SES
sem derrubar reset de senha de ninguém.

Consequência prática para a operação: FullCommerce, ArchScene, `je4ndev.com` e
`mepmail.dev` dividem `us-east-1`. Com a região pausada, o **transacional deles
continua saindo**, mas **campanha/broadcast de todos eles para** até a região sair
do estado ou o operador soltar.

**Pausa de time** (`teams.send_review_at`, motivo `reputation`) — tudo do time:

- transacional, broadcast, SMTP e correio daquele time ficam retidos para revisão
  (`send-email`, `send-broadcast`, `mailbox-sender` checam a mesma marca);
- entra na fila de revisão do console com a nota do motivo, e o dono é avisado.

O time que gerou a reclamação perde o envio inteiro — inclusive o transacional
dele. É a troca deliberada: um time retido em vez de 5,9 mil contas de broadcast
paradas na região.

## Retomada

**Time** (caminho normal, no produto): Console → segurança/revisão → liberar a
revisão do time. A mutação é `releaseReview` (`apps/web/src/server/routers/console/teams.ts`),
que limpa `send_review_at`, fecha a flag `review` aberta e notifica o dono.
Efeito colateral pretendido: o mesmo time não volta a ser retido pelo mesmo
episódio já revisado.

**Região** (quando a taxa realmente exige esperar): `releaseRegion(db, region)`
(`packages/core/src/platform-breaker.ts`), exposto no console de regiões. O cron
do breaker volta a julgar a região pelas taxas na execução seguinte, e um hold
manual (`manualReason`) só sai por essa ação — o breaker nunca solta sozinho um
hold que o operador colocou.

## Alerta

`packages/core/src/region-breaker-notice.ts` manda no Telegram do operador
(mesmo canal dos alertas de cadastro e de reputação):

- time pausado: região, motivo, time, eventos/envios e janela;
- região pausada: taxa, limite, janela, e que transacional/first-party seguem;
- região liberada porque a pausa ficou no time.

Sem token configurado o notificador é no-op e nunca atrasa o breaker.

## Deploy

`scripts/deploy-detached.sh` (rodar com `setsid nohup`, nunca no ciclo de vida de
uma sessão de agente): copia os logs dos containers que vão sair **antes** do
`compose up`, recria um papel por vez atrás do próprio health check (`/health`,
porta 2587, porta 1465), e devolve o papel ao digest anterior se ele não subir.
A imagem de rollback nunca é apagada.
