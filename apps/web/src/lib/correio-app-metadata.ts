import type { Metadata } from "next";

/**
 * The Correio as an app on a phone's home screen (no store): its own manifest that
 * opens straight on the inbox (public/correio.webmanifest, id /mail, apart from the
 * dashboard's), and the iPhone's "Adicionar à Tela de Início" full screen.
 */
export const CORREIO_APP_METADATA: Metadata = {
  title: "Correio",
  manifest: "/correio.webmanifest",
  appleWebApp: { capable: true, title: "Correio", statusBarStyle: "black-translucent" },
};
