# Marco local — pacote MepMail 0.1.0 (t_b8f01b8a)

## Entrega e resultado

Pacote portable Agent Plugins 1.0.0 em `plugins/mepmail/`: manifest raiz, MCP remoto existente, duas skills EN (onboarding/consultas), listagem PT, logo original e AGPL/NOTICE. Não há outro backend/UI, secrets, hooks, app IDs inventados ou conta criada. ZIP produzido e reaberto/validado no Windows existente; instalação no host NÃO executada. Solicitar revisão independente a `qa`, não aprovar distribuição.

ZIP final: `docs/gtm/artifacts/mepmail-plugin/mepmail-0.1.0.zip` (artefato local, não versionado).
SHA256: `9b7f928ecff0edb64e708ec5d12471ab31a82ca5dec7cfa336da6194adf57949`.
Tamanho: 81.291 bytes; 8 arquivos. Cópia Windows: `F:/MepMail-artifacts/plugin/final/mepmail-0.1.0.zip`.
A candidata anterior 81c97994 foi substituída pela final após explicitar o gate de minimização de dados apontado por Security.

## Verificação realmente executada

- Windows F:\MepMail, Python 3.13/jsonschema 4.26.0: 25 testes do validador/empacotador aprovados. Cobertura: schemas oficiais, campos OpenAI, MCP presente, HTTPS/paths, marca/licença, arquivo extra/credencial, hooks/vídeo fictício, casos não executados, traversal/duplicação/symlink ZIP, paridade e determinismo; ausência do README interno em public/product.
- Schemas oficiais 1.0.0 copiados sem edição. SHA256 plugin: `0a4aad95ce337878ad38802ebf0daa3fde76abe3f65400c86bcbb1ec0b3ab883`; MCP: `6539175bfcdf43085855183e86da40ea94b166547a72b47ae9a0a390516d3acb`. Validação local não equivale ao validador proprietário do portal.
- Biome: 2 JSONs do pacote, exit 0.
- Suite MCP existente: 33 testes/1 suite aprovados no Windows com PGlite/JWKS local; inclui autenticação, scopes, time/roles e chamadas REST locais. Isso NÃO é OAuth/ChatGPT real nem envio externo.
- 13 entradas relevantes MCP/fonte/harness conferidas por SHA. Export tinha quatro arquivos antigos (API MCP/test/app e lockfile); diffs inspecionados, originais preservados com hash em `F:/MepMail-preserved/t_b8f01b8a-plugin/`, depois alinhados à fonte existente. Backend no Git não foi alterado. Dependências do MCP já instaladas; não foi criada stack/venv nem executado build VPS.
- 12 GETs anônimos aprovados: MCP401+desafio; discovery raiz e /mcp200; OAuth metadata200 com issuer/resource coerentes, DCR/none/S256; website/support/privacy/terms200 com marcador do publisher. Nenhum POST, DCR, callback, grant ou leitura autenticada.
- Logo 400×400 inspecionado visualmente, sem PII, hash idêntico ao asset original. Não é captura de painel.
- Correção adicional da Luna: removido `apps/web/public/product/README.md`, preservada proveniência em docs fora do webroot e sem path interno. Preview existente reiniciado, sem rebuild: README404; home e dois WebPs200; bytes dos assets servidos idênticos à fonte. Não foi alterado hero/arte/cadastro/preços.

Falhas intermediárias resolvidas: export não tinha o logo-fonte; copiado após conferência; harness MCP inicialmente bloqueou por divergência de export (não contou testes como passados). Instalação pip acusou WinError448 no wrapper CLI em mount não confiável, mas biblioteca/import e validação reais funcionaram, sem alterar o mount. Remoção do README retornou500 pelo cache de arquivos do processo antigo; após restart devolveu404. Linha de comando Windows excedeu limite no segundo sync; transporte por stdin resolveu, com read-back de hashes. Nenhum desses erros foi apresentado como sucesso.

## Matriz / limites

| Frente | Estado |
|---|---|
| Itens 1/2/4 anteriores | Aceite QA local preservado; sem repetir suíte/build não afetados |
| Item 3, captura | Pendente. Login humano no pane confirmado pela Luna, mas ainda sem captura sanitizada/receipt visual disponível. Não pedir novo login nem usar conta externa/galeria como substituto |
| Pacote plugin | ZIP e contratos locais verdes; revisão QA solicitada; sem instalação/E2E no host |
| Segurança/distribuição | NO-GO de publicação, confirmado em t_c3a8de4c: annotations explícitas/efeitos irreversíveis, mínimo privilégio efetivo e minimização/justificativa de get_email precisam de delta aprovado/testes posteriores |
| Portal | Sem upload/registro. 5 positivos/3 negativos preparados, NÃO executados. Identidade, conta dedicada, vídeo real e execução desktop/mobile pendentes |
| Preço/contratação P0 | t_26b106f0. Proposta de entrada39 rejeitada; direção é preservar20. Tabela numérica ainda pendente; PLAN_RUNGS/Stripe não alterados |

`get_email` retorna conteúdo/endereços ao host: omiti-los na resposta não minimiza transporte. Discovery anuncia capacidades amplas, consent pré-seleciona as solicitadas; skills/allowlist não são autorização. Um time/domains:read é o mínimo; emails:read só sob demanda, sem offline_access por padrão. Testes autenticados futuros exigem autorização separada e conta dedicada não cliente. Nenhuma alteração de auth/MCP servidor nesta entrega.

## Instalação, publicação e próxima escrita

Comandos reproduzíveis de teste/ZIP em `scripts/plugin/README.md`; instalação manual no marketplace existente e etapas separadas do portal em `plugins/mepmail/README.md`. Não instalar automaticamente, publicar o build dummy, fazer push/merge/deploy ou mexer em banco/Stripe. Após eventual autorização, validar a revisão exata antes de distribuir; aprovação do portal não publica automaticamente.

A fonte fica liberada após o handoff para QA. Próxima escrita de Dev: correção coerente de catálogo/UI/checkout somente após tabela validada no t_26b106f0. Não expandir plugin enquanto preços são P0. Retomada da captura: receber imagem segura de área interna autorizada + URL/data/hash/mascaramento, conferir visual e integrar abaixo do hero EN/PT; executar apenas gates de landing afetados.

Evidências desta rodada ficam junto ao ZIP local em `docs/gtm/artifacts/mepmail-plugin/`: package-tests.log, mcp-tests.txt, source-manifest.json, mcp-input-parity.json e public-probes.json. Preservar candidata/preview para QA; originais divergentes do export não são temporários descartáveis.
