import type { Metadata } from "next";
import { InstallGuide } from "@/components/install/install-guide";

const title = "Instaliraj EventZeka App";
const description = "Dodaj EventZeka App na početni ekran. Uputstvo za instalaciju na iPhone, Android i računar.";

export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: "/install" },
  openGraph: {
    title: `${title} | Event Zeka`,
    description,
    type: "website",
    locale: "sr_RS",
    siteName: "Event Zeka",
    url: "/install",
  },
  twitter: { card: "summary_large_image", title: `${title} | Event Zeka`, description },
};

export default function InstallPage() {
  return <InstallGuide />;
}
