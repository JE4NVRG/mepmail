# Preview estático e gate mobile

Card: t_dd7bd2e2. Branch existente: feat/launch-readiness. Baseline: 84b51e70. Spec vigente: [login-video-spec.md](login-video-spec.md); DESIGN.md 1.3. Relatos anteriores de vídeo são históricos e estão substituídos por esta entrega.

## Resultado

AuthArt agora contém somente a WebP existente template FIRST_NAME → Ana/Sam. Removidos vídeo, hooks/controlador, estilos e traduções de reprodução, teste sintético de playback e MP4 público sem consumidores. Original/evidência histórica preservados; nenhuma mídia gerada. Abaixo de 960px, arte oculta sem download, formulário primeiro. Sem mudanças nos contratos auth, backend, OAuth, captcha, next ou pricing; nenhuma regressão de layout que exigisse redesign foi encontrada.

## Evidência executada

- Preview: http://127.0.0.1:9897/login, mesmo export F:\MepMail, porta e túnel.
- BUILD_ID anterior: 2fyJDQAtKJupvdhQfYYzf; atual: sWNo_0vq1OIqHoj_WixXq. Manifest atual servido HTTP200 em /_next/static/sWNo_0vq1OIqHoj_WixXq/_buildManifest.js; MP4 removido responde 404. WebP servida com SHA256 idêntico ao arquivo Git.
- Windows: Biome focal (5 arquivos), 71 testes em 4 suites, TypeScript e next build --webpack aprovados. Build registra ECONNREFUSED do banco dummy 127.0.0.1:1; não representa regressão nem validação de backend.
- Chromium real, viewport/toque emulados: 40 casos, landing/login/signup/forgot-password em 360×800, 390×844, 430×932, 768×1024 e 1440×900, EN-dark e PT-light. 332 checks aprovados: rota exata, DOM sem vídeo/controlador auth, rede sem MP4, zero overflow horizontal, campos/CTA alcançáveis e dimensões de toque auth, ausência de download da arte abaixo de 960px, foco email→senha, teclado e persistência de email/next ao mudar idioma. Desktop sem JS também validado.
- 80 checks adicionais: menu mobile abre por toque e fecha com Escape, controles do menu dentro do viewport, hero CTA termina antes de y=600, CTA navega ao signup, login↔signup preserva next, recuperação recebe email, reset exibe ambos os campos. Viewport reduzido para 440px de altura verifica acesso ao campo de senha; não equivale a teclado virtual de aparelho físico.
- Capturas revisadas visualmente: login desktop com arte, login mobile dark, signup completo mobile, recuperação light, menu aberto e tablet light. Sem alegação de teste em telefone físico, Safari ou WebKit.

Evidências e scripts: /home/jean/.hermes/cache/scratch/mepmail-static-mobile/{dev-result.md,source-manifest.json,gates.log,build.log,browser-results.json,navigation-results.json,preview/}. Hashes de todos os paths alterados conferidos antes/depois da sincronização com Windows; exclusões verificadas explicitamente.

## Reprodução e implantação

1. QA deve usar o build vivo acima, sem reconstruir. Os scripts browser.py/navigation.py usam CDP existente 9223, contextos descartáveis e bloqueio de /api/auth/*, /api/updates/* e analytics; nenhuma conta ou mensagem real é criada.
2. Recuperação exige configuração de mail. Inicialmente /forgot-password redirecionava a /login por gate correto. O runtime do MESMO build foi reiniciado com valores explicitamente fictícios, via start-recovery.py, para expor a UI; não há credenciais reais nem prova de entrega de email. Não reutilizar esses valores em produção.
3. Se for necessário revalidar código alterado: python3 /home/jean/.hermes/cache/scratch/mepmail-cro/win.py /home/jean/.hermes/cache/scratch/mepmail-static-mobile/gates.ps1. Build local usa o wrapper existente mepmail-polish/build.ps1 via win.py; ele valida e para somente o listener Next start 9897. Nunca rodar build concorrente com o listener ou criar outra stack.
4. Para reiniciar o preview após parada controlada, executar start-recovery.py em processo persistente; manter a mesma porta/túnel. Não executar em paralelo com o listener existente. Parar apenas com restart.ps1, que valida o comando do PID.
5. Implantação NÃO executada neste card. Após QA independente no mesmo card, Luna conduz release separado já autorizado por Jean: build de produção com configuração correta pelo pipeline vigente, artefato mínimo, verificação do SHA servido e jornada. Nunca publicar o build dummy deste preview. Sem push/merge/deploy, alterações em banco/secrets/DNS ou limpeza de legado nesta fase.

Retenção: preview e evidências compactas são candidata ativa até QA/release; contextos browser temporários fechados. Nenhum clone, worktree, ambiente novo ou cópia integral criado.
