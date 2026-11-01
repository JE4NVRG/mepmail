/** Public entry copy kept separate from the client-only signup controls. */
export function publicSignupCopy(locale: string) {
  return locale === "pt-BR"
    ? {
        check: "Consultar disponibilidade",
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
