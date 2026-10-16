import { buttonVariants } from "fumadocs-ui/components/ui/button";
import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";

export function baseOptions(lang = "en"): BaseLayoutProps {
  const portuguese = lang === "pt-BR";
  return {
    nav: {
      title: "MepMail Docs",
    },
    githubUrl: "https://github.com/JE4NVRG/mepmail",
    links: [
      {
        type: "custom",
        children: (
          <a href="https://mepmail.dev">{portuguese ? "Voltar ao site" : "MepMail website"}</a>
        ),
      },
      {
        type: "custom",
        children: (
          <a href="https://mepmail.dev/signup" className={buttonVariants({ size: "sm" })}>
            {portuguese ? "Criar conta" : "Create account"}
          </a>
        ),
      },
      {
        type: "custom",
        secondary: true,
        // An archive is a download, not a client-side route. A native anchor
        // prevents Next from prefetching several MB on every docs page.
        children: (
          <a href="/source" download>
            {portuguese ? "Código-fonte (AGPL)" : "Source (AGPL)"}
          </a>
        ),
      },
    ],
  };
}
