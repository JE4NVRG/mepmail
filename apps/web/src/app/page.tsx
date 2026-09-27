import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { hasSession } from "@/server/auth";
import "./landing.css";

const contact = "mailto:jean@je4ndev.com";

const comparison = [
  ["100k", "US$ 20", "US$ 35", "US$ 34,95", "US$ 115", "US$ 90", "43%"],
  ["200k", "US$ 69", "US$ 160", "US$ 249", "US$ 245", "US$ 215", "57–72%"],
  ["500k", "US$ 159", "US$ 350", "US$ 499", "US$ 455", "US$ 400", "55–68%"],
  ["1M", "US$ 259", "US$ 650", "US$ 799", "US$ 775", "US$ 700", "60–68%"],
  ["1,5M", "US$ 369", "US$ 825", "US$ 799", "US$ 775", "US$ 700", "47–55%"],
  ["2,5M", "US$ 549", "US$ 1.150", "US$ 1.099", "(vendas)", "US$ 1.250", "50–56%"],
] as const;

const plans = [
  {
    name: "Free",
    volume: "100/dia (~3k/mês)",
    price: "US$ 0",
    overage: "para no cap",
    attachment: "1 MB",
    limits: "1 domínio · 1 workspace · 1.000 contatos",
  },
  {
    name: "Starter",
    volume: "1.500/dia (~45k/mês)",
    price: "US$ 9",
    overage: "para no cap",
    attachment: "1 MB",
    limits: "3 domínios · 2 workspaces · 10.000 contatos",
  },
  {
    name: "Pro 100K",
    volume: "100.000/mês",
    price: "US$ 20",
    overage: "US$ 0,30/1k",
    attachment: "5 MB",
    limits: "10 domínios · 5 workspaces · contatos ilimitados",
  },
  {
    name: "Pro 200K",
    volume: "200.000/mês",
    price: "US$ 69",
    overage: "US$ 0,30/1k",
    attachment: "5 MB",
    limits: "10 domínios · 5 workspaces · contatos ilimitados",
  },
  {
    name: "Scale 500K",
    volume: "500.000/mês",
    price: "US$ 159",
    overage: "US$ 0,25/1k",
    attachment: "10 MB",
    limits: "Domínios ilimitados · 10 workspaces · contatos ilimitados",
  },
  {
    name: "Scale 1M",
    volume: "1.000.000/mês",
    price: "US$ 259",
    overage: "US$ 0,20/1k",
    attachment: "10 MB",
    limits: "Domínios ilimitados · 10 workspaces · contatos ilimitados",
  },
  {
    name: "Scale 1.5M",
    volume: "1.500.000/mês",
    price: "US$ 369",
    overage: "US$ 0,18/1k",
    attachment: "10 MB",
    limits: "Domínios ilimitados · 10 workspaces · contatos ilimitados",
  },
  {
    name: "Scale 2.5M",
    volume: "2.500.000/mês",
    price: "US$ 549",
    overage: "US$ 0,16/1k",
    attachment: "10 MB",
    limits: "Domínios ilimitados · 10 workspaces · contatos ilimitados",
  },
] as const;

