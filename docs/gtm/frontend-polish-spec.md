# Polimento de frontend: contrato de preview

Direção: Luna. Executor único: Dev. Autorização de Jean amplia a rodada CRO exclusivamente para apresentação e estados UX de auth. Este adendo prevalece sobre a exclusão anterior de autenticação no PRD de landing, sem autorizar mudança de backend, protocolo, segurança ou políticas.

## Resultado esperado
- Copy EN/PT natural, sem U+2014 editorial em landing, chrome, planos, comparação, integrações e auth. Preservar placeholders e comandos. Remover promessa de ativação em um clique.
- AuthScreen compartilhado: painel de produto assimétrico desktop com screenshot sanitizado já existente; formulário em superfície calma, sem tecido/WebGL. Mobile sem painel lateral. Wordmark e voltar ao site continuam apontando para /; idioma persiste por cookie.
- Controles 48px, olhos >=44px, inputs 16px, contraste AA e foco explícito. Preservar cinco campos do cadastro, confirmação, meter e olhos existentes.
- Login email-first com ação explícita Continuar com e-mail, instrução curta e foco na senha. Pending visível/anunciado e sem duplicidade; erros associados e live; falha de rede recuperável sem limpar campos. Preservar safeNextPath, next/invite/email, captcha, consent, callbacks e flags reais de providers.
- Motion funcional: entrada sequenciada do hero, prova do produto, grupos de seções no viewport, tabs, auth e etapa de senha; microinterações. Contrato completo no DESIGN.md. SSR legível sem JS e reduced-motion seguro.

## Evidência e gates
Reutilizar F:\MepMail via win-je4ndev para testes/build e preview 9897. Antes de sobrescrever fontes divergentes, preservar bytes e manifesto fora de cache; comparar SHA256 das fontes. Parar somente listener conhecido antes do build, verificar porta livre, novo build ID e marcador servido.

Testes focados de UX/copy/motion, i18n, CRO, safe next, signup, atribuição HTTP, funil e planos; Biome e tsc web; build Windows. Browser real EN/PT em 1440x1000, 768x1024, 390x844, 375x667: home/login/signup/forgot; smoke reset/verify/updates/consent/pricing/alternativa; overflow, keyboard, links, assets e erros. Provar motion no runtime e vídeo real, reduced-motion e fallback sem JS. Testes de componente com stubs explicitamente rotulados não provam OAuth nem backend.

## Limites de execução e entrega
Sem produção, push, merge, novo ambiente, dependência, fonte externa, envio de e-mail, signup real, cobrança, analytics reais ou escrita de banco. Ambiente dummy MEPMAIL_LOCAL_PREVIEW=1 e collectors vazios. Não transportar secrets/env/node_modules nem forçar flags OAuth. AGENTS.md na raiz não existe neste checkout; apps/web/AGENTS.md é o contrato disponível.

Entregar docs/gtm/frontend-polish-preview.md, evidência real em /home/jean/.hermes/cache/scratch/mepmail-polish/, commit LOCAL após gates verdes e handoff na issue #45. Revisão independente no mesmo card por qa; Luna valida antes de apresentar. Publicação depende de autorização posterior: nenhuma instrução deste adendo autoriza deploy.
