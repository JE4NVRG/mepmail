# MepMail — landing pública de vendas

Spec de implementação e copy final · rota `/` para visitantes deslogados · idioma pt-BR.

## Contrato da oferta

Fonte de verdade da oferta e dos comparativos: `JE4NDEV-Memory-Vault/02_Projects/MepMail/GTM-Primeiro-Faturamento.md`, §§1–2 (decisão de 27/09/2026); degraus e limites de anexo confirmados em `packages/core/src/plans.ts` (`PLAN_RUNGS`, `PLAN_ATTACHMENT_BYTES`). Valores desta página são mensais em USD. Primeiros clientes: cobrança manual via PIX em BRL pela cotação do dia, com fatura simples; não sugerir checkout nem conversão fixa. Venda concierge: acesso liberado após contato, sem cadastro público. O Free é um degrau disponível por provisionamento assistido, não um convite para abrir conta. A oferta de lançamento é setup grátis e 2 meses de gestão grátis para os 3 primeiros clientes; por ser limitada e dependente de disponibilidade, apresentá-la como condição sujeita a confirmação por contato, nunca como contador ou vaga em tempo real.

## Copy final — ordem da página

### 1. Cabeçalho e hero

- Logo: wordmark MepMail existente, à esquerda, com link para `/`. À direita: âncoras `#comparativo` («Comparar preços»), `#planos` («Planos»), `#como-funciona` («Como funciona») e link `/login` («Entrar»); em largura estreita, manter logo, «Entrar» e CTA, e mover âncoras para navegação acessível ou omiti-las (as seções continuam no fluxo).
- Sobretítulo: «E-mail transacional para quem constrói produtos no Brasil».
- H1: «Mesma API do Resend. Até 60% mais barato.»
- Subtítulo: «Envie e-mails transacionais com API HTTPS compatível com o Resend ou relay SMTP. Nós ajudamos a configurar seu domínio, DKIM e MAIL FROM. Planos em USD, atendimento em português e implantação assistida.»
- CTA principal, rótulo exato «Solicitar acesso»: `mailto:jean@je4ndev.com` (sem assunto predefinido). Apoio sob CTA: «Sem cadastro público. Conte seu volume de envio e receba orientação sobre o plano.»
- Link secundário «Ver planos» → `#planos`. Sem formulário de cadastro ou promessa de ativação automática. **WhatsApp descartado (decisão do Jean, 27/09/2026): nenhum botão/link de WhatsApp deve existir, em nenhuma hipótese.**

### 2. Prova de preço (`#comparativo`)

- H2: «Compare pelo volume que você realmente envia.»
- Texto: «Os valores abaixo comparam o menor plano que cobre cada volume mensal. A economia varia por faixa e fornecedor; confirme condições atuais antes de contratar.»
- Tabela legível com cabeçalhos «Envios/mês», «MepMail», «Resend», «SendGrid», «Postmark», «Mailgun», «Vantagem». Renderizar exatamente estes valores (USD/mês):

| Envios/mês | MepMail | Resend | SendGrid | Postmark | Mailgun | Vantagem |
|---|---:|---:|---:|---:|---:|---:|
| 100k | US$ 20 | US$ 35 | US$ 34,95 | US$ 115 | US$ 90 | 43% |
| 200k | US$ 69 | US$ 160 | US$ 249 | US$ 245 | US$ 215 | 57–72% |
| 500k | US$ 159 | US$ 350 | US$ 499 | US$ 455 | US$ 400 | 55–68% |
| 1M | US$ 259 | US$ 650 | US$ 799 | US$ 775 | US$ 700 | 60–68% |
| 1,5M | US$ 369 | US$ 825 | US$ 799 | US$ 775 | US$ 700 | 47–55% |
| 2,5M | US$ 549 | US$ 1.150 | US$ 1.099 | (vendas) | US$ 1.250 | 50–56% |

- Nota visível abaixo: «Referência da análise comercial de 27/09/2026; preços públicos de terceiros podem mudar e condições/recursos não são equivalentes. Valores em USD por mês, sem impostos ou excedentes. “(vendas)” indica cotação comercial, não preço público.» Não calcular outro percentual nem transformar a faixa «78–86%» em uma promessa superior à âncora do hero.

### 3. Por que custa menos

