# Vídeo de acesso: entrega para revisão, somente preview

Implementação local: `a9d1abe218c326f54bb2a6ebdaf0cf8aa02410b9` (feat/launch-readiness). Build Windows: `1IHMQHxQQwC1ofAG23v_x`, confirmado no HTML de http://127.0.0.1:9897/login. Commit de relatório posterior não altera o artefato. Nenhum push, merge ou deploy.

## Entregue e executado
- AuthScreen reutilizado, sem mudanças no auth-form/backend. Arte própria no acesso; landing mantém screenshot real. Copy EN/PT, contain quadrado, formulário preservado; tokens preto/marfim/violeta existentes. Exceção decorativa de preview registrada antes do código em login-video-spec.md, DESIGN.md e constitution.
- MP4 685244 bytes, stream único H264 960×960, 24fps, 145 frames, 6.041667s, zero áudio/capa. Remux sem reencode: hash do stream principal igual à fonte `2badc4842f635a94bf9cc11f597dce41d0c9e6eb41ab428ef5dbd1f3f8b61bb7`. Poster primeiro frame WebP, 28604 bytes.
- MP4 SHA256 `8e7ec396e0dde1e514d5a3e1f066ed3e1aa927b2d9e50d7c1df163e0784ace4b`; poster `993fd2d4cd2342e3d5da89f6d05092247cbb84859b3d1939042463d69d665522`. GET200, MIME correto e bytes servidos iguais ao repo.
- Windows: Biome 7 arquivos sem avisos; 75 testes/4 suítes (auth-art, auth-polish, i18n-parity, frontend-polish); tsc --noEmit; build Next verde. Avisos ECONNREFUSED em 127.0.0.1:1 são do banco dummy já previsto, não validação de OAuth real.
- Browser Chrome real: avanço de frames, loop observado; pausa e retomada por Enter; controle 44px/foco visível; foco senha no email-first; idioma/next/email e pausa preservados; alternância real de abas pausa/resume; reduce dinâmico desmonta vídeo e retorno respeita pausa manual; zero erros JS no smoke; sem overflow horizontal desktop 1440×900 e 1280×720. Não confundir loop observado com seam perfeito.
- Fontes/assets alterados sincronizados e hashes comparados no export existente F:\MepMail. Sem copiar dependências/cache/env/Git. Preview persiste por SSH; túnel original mantido.

## Revisão independente e limites
Por ajuste da Luna/Jean durante execução, Dev entrega preview+smoke rapidamente; matriz restante cabe ao QA, sem repetir gates/build. Reutilizar `/home/jean/.hermes/cache/scratch/mepmail-login-video-integration/qa-preflight.md`, cujos hashes de código permanecem iguais.

Pendências explícitas para QA: rede fria mobile/959px (zero MP4 e poster), reduced-motion inicial (zero MP4), no-JS, autoplay negado, erro de mídia e seam visual. Preflight apontou risco P2 NÃO reproduzido no smoke: play() pendente no clique pode competir com cleanup pause()/novo play(); reproduzir com rede lenta/autoplay negado. P3 conhecido de compatibilidade: sem IntersectionObserver, poster permanece mas controle de reprodução não inicia. Browser moderno com API passou smoke. Não declarar aprovação final desses cenários.

Screenshot light foi obtido forçando data-theme no DOM para inspeção de contraste; wordmark/CTA precisam ser confirmados pelo QA no caminho real de tema, não tratados como aprovação abrangente. Microtexto da arte é secundário, especialmente em 1280×720; relação template→destinatários permanece visível. Nenhuma autenticação, senha, cadastro, e-mail, cobrança ou analytics real executado. Forgot/consent mantêm limitações de env dummy anteriores.

## Evidência e reprodução local
Diretório: `/home/jean/.hermes/cache/scratch/mepmail-login-video-integration/`.
- `gates-final.log`, `build.log`, `preview.log`, `source-manifest.json`, `ffprobe.json`, `browser-results.json`/`browser-smoke.log`.
- `preview/login-en-1440x900.png`, `preview/login-pt-1280x720.png`, `preview/login-light-1280x720.png`.
- `login-playback-control.mp4`: gravação CDP real de loop e controle, com `recording.json` de estado. Sem fabricar vídeo de still.
- `verify-browser.py --smoke`; a execução sem flag disponibiliza a matriz adicional para QA, sem obrigar duplicação. O helper anterior enviava Enter sem text CR e não ativava botão: correção apenas no harness, sem mudança no produto.

Restart (somente se necessário; não repetir por troca de agente): preservar porta/túnel 9897, confirmar listener Next start; executar `python3 /home/jean/.hermes/cache/scratch/mepmail-cro/win.py /home/jean/.hermes/cache/scratch/mepmail-polish/build.ps1` em background com log. Wrapper valida/paralisa apenas listener da candidata antes de tocar .next. Após build verde, executar o mesmo win.py com `.../mepmail-polish/start.ps1` em background persistente, logando fora do repo. Revalidar BUILD_ID no HTML e hashes servidos. Não iniciar outro build enquanto servidor usa .next. Sem implantação em produção autorizada.
