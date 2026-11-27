import type { Metadata } from "next";
import { getLocale } from "@/i18n/server";
import { localizedMetadata } from "@/lib/i18n/seo";
import { travelText } from "@/lib/travel/copy";
import { CompassEntry } from "@/components/travel/compass-entry";

export const revalidate = 60;

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getLocale();
  return localizedMetadata({ locale, path: "/next", title: travelText(locale, "next"), description: travelText(locale, "locationIntro"), index: false });
}

export default function NextPlacePage() {
  return <CompassEntry />;
}