- H2: «Menos camadas entre sua aplicação e a entrega.»
- Texto: «Operamos nossa própria camada de API, relay e painel sobre o Amazon SES. O envio é contratado à la carte, sem repassar a estrutura de preços de um intermediário. É assim que oferecemos preços menores sem vender uma cópia de todas as funcionalidades de outros provedores.»
- Três pontos curtos: «Infraestrutura de operação própria: API, relay e painel MepMail.» · «Envio via Amazon SES à la carte.» · «Implantação acompanhada, sem intermediário de atendimento.»

### 4. Planos (`#planos`)

- H2: «Escolha o volume. Nós ajudamos na configuração.»
- Intro: «Todos os planos incluem onboarding assistido e suporte em português. Preços mensais em USD; para os primeiros clientes, cobrança via PIX em BRL pela cotação do dia.»
- Oito degraus, sem ocultar os maiores em abas; cada linha/card contém nome, cota, preço, anexo por mensagem, regra de excedente e CTA «Solicitar acesso» para o mesmo `mailto:jean@je4ndev.com`. A cotação mensal aproximada de Free e Starter é ilustrativa; o limite efetivo é diário (UTC). Para Pro e Scale, o excedente é por 1.000 e depende da habilitação no provisionamento; sem ele os envios param na cota. Há teto de segurança de 5× o volume incluído mesmo com excedente habilitado — não dizer «envios ilimitados».

| Plano | Volume incluído | Preço/mês | Excedente | Anexos por mensagem |
|---|---|---:|---|---:|
| Free | 100/dia (~3k/mês) | US$ 0 | para no cap | 1 MB |
| Starter | 1.500/dia (~45k/mês) | US$ 9 | para no cap | 1 MB |
| Pro 100K | 100.000/mês | US$ 20 | US$ 0,30/1k | 5 MB |
| Pro 200K | 200.000/mês | US$ 69 | US$ 0,30/1k | 5 MB |
| Scale 500K | 500.000/mês | US$ 159 | US$ 0,25/1k | 10 MB |
| Scale 1M | 1.000.000/mês | US$ 259 | US$ 0,20/1k | 10 MB |
| Scale 1.5M | 1.500.000/mês | US$ 369 | US$ 0,18/1k | 10 MB |
| Scale 2.5M | 2.500.000/mês | US$ 549 | US$ 0,16/1k | 10 MB |

- Abaixo da grade: «Gestão proativa opcional: +US$ 29/mês. Inclui monitoramento de reputação, ajustes de DNS/entregabilidade e prioridade de atendimento. Sem gestão, você continua com onboarding assistido e suporte. Sem fidelidade.»
- Faixa de lançamento: «Para os 3 primeiros clientes: setup grátis e 2 meses de gestão grátis. Consulte a disponibilidade ao solicitar acesso.» Não aplicar o desconto automaticamente em um total calculado; o prazo depende do fechamento dos clientes.
- Nota de anexos: «Limite por e-mail: tamanho total dos anexos após decodificação, não por arquivo.»

### 5. Como funciona (`#como-funciona`)

- H2: «Da conversa ao primeiro envio, com ajuda de quem construiu.»
- Passo 1: «Conte seu volume mensal e como envia hoje. Indicamos o degrau e combinamos o acesso.»
- Passo 2: «Configuramos seu domínio de envio com você: registros DNS para DKIM e MAIL FROM, verificação e chave de API dedicada ou credenciais do relay SMTP.»
- Passo 3: «Faça um envio de teste pela API ou pelo relay. Você acompanha logs, domínios, supressões e métricas no painel MepMail.»
- Nota de prazo: «A configuração assistida costuma levar cerca de 15 minutos depois que você tem acesso ao DNS; a propagação e a verificação do domínio podem levar mais tempo. A verificação automática roda a cada 15 minutos.»
- CTA «Solicitar acesso» → `mailto:jean@je4ndev.com`.

### 6. Entregabilidade e integração

- H2: «Sua identidade de envio, sua integração.»
- Texto: «Cada cliente usa um domínio de envio próprio verificado com DKIM e MAIL FROM no Amazon SES, com reputação isolada. Escolha a API HTTPS compatível com chamadas de envio do Resend, com base URL `api-mepmail.agenciamep.com`, ou o relay SMTP com STARTTLS em `smtp-mepmail.agenciamep.com:2587`. A chave de API é dedicada à sua operação.»
- Nota: «Compatibilidade de API não significa paridade de recursos: inbound, IP dedicado e SSO não fazem parte desta promessa. A entrega na caixa de entrada depende também do domínio, do conteúdo e da reputação de envio.»