const questions = [
  [
    "Já uso Resend. Preciso reescrever minha integração?",
    "Para os fluxos de envio compatíveis, você pode manter o SDK oficial do Resend e trocar a base URL e a chave. Revisamos sua integração na migração para identificar recursos que não são equivalentes. Não prometemos paridade total de funcionalidades.",
  ],
  [
    "Vocês garantem entrega na caixa de entrada?",
    "Não. Configuramos DKIM e MAIL FROM no domínio de envio e acompanhamos a reputação, mas a classificação final depende dos provedores de destino, do seu conteúdo e do histórico do domínio. Não existe garantia honesta de caixa de entrada.",
  ],
  [
    "Existe fidelidade ou multa para cancelar?",
    "Não há fidelidade. Você pode pedir o cancelamento sem multa; combinamos o encerramento dos envios e a retirada das configurações de DNS quando aplicável.",
  ],
  [
    "Qual o limite de anexos?",
    "O limite total por mensagem é de 1 MB no Free e Starter, 5 MB no Pro e 10 MB no Scale. Vale para a soma dos anexos decodificados, não para cada arquivo separadamente.",
  ],
  [
    "O que acontece quando passo da cota?",
    "No Free e Starter, os envios param no limite diário. Nos planos Pro e Scale, com excedente habilitado, os envios adicionais são cobrados pela tarifa de cada plano por 1.000 e respeitam o teto de segurança de 5× o volume incluído; sem excedente habilitado, param na cota mensal. Se você prevê aumento de volume, fale conosco antes.",
  ],
  [
    "O suporte é em português?",
    "Sim. O onboarding é assistido e o suporte é direto em português com quem construiu o produto. A gestão proativa é opcional e adiciona monitoramento, ajustes e prioridade de atendimento.",
  ],
  [
    "Como funciona o beta?",
    "O beta é limitado a 100 contas grátis, cada uma com teto de 100 e-mails por dia no plano Free. Quando as vagas acabam, novos cadastros pausam até a próxima leva; para volume maior, fale com a gente e combinamos o plano.",
  ],
] as const;

const description =
  "E-mail transacional com onboarding assistido no Brasil. Compare planos MepMail, envie pela API compatível com Resend ou relay SMTP e crie sua conta grátis no beta.";

export const metadata: Metadata = {
  title: { absolute: "MepMail — E-mail transacional com API compatível com Resend" },
  description,
  robots: { index: true, follow: true },
  openGraph: {
    title: "MepMail — E-mail transacional com API compatível com Resend",
    description,
    type: "website",
    images: [{ url: "/og.png", width: 1280, height: 640, alt: "MepMail" }],
  },
};

function Wordmark() {
  return (
    <span className="gtm-wordmark">
      <img
        className="gtm-wordmark-dark"
        src="/logo/mepmail-wordmark.svg"
        alt=""
        width="143"
        height="20"
      />
      <img
        className="gtm-wordmark-light"
        src="/logo/mepmail-wordmark-light.svg"
        alt=""
        width="143"
        height="20"
      />
    </span>
  );
}

function SignupLink({ label = "Criar conta grátis" }: { label?: string }) {
  return (
    <a className="ms-btn ms-btn-primary gtm-action" href="/signup">
      {label}
    </a>
  );
}

