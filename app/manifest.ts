import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Event Zeka",
    short_name: "Event Zeka",
    id: "/",
    scope: "/",
    lang: "sr-Latn-RS",
    description: "Događaji u Beogradu: žurke, koncerti, izložbe, pozorište i kultura.",
    start_url: "/",
    display: "standalone",
    background_color: "#10141F",
    theme_color: "#D5F56B",
    icons: [
      {
        src: "/event-zeka-icon-192.png",
        sizes: "192x192",
        type: "image/png",
      },
      {
        src: "/event-zeka-icon-512.png",
        sizes: "512x512",
        type: "image/png",
      },
    ],
  };
}
