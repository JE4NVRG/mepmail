# Correções de confiança e conversão — t_b8f01b8a

## Delta P0 t_e07c19a6 — contrato /usage (diagnóstico; decisão pendente)

Não é correção de produto nem autorização de publicação. A candidata 68239bc3 troca `period.overage_usd_per_1k: number` por `number | null` na mesma rota: quebra de wire para consumidores anteriores. Disponibilidade da taxa é problema distinto: `auth.billing` não contém os termos financeiros, `teams` persiste IDs/quota/período, não a taxa dos itens. Alteração comercial é um terceiro eixo: a tabela nova NÃO muda contratos existentes. Nenhum desses eixos autoriza inferir taxa por quota, devolver zero, esconder o período mensal ou usar catálogo atual como contrato.

Invariante impeditiva: assinaturas com mesma quota podem ter taxas antigas e novas diferentes. Sem fonte adicional de termos contratados, /usage não consegue devolver um número verdadeiro em ambos os casos. ID de assinatura/item não codifica preço. Restaurar apenas `number` no schema ou adicionar opt-in nullable não resolve essa ausência de informação. Não implementar fallback nem 503 generalizado; preservar runtime e interromper para decisão da Luna.

Duas opções, não implementadas:

1. Recomendada: autorizar desenho de um snapshot durável dos termos dos itens efetivos, atualizado por eventos de assinatura e reconciliação controlada, com proveniência (assinatura/Price/moeda/unidade/arredondamento), ordenação/idempotência e política de validade. Exige aprovação separada de persistência/migração/backfill; não criar nesta entrega. Preservar o wire numérico de /usage somente quando a fonte confiável estiver disponível; inventariar e resolver lacunas antes de publicar. Indisponibilidade Stripe não invalida automaticamente snapshot contratual verificado, mas estado ausente/incompatível/invalidado não pode virar número. Cobertura incompleta mantém o gate fechado: não prometer 200 universal nem servir snapshot obsoleto como vigente. Novo contrato nullable apenas em opt-in explicitamente versionado (proposta `/v2/usage`), com OpenAPI separado; nunca alterar silenciosamente o default.
2. Se a fonte durável não for autorizada: aprovar explicitamente transição incompatível, inventário de consumidores e janela de depreciação/migração para `/v2/usage`, mantendo publicação bloqueada até resolver o comportamento e retirada da rota antiga. V2 pode preservar uso/limites com taxa desconhecida; não é retrocompatibilidade e não corrige a semântica financeira do endpoint antigo. Não existe transição segura imediata garantida só por criar uma segunda rota.

Contrato novo proposto: taxa nullable significa desconhecida, nunca grátis; valores conhecidos vêm dos itens efetivos (inclusive arquivados), não de metadados do catálogo novo. Free/Starter continuam com `period: null` e limites diários; planos mensais preservam contadores, quota e período mesmo sem taxa. MCP deve preservar null; CLI que só usa contadores/limites não demonstra compatibilidade dos demais consumidores. EN/PT e OpenAPI deverão documentar versão/default/depreciação, não apenas nullable. Consumidor representativo antigo deve rejeitar null, o novo deve tratá-lo explicitamente, e controle negativo deve detectar a quebra.

Implantação: nenhuma nesta entrega. A escolha da arquitetura/versão é da Luna; depois exige implementação, testes focais e QA independente `qa`, antes de liberação separada no gate t_0ba7607f. Não publicar a candidata nullable atual nem o build dummy. Tabela aprovada, guards e pilha anterior preservados; sem nova stack, Stripe real, migração, push ou deploy.

## Delta P0 t_8e779ff9 — tabela aprovada e contratos existentes (antes do código)

Jean aprovou implementação LOCAL: pro_100k 2000/30; pro_200k 3900/28; scale_500k 9500/25; scale_1m 17900/23; scale_1_5m 26500/22; scale_2_5m 42900/21 (mensalidade/excedente por mil em centavos USD). Quotas, chaves, Free, Starter, limites e recursos intactos. Substitui a pendência comercial histórica abaixo; 19c uniforme NÃO aprovado. Comparativos mantêm as bases existentes dos concorrentes. Fórmula: base + taxa * ceil(max(0, volume - quota)/1000), aplicada aos DOIS planos.