export default async function RootPage() {
  if (await hasSession()) redirect("/emails");

  return (
    <div className="gtm">
      <a className="gtm-skip" href="#conteudo">
        Pular para o conteúdo
      </a>
      <header className="gtm-header">
        <div className="gtm-container gtm-header-inner">
          <a className="gtm-brand" href="/" aria-label="MepMail — início">
            <Wordmark />
          </a>
          <nav className="gtm-nav" aria-label="Navegação principal">
            <a className="gtm-nav-extra" href="#comparativo">
              Comparar preços
            </a>
            <a className="gtm-nav-extra" href="#planos">
              Planos
            </a>
            <a className="gtm-nav-extra" href="#como-funciona">
              Como funciona
            </a>
            <a href="/login">Entrar</a>
            <SignupLink label="Criar conta" />
          </nav>
        </div>
      </header>
      <main id="conteudo">
        <section className="gtm-section gtm-hero">
          <div className="gtm-container">
            <p className="gtm-eyebrow">
              E-mail transacional para quem constrói produtos no Brasil{" "}
              <span className="gtm-beta-badge">Beta · 100 contas grátis</span>
            </p>
            <h1>
              Mesma API do Resend. <span>Até 60% mais barato.</span>
            </h1>
            <p className="gtm-lead">
              Envie e-mails transacionais com API HTTPS compatível com o Resend ou relay SMTP. Nós
              ajudamos a configurar seu domínio, DKIM e MAIL FROM. Planos em USD, atendimento em
              português e implantação assistida.
            </p>
            <div className="gtm-actions">
              <SignupLink />
              <a className="ms-btn ms-btn-secondary gtm-action" href="#planos">
                Ver planos
              </a>
            </div>
            <p className="gtm-note">
              Beta aberto: 100 contas grátis, teto de 100 e-mails por dia em cada uma. Crie a sua
              em 1 minuto — sem cartão.
            </p>
          </div>
        </section>

        <section className="gtm-section gtm-alt" id="comparativo">
          <div className="gtm-container">
            <p className="gtm-eyebrow">Preço sem adivinhação</p>
            <h2>Compare pelo volume que você realmente envia.</h2>
            <p>
              Os valores abaixo comparam o menor plano que cobre cada volume mensal. A economia
              varia por faixa e fornecedor; confirme condições atuais antes de contratar.
            </p>
            <section
              className="gtm-table-scroll"
              aria-label="Comparativo de preços por volume"
              // biome-ignore lint/a11y/noNoninteractiveTabindex: a tabela com overflow precisa de foco para rolagem por teclado
              tabIndex={0}
            >
              <table className="gtm-table">
                <thead>
                  <tr>
                    {[
                      "Envios/mês",
                      "MepMail",
                      "Resend",
                      "SendGrid",
                      "Postmark",
                      "Mailgun",
                      "Vantagem",
                    ].map((label) => (
                      <th scope="col" key={label}>
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {comparison.map(([volume, ...values]) => (
                    <tr key={volume}>
                      <th scope="row">{volume}</th>
                      {values.map((value, index) => (
                        <td
                          key={
                            ["MepMail", "Resend", "SendGrid", "Postmark", "Mailgun", "Vantagem"][
                              index
                            ]
                          }
                        >
                          {value}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
            <p className="gtm-note">
              Deslize a tabela para ver todos os fornecedores em telas menores.
            </p>
            <p className="gtm-note">
              Referência da análise comercial de 27/09/2026; preços públicos de terceiros podem
              mudar e condições/recursos não são equivalentes. Valores em USD por mês, sem impostos
              ou excedentes. “(vendas)” indica cotação comercial, não preço público.
            </p>
          </div>
        </section>

        <section className="gtm-section">
          <div className="gtm-container">
            <p className="gtm-eyebrow">Nossa estrutura</p>
            <h2>Menos camadas entre sua aplicação e a entrega.</h2>
            <p>
              Operamos nossa própria camada de API, relay e painel sobre o Amazon SES. O envio é
              contratado à la carte, sem repassar a estrutura de preços de um intermediário. É assim
              que oferecemos preços menores sem vender uma cópia de todas as funcionalidades de
              outros provedores.
            </p>
            <ul className="gtm-points">
              <li>Infraestrutura de operação própria: API, relay e painel MepMail.</li>
              <li>Envio via Amazon SES à la carte.</li>
              <li>Implantação acompanhada, sem intermediário de atendimento.</li>
            </ul>
          </div>
        </section>

        <section className="gtm-section gtm-alt" id="planos">
          <div className="gtm-container">
            <p className="gtm-eyebrow">Planos</p>
            <h2>Escolha o volume. Nós ajudamos na configuração.</h2>
            <p>
              Todos os planos incluem onboarding assistido e suporte em português. Preços mensais em
              USD; para os primeiros clientes, cobrança via PIX em BRL pela cotação do dia.
            </p>
            <div className="gtm-plan-grid">
              {plans.map((plan) => (
                <article className="ms-card gtm-plan" key={plan.name}>
                  <h3>{plan.name}</h3>
                  <p className="gtm-price">
                    {plan.price}
                    <span>/mês</span>
                  </p>
                  <p className="gtm-volume">{plan.volume}</p>
                  <dl>
                    <div>
                      <dt>Workspaces e limites</dt>
                      <dd>{plan.limits}</dd>
                    </div>
                    <div>
                      <dt>Excedente</dt>
                      <dd>{plan.overage}</dd>
                    </div>
                    <div>
                      <dt>Anexos por mensagem</dt>
                      <dd>{plan.attachment}</dd>
                    </div>
                  </dl>
                  <SignupLink label="Começar grátis" />
                </article>
              ))}
            </div>
            <p className="gtm-note">
              Free e Starter têm limite diário (UTC); o volume mensal é apenas ilustrativo. Em Pro e
              Scale, o excedente por 1.000 depende de habilitação no provisionamento; sem ele, os
              envios param na cota. Mesmo com excedente habilitado, vale o teto de segurança de 5× o
              volume incluído.
            </p>
            <div className="gtm-offers">
              <p>
                <strong>Gestão proativa opcional: +US$ 29/mês.</strong> Inclui monitoramento de
                reputação, ajustes de DNS/entregabilidade e prioridade de atendimento. Sem gestão,
                você continua com onboarding assistido e suporte. Sem fidelidade.
              </p>
              <p>
                <strong>
                  Para os 3 primeiros clientes: setup grátis e 2 meses de gestão grátis.
                </strong>{" "}
                Crie sua conta grátis e fale com a gente para garantir a sua.
              </p>
            </div>
            <p className="gtm-note">
              Limite por e-mail: tamanho total dos anexos após decodificação, não por arquivo.
            </p>
          </div>
        </section>

        <section className="gtm-section" id="como-funciona">
          <div className="gtm-container">
            <p className="gtm-eyebrow">Implantação assistida</p>
            <h2>Da conversa ao primeiro envio, com ajuda de quem construiu.</h2>
            <ol className="gtm-steps">
              <li>
                Crie sua conta grátis e conte como você envia hoje. Indicamos o degrau certo e
                acompanhamos a migração.
              </li>
              <li>
                Configuramos seu domínio de envio com você: registros DNS para DKIM e MAIL FROM,
                verificação e chave de API dedicada ou credenciais do relay SMTP.
              </li>
              <li>
                Faça um envio de teste pela API ou pelo relay. Você acompanha logs, domínios,
                supressões e métricas no painel MepMail.
              </li>
            </ol>
            <p className="gtm-note">
              A configuração assistida costuma levar cerca de 15 minutos depois que você tem acesso
              ao DNS; a propagação e a verificação do domínio podem levar mais tempo. A verificação
              automática roda a cada 15 minutos.
            </p>
            <SignupLink />
          </div>
        </section>

        <section className="gtm-section gtm-alt">
          <div className="gtm-container">
            <p className="gtm-eyebrow">Entregabilidade e integração</p>
            <h2>Sua identidade de envio, sua integração.</h2>
            <p>
              Cada cliente usa um domínio de envio próprio verificado com DKIM e MAIL FROM no Amazon
              SES, com reputação isolada. Escolha a API HTTPS compatível com chamadas de envio do
              Resend, com base URL <code>api-mepmail.je4ndev.com</code>, ou o relay SMTP com
              STARTTLS em <code>smtp-mepmail.agenciamep.com:2587</code>. A chave de API é dedicada à
              sua operação.
            </p>
            <p className="gtm-note">
              Compatibilidade de API não significa paridade de recursos: inbound, IP dedicado e SSO
              não fazem parte desta promessa. A entrega na caixa de entrada depende também do
              domínio, do conteúdo e da reputação de envio.
            </p>
          </div>
        </section>

        <section className="gtm-section">
          <div className="gtm-container">
            <p className="gtm-eyebrow">Perguntas frequentes</p>
            <h2>Perguntas antes de migrar</h2>
            <div className="gtm-faq">
              {questions.map(([question, answer]) => (
                <details key={question}>
                  <summary>{question}</summary>
                  <p>{answer}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        <section className="gtm-section gtm-alt gtm-close">
          <div className="gtm-container">
            <h2>Vamos encontrar o plano para o seu volume?</h2>
            <p>
              Crie sua conta grátis, faça seus primeiros envios e conte como você envia hoje — na
              migração, a gente vai junto.
            </p>
            <SignupLink />
          </div>
        </section>
      </main>
      <footer className="gtm-footer">
        <div className="gtm-container gtm-footer-inner">
          <div>
            <a className="gtm-brand" href="/" aria-label="MepMail — início">
              <Wordmark />
            </a>
            <p>MepMail · E-mail transacional com implantação assistida no Brasil</p>
          </div>
          <nav aria-label="Rodapé">
            <a href="/login">Entrar</a>
            <a href={contact}>Contato</a>
          </nav>
        </div>
      </footer>
    </div>
  );
}