### 7. Perguntas frequentes

H2: «Perguntas antes de migrar»; seis pares de pergunta/resposta, nessa ordem:

1. «Já uso Resend. Preciso reescrever minha integração?» — «Para os fluxos de envio compatíveis, você pode manter o SDK oficial do Resend e trocar a base URL e a chave. Revisamos sua integração na migração para identificar recursos que não são equivalentes. Não prometemos paridade total de funcionalidades.»
2. «Vocês garantem entrega na caixa de entrada?» — «Não. Configuramos DKIM e MAIL FROM no domínio de envio e acompanhamos a reputação, mas a classificação final depende dos provedores de destino, do seu conteúdo e do histórico do domínio. Não existe garantia honesta de caixa de entrada.»
3. «Existe fidelidade ou multa para cancelar?» — «Não há fidelidade. Você pode pedir o cancelamento sem multa; combinamos o encerramento dos envios e a retirada das configurações de DNS quando aplicável.»
4. «Qual o limite de anexos?» — «O limite total por mensagem é de 1 MB no Free e Starter, 5 MB no Pro e 10 MB no Scale. Vale para a soma dos anexos decodificados, não para cada arquivo separadamente.»
5. «O que acontece quando passo da cota?» — «No Free e Starter, os envios param no limite diário. Nos planos Pro e Scale, com excedente habilitado, os envios adicionais são cobrados pela tarifa de cada plano por 1.000 e respeitam o teto de segurança de 5× o volume incluído; sem excedente habilitado, param na cota mensal. Se você prevê aumento de volume, fale conosco antes.»
6. «O suporte é em português?» — «Sim. O onboarding é assistido e o suporte é direto em português com quem construiu o produto. A gestão proativa é opcional e adiciona monitoramento, ajustes e prioridade de atendimento.»

### 8. Encerramento e footer

- H2 de encerramento: «Vamos encontrar o plano para o seu volume?»
- Texto: «Conte como você envia hoje e receba uma orientação de migração, sem criar conta nem mudar tudo de uma vez.»
- CTA «Solicitar acesso» → `mailto:jean@je4ndev.com`.
- Footer: wordmark existente, «MepMail · E-mail transacional com implantação assistida no Brasil», link «Entrar» → `/login`, link «Contato» → `mailto:jean@je4ndev.com`. Não inventar endereço, CNPJ, páginas legais, perfis sociais ou depoimentos. Se alguma página legal for posteriormente aprovada, adicionar link apenas quando a rota existir.

## Direção visual e handoff de implementação

