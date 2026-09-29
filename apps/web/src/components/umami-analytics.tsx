import { UMAMI_SCRIPT_URL, UMAMI_WEBSITE_ID } from "@/lib/analytics";

// Tag de tracking do Umami self-hosted. `defer` mantém o carregamento fora do
// caminho crítico e a origem é externa (a instância roda em outro host), logo
// nenhum bloqueio de render. O Umami não usa cookies nem coleta dados pessoais,
// então não exige banner de consentimento.
export function UmamiAnalytics() {
  // Preview local explícito: nunca carregar o tracker de produção nesse ambiente.
  if (process.env.MEPMAIL_LOCAL_PREVIEW === "1") return null;
  return <script defer src={UMAMI_SCRIPT_URL} data-website-id={UMAMI_WEBSITE_ID} />;
}
