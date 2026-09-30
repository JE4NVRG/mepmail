# Correções de confiança e conversão — t_b8f01b8a

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
