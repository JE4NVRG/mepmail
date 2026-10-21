export interface PublishedIncident {
  id: string;
  startedAt: string;
  resolvedAt: string | null;
  summary: { en: string; "pt-BR": string };
}

/** Add only incidents approved for public disclosure; never infer an uptime history. */
export const PUBLISHED_INCIDENTS: readonly PublishedIncident[] = [
  {
    id: "2026-10-18-origin-restart",
    startedAt: "2026-10-18T11:57:00Z",
    resolvedAt: "2026-10-18T18:21:00Z",
    summary: {
      en: "Unplanned restart of the production server. The web server did not come back after the reboot, so the website, dashboard, HTTP API, documentation, IMAP (993) and SMTP submission on ports 465 and 587 were unreachable for about 6 h 24 min, until 18:21 UTC. Incoming mail kept arriving and was stored in mailboxes, and SMTP on port 2587, which does not go through the web server, stayed up. API calls made during the outage failed and had to be retried. Fixes: the web server now waits for the network at boot and restarts itself if it fails, an origin-down alert notifies the team, and since 21 October an external probe checks the site, API and mail ports every minute from outside the production server.",
      "pt-BR":
        "Reinício não planejado do servidor de produção. O servidor web não voltou depois do reinício, e o site, o painel, a API HTTP, a documentação, o IMAP (993) e o envio SMTP nas portas 465 e 587 ficaram inacessíveis por cerca de 6 h 24 min, até 18:21 UTC. Os e-mails recebidos continuaram chegando e foram guardados nas caixas, e o SMTP na porta 2587, que não passa pelo servidor web, ficou no ar. Chamadas à API feitas durante a queda falharam e precisaram ser repetidas. Correções: o servidor web agora espera a rede no boot e se reinicia sozinho se falhar, um alerta avisa a equipe quando a origem cai e, desde 21 de outubro, uma sonda externa verifica site, API e portas de e-mail a cada minuto, de fora do servidor de produção.",
    },
  },
];
