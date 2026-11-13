/** Public entry copy kept separate from the client-only signup controls. */
export function publicSignupCopy(locale: string) {
  return locale === "pt-BR"
    ? {
        check: "Consultar disponibilidade",
        availabilityBody:
          "Consulte o cadastro para verificar a disponibilidade de novas contas. Contas existentes podem continuar entrando.",
        admissionTitle: "Novos cadastros e assinaturas pausados",
        admissionBody:
          "Novos cadastros, assinaturas e testes estão temporariamente indisponíveis. Contas existentes podem entrar e gerenciar suas assinaturas. Ainda não há data de reabertura.",
        catalog:
          "Preços, limites e condições abaixo são referências do catálogo, não uma oferta disponível para contratação agora.",
        paused: "Novos cadastros pausados",
        full: "Capacidade de cadastro atingida",
        pausedBody:
          "A criação de novas contas está pausada. Não é possível se cadastrar agora. Contas existentes podem continuar entrando.",
        fullBody:
          "Todas as vagas de cadastro estão ocupadas. Não é possível criar uma conta agora. Contas existentes podem continuar entrando.",
        login: "Entrar na minha conta",
        status: "Ver status do serviço",
        source: "Código-fonte",
        contact: "Falar com o suporte",
        back: "Voltar ao site",
        links: "Próximos passos",
      }
    : {
        check: "Check availability",
        availabilityBody:
          "Check registration for new account availability. Existing accounts can still sign in.",
        admissionTitle: "New registrations and subscriptions paused",
        admissionBody:
          "New registrations, subscriptions and trials are temporarily unavailable. Existing accounts can sign in and manage their subscriptions. No reopening date has been announced.",
        catalog:
          "Prices, limits and terms below are catalog references, not an offer available to purchase now.",
        paused: "New registrations paused",
        full: "Registration capacity reached",
        pausedBody:
          "New account creation is paused. You cannot register right now. Existing accounts can still sign in.",
        fullBody:
          "All registration places are taken. You cannot create an account right now. Existing accounts can still sign in.",
        login: "Sign in to my account",
        status: "View service status",
        source: "Source code",
        contact: "Contact support",
        back: "Back to site",
        links: "Next steps",
      };
}
