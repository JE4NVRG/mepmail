# Imagem estática no acesso: contrato de preview e gate mobile

Direção/aceite: Luna + Jean. Executor único: Dev; revisão independente: QA no mesmo card t_dd7bd2e2. Jean rejeitou o vídeo, inclusive a versão 1,5×: usar somente a imagem aprovada. Produção autorizada após gates e QA, em etapa separada; este card não faz push, merge ou release. O nome deste documento permanece para preservar referências históricas.

## Resultado e escopo
Substituir exclusivamente a captura de templates do AuthScreen pela ilustração aprovada: template FIRST_NAME conectado a versões fictícias Ana/Sam. Landing mantém screenshot real. Login, cadastro e recuperação reutilizam a mesma apresentação; formulário e CTA permanecem dominantes. Copy EN/PT curta, sem promessa de conversão, entrega ou tempo. Não alterar backend, autenticação/OAuth, next, captcha, consentimento, billing, envio, dados ou infraestrutura.

## Mídia e comportamento
- Reutilizar auth-personalization.webp existente, sem gerar mídia. Preservar o original e evidências históricas no Kanban; retirar apenas o MP4 sem uso do bundle público.
- Imagem contain em desktop >=960px. Zero vídeo, controlador, hooks de reprodução e traduções de pausa/reprodução.
- Abaixo de 960px: formulário primeiro, painel de arte oculto e nenhum download de imagem de personalização. picture com source condicionado ao viewport e fallback inline funciona também sem JS.
- Sem JS e com reduced-motion: mesma imagem estática desktop e formulário SSR legível. Mídia nunca bloqueia formulário.
- Preto/marfim/violeta contido; painel sem molduras aninhadas/glow. Mensagem acima da arte, sem crop de texto. Light mantém arte escura intencional e contraste do formulário.

## Gates e execução
Reutilizar feat/launch-readiness e export Windows F:\MepMail, preview 9897 e túnel existente. Comparar apenas paths afetados antes de sincronizar; preservar WIP divergente. Nenhuma dependência nova. Build/testes no Windows com ambiente dummy existente. Antes do build parar apenas listener Next start 9897 validado; porta livre, build único, restart persistente e BUILD_ID servido verificado.

Gates: Biome dos arquivos alterados; TypeScript; testes focais da imagem e email-first/i18n; build local Windows. Browser real emulado: landing, login, signup e recuperação em 360/390/430/768px, smoke desktop 1440px; EN/PT e light/dark representativos. Zero overflow horizontal, CTA/campos acessíveis, toque e teclado sem cortes, foco email→senha, navegação/idioma/next preservados. Provar ausência de vídeo no DOM/rede e de download da arte mobile; registrar screenshots e BUILD_ID servido em mepmail-static-mobile. Não confundir emulação com telefone físico. Não executar autenticação/cadastro/envio/analytics reais.

## Entrega e publicação
Imagem e código finais no Git; evidência curta em dev-result.md e docs/gtm/static-mobile-preview.md. Commit apenas local após gates verdes. Encaminhar reviewer=qa, sem autoaprovação. Reproduzir localmente com wrappers existentes build.ps1/start.ps1 via win.py, mesma porta/túnel; preview dummy não é artefato de produção nem prova de auth/OAuth/backend reais. Luna conduz release separado após QA, sem publicar o build dummy. Padrão JE4NDEV-LOCAL-FIRST-v1 vigente.
