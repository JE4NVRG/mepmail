# Migre este projeto do Resend para o MepMail

Você está migrando uma aplicação do Resend para o MepMail. A API REST do MepMail é compatível no wire com a do Resend — mesmos endpoints, mesmos formatos de requisição e resposta — então isto é uma mudança de configuração mais uma migração dos dados da conta, não uma reescrita. Siga os passos na ordem. Pare e pergunte antes de qualquer ação irreversível. Nunca imprima, registre em log ou commite uma chave de API.

## Fatos em que você pode confiar

- URL base da API Cloud: `https://api-mepmail.agenciamep.com`. Auto-hospedado: a origem da API da própria instância (pergunte se não estiver no repositório).
- Chaves de API começam com `ms_` e são criadas no painel em **Chaves de API**. Use uma chave de acesso total para a migração e chaves de acesso de envio para os remetentes de produção.
- Documentação: os documentos ficam no repositório, em `apps/docs/content/` — o markdown cru está no mesmo caminho em `raw.githubusercontent.com/JE4NVRG/mepmail/main/`, e a própria API serve a especificação OpenAPI 3.1 em `/openapi.json`. O guia de migração está em https://github.com/JE4NVRG/mepmail/blob/main/apps/docs/content/docs/migrate-from-resend.pt-BR.mdx e a referência da CLI em https://github.com/JE4NVRG/mepmail/blob/main/apps/docs/content/docs/cli.pt-BR.mdx.
- A CLI de migração (`@millionsend/cli`) só lê do Resend (requisições `GET`), mantém as chaves em memória, não as grava em arquivo algum e não envia telemetria.
- Os ids diferem entre os provedores: contatos são casados por e-mail, o restante por nome, chave, alias ou endpoint. O relatório da CLI traz um mapa de ids para tópicos e segmentos.

## Passo 1 — Inventário desta base de código

Encontre todo ponto de contato com o Resend antes de mudar qualquer coisa e mostre a lista ao usuário:

- Pacotes de SDK: `resend` (Node), `resend` (Python), `resend-go`, `resend-php`, `resend-ruby`, `resend-java`, `resend-dotnet`, `resend-elixir`.
- Variáveis de ambiente: `RESEND_API_KEY`, `RESEND_BASE_URL` e qualquer `https://api.resend.com` fixo no código.
- Receptores de webhook que verificam os cabeçalhos de assinatura `svix-*`, e as URLs de endpoint registradas no Resend.
- Ids ou aliases de audiências, segmentos, tópicos e templates referenciados em código ou configuração.
- Corpos de broadcast ou template que usam `{{{RESEND_UNSUBSCRIBE_URL}}}` (continua funcionando no MepMail como alias de `{{{UNSUBSCRIBE_URL}}}`).

## Passo 2 — Mova a conta

Peça ao usuário uma chave do Resend com acesso total, uma chave do MepMail com acesso total e se o destino é o Cloud ou uma URL auto-hospedada. Passe as chaves por variáveis de ambiente, nunca como argumentos de linha de comando.

Primeiro o plano (somente leitura; código de saída 2 significa que há mudanças, 0 nada a fazer, 1 erro):

```sh
export RESEND_API_KEY=re_...
export MILLIONSEND_API_KEY=ms_...
export MILLIONSEND_BASE_URL=https://api-mepmail.agenciamep.com   # ou a URL da instância

npx @millionsend/cli migrate plan --from resend --out plan.json
```

Mostre ao usuário o resumo do plano, incluindo avisos de limite do plano (por exemplo "7 domínios a criar; o plano Free permite 3"), e aguarde a aprovação. Então aplique:

```sh
npx @millionsend/cli migrate apply plan.json --yes
```

Flags que valem conhecer: `--rps <n>` reduz a taxa de leitura contra o Resend (padrão 8; o Resend permite 10 por time, compartilhados com o envio em produção); `--skip enrichment` pula a segunda passagem por contato para propriedades e tópicos; `--include-sent` importa também broadcasts enviados como rascunhos; `--fresh-webhook-secrets` gera novos segredos de webhook em vez de copiá-los; `--on-conflict skip|error` muda como contatos já existentes são tratados (padrão upsert).

