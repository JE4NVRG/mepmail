# Frontend polish: preview para revisão independente

Implementação congelada em 07891e310693a98e6b3e9acae32724d08dd9db27, branch feat/launch-readiness. Somente LOCAL; sem push, merge ou deploy. Produção não foi alterada. Luna pediu encerramento do refinamento e revisão focal de QA, reutilizando esta evidência.

## Preview e resultado
- URL: http://127.0.0.1:9897/login (Windows existente F:\MepMail, via túnel).
- BUILD_ID servido: WTvbzXI8q0mvN_0NePddL; listener Windows PID 26368. HTTP 200, build ID e novo texto Continue with email confirmados no HTML.
- 233 fontes em paridade SHA256 Windows/worktree antes do build, zero divergências. WIP prévio preservado com hashes em F:\MepMail\.local-wip-preserved\polish-t_c93bbfa3; cro-base intocado.
- AuthScreen compartilhado, prova real sanitizada, painel desktop e formulário mobile sem tecido/WebGL. Inputs 48px/16px, olhos 44px; ambos os links de retorno mantidos. Idioma acessível por cookie. Email-first preservado com foco real na senha, pending anunciado e recuperação de erros de rede sem limpar valores.
- Copy EN/PT das superfícies autorizadas sem travessões editoriais e sem promessa de ativação em um clique. Motion no hero/prova, seções, tabs, CTAs e auth; reduced-motion e fallback estático preservados.

## Gates e evidência
Base dos caminhos: /home/jean/.hermes/cache/scratch/mepmail-polish/

- gates-final.log: 131 testes/13 suítes, Biome de 19 arquivos e TypeScript web verdes. Testes auth-polish são um harness SINTÉTICO de estado/handlers e cliente, incluindo flags Google/GitHub/Microsoft, pending, falha de rede, confirmação e recuperação. Não são OAuth E2E.
- css-gate.txt: após ajuste real de box-sizing, Biome do CSS e 12 testes pertinentes verdes. Demais gates reutilizados porque não houve mudança de lógica. build-final.log: build Windows verde, incluindo tsc. Logs contêm ECONNREFUSED esperado do banco dummy; não significam backend funcional.
- runtime.json e acceptance-summary.json: 32 casos principais (EN/PT × 1440x1000, 768x1024, 390x844, 375x667 × home/login/signup/forgot). Zero overflow; dimensões exatas dos 32 screenshots verificadas. Forgot é redirecionamento, não formulário funcional.
- Foco #password em 8/8 casos; tabs por teclado, menu/Escape, disclosures e âncoras exercitados. Troca EN→PT com e-mail preenchido preservou valor, etapa de senha e next; signup manteve idioma e next.
- 70 medições de texto em auth dark/light: mínimo 5,64:1. Zero exceções JS, assets HTTP404 ou requests de analytics/auth. supplemental-runtime.json: zero console.error nas 10 rotas exercitadas; fallback sem observer/Web Animations legível. Reduced-motion: zero animações em home/tab/auth e cancelamento 2→0 ao mudar preferência. SSR sem JS permanece visível.
- Smoke EN/PT: reset sem token, verify-email, updates, pricing, alternatives/resend e integrations. Consent: HTTP500 por banco dummy (ver limitações).
- frontend-polish-motion.mp4: screencast CDP REAL, 20,57s, 1440x722 nativos com padding de 1px horizontal quando necessário, sem distorcer proporção. 286 frames capturados; mostra entrada, scroll, tabs e login/etapa de senha. Não é GIF sintetizado. recording.json registra timestamps.
- Prints principais: preview/en-1440-login.png, preview/pt-BR-390-login.png, preview/pt-BR-390-signup.png, preview/contrast-light-login.png. Demais screenshots no mesmo diretório. Capturas de viewport usam captureBeyondViewport=false para evitar reamostragem da animação na captura; vídeo é independente.

## Limitações que NÃO são aprovação de auth E2E
- /forgot-password redireciona para /login porque envio de recuperação está desabilitado na configuração dummy. Estados de recuperação foram cobertos sinteticamente, não houve email enviado.
- /oauth/consent retorna HTTP500 ao inicializar auth e consultar oauth_resource: ECONNREFUSED 127.0.0.1:1. Nenhuma mudança de backend para contornar isso. Foram duas respostas 500 no smoke EN/PT, não defeitos ocultados.
- Providers reais não aparecem neste preview sem credenciais; flags e handlers são testes sintéticos. Não houve signup real, autenticação, token real, reset real, pagamento, escrita de banco ou evento analítico.

## Operação / publicação
Preview atual permanece no processo SSH persistente proc_dd588bd45eac (PID wrapper Linux 3836631), listener Windows 26368. Não encerrar a candidata durante a revisão. QA deve usar a revisão servida e estes logs, sem reinstalar/rebuild nem repetir toda a suíte. Se precisar reiniciar o mesmo preview, o wrapper existente é python3 /home/jean/.hermes/cache/scratch/mepmail-cro/win.py /home/jean/.hermes/cache/scratch/mepmail-polish/start.ps1; confirma porta livre antes de iniciar. Não executar uma segunda instância com o listener ativo.

Deploy NÃO autorizado. A eventual publicação exige aprovação posterior de Jean, pipeline existente e verificação do SHA/jornada em produção. Este relatório aprova apenas a implementação para revisão; QA e Luna ainda decidem sobre o preview.
