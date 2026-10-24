import { UMAMI_SCRIPT_URL, UMAMI_WEBSITE_ID } from "@/lib/analytics";
import { SiteFunnelEvents } from "./site-funnel-events";

// Tag de tracking do Umami self-hosted. `defer` mantém o carregamento fora do
// caminho crítico e a origem é externa (a instância roda em outro host), logo
// nenhum bloqueio de render. O tracker de navegador não recebe identidade de
// conta/time. A seleção de produto/plano é metadado funcional do cadastro.
export function UmamiAnalytics() {
  // Preview local explícito: nunca carregar o tracker de produção nesse ambiente.
  if (process.env.MEPMAIL_LOCAL_PREVIEW === "1") return <SiteFunnelEvents />;
  return (
    <>
      <SiteFunnelEvents />
      <script defer src={UMAMI_SCRIPT_URL} data-website-id={UMAMI_WEBSITE_ID} />
    </>
  );
}