Catálogo novo não representa contrato existente. Resolver valores efetivos pelo Price/itens da assinatura, nunca lookup atual; sem taxa confiável, não apresentar estimativa como vigente. Nenhuma migração de banco, Stripe real, push ou publicação autorizada. Rotação de preços deve preservar valores/metadados históricos; round down não equivale a round up. Testes com cliente injetado são sintéticos, não prova de cobrança real. Preview/build/testes no Windows existente, QA independente e gate de publicação t_0ba7607f mantidos.

## Delta P0 t_c8f557ab — continuidade e estimativa (antes do código)

Autorização focal sobre PRD/constitution: transportar chave estável de PLAN_RUNGS em `/signup?next=` até `/settings/billing?rung=`, mantendo Free/cadastro geral sem oferta. `pro_100k` e `pro_200k` continuam distintos. Billing apenas preseleciona comparação; mutações continuam exclusivamente em cliques explícitos com roles existentes. Não altera catálogo, contratos antigos, Stripe, plugin ou protocolo auth.

Preservar destino interno validado na troca signup/login, verificação, erro OAuth, recuperação e dashboard/onboarding. O proxy sobrescreve header interno com pathname/query da própria requisição (não confiar no header fornecido pelo cliente); guards continuam validando sessão/time. Rejeitar next múltiplo, externo e ciclos de auth/onboarding. Após criar time, refresh existente retoma destino; sem next, onboarding conserva o passo de ativação atual. Estimativa usa `ceil(over/1000)*quota.overageCentsPer1k`, nunca taxa do catálogo em lugar da assinatura.

Regressões RED→GREEN, gates focais e build no Windows existente, smoke anônimo EN/PT sem submit/charge; QA independente no SHA congelado. Nenhuma alegação de E2E pago, OAuth externo ou e-mail entregue. Publicação continua não autorizada; usar pipeline existente somente após autorização separada e nunca publicar build dummy.

## Handoff P0 t_c8f557ab

Implementação local: oferta validada até billing; comparação preselecionada sem mutação por query; Free mantém onboarding normal; recuperação, verificação e erro OAuth preservam destino seguro. Estimativa por blocos usa a taxa recebida da assinatura. Catálogo comercial/Stripe/plugin intactos.

Gates Windows: RED inicial com 9 falhas demonstradas; GREEN final com 179 testes (125 web focais + 12 atribuição/funil + 23 planos + 19 preços/provisionamento), Biome22, TypeScript e build exit0. Preview http://127.0.0.1:9897, BUILD_ID Mvx6YydF8zuMfA1xUKPh4, manifest servido200. Navegação Chromium real: 16 cliques Free/Starter/Pro110K/Pro220K em home/pricing EN/PT, 138 checks, sem POST. Inspeção visual PT390/EN1440 sem overflow, campos vazios e opt-in desligado.

Limites: preview dummy/self-host, sem banco real; GET direto ao dashboard retorna500 por inicialização auth/ECONNREFUSED. Guards com/sem time, UI billing/roles/ausência de auto-mutações foram exercitados em harness sintético e contratos PGlite, NÃO jornada autenticada/pagamento Stripe nem envio externo. QA independente deve revisar esses limites no SHA congelado. Não publicar o build dummy; somente após autorização separada, usar o pipeline existente com artefato de produção, conferir SHA servido e jornada. Fonte/export em paridade por manifesto; originais do export preservados por hash em F:/MepMail-preserved/t_c8f557ab.

## Delta aprovado pelo card (antes do código)

Esta correção prevalece sobre a copy anterior de landing-cro-spec e a exigência de cinco campos de frontend-polish-spec. Reutiliza o visual, fonte e preview existentes; nenhuma publicação está autorizada.

1. Cloud SES: us-east-1 nas instruções EN/PT de migração e domínios. Exemplos self-host/terceiros e infraestrutura intactos.
2. Hero: migração compatível, oferta publicada e apoio assistido antes de MCP; preservar CTAs, atribuição e identidade.
3. Produto: somente captura real existente sanitizada ou sessão existente somente leitura. Galeria não basta para este item. Arte estática do acesso intacta.
4. Cadastro: nome/e-mail/senha; confirmação real por e-mail, força/olho, captcha e callbacks intactos. Escolha de novidades separada, desmarcada. Reutilizar endpoint público de double opt-in já existente; cadastro sem escolha, OAuth e clientes antigos não podem criar contatos de marketing. Remover inscrição automática, preservando boas-vindas transacionais e apagamento. Não introduzir armazenamento, schema, migration, cookie de consentimento ou protocolo auth novo. A extensão autorizada é de apresentação e acionamento do fluxo existente de marketing, não de autenticação.
5. Preços: escopo reaberto por Jean durante a execução. O salto US$20/110K → US$100/220K foi rejeitado comercialmente. Depende da análise t_3655629d e da aprovação dos novos valores; explicação matemática NÃO resolve o item. Rascunho preservado nas chaves choiceTitle/choiceBody e em pricing-draft.patch, mas não renderizado no preview. Catálogo/Stripe intactos. Arredondamento atual confirmado em packages/billing/src/provision.ts:205 (blocos de 1.000 para cima); exemplo histórico 220K = US$119 no menor, não recomendação de preço futuro.

