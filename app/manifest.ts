import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Event Zeka",
    short_name: "Event Zeka",
    description: "Belgrade events today: nightlife, concerts, DJ nights, exhibitions, theatre, film, festivals, and culture for locals and visitors.",
    start_url: "/",
    display: "standalone",
    background_color: "#050609",
    theme_color: "#8B86FB",
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
