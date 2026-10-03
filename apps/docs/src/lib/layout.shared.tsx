import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: "MepMail Docs",
    },
    githubUrl: "https://github.com/JE4NVRG/mepmail",
    links: [{ text: "Source (AGPL)", url: "/source" }],
  };
}