## Validação e entrega

Gates focais no Windows F:\MepMail e preview 9897, EN/PT desktop/mobile. Contratos locais/PGlite e transporte capturado não são autenticação ou envio produtivo. Reutilizar evidências da arte estática não alterada; QA independente obrigatório. Resultado e limitações serão registrados no handoff final.

## Publicação

Local-only. Não publicar o build dummy do preview. Após QA e autorização separada da Luna, usar o pipeline existente com artefato de produção da revisão aprovada, verificar SHA servido e jornada; sem novas stacks, secrets ou mudanças de banco.

## Handoff de implementação

- 1 — Resolvido na fonte: migração e conceitos/domínios EN/PT usam us-east-1. Exemplos multi-região self-host, testes e configurações não foram substituídos. Contrato automático cobre os quatro documentos; README do CLI já estava correto.
- 2 — Resolvido no preview: H1 EN/PT orientado à migração/custo, lead de compatibilidade/suporte e anúncio sem MCP dominante. CTAs, tabs, marca, atribuição e seção MCP preservados. Sem alegação de melhora de conversão medida.
- 3 — Bloqueado: GET somente leitura em /domains no Chrome existente retornou /login. Não havia captura segura com proveniência de painel/domínios/logs nos artefatos encontrados. Galeria anterior e arte FIRST_NAME → Ana/Sam preservadas. Precisa de captura segura aprovada ou sessão autenticada existente; nenhuma conta/dado foi criado.
- 4 — Resolvido nos contratos locais e na UI: três campos; escolha opcional desligada; signup sem escolha, verificação da conta e caminho de usuário verificado usado por OAuth não criam contato. Com escolha, frontend chama POST JSON /api/updates/subscribe; endpoint mantém rate limits e confirmação separada. Somente POST de confirmação cria/reinscreve contato. Boas-vindas, password reset, consentimento MCP e remoção de conta intactos. Contatos históricos não são alterados; análise/regularização deles não foi autorizada.
- 5 — Pendente: proposta Financeiro t_3655629d precisa de validação da Luna e aprovação de Jean. Nenhum valor proposto implementado. Rascunho de comparação antigo não aparece no DOM. Alertas recebidos: cobrança Stripe arredonda blocos para cima, estimativa billing-view usa outra regra; futuro reprice deve preservar contratos antigos. Não corrigido nem aprovado aqui.

Evidência: /home/jean/.hermes/cache/scratch/mepmail-five-point-correction/.
Gates Windows: Biome (14 arquivos), 154 testes/17 suites e tsc --noEmit exit 0; next build --webpack exit 0. BUILD_ID qGn_R1DWce4lACEuq2K9o, preview http://127.0.0.1:9897. BUILD_ID e marcador novo conferidos. O build registra ECONNREFUSED para DB dummy deliberado; não é pacote de produção.

Browser Chromium real via CDP: 18 casos/202 checks (home/signup/pricing, EN/PT, 375/390/1440), mais 10 checks de navegação/Tab/idioma/atribuição. Sem overflow ou exceções de render, CTA mobile antes de y=600, opt-in off/teclado e olho exercitados sem enviar formulário. Inspeção visual das capturas PT-mobile/EN-desktop confirmou formulário legível e arte intacta. Reutilizada a evidência anterior não afetada de static-mobile/qa/qa-result.md; não revalidado Safari/teclado físico.

Limites: preview com ALLOW_SIGNUP=true e valores fictícios somente para expor UI; OAuth providers não foram habilitados artificialmente. Nenhum e-mail externo, banco real, cobrança, push ou deploy. PGlite e transporte capturado comprovam contratos de backend, NÃO login OAuth com provedor externo nem entrega real de e-mail. A aprovação independente é de QA; não encerrar os cinco itens como completos.

Preservação: export Windows tinha quatro docs antigos, guardados e verificados em F:\MepMail-preserved\t_b8f01b8a antes de sincronizar. Manifesto source-manifest.json confirma paridade dos paths sincronizados. A candidata e o preview ficam disponíveis ao QA; contextos browser temporários foram fechados.

