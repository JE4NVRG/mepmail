# MepMail — direção de conversão da landing

Dona da direção e revisão: Luna. Solicitação de Jean: melhorar diretamente o front-end, pesquisar referências e fazer a página vender melhor. Escopo aprovado: redesign e validação em preview, NÃO deploy/merge em produção.

## Objetivo / PRD da mudança
Transformar a home de descrição de infraestrutura em uma jornada de aquisição para builders, times SaaS e desenvolvedores de automações. A ação principal é criar conta grátis; a secundária é entender o produto. Resultado desta rodada: página real em PT/EN, funcionando em desktop/mobile, com oferta factual, prova de produto, caminhos para cadastro/preço/docs e eventos preservados. Melhora de conversão é hipótese: não declarar lift sem tráfego externo limpo e período de medição.

Não-escopo: mudar planos/billing/quotas, engine de envio, autenticação, banco, DNS, infraestrutura, configuração de analytics, publicar release ou reativar divulgação no X.

## Pesquisa (páginas reais inspecionadas)
- https://resend.com — proposta curta e específica, ritmo tipográfico, integração concreta. Aproveitar concisão e foco; NÃO imitar marca, usar ativos ou reproduzir promessas de entregabilidade.
- https://loops.so — texto da página: apresenta plataforma e mostra o fluxo do produto antes de listar arquitetura. A captura visual inicial ficou branca; não usar aquele screenshot como referência visual validada.
- https://www.useplunk.com — hierarquia de título/CTA, preço e open source fáceis de localizar; seção de agentes integrada à narrativa. Não usar seus números, logos de clientes ou depoimentos.
- https://postmarkapp.com — linguagem orientada ao trabalho do usuário e suporte visível, integração seguida de confiança.
Capturas/DOM: /home/jean/.hermes/cache/scratch/mepmail-cro/{resend,loops,plunk,postmark}-*.png e *-page.json.

Constatação importante: Loops e Plunk JÁ anunciam agentes/MCP. Não dizer que MepMail é o único, primeiro ou que nenhum concorrente tem MCP.

## Auditoria da home atual
- H1 abstrato: infraestrutura que você entende. Subtítulo mistura SES, arquitetura, isolamento, preço, agentes e suporte.
- Mostra código, mas não a interface do produto. Comparação de fornecedores vem antes de demonstrar o MepMail.
- MCP só explicado muito abaixo. Não inventar métricas de clientes/envio/uptime para preencher esse vazio.
- Em 390×844 o CTA real está visível (y~665 a 709): o problema é aparecer tarde, NÃO estar fora da dobra. Meta desta rodada: CTA primário inteiramente antes de y=600 em 390×844.
- DESIGN.md tem tokens corretos no início e prosa antiga sobre VoltAgent/verde depois. Reconciliar; não herdar o verde.

## Copy definida pela Luna
PT:
- Eyebrow curto: E-MAIL PARA PRODUTOS E AGENTES
- H1: Envie e-mails. Continue construindo.
- Lead: Notificações, recibos e campanhas por API, SMTP ou agentes de IA. Controle seus envios em um só painel.
- CTA primário: Começar grátis → fluxo real /signup com atribuição preservada.
- CTA secundário: Conhecer o produto → #product.
- Nota: 100 e-mails por dia no plano grátis. Sem cartão.
- Oferta em linha separada e escaneável: 110.000 e-mails/mês por US$ 20. Não chamar de preço inicial pois Starter de US$ 9 existe.
- Próximo título: Do primeiro envio ao próximo crescimento.
- Produto: Templates prontos. Menos trabalho para começar.
- Integração: Seu código. Seu fluxo. Seu agente.
- Valor: Domínio próprio. Visibilidade de cada envio. Apoio de quem constrói.
- Preços: Comece grátis. Cresça por volume.
- CTA final: Seu próximo envio começa aqui.
EN natural equivalente:
- EMAIL FOR PRODUCTS AND AGENTS
- Send emails. Keep building.
- Notifications, receipts and campaigns through API, SMTP or AI agents. Manage your sending in one dashboard.
- Start free / Explore the product
- 100 emails a day on the free plan. No credit card.
- 110,000 emails/month for US$20.
- Ready-made templates. Less work to get started.
- Your code. Your workflow. Your agent.
- Start free. Scale by volume.
- Your next email starts here.
Adaptar a gramática aos componentes existentes; manter o sentido e a economia de texto. Não prometer entrega garantida, zero spam, reputação totalmente isolada de infraestrutura compartilhada, setup em um minuto, ou e-mails ilimitados.

