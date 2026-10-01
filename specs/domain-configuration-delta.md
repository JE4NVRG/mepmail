# Delta de configuração — painel mepmail.dev (preparação)

Extensão curta do PRD/constitution existentes, autorizada por Jean para esta rodada; não altera protocolo OAuth, políticas JWT, finanças, contratos históricos ou infraestrutura. Fonte única: `feat/launch-readiness`, baseline `630abb16d3428d4523d9fdbff69e0eea87dd5e88`. A imagem dessa revisão permanece imutável; este WIP não pertence a ela.

- Endereço web futuro: `https://mepmail.dev`; não é default nem declaração de cutover. `APP_BASE_URL`/trustedOrigins continuam exclusivamente o host web configurado, sem aliases confiáveis adicionais.
- Novo parâmetro opcional `OAUTH_ISSUER_URL`: um único issuer HTTP(S) absoluto, sem credenciais, path, query, fragmento ou barra final. Ausente: issuer continua o `APP_BASE_URL` resolvido, preservando os defaults atuais.
- Primeira transição proposta (não aplicada): `APP_BASE_URL=https://mepmail.dev`, `OAUTH_ISSUER_URL=https://mepmail.je4ndev.com` e `PUBLIC_API_URL` explicitamente igual à API pública existente. Nenhum novo host API/MCP/audience é inferido. Issuer diferente do painel sem `PUBLIC_API_URL` deve falhar, não derivar porta 3001.
- Emissão/authorization response/discovery e verificação MCP usam o mesmo issuer. Discovery e verificador mantêm JWKS no host web configurado (`APP_BASE_URL/api/auth/jwks`), que serve as mesmas chaves existentes; não gera/rotaciona chaves produtivas. Endpoints OAuth da metadata seguem o host web, não uma segunda trustedOrigin.
- Prova focal: round trip real Better Auth (PKCE/consent/token) + verificação real do MCP em processo com PGlite/fixtures sintéticas, duas origens web e issuer estável; negativos issuer estrangeiro/audience errada/URL relativa ou malformada. Não é E2E nem prova de DNS/TLS/callbacks externos.

Env produtivo, DNS/TLS/nginx, callbacks externos, sessões/cookies, API/SMTP/SNS, chaves e dados reais permanecem intocados. Manter discovery acessível no issuer antigo e JWKS/chaves persistidas requer verificação posterior na janela nominativa; este delta não publica nem autoriza migração financeira. Revisão cruzada de Luna e gates focais precedem qualquer commit/publicação futura.
