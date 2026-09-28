// Umami self-hosted (JE4NDEV) — analytics do site público.
//
// Os dois valores abaixo são PÚBLICOS: eles aparecem no HTML de toda página
// pública de qualquer forma, então ficam em código (e não em env de build) —
// o build via Docker não recebe NEXT_PUBLIC_* do runtime.
export const UMAMI_SCRIPT_URL = "https://umami.je4ndev.com/script.js";

// Website "mepmail-web" (domínio mepmail.je4ndev.com) na instância própria.
export const UMAMI_WEBSITE_ID = "167a3266-4a56-4fd1-8d14-59ed7437a313";

type UmamiTracker = {
  track: (event: string, data?: Record<string, unknown>) => void;
};

// O tracker vive em uma origem externa e pode não estar carregado (bloqueador,
// offline, script ainda baixando). Medição é best-effort: nunca pode quebrar
// a navegação do usuário — daí o optional chaining.
export function trackEvent(event: string, data?: Record<string, unknown>): void {
  if (typeof window === "undefined") return;
  const tracker = (window as unknown as { umami?: UmamiTracker }).umami;
  tracker?.track(event, data);
}