Depois leia `.millionsend/migrate-report.md`: contagens por recurso, o checklist de itens manuais, os registros DNS por domínio e o mapa de ids. A ferramenta acrescenta `.millionsend/` ao `.gitignore` quando existe um; confirme que fez isso.

## Passo 3 — Aponte o código para o MepMail

Escolha uma das duas opções, com o usuário:

1. **Mantenha o SDK do Resend.** Os SDKs oficiais do Resend respeitam uma URL base. Defina, em todo ambiente que envia:
   ```sh
   RESEND_API_KEY=ms_...
   RESEND_BASE_URL=https://api-mepmail.agenciamep.com
   ```
   Confirme que a versão instalada do SDK lê `RESEND_BASE_URL` (ou a opção de URL base do construtor) e substitua qualquer `https://api.resend.com` fixo no código.
2. **Mantenha o SDK do Resend que você já tem — não existe cliente nosso para trocar.** Aponte-o para a instância pela opção de URL base dele (`baseUrl` no Node, `base_url` no Python, `RESEND_BASE_URL` nos demais, `BaseURL` no Go; se o valor quer barra final varia por linguagem) e deixe imports e nomes de classe como estão. Detalhes por linguagem: https://github.com/JE4NVRG/mepmail/blob/main/apps/docs/content/docs/sdks.pt-BR.mdx.
   PHP: `Resend::client()` devolve um `Client` que mantém o `HttpClient` privado. Para uma requisição sem método no SDK, construa o `HttpClient` você mesmo com os mesmos argumentos que a factory passa (leia `Resend::client()` no pacote): mesmo pacote, mesmo comportamento, um nível abaixo.

Então resolva o que o relatório lista:

- Atualize ids de tópicos e segmentos em código e configuração usando o mapa de ids do relatório.
- Templates: templates do MepMail não armazenam `from` nem `reply_to`; passe-os em cada envio.
- Webhooks: endpoint, eventos e segredo de assinatura foram copiados, então o receptor existente continua verificando os cabeçalhos `svix-*`. Tipos de evento fora dos sete tipos `email.*` do MepMail foram descartados por webhook e estão listados; remova ou substitua os handlers deles.
- Chaves de API não podem ser migradas (o Resend expõe apenas os nomes). Crie uma para cada nome que o relatório lista, no painel, e coloque-as nos ambientes correspondentes.

## Passo 4 — DNS, feito pelo usuário

O MepMail usa seu próprio par de chaves DKIM, então todo domínio precisa de novos registros DNS mesmo que já envie pelo Resend. Os registros estão no relatório e em **Domínios** no painel. Os dois provedores podem ficar verificados lado a lado. Não mude o tráfego até cada domínio aparecer como **Verificado**.

## Passo 5 — Faça a virada e verifique

1. Rode `migrate plan` e `migrate apply` de novo logo antes de virar o tráfego: cada execução é um diff, então os contatos que chegaram nesse meio-tempo vêm junto e nada é duplicado.
2. Faça o deploy das mudanças de ambiente do passo 3.
3. Envie um e-mail pela nova URL base e confirme que ele chega a **Entregue** na página de E-mails; confirme que uma entrega de webhook chega ao receptor.
4. Mantenha a conta do Resend intocada até o usuário estar confiante. Se algo precisar ser desfeito do lado do MepMail, `npx @millionsend/cli migrate rollback` apaga somente o que a ferramenta criou, depois de listar e perguntar.

## Regras

- O Resend é somente leitura durante toda a migração: nunca crie, altere ou apague nada lá.
- Chaves passam por variáveis de ambiente ou stdin, nunca por arquivos, logs, argumentos ou commits.
- Pergunte antes de aplicar o plano, antes de mexer em variáveis de ambiente de produção e antes de qualquer mudança de DNS.
- Termine com um resumo: o que mudou no repositório, o que foi movido na conta e exatamente os itens que o usuário ainda precisa fazer.
