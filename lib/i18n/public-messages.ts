import type { Locale } from "@/i18n/config";
import seed from "./public-message-seed.json" with { type: "json" };
import additional from "./public-message-extra.json" with { type: "json" };
import supplement from "./public-message-supplement.json" with { type: "json" };

type Translation = Record<Locale, string>;
const extra = { ...additional, ...supplement } as Record<string, Translation>;

/** Presentation copy only. Callers explicitly mark UI text; event/source facts
 * are never walked, rewritten, or used to update canonical data. */
export function publicText(locale: Locale, value: string): string {
  const key = value.replace(/\s+/gu, " ").trim();
  const capitalized = key.charAt(0).toUpperCase() + key.slice(1);
  const translated = extra[key] ?? (seed as Record<string, Translation>)[key]
    ?? extra[capitalized] ?? (seed as Record<string, Translation>)[capitalized];
  if (translated) return value.replace(value.trim(), translated[locale]);
  const relativeDay = /^In (\d+) days$/u.exec(key);
  if (relativeDay) return new Intl.RelativeTimeFormat(locale === "sr" ? "sr-Latn" : locale, { numeric: "always" }).format(Number(relativeDay[1]), "day");
  const relativeTime = /^(Tonight|Tomorrow|In \d+ days)( · .+)$/u.exec(key);
  if (relativeTime) return `${publicText(locale, relativeTime[1])}${relativeTime[2]}`;
  const ages = /^Ages (\d+[–-]\d+)(.*)$/u.exec(key);
  if (ages) return `${{ sr: "Uzrast", en: "Ages", ru: "Возраст" }[locale]} ${ages[1]}${ages[2]}`;
  const prefixes: Array<[RegExp, Record<Locale, string>]> = [
    [/^Show Instagram post for (.+)$/u, { sr: "Prikaži Instagram objavu: ", en: "Show Instagram post for ", ru: "Показать публикацию Instagram: " }],
    [/^Hide Instagram post for (.+)$/u, { sr: "Sakrij Instagram objavu: ", en: "Hide Instagram post for ", ru: "Скрыть публикацию Instagram: " }],
    [/^Save (.+)$/u, { sr: "Sačuvaj: ", en: "Save ", ru: "Сохранить: " }],
    [/^Unsave (.+)$/u, { sr: "Ukloni iz sačuvanih: ", en: "Unsave ", ru: "Удалить из сохранённого: " }],
    [/^Open details for (.+)$/u, { sr: "Otvori detalje: ", en: "Open details for ", ru: "Открыть подробности: " }],
    [/^Open (.+)$/u, { sr: "Otvori: ", en: "Open ", ru: "Открыть: " }],
    [/^Radno vreme mesta: (.+)$/u, { sr: "Radno vreme mesta: ", en: "Venue opening hours: ", ru: "Часы работы места: " }],
    [/^Status source (\d+)$/u, { sr: "Izvor statusa ", en: "Status source ", ru: "Источник статуса " }],
    [/^Hours source (\d+)$/u, { sr: "Izvor radnog vremena ", en: "Hours source ", ru: "Источник часов работы " }],
    [/^Ukloni iz izbora: (.+)$/u, { sr: "Ukloni iz izbora: ", en: "Remove from picks: ", ru: "Убрать из подборки: " }],
    [/^(?:Otvori detalje događaja|Detalji događaja): (.+)$/u, { sr: "Detalji događaja: ", en: "Event details: ", ru: "Подробности события: " }],
    [/^Pregledani događaji: (.+)$/u, { sr: "Pregledani događaji: ", en: "Reviewed events: ", ru: "Просмотренные события: " }],
    [/^Ponovo biraj: (.+)$/u, { sr: "Ponovo biraj: ", en: "Choose again: ", ru: "Выбрать заново: " }],
    [/^Vrati poslednju odluku: (.+)$/u, { sr: "Vrati poslednju odluku: ", en: "Undo last decision: ", ru: "Отменить последнее решение: " }],
    [/^Vraćena poslednja kartica: (.+)$/u, { sr: "Vraćena poslednja kartica: ", en: "Last card restored: ", ru: "Последняя карточка восстановлена: " }],
    [/^Sviđa ti se: (.+)$/u, { sr: "Sviđa ti se: ", en: "Liked: ", ru: "Нравится: " }],
    [/^Preskočeno: (.+)$/u, { sr: "Preskočeno: ", en: "Skipped: ", ru: "Пропущено: " }],
  ];
  for (const [pattern, prefix] of prefixes) {
    const match = pattern.exec(key);
    if (match) return `${prefix[locale]}${match[1]}`;
  }
  const inferredTime = /^Najavljeni početak: (.+)\. Pretpostavljeni završetak prema zatvaranju mesta: (.+)\.$/u.exec(key);
  if (inferredTime) return {
    sr: `Najavljeni početak: ${inferredTime[1]}. Pretpostavljeni završetak prema zatvaranju mesta: ${inferredTime[2]}.`,
    en: `Announced start: ${inferredTime[1]}. End inferred from venue closing: ${inferredTime[2]}.`,
    ru: `Объявленное начало: ${inferredTime[1]}. Окончание предполагается по закрытию места: ${inferredTime[2]}.`,
  }[locale];
  return value;
}
