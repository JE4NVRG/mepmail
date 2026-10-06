import type { MetadataRoute } from "next";

/** Installation metadata only: private mail always uses the authenticated online app. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "MepMail",
    short_name: "MepMail",
    description: "Email for your products, your team and your agents.",
    start_url: "/emails",
    scope: "/",
    display: "standalone",
    background_color: "#000000",
    theme_color: "#000000",
    prefer_related_applications: false,
    icons: [
      { src: "/logo/mepmail-app-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/logo/mepmail-app-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    ],
  };
}