## Arquitetura e direção visual
Preservar branding MepMail e header/footer atuais (incluindo rotas reais de docs/suporte/segurança e seletor de idioma). Não reabrir a discussão de navegação da rodada anterior.
1. Hero compacto: título grande (~68–76px desktop, ~40–46px mobile), largura controlada, peso 500–600, line-height ~1.04. Lead ~18px/1.55, no máximo 3 linhas desktop. CTA principal bone no dark; secundário outline/ghost. Sem brilho exagerado, gradients decorativos ou headline toda violeta.
2. Área hero à direita: prova REAL do produto (galeria/templates com recorte seguro) em moldura leve. Não construir painel falso com números. Em mobile texto/CTA primeiro, imagem depois. Legenda factual: galeria de templates do MepMail; screenshot em inglês se só EN disponível.
3. Strip compacto de integrações reais, SEM transformar logos de ferramentas em clientes. Preservar logos e seus rótulos verdadeiros (comunitário/compatibilidade/canais).
4. #product: resultado concreto e prova de produto. Três benefícios curtos ligados a telas existentes: domínio verificado, templates/campanhas e acompanhamento de envios. As alegações precisam ser confirmadas no código. Evitar grade genérica de seis cards idênticos com ícone.
5. Integração: componente funcional de tabs API / SMTP / Agentes, se viável sem dependência nova. O CodeDemo existente cabe no painel API; SMTP mostra instrução factual de integração sem credenciais; Agentes explica @mepmail/mcp e aponta para #mcp. Conteúdo estático sem rede é preferível a fingir um envio vivo. Snippets são EXEMPLOS rotulados, não resultados simulados. Compatibilidade Resend fica só como detalhe de migração.
6. #mcp: trazer para antes dos preços; mostrar comando/config real e copy funcional, preservar tracking mcp-config-copy. Não expor chaves.
7. #planos: destacar Free, Starter e Pro110K (sem inventar 'mais popular' por volume de clientes; usar 'Para crescer' se badge for editorial). Mais volumes acessíveis por disclosure/link real para /pricing. Nenhum plano removido do catálogo. Dados de packages/core/src/plans.ts e landing-plans.ts — não duplicar limites manualmente.
8. #comparativo: depois dos planos, calculadora existente + details acessível para tabela detalhada. Manter fontes/datas/disclaimer. Não recalcular comerciais nesta rodada.
9. Passos de ativação curtos: criar conta → verificar domínio → integrar e acompanhar. Sem promessa de tempo não testada.
10. FAQ factual e CTA final com signup, não mailto como única saída.

Tokens: preservar --ms-void #000, --ms-ground #050505, superfícies #0c0c0d/#131316, bone #f4f1ea, aço #7f8791, violeta #c0a8e1. Texto auxiliar legível: revisar cinza atual e elevar para ~#aaa7a0 quando necessário em escopo .gtm. Container ~1180px; gutters 20 mobile/32 desktop; seções 64–88px desktop/48 mobile, ritmos variados. Cards 12–16px radius e hairlines discretas. Não alterar globalmente UI autenticada. Zero novas libs, fontes externas, animações bloqueando render ou paralaxe.

## Prova de produto / privacidade
Existem capturas de QA do produto em /home/jean/.hermes/cache/scratch/mepmail-gallery-live.png e mepmail-template-from-starter.png. Galeria é preferível. Conferir dimensões reais; recortar somente o painel de templates, EXCLUINDO completamente sidebar com avatar/nome/e-mail. Verificar imagem recortada com vision antes de incluí-la. Não anonimizar preenchendo dados inventados. Não publicar screenshot original nem copiar dados reais para fixture. Registrar proveniência, rota /templates/new e recorte. Se prova da origem não for suficiente, usar app real numa sessão existente de QA somente leitura; nunca criar sessão privilegiada ou escrever no banco para fotografia. Nunca capturar/inserir métricas de clientes. Entregar asset WebP otimizado com dimensões e texto alternativo; sem perda de legibilidade.

## Constituição / guardrails da mudança
Conservar AGPL/NOTICE, origem/licença dos logos, EN como default e PT completo, API/Stripe/planos intactos; preservar atribuição UTM e eventos Umami; nenhuma PII em assets/logs. Sem mock de dashboard, depoimento inventado, selo indevido, FOMO, autoenvio de e-mail ou compra. Nenhum push main, merge ou deploy. Um executor por arquivos. Reutilizar checkout/branch/ambiente, builds e QA local Windows; sem clone, worktree ou stack nova. Padrão completo: /home/jean/.local/share/je4ndev-delivery/Engineering-Delivery-Standard.md.

## Aceite
- Spec/PRD/constitution desta mudança e DESIGN coerente salvos no repositório ANTES do código; referenciar PRD/constitution existentes se houver. Não fingir aprovação de um PRD inteiro ou criar escopo de produto novo.
- Preview real da revisão nova acessível ao Jean; marker do novo H1 verificado, sem HTML antigo/asset novo.
- PT e EN: desktop 1440×1000, tablet 768×1024, mobile 390×844 e 375×667; sem overflow horizontal. H1/CTA mobile visíveis antes do produto.
- CTAs navegam corretamente, menu fecha por Escape, foco visível, tabs operáveis por teclado e ARIA, details funciona, âncoras respeitam header sticky.
- Sem errors de render/hydration, screenshots de páginas completas e crops principais; recursos locais sem 404.
- Testes de i18n/paridade, landing/plans/eventos pertinentes, Biome e TypeScript web; build do web local. Reutilizar gates não afetados. Testes sem env de produção e analytics de QA não enviados para produção.
- QA independente e revisão visual da Luna. Evidência é pass/fail real, não nota perfeita por conveniência.
- Publicação depende de aprovação posterior do Jean.