## Delta da retomada — pacote OpenAI (antes do código)

Card reatribuído a Dev para implementação; QA continua independente. Reutiliza este contrato, PRD e constitution, sem novo intake. Item 5 foi separado em t_26b106f0 e continua pendente; não modificar PLAN_RUNGS/Stripe. Item 3 depende do receipt seguro de t_5dce313a. Em 30/09/2026 o executor da captura confirmou apenas login no CDP Linux, sem acesso ao pane Windows; não inferir ausência de sessão global nem usar imagem fictícia. Retomada exata: receber imagem sanitizada com URL/data/hash/receipt, conferir visual, integrar abaixo do hero EN/PT e validar preview/crop/mobile.

Entregar `plugins/mepmail/` como pacote portable Agent Plugins 1.0.0, manifest raiz `plugin.json`, `mcp.json` streamable-http com o endpoint existente, skills EN de onboarding e consultas, tradução de listagem PT, logo original e AGPL/NOTICE. ZIP determinístico com allowlist; nenhuma credencial, hooks, app ID inventado, backend/UI novo ou instalação automática. Casos 5 positivos/3 negativos são roteiro NÃO EXECUTADO no ChatGPT; vídeo, identidade, conta dedicada e portal permanecem gates humanos.

Permissões iniciais: um time, `domains:read`; `emails:read` somente quando a consulta requer entregas. Sem `offline_access` por padrão, envio/escrita, audiência, webhooks, API keys ou todos os times. O schema MCP portable não aceita campo OAuth scope: não inventá-lo. A seleção efetiva é feita no consentimento OAuth existente, que inicialmente marca os scopes pedidos; instruir desmarcar tudo fora do mínimo ANTES de autorizar e interromper se não for possível. Skills/allowlist no host não substituem autorização servidor. Publicação fica bloqueada até verificar conexão com escopos mínimos no host e conta dedicada; não anunciar o servidor inteiro como somente leitura.

Sonda anônima: /mcp retorna 401/desafio correto; discovery retorna recurso/issuer canônicos, DCR, PKCE S256, `none`, issuer identification anunciado. Isso NÃO prova DCR, callback, grant, refresh ou ferramentas autenticadas. Fonte MCP já filtra ferramentas pelo token/time; porém annotations atuais não explicitam os três booleanos exigidos e alguns envios não são marcados irreversíveis. Registrar como gate de contrato servidor para revisão separada, sem modificar auth/MCP por conveniência neste pacote.

Gates focais: schemas oficiais e validação semântica de paths/metadados/ZIP, testes negativos do empacotador, contrato MCP existente no Windows, URLs públicas e receipt anônimo. Sem rebuild web se captura não disponível. Instalação local manual e publicação em etapas separadas, condicionadas a revisão; não fazer upload/portal nem deploy.

Fontes consultadas: https://developers.openai.com/plugins/build/plugins.md ; https://developers.openai.com/plugins/build/auth.md ; https://developers.openai.com/plugins/deploy/submission.md ; https://developers.openai.com/plugins/plugin-guidelines.md ; https://agent-plugins.org/schemas/1.0.0/plugin.schema.json ; https://agent-plugins.org/schemas/1.0.0/mcp.schema.json .

### Gates confirmados durante a execução

- Luna confirmou login humano no pane Windows; captura segue aguardando um caminho de screenshot viável coordenado por ela, não outro login. Nenhum dado de conta externa pode compor a vitrine. Sem tentativa adicional pelo CDP nem transferência de cookies.
- Correção pontual autorizada: documentação de proveniência saiu de `apps/web/public/product/README.md` para `docs/gtm/product-screenshot-provenance.md`, sem paths internos na cópia versionada. Remoção aplicada ao export, preview reiniciado sem rebuild; rota retornou 404, dois assets e home retornaram 200. Produção intocada.
- Security t_c3a8de4c permite continuar pacote/contratos locais, NÃO testes autenticados nem distribuição. Além das annotations e escopos, há gate de minimização: `get_email` entrega corpo/remetente/destinatários ao host. Para consulta apenas de status, justificar esse acesso ou aprovar delta servidor; omitir dados na resposta do assistente não impede transmissão ao host. Teste autenticado futuro exige autorização separada e conta dedicada não cliente. Perfil/CIMD/UserInfo Enterprise não são requisitos universais inventados para bloquear o pacote.