- Produto existente, não rebranding: usar `/logo/mepmail-wordmark.svg` no fundo escuro, `/logo/mepmail-wordmark-light.svg` somente em fundo claro; favicon existente em `/logo/mepmail-favicon.svg` ou `/favicon.ico`. Não usar screenshots do painel como prova social sem autorização. A marca violeta já está no gradiente do wordmark; usar `--ms-violet`/`--ms-violet-bg` para pequenos destaques e `--ms-bone` para ação principal. Fundo escuro `--ms-void` (#000000), seções alternadas `--ms-ground` (#050505), cards `--ms-panel` (#0c0c0d), bordas `--ms-line-strong` (#2a2a2e), texto `--ms-bone` (#f4f1ea), secundário `--ms-muted` (#918f89). Nunca usar `--ms-faint` para texto legível.
- Reusar tokens em `apps/web/src/styles/tokens/{colors,typography,spacing,motion}.css` e classes existentes em `apps/web/src/styles/components.css` (`ms-card`, `ms-btn`, `ms-btn-primary`, `ms-btn-secondary`); o repo não possui `components.json`/shadcn configurado, portanto não instalar nem inventar esse kit. Preferir uma folha local escopada à landing para layout e tipografia editorial; sem alterar tokens globais. Sans do produto para títulos/texto, `--ms-font-mono` somente para números/etiquetas de preço.
- Mobile-first: área útil 320 px sem overflow horizontal da página, padding lateral 16 px; ≥640 px 24 px; ≥1024 px 32 px, largura máxima 1200 px centralizada. Hero em coluna com largura de leitura ≤760 px; H1 36 px/1.08 mobile, 56 px/1.05 desktop, peso 700; H2 28 px/1.15 mobile e 36 px/1.15 desktop; corpo 16 px/1.55; detalhes 14 px/1.5. Usar espaçamento de 4 px conforme `--ms-sp-*`: seção 64 px vertical mobile e 96 px desktop, intervalos entre cards 16–24 px. Uma única H1 e H2 por seção, IDs estáveis nos links de âncora.
- Hero sem mock de gráfico ou badges com números inventados. Prova de preço antes da grade de planos para apoiar a âncora de economia; destaque discreto somente para a coluna MepMail. Comparativo: em mobile rolagem horizontal **dentro** de região nomeada («Comparativo de preços por volume») com indicação visual de rolagem, cabeçalhos `scope="col"` e primeira célula da linha com `scope="row"`; sem cortar números e sem encolher fonte abaixo de 14 px. Planos: cards em uma coluna no mobile; duas colunas ≥640 px, quatro ≥1024 px, com alinhamento de preços e CTAs; não promover um plano como «mais popular» sem dado. Tabela de oito degraus acima serve como conteúdo obrigatório, mas UI pode ser grade de cards se todos os campos estiverem visíveis sem interação. Gestão opcional e oferta de lançamento em faixa separada abaixo da grade. FAQ em lista de `<details>/<summary>` nativos ou componente acessível equivalente, primeiro item fechado por padrão, preservando leitura sem JavaScript.
- CTA real como `<a href="mailto:jean@je4ndev.com">Solicitar acesso</a>` estilizado com classes existentes; altura mínima 44 px e foco visível de 2 px com offset, sem depender só de cor. Hover com leve alteração de opacidade/cor e sem deslocamento de layout; active explícito, `prefers-reduced-motion: reduce` sem transições não essenciais. Links e botões com alvos ≥44×44 px e estados de foco também nas âncoras do cabeçalho, FAQ e link de login.
- Contraste AA: texto normal ≥4,5:1, texto grande e fronteiras de elementos de interface ≥3:1 no fundo real; checar inclusive a nota de preços e foco. Não usar violeta saturado de marca como texto pequeno sobre preto sem medir; usar `--ms-violet` para texto e `--ms-violet-bg` para chips apenas após checagem, e `--ms-bone` para CTA de alto contraste. Não usar `--ms-line` isoladamente como único delimitador de controle quando sua razão for insuficiente. Navegação por teclado em ordem DOM, sem carrossel, modal de captura ou CTA fixo cobrindo conteúdo; zoom 200% sem perda.
- Estados: links/CTA default, hover, focus-visible e active; FAQ fechado/aberto; sem estados de carregamento para preços estáticos. Navegação para âncoras com `scroll-margin-top` se o cabeçalho for sticky. Respeitar tema configurado: no tema claro, usar wordmark light e as variantes de tokens existentes; não renderizar texto claro sobre fundo claro. Sem imagens geradas: SVGs existentes bastam, sem dependência de rede externa ou fonte nova.
- SEO para a rota pública: `title` «MepMail — E-mail transacional com API compatível com Resend», descrição «E-mail transacional com onboarding assistido no Brasil. Compare planos MepMail, envie pela API compatível com Resend ou relay SMTP e solicite acesso.», OG com marca existente somente se o ativo for conferido no repo. Não aplicar metadados comerciais a `/login` ou ao painel. Visitante deslogado vê a landing em `/`; autenticado mantém navegação ao dashboard; `/login` permanece funcional. Sem CTA para `/signup` ou `/register` em qualquer breakpoint.

## Aceite do design

- Confere os oito degraus, anexos, excedentes e seis linhas do comparativo com as fontes citadas; nenhuma porcentagem nova foi derivada. Condições de excedente e PIX visíveis; Free/Starter têm cota diária, não mensal garantida.
- Headline, CTA por e-mail, FAQ completo e nenhuma alegação de inbox garantida, feature parity total ou prova social não verificada. Checagem responsiva em 320, 390, 768 e 1280 px, zoom 200%, navegação somente por teclado, contraste AA e preferência por movimento reduzido.
- Na implementação: **WhatsApp descartado (27/09/2026)** — nenhum botão/link de WhatsApp; nenhum placeholder deve ser exibido na página.

## Decisões pendentes do Jean / placeholders

| Placeholder | Decisão e comportamento enquanto pendente |
|---|---|
| ~~`[WHATSAPP_URL]`~~ | **Descartado (27/09/2026)**: Jean não usará WhatsApp por ora; sem URL oficial. Nenhum botão/link de WhatsApp. Todos os CTAs continuam no e-mail acima. |
