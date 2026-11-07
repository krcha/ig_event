import Link from "next/link";
import { getLocale } from "@/i18n/server";
import { localizeHref } from "@/i18n/config";

export default async function NotFound() {
  const locale = await getLocale();
  const copy = {
    sr: ["Stranica nije pronađena", "Ova stranica više nije dostupna ili je adresa pogrešna.", "Nazad na događaje"],
    en: ["Page not found", "This page is unavailable or the address is incorrect.", "Back to events"],
    ru: ["Страница не найдена", "Эта страница недоступна или указан неверный адрес.", "К событиям"],
  }[locale];
  return <main className="app-page py-12"><h1 className="text-3xl font-semibold">{copy[0]}</h1><p className="text-muted-foreground">{copy[1]}</p><Link className="button-secondary w-fit px-4" href={localizeHref("/", locale)}>{copy[2]}</Link></main>;
}
