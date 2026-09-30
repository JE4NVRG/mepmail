# Vídeo de personalização no acesso: contrato de preview

Direção/aceite: Luna + Jean. Executor único: Dev; revisão independente: QA no mesmo card t_00a11b69. Autorização: remover áudio do vídeo enviado e integrar somente ao preview existente. Sem produção, push, merge ou release.

## Resultado e escopo
Substituir exclusivamente a captura de templates do AuthScreen pela ilustração aprovada: template FIRST_NAME conectado a versões fictícias Ana/Sam. Landing mantém screenshot real. Login, cadastro e recuperação reutilizam a mesma apresentação; formulário e CTA permanecem dominantes. Copy EN/PT curta, sem promessa de conversão, entrega ou tempo. Não alterar backend, autenticação/OAuth, next, captcha, consentimento, billing, envio, dados ou infraestrutura.

## Mídia e comportamento
- Fonte imutável: attachment t_3b42fb3b/mepmail-login-video-grok-v1.mp4. Remux somente 0:v:0 H264, sem áudio/capa/metadados, +faststart; preservar 960×960, duração e frames. Poster WebP do primeiro frame real.
- Vídeo contain, inline e muted. Autoplay/loop apenas desktop >=960px, documento visível e sem reduced-motion. Loop condicionado à observação do seam.
- Controle EN/PT de pausa/reprodução >=44px com foco visível. Pausa manual persiste em rerender, idioma e retorno à página.
- Mobile não requisita vídeo nem poster. Reduced-motion inicial não requisita MP4; mudança dinâmica para reduce desmonta o vídeo e exibe poster. Retorno respeita pausa manual.
- Sem JS: poster responsivo desktop e formulário SSR legível. Autoplay negado: poster e botão para tentar reprodução, promessa rejeitada tratada. Mídia nunca bloqueia formulário.
- Preto/marfim/violeta contido; painel sem molduras aninhadas/glow. Mensagem acima da arte, sem crop de texto. Light mantém arte escura intencional e contraste do formulário.

## Gates e execução
Reutilizar feat/launch-readiness e export Windows F:\MepMail, preview 9897 e túnel existente. Comparar apenas paths afetados antes de sincronizar; preservar WIP divergente. Nenhuma dependência nova. Build/testes no Windows com ambiente dummy existente. Antes do build parar apenas listener Next start 9897 validado; porta livre, build único, restart persistente e BUILD_ID servido verificado.

Gates: ffprobe de stream único; Biome dos arquivos alterados; TypeScript; testes focais de mídia e email-first/i18n; browser real EN/PT, 1440×900 e 1280×720, mobile, light/dark, teclado, pause/play/loop, visibility, reduce inicial/dinâmico, ausência de downloads mobile/reduce, next/foco senha, sem overflow/erros novos. Screenshots e gravação real em mepmail-login-video-integration. Não executar autenticação/cadastro/envio/analytics reais.

## Entrega e publicação
Assets finais no Git; evidência curta em dev-result.md e docs/gtm/login-video-preview.md. Commit apenas local após gates verdes. Encaminhar reviewer=qa, sem autoaprovação. Sem implantação em produção autorizada: para reprodução local usar wrappers existentes build.ps1/start.ps1 via win.py; autorização futura de Jean é necessária antes de qualquer release. Padrão JE4NDEV-LOCAL-FIRST-v1 vigente.
